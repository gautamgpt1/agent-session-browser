import fs from "node:fs";
import path from "node:path";
import { JSONParser } from "@streamparser/json";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import { BoundedItemCollector, type BoundedParseOptions, HeadTailBuffer, SearchTextCollector } from "./bounded-parse.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { iterateSourceLines } from "./source-lines.js";
import { compactWhitespace, toDisplayText, truncateText } from "./text.js";

type RecordValue = Record<string, unknown>;
type GeminiRecord =
  | { kind: "metadata" | "message"; value: RecordValue; lineNo: number; rawJson?: string }
  | { kind: "error"; message: string; lineNo: number };

interface GeminiSourceState {
  lineCount: number;
  errors: string[];
}

export async function parseGeminiSessionFile(sourcePath: string, archiveState: ArchiveState, cwd: string | null, options: BoundedParseOptions = {}): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const sourceState: GeminiSourceState = { lineCount: 0, errors: [] };
  const collectionLimit = options.retainItems === false ? 0 : undefined;
  const itemCollector = new BoundedItemCollector(options);
  const toolCollector = new HeadTailBuffer<Omit<ToolCall, "id" | "cwd" | "archiveState">>(collectionLimit);
  const turnCollector = new HeadTailBuffer<ParsedTurn>(collectionLimit);
  const searchText = new SearchTextCollector();
  let metadata: RecordValue = {};
  let sequence = 0;
  let turnNumber = 0;
  let currentTurnId = "turn-1";
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;

  const addItem = (input: Omit<ConversationItem, "id" | "sessionId" | "sequence">) => {
    itemCollector.add({ ...input, sessionId: "", sequence: sequence++ });
    searchText.add([input.role, input.text, input.summary, input.toolName, input.payloadType]);
  };

  for await (const record of readGeminiRecords(sourcePath, options, sourceState)) {
    if (record.kind === "error") {
      addItem({
        nativeId: null, parentId: null, requestId: null, model: null, stopReason: null,
        usageJson: null, providerMetadataJson: null, turnId: currentTurnId, timestamp: null,
        envelopeType: "parse_error", payloadType: "error", role: null, toolName: null,
        callId: null, phase: null, summary: record.message, text: null, rawJson: undefined,
        lineNo: record.lineNo
      });
      continue;
    }
    if (record.kind === "metadata") {
      metadata = record.value;
      startedAt = stringOrNull(metadata.startTime);
      lastEventAt = stringOrNull(metadata.lastUpdated);
      addItem({
        nativeId: stringOrNull(metadata.sessionId), providerMetadataJson: stringifyMaybe(metadata),
        turnId: null, timestamp: startedAt, envelopeType: "session_meta", payloadType: "session_meta",
        role: null, toolName: null, callId: null, phase: null, summary: stringOrNull(metadata.summary),
        text: null, rawJson: record.rawJson, lineNo: record.lineNo, parentId: null, requestId: null,
        model: null, stopReason: null, usageJson: null
      });
      continue;
    }

    const message = record.value;
    const messageType = stringOrNull(message.type) || "unknown";
    const timestamp = stringOrNull(message.timestamp);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }
    if (messageType === "user") {
      turnNumber += 1;
      currentTurnId = stringOrNull(message.id) || `turn-${turnNumber}`;
      turnCollector.add({ turnId: currentTurnId, startedAt: timestamp, cwd, currentDate: timestamp?.slice(0, 10) || null, approvalPolicy: null, sandboxPolicy: null });
    }
    const messageText = toDisplayText(message.displayContent) || toDisplayText(message.content);
    const role = messageType === "user" ? "user" : messageType === "gemini" ? "assistant" : null;
    const assistantPhase = role === "assistant" ? classifyAssistantPhase(message) : null;
    const nativeFields = {
      nativeId: stringOrNull(message.id), parentId: stringOrNull(message.parentId), requestId: stringOrNull(message.requestId),
      model: stringOrNull(message.model), stopReason: stringOrNull(message.stopReason) || stringOrNull(message.finishReason),
      usageJson: stringifyMaybe(message.usageMetadata || message.usage),
      providerMetadataJson: stringifyMaybe(metadataOnly(message, ["content", "displayContent", "thoughts", "toolCalls"]))
    };
    if (role === "user" && messageText && !looksInjected(messageText) && !firstUserMessage) firstUserMessage = compactWhitespace(messageText).slice(0, 500);
    if (role === "assistant" && messageText) lastAssistantMessage = compactWhitespace(messageText).slice(0, 500);
    if (messageText) {
      addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: messageType === "gemini" ? "message" : messageType, role, toolName: null, callId: null, phase: assistantPhase, summary: null, text: messageText, rawJson: record.rawJson, lineNo: record.lineNo });
    }

    if (Array.isArray(message.thoughts)) {
      for (const thought of message.thoughts) {
        if (!isRecord(thought)) continue;
        const thoughtText = [toDisplayText(thought.subject), toDisplayText(thought.description)].filter(Boolean).join("\n");
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "reasoning", role: null, toolName: null, callId: null, phase: null, summary: toDisplayText(thought.subject), text: thoughtText || null, rawJson: record.rawJson, lineNo: record.lineNo });
      }
    }

    if (Array.isArray(message.toolCalls)) {
      for (const value of message.toolCalls) {
        if (!isRecord(value)) continue;
        const callId = stringOrNull(value.id);
        const toolName = stringOrNull(value.displayName) || stringOrNull(value.name) || "tool_call";
        const argumentsJson = stringifyMaybe(value.args);
        const outputText = toDisplayText(value.resultDisplay) || toDisplayText(value.result);
        const status = stringOrNull(value.status) || (outputText ? "completed" : "started");
        toolCollector.add({ sessionId: "", turnId: currentTurnId, timestamp, toolName, callId, argumentsJson, outputText: truncateText(outputText), status });
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "function_call", role: null, toolName, callId, phase: "started", summary: stringOrNull(value.description), text: argumentsJson, rawJson: record.rawJson, lineNo: record.lineNo });
        if (outputText) addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "function_call_output", role: null, toolName, callId, phase: status, summary: null, text: outputText, rawJson: record.rawJson, lineNo: record.lineNo });
      }
    }
  }

  const metadataStart = stringOrNull(metadata.startTime);
  const metadataEnd = stringOrNull(metadata.lastUpdated);
  if (metadataStart && (!startedAt || metadataStart < startedAt)) startedAt = metadataStart;
  if (metadataEnd && (!lastEventAt || metadataEnd > lastEventAt)) lastEventAt = metadataEnd;

  if (turnCollector.values().length === 0) turnCollector.add({ turnId: "turn-1", startedAt, cwd, currentDate: startedAt?.slice(0, 10) || null, approvalPolicy: null, sandboxPolicy: null });
  const nativeId = stringOrNull(metadata.sessionId) || extractUuid(sourcePath) || path.basename(sourcePath).replace(/\.jsonl?$/i, "");
  const id = `gemini:${nativeId}`;
  const items = itemCollector.values();
  const tools = toolCollector.values();
  for (const item of items) item.sessionId = id;
  for (const tool of tools) tool.sessionId = id;
  return {
    id, nativeId, provider: "gemini", sourcePath, archiveState, cwd, originator: "gemini-cli", source: "cli",
    cliVersion: null, modelProvider: "google", startedAt, lastEventAt, bytes: stat.size, mtimeMs: stat.mtimeMs,
    lineCount: sourceState.lineCount, parseStatus: sourceState.errors.length === 0 ? "ok" : items.length > 1 ? "partial" : "error",
    parseError: sourceState.errors.join("\n") || null, firstUserMessage, lastAssistantMessage,
    turns: turnCollector.values(), items, tools,
    searchText: [cwd, stringOrNull(metadata.summary), searchText.value()].filter(Boolean).join("\n"),
    deferredRecords: itemCollector.deferredCount
  };
}

