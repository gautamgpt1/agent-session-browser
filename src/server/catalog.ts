import fs from "node:fs";
import path from "node:path";
import type { AgentProvider, ArchiveState } from "../shared/types.js";
import type { ParsedSession } from "./parser.js";
import { parseGeminiSessionFile } from "./gemini-parser.js";
import { compactWhitespace, toDisplayText } from "./text.js";

type JsonObject = Record<string, any>;

const SAMPLE_BYTES = 128 * 1024;

export async function catalogSessionFile(
  provider: AgentProvider,
  sourcePath: string,
  archiveState: ArchiveState,
  knownCwd: string | null = null
): Promise<ParsedSession> {
  if (provider === "gemini" && path.extname(sourcePath).toLowerCase() === ".json") {
    const parsed = await parseGeminiSessionFile(sourcePath, archiveState, knownCwd, { compactItems: true, retainItems: false });
    return { ...parsed, searchText: "" };
  }
  const stat = await fs.promises.stat(sourcePath);
  const lines = await readSampleLines(sourcePath, stat.size);
  const records: JsonObject[] = [];
  const errors: string[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as JsonObject);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }

  const metadata = provider === "claude"
    ? claudeMetadata(records, sourcePath)
    : provider === "gemini"
      ? geminiMetadata(records, sourcePath, knownCwd)
      : provider === "pi"
        ? piMetadata(records, sourcePath)
        : codexMetadata(records, sourcePath);

  return {
    ...metadata,
    provider,
    sourcePath,
    archiveState,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount: 0,
    parseStatus: errors.length && records.length === 0 ? "error" : errors.length ? "partial" : "ok",
    parseError: errors.slice(0, 3).join("\n") || null,
    turns: [],
    items: [],
    tools: [],
    searchText: ""
  };
}

