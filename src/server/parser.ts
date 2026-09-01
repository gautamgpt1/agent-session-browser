import fs from "node:fs";
import path from "node:path";
import type { AgentProvider, ArchiveState, ConversationItem, ParseStatus, ToolCall } from "../shared/types.js";
import { BoundedItemCollector, BoundedMap, type BoundedParseOptions, HeadTailBuffer, SearchTextCollector } from "./bounded-parse.js";
import { iterateSourceLines } from "./source-lines.js";
import { compactWhitespace, toDisplayText, truncateText } from "./text.js";

export interface ParsedTurn {
  turnId: string;
  startedAt: string | null;
  cwd: string | null;
  currentDate: string | null;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
}

export interface ParsedSession {
  id: string;
  nativeId: string;
  provider: AgentProvider;
  sourcePath: string;
  archiveState: ArchiveState;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  cliVersion: string | null;
  modelProvider: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  bytes: number;
  mtimeMs: number;
  lineCount: number;
  parseStatus: ParseStatus;
  parseError: string | null;
  firstUserMessage: string | null;
  lastAssistantMessage: string | null;
  turns: ParsedTurn[];
  items: Omit<ConversationItem, "id">[];
  tools: Omit<ToolCall, "id" | "cwd" | "archiveState">[];
  searchText: string;
  deferredRecords?: number;
}

export type CodexParseOptions = BoundedParseOptions;

interface Envelope {
  item?: Record<string, unknown>;
  method?: string;
  params?: Record<string, unknown>;
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "web_search_call",
  "image_generation_call",
  "tool_search_call"
]);

const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "web_search_output",
  "image_generation_output",
  "tool_search_output"
]);