async function* readGeminiRecords(sourcePath: string, options: BoundedParseOptions, state: GeminiSourceState): AsyncGenerator<GeminiRecord> {
  if (path.extname(sourcePath).toLowerCase() === ".json") {
    yield* readMonolithicGeminiRecords(sourcePath, state);
    return;
  }

  let metadataSeen = false;
  for await (const { line, lineNo } of iterateSourceLines(sourcePath)) {
    state.lineCount = lineNo;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const message = `Line ${lineNo}: ${(error as Error).message}`;
      if (state.errors.length < 10) state.errors.push(message);
      yield { kind: "error", message, lineNo };
      continue;
    }
    if (!isRecord(value)) continue;
    if (!metadataSeen) {
      metadataSeen = true;
      yield { kind: "metadata", value, lineNo };
      if (Array.isArray(value.messages)) for (const message of value.messages) if (isRecord(message)) yield { kind: "message", value: message, lineNo };
    } else {
      yield { kind: "message", value, lineNo };
    }
  }
  if (!metadataSeen) yield { kind: "metadata", value: {}, lineNo: 1 };
}

async function* readMonolithicGeminiRecords(sourcePath: string, state: GeminiSourceState): AsyncGenerator<GeminiRecord> {
  const metadata: RecordValue = {};
  const queued: RecordValue[] = [];
  let metadataEmitted = false;
  let messageCount = 0;
  const parser = new JSONParser({
    paths: ["$.sessionId", "$.startTime", "$.lastUpdated", "$.summary", "$.messages.*"],
    keepStack: false
  });
  parser.onValue = ({ value, key, stack }) => {
    if (typeof key === "number" && stack.at(-1)?.key === "messages") {
      if (isRecord(value)) queued.push(value);
    } else if (typeof key === "string" && ["sessionId", "startTime", "lastUpdated", "summary"].includes(key)) {
      metadata[key] = value;
    }
  };
  try {
    for await (const chunk of fs.createReadStream(sourcePath)) {
      parser.write(chunk);
      if (!metadataEmitted && queued.length) {
        metadataEmitted = true;
        yield { kind: "metadata", value: metadata, lineNo: 1 };
      }
      while (queued.length) {
        messageCount += 1;
        yield { kind: "message", value: queued.shift()!, lineNo: messageCount + 1 };
      }
    }
    if (!parser.isEnded) parser.end();
  } catch (error) {
    const message = `Monolithic JSON: ${(error as Error).message}`;
    state.errors.push(message);
    if (!metadataEmitted) {
      metadataEmitted = true;
      yield { kind: "metadata", value: metadata, lineNo: 1 };
    }
    yield { kind: "error", message, lineNo: messageCount + 2 };
  }
  if (!metadataEmitted) yield { kind: "metadata", value: metadata, lineNo: 1 };
  while (queued.length) {
    messageCount += 1;
    yield { kind: "message", value: queued.shift()!, lineNo: messageCount + 1 };
  }
  state.lineCount = Math.max(1, messageCount + 1);
}