async function readSampleLines(sourcePath: string, size: number): Promise<string[]> {
  if (size === 0) return [];
  const handle = await fs.promises.open(sourcePath, "r");
  try {
    const headSize = Math.min(size, SAMPLE_BYTES);
    const head = Buffer.allocUnsafe(headSize);
    await handle.read(head, 0, headSize, 0);
    if (size <= SAMPLE_BYTES) return completeLines(head.toString("utf8"), true, true);

    const tailSize = Math.min(size, SAMPLE_BYTES);
    const tail = Buffer.allocUnsafe(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    return [
      ...completeLines(head.toString("utf8"), true, false),
      ...completeLines(tail.toString("utf8"), false, true)
    ];
  } finally {
    await handle.close();
  }
}

function completeLines(value: string, startsAtBoundary: boolean, endsAtBoundary: boolean): string[] {
  const lines = value.split(/\r?\n/);
  if (!startsAtBoundary) lines.shift();
  if (!endsAtBoundary) lines.pop();
  return lines.filter((line) => line.trim());
}

function codexMetadata(records: JsonObject[], sourcePath: string) {
  let id = extractUuid(sourcePath) || path.basename(sourcePath, ".jsonl");
  let cwd: string | null = null;
  let originator: string | null = null;
  let source: string | null = null;
  let cliVersion: string | null = null;
  let modelProvider: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  for (const record of records) {
    const payload = primaryPayload(record);
    const timestamp = stringOrNull(record.timestamp) || stringOrNull(payload.timestamp);
    ({ startedAt, lastEventAt } = includeTimestamp(startedAt, lastEventAt, timestamp));
    if (record.type === "session_meta") {
      id = stringOrNull(payload.id) || id;
      cwd = stringOrNull(payload.cwd) || cwd;
      originator = stringOrNull(payload.originator) || originator;
      source = stringOrNull(payload.source) || source;
      cliVersion = stringOrNull(payload.cli_version) || cliVersion;
      modelProvider = stringOrNull(payload.model_provider) || modelProvider;
    }
    const role = stringOrNull(payload.role) || (payload.type === "user_message" ? "user" : payload.type === "agent_message" ? "assistant" : null);
    const text = codexText(record, payload);
    if (role === "user" && text && !looksInjected(text) && !firstUserMessage) firstUserMessage = preview(text);
    if (role === "assistant" && text) lastAssistantMessage = preview(text);
  }
  return baseMetadata(id, id, cwd, originator, source, cliVersion, modelProvider, startedAt, lastEventAt, firstUserMessage, lastAssistantMessage);
}

function claudeMetadata(records: JsonObject[], sourcePath: string) {
  let nativeId = extractUuid(sourcePath) || path.basename(sourcePath, ".jsonl");
  let agentId: string | null = null;
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let originator: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  for (const record of records) {
    nativeId = stringOrNull(record.sessionId) || nativeId;
    agentId = stringOrNull(record.agentId) || agentId;
    cwd = stringOrNull(record.cwd) || cwd;
    cliVersion = stringOrNull(record.version) || cliVersion;
    originator = stringOrNull(record.entrypoint) || originator;
    ({ startedAt, lastEventAt } = includeTimestamp(startedAt, lastEventAt, stringOrNull(record.timestamp)));
    const message = isObject(record.message) ? record.message : {};
    const text = toDisplayText(message.content);
    if (record.type === "user" && !record.isMeta && text && !firstUserMessage) firstUserMessage = preview(text);
    if (record.type === "assistant" && text) lastAssistantMessage = preview(text);
  }
  const id = `claude:${nativeId}${agentId ? `:${agentId}` : ""}`;
  return baseMetadata(id, nativeId, cwd, agentId ? `subagent:${agentId}` : originator, agentId ? "subagent" : "cli", cliVersion, "anthropic", startedAt, lastEventAt, firstUserMessage, lastAssistantMessage);
}

function geminiMetadata(records: JsonObject[], sourcePath: string, cwd: string | null) {
  const metadata = records[0] || {};
  const nativeId = stringOrNull(metadata.sessionId) || extractUuid(sourcePath) || path.basename(sourcePath).replace(/\.jsonl?$/i, "");
  let startedAt = stringOrNull(metadata.startTime);
  let lastEventAt = stringOrNull(metadata.lastUpdated);
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  const messages = [...(Array.isArray(metadata.messages) ? metadata.messages.filter(isObject) : []), ...records.slice(1)];
  for (const message of messages) {
    const timestamp = stringOrNull(message.timestamp);
    ({ startedAt, lastEventAt } = includeTimestamp(startedAt, lastEventAt, timestamp));
    const text = toDisplayText(message.displayContent) || toDisplayText(message.content);
    if (message.type === "user" && text && !firstUserMessage) firstUserMessage = preview(text);
    if (message.type === "gemini" && text) lastAssistantMessage = preview(text);
  }
  return baseMetadata(`gemini:${nativeId}`, nativeId, cwd, "gemini-cli", "cli", null, "google", startedAt, lastEventAt, firstUserMessage || stringOrNull(metadata.summary), lastAssistantMessage);
}

function piMetadata(records: JsonObject[], sourcePath: string) {
  const header = records.find((record) => record.type === "session") || {};
  const nativeId = stringOrNull(header.id) || path.basename(sourcePath, ".jsonl");
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let modelProvider: string | null = null;
  let sessionName: string | null = null;
  for (const record of records) {
    ({ startedAt, lastEventAt } = includeTimestamp(startedAt, lastEventAt, stringOrNull(record.timestamp)));
    if (record.type === "session_info") sessionName = stringOrNull(record.name) || sessionName;
    const message = isObject(record.message) ? record.message : {};
    const text = toDisplayText(message.content);
    if (message.role === "user" && text && !firstUserMessage) firstUserMessage = preview(text);
    if (message.role === "assistant") {
      if (text) lastAssistantMessage = preview(text);
      modelProvider = stringOrNull(message.provider) || modelProvider;
    }
  }
  return baseMetadata(`pi:${nativeId}`, nativeId, stringOrNull(header.cwd), "pi-tui", stringOrNull(header.parentSession) ? "fork" : "cli", header.version ? `session-v${header.version}` : null, modelProvider, startedAt, lastEventAt, firstUserMessage || sessionName, lastAssistantMessage);
}

function baseMetadata(id: string, nativeId: string, cwd: string | null, originator: string | null, source: string | null, cliVersion: string | null, modelProvider: string | null, startedAt: string | null, lastEventAt: string | null, firstUserMessage: string | null, lastAssistantMessage: string | null) {
  return { id, nativeId, cwd, originator, source, cliVersion, modelProvider, startedAt, lastEventAt, firstUserMessage, lastAssistantMessage };
}

function primaryPayload(record: JsonObject): JsonObject {
  if (isObject(record.payload)) return record.payload;
  if (isObject(record.item)) return record.item;
  if (isObject(record.params?.item)) return record.params.item;
  return isObject(record.params) ? record.params : {};
}

function codexText(record: JsonObject, payload: JsonObject): string | null {
  if (record.type === "event_msg") return toDisplayText(payload.message);
  if (payload.type === "message") return toDisplayText(payload.content);
  return toDisplayText(payload.text) || toDisplayText(payload.message) || toDisplayText(payload.content);
}

function includeTimestamp(startedAt: string | null, lastEventAt: string | null, timestamp: string | null) {
  if (!timestamp) return { startedAt, lastEventAt };
  return {
    startedAt: !startedAt || timestamp < startedAt ? timestamp : startedAt,
    lastEventAt: !lastEventAt || timestamp > lastEventAt ? timestamp : lastEventAt
  };
}

function preview(value: string): string {
  return compactWhitespace(value).slice(0, 500);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractUuid(value: string): string | null {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null;
}

function looksInjected(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<environment_context>") || text.startsWith("<codex_internal_context");
}