export async function parseCodexJsonlFile(sourcePath: string, archiveState: ArchiveState, options: CodexParseOptions = {}): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const collectionLimit = options.retainItems === false ? 0 : undefined;
  const turnCollector = new HeadTailBuffer<ParsedTurn>(collectionLimit);
  const itemCollector = new BoundedItemCollector(options);
  const toolsByCallId = new BoundedMap<string, Omit<ToolCall, "id" | "cwd" | "archiveState">>(options.retainItems === false ? 10_000 : undefined);
  const toolCollector = new HeadTailBuffer<Omit<ToolCall, "id" | "cwd" | "archiveState">>(collectionLimit);
  const searchText = new SearchTextCollector();
  const parseErrors: string[] = [];

  let lineCount = 0;
  let sequence = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let originator: string | null = null;
  let source: string | null = null;
  let cliVersion: string | null = null;
  let modelProvider: string | null = null;
  let currentModel: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let currentTurnId: string | null = null;
  let turnNumber = 0;
  let firstUserMessage: string | null = null;
  let fallbackUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;

  for await (const sourceLine of iterateSourceLines(sourcePath)) {
    const { line, lineNo } = sourceLine;
    lineCount = lineNo;
    if (!line.trim()) continue;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(line) as Envelope;
    } catch (error) {
      const message = `Line ${lineCount}: ${(error as Error).message}`;
      if (parseErrors.length < 10) parseErrors.push(message);
      itemCollector.add({
        sessionId: "",
        turnId: currentTurnId,
        timestamp: null,
        envelopeType: "parse_error",
        payloadType: "error",
        role: null,
        toolName: null,
        callId: null,
        phase: null,
        nativeId: null,
        parentId: null,
        requestId: null,
        model: currentModel,
        stopReason: null,
        usageJson: null,
        providerMetadataJson: null,
        summary: message,
        text: null,
        rawJson: undefined,
        lineNo,
        sequence: sequence++
      });
      continue;
    }

    const payload = getPrimaryPayload(envelope);
    const envelopeType = String(envelope.type || envelope.method || "unknown");
    const payloadType = stringOrNull(payload.type);
    currentModel = stringOrNull(payload.model) || currentModel;
    const timestamp =
      stringOrNull(envelope.timestamp) ||
      stringOrNull(payload.timestamp) ||
      timestampFromMilliseconds(envelope.params?.startedAtMs) ||
      timestampFromMilliseconds(envelope.params?.completedAtMs);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }

    if (envelopeType === "session_meta") {
      sessionId = stringOrNull(payload.id) || sessionId;
      cwd = stringOrNull(payload.cwd) || cwd;
      originator = stringOrNull(payload.originator) || originator;
      source = stringOrNull(payload.source) || source;
      cliVersion = stringOrNull(payload.cli_version) || cliVersion;
      modelProvider = stringOrNull(payload.model_provider) || modelProvider;
    }

    const payloadTurnId = stringOrNull(payload.turn_id) || stringOrNull((payload.metadata as Record<string, unknown> | undefined)?.turn_id);
    if (payloadTurnId) currentTurnId = payloadTurnId;

    if (envelopeType === "turn_context") {
      turnNumber += 1;
      const turnId = payloadTurnId || `turn-${turnNumber}`;
      currentTurnId = turnId;
      turnCollector.add({
        turnId,
        startedAt: timestamp,
        cwd: stringOrNull(payload.cwd),
        currentDate: stringOrNull(payload.current_date),
        approvalPolicy: stringOrNull(payload.approval_policy),
        sandboxPolicy: stringOrNull(payload.sandbox_policy)
      });
    }

    const role = detectRole(envelopeType, payload);
    const text = normalizeItemText(envelopeType, payload);
    const summary = normalizeSummary(payload);
    const toolName = normalizeToolName(payloadType, payload);
    const callId = stringOrNull(payload.call_id);
    const phase = stringOrNull(payload.phase);
    const nativeId = stringOrNull(payload.id) || stringOrNull(envelope.params?.itemId);
    const parentId = stringOrNull(payload.parent_id) || stringOrNull(payload.parentId);
    const requestId = stringOrNull(payload.request_id) || stringOrNull(envelope.params?.requestId);
    const model = stringOrNull(payload.model) || currentModel;
    const stopReason = stringOrNull(payload.stop_reason);
    const itemTurnId = payloadTurnId || currentTurnId;

    if (role === "user" && text) {
      const normalized = compactWhitespace(text).slice(0, 500);
      if (!fallbackUserMessage) fallbackUserMessage = normalized;
      if (!firstUserMessage && !looksLikeInjectedContext(text)) {
        firstUserMessage = normalized;
      }
    }
    if (role === "assistant" && text) {
      lastAssistantMessage = compactWhitespace(text).slice(0, 500);
    }

    const item: Omit<ConversationItem, "id"> = {
      sessionId: "",
      turnId: itemTurnId,
      timestamp,
      envelopeType,
      payloadType,
      role,
      toolName,
      callId,
      phase,
      nativeId,
      parentId,
      requestId,
      model,
      stopReason,
      usageJson: stringifyMaybe(extractUsage(payload)),
      providerMetadataJson: stringifyMaybe({
        envelope: metadataOnly(envelope as Record<string, unknown>, ["payload", "item", "params"]),
        params: envelope.params ? metadataOnly(envelope.params, ["item"]) : null,
        payload: metadataOnly(payload, ["content", "message", "text", "arguments", "input", "output"])
      }),
      summary,
      text,
      rawJson: undefined,
      lineNo: lineCount,
      sequence: sequence++
    };
    const storedItem = itemCollector.add(item);
    searchText.add([cwd, storedItem.role, storedItem.text, storedItem.summary, storedItem.toolName, storedItem.payloadType]);

    if (payloadType && TOOL_CALL_TYPES.has(payloadType)) {
      const name = toolName || payloadType;
      const tool: Omit<ToolCall, "id" | "cwd" | "archiveState"> = {
        sessionId: "",
        turnId: itemTurnId,
        timestamp,
        toolName: name,
        callId,
        argumentsJson: stringifyMaybe(payload.arguments) || stringifyMaybe(payload.input) || null,
        outputText: null,
        status: "started"
      };
      toolCollector.add(tool);
      if (callId) toolsByCallId.set(callId, tool);
      searchText.add([name, tool.argumentsJson]);
    }

    if (payloadType && TOOL_OUTPUT_TYPES.has(payloadType)) {
      const outputText = toDisplayText(payload.output) || toDisplayText(payload.content) || toDisplayText(payload);
      if (callId && toolsByCallId.has(callId)) {
        const tool = toolsByCallId.get(callId)!;
        tool.outputText = truncateText(outputText);
        tool.status = "completed";
        searchText.add([tool.outputText]);
      } else {
        toolCollector.add({
          sessionId: "",
          turnId: itemTurnId,
          timestamp,
          toolName: payloadType,
          callId,
          argumentsJson: null,
          outputText: truncateText(outputText),
          status: "completed"
        });
      }
    }
  }

  const fallbackId = extractUuid(sourcePath) || path.basename(sourcePath, ".jsonl");
  const id = sessionId || fallbackId;
  const items = itemCollector.values();
  const tools = toolCollector.values();
  for (const item of items) item.sessionId = id;
  for (const tool of tools) tool.sessionId = id;

  return {
    id,
    nativeId: id,
    provider: "codex",
    sourcePath,
    archiveState,
    cwd,
    originator,
    source,
    cliVersion,
    modelProvider,
    startedAt,
    lastEventAt,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount,
    parseStatus: parseErrors.length === 0 ? "ok" : items.length > 0 ? "partial" : "error",
    parseError: parseErrors.slice(0, 10).join("\n") || null,
    firstUserMessage: firstUserMessage || fallbackUserMessage,
    lastAssistantMessage,
    turns: turnCollector.values(),
    items,
    tools,
    searchText: searchText.value(),
    deferredRecords: itemCollector.deferredCount
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function detectRole(envelopeType: string, payload: Record<string, unknown>): string | null {
  const role = stringOrNull(payload.role);
  if (role) return role;
  if (payload.type === "user_message" || payload.type === "userMessage") return "user";
  if (payload.type === "agent_message" || payload.type === "agentMessage") return "assistant";
  return null;
}

function normalizeItemText(envelopeType: string, payload: Record<string, unknown>): string | null {
  if (envelopeType === "event_msg" && payload.type === "user_message") {
    return toDisplayText(payload.message);
  }
  if (envelopeType === "event_msg" && payload.type === "agent_message") {
    return toDisplayText(payload.message);
  }
  if (payload.type === "message") {
    return toDisplayText(payload.content);
  }
  if (payload.type === "agent_message" || payload.type === "agentMessage") {
    return toDisplayText(payload.text) || toDisplayText(payload.message) || toDisplayText(payload.content);
  }
  if (payload.type === "user_message" || payload.type === "userMessage") {
    return toDisplayText(payload.text) || toDisplayText(payload.message) || toDisplayText(payload.content) || toDisplayText(payload.input);
  }
  if (payload.type === "command_execution" || payload.type === "commandExecution") {
    return toDisplayText(payload.command) || toDisplayText(payload.output);
  }
  if (payload.type === "web_search" || payload.type === "webSearch") {
    return toDisplayText(payload.query) || toDisplayText(payload.action);
  }
  if (payload.type === "plan_update" || payload.type === "plan") {
    return toDisplayText(payload.plan) || toDisplayText(payload.update) || normalizeSummary(payload);
  }
  if (TOOL_OUTPUT_TYPES.has(String(payload.type))) {
    return toDisplayText(payload.output) || toDisplayText(payload.content);
  }
  if (payload.type === "reasoning") {
    return normalizeSummary(payload);
  }
  if (payload.message) {
    return toDisplayText(payload.message);
  }
  if (payload.text) {
    return toDisplayText(payload.text);
  }
  return null;
}

function normalizeSummary(payload: Record<string, unknown>): string | null {
  return toDisplayText(payload.summary) || null;
}

function normalizeToolName(payloadType: string | null, payload: Record<string, unknown>): string | null {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  if (payloadType && (TOOL_CALL_TYPES.has(payloadType) || TOOL_OUTPUT_TYPES.has(payloadType))) return payloadType;
  return null;
}

function stringifyMaybe(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractUsage(payload: Record<string, unknown>): unknown {
  const info = isRecord(payload.info) ? payload.info : null;
  return payload.usage || payload.token_usage || payload.tokenUsage ||
    info?.last_token_usage || info?.lastTokenUsage ||
    payload.last_token_usage || payload.lastTokenUsage;
}

function metadataOnly(value: Record<string, unknown>, excluded: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !excluded.includes(key) && entry !== undefined));
}

function getPrimaryPayload(envelope: Envelope): Record<string, unknown> {
  if (envelope.payload) return envelope.payload;
  if (envelope.item) return envelope.item;
  if (isRecord(envelope.params?.item)) return envelope.params.item;
  return envelope.params || {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampFromMilliseconds(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function extractUuid(value: string): string | null {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null;
}

function looksLikeInjectedContext(value: string): boolean {
  const text = value.trimStart();
  return text.startsWith("<environment_context>") || text.startsWith("<codex_internal_context");
}