export async function readGeminiJsonSourceRecord(sourcePath: string, lineNo: number): Promise<string | null> {
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  const metadata: RecordValue = {};
  let selected: RecordValue | null = null;
  const messageIndex = lineNo - 2;
  const parser = new JSONParser({
    paths: messageIndex >= 0
      ? [`$.messages.${messageIndex}`]
      : ["$.sessionId", "$.startTime", "$.lastUpdated", "$.summary"],
    keepStack: false
  });
  parser.onValue = ({ value, key }) => {
    if (messageIndex >= 0) {
      if (isRecord(value)) selected = value;
    } else if (typeof key === "string") {
      metadata[key] = value;
    }
  };
  for await (const chunk of fs.createReadStream(sourcePath)) {
    parser.write(chunk);
    if (selected) break;
  }
  if (messageIndex >= 0) return selected ? JSON.stringify(selected) : null;
  if (!parser.isEnded) parser.end();
  return JSON.stringify(metadata);
}

function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function stringifyMaybe(value: unknown): string | null { if (value == null) return null; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function extractUuid(value: string): string | null { return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null; }
function looksInjected(value: string): boolean { const text = value.trimStart(); return text.startsWith("<session_context>") || text.startsWith("<hook_context>"); }
function metadataOnly(value: RecordValue, excluded: string[]): RecordValue { return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !excluded.includes(key) && entry !== undefined)); }
function classifyAssistantPhase(message: RecordValue): string {
  const reason = (stringOrNull(message.stopReason) || stringOrNull(message.finishReason) || "").toLowerCase();
  if (["error", "cancelled", "canceled", "max_tokens", "length"].includes(reason)) return "incomplete";
  return "final_answer";
}
