import fs from "node:fs";
import path from "node:path";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { compactWhitespace, toDisplayText, truncateText } from "./text.js";

type RecordValue = Record<string, unknown>;

export async function parseGeminiSessionFile(sourcePath: string, archiveState: ArchiveState, cwd: string | null): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const content = await fs.promises.readFile(sourcePath, "utf8");
  const { metadata, messages, lineCount, errors } = decodeGeminiFile(content);
  const items: Omit<ConversationItem, "id">[] = [];
  const tools: Omit<ToolCall, "id" | "cwd" | "archiveState">[] = [];
  const turns: ParsedTurn[] = [];
  const searchChunks: string[] = [];
  let sequence = 0;
  let turnNumber = 0;
  let currentTurnId = "turn-1";
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let startedAt = stringOrNull(metadata.startTime);
  let lastEventAt = stringOrNull(metadata.lastUpdated);

  const nativeId = stringOrNull(metadata.sessionId) || extractUuid(sourcePath) || path.basename(sourcePath).replace(/\.jsonl?$/i, "");
  const id = `gemini:${nativeId}`;
  const addItem = (input: Omit<ConversationItem, "id" | "sessionId" | "sequence">) => {
    items.push({ ...input, sessionId: id, sequence: sequence++ });
    for (const value of [input.role, input.text, input.summary, input.toolName, input.payloadType]) if (value) searchChunks.push(value);
  };

  addItem({ nativeId, providerMetadataJson: stringifyMaybe(metadata), turnId: null, timestamp: startedAt, envelopeType: "session_meta", payloadType: "session_meta", role: null, toolName: null, callId: null, phase: null, summary: stringOrNull(metadata.summary), text: null, rawJson: JSON.stringify(metadata), lineNo: 1 });

  messages.forEach((message, index) => {
    const messageType = stringOrNull(message.type) || "unknown";
    const timestamp = stringOrNull(message.timestamp);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }
    if (messageType === "user") {
      turnNumber += 1;
      currentTurnId = stringOrNull(message.id) || `turn-${turnNumber}`;
      turns.push({ turnId: currentTurnId, startedAt: timestamp, cwd, currentDate: timestamp?.slice(0, 10) || null, approvalPolicy: null, sandboxPolicy: null });
    }
    const text = toDisplayText(message.displayContent) || toDisplayText(message.content);
    const role = messageType === "user" ? "user" : messageType === "gemini" ? "assistant" : null;
    const assistantPhase = role === "assistant" ? classifyAssistantPhase(message) : null;
    const nativeFields = {
      nativeId: stringOrNull(message.id),
      parentId: stringOrNull(message.parentId),
      requestId: stringOrNull(message.requestId),
      model: stringOrNull(message.model),
      stopReason: stringOrNull(message.stopReason) || stringOrNull(message.finishReason),
      usageJson: stringifyMaybe(message.usageMetadata || message.usage),
      providerMetadataJson: stringifyMaybe(metadataOnly(message, ["content", "displayContent", "thoughts", "toolCalls"]))
    };
    if (role === "user" && text && !looksInjected(text) && !firstUserMessage) firstUserMessage = compactWhitespace(text).slice(0, 500);
    if (role === "assistant" && text) lastAssistantMessage = compactWhitespace(text).slice(0, 500);
    if (text) {
      addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: messageType === "gemini" ? "message" : messageType, role, toolName: null, callId: null, phase: assistantPhase, summary: null, text, rawJson: JSON.stringify(message), lineNo: index + 2 });
    }

    if (Array.isArray(message.thoughts)) {
      for (const thought of message.thoughts) {
        if (!isRecord(thought)) continue;
        const thoughtText = [toDisplayText(thought.subject), toDisplayText(thought.description)].filter(Boolean).join("\n");
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "reasoning", role: null, toolName: null, callId: null, phase: null, summary: toDisplayText(thought.subject), text: thoughtText || null, rawJson: JSON.stringify(message), lineNo: index + 2 });
      }
    }

    if (Array.isArray(message.toolCalls)) {
      for (const value of message.toolCalls) {
        if (!isRecord(value)) continue;
        const callId = stringOrNull(value.id);
        const toolName = stringOrNull(value.displayName) || stringOrNull(value.name) || "tool_call";
        const argumentsJson = stringifyMaybe(value.args);
        const outputText = truncateText(toDisplayText(value.resultDisplay) || toDisplayText(value.result));
        const status = stringOrNull(value.status) || (outputText ? "completed" : "started");
        tools.push({ sessionId: id, turnId: currentTurnId, timestamp, toolName, callId, argumentsJson, outputText, status });
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "function_call", role: null, toolName, callId, phase: "started", summary: stringOrNull(value.description), text: argumentsJson, rawJson: JSON.stringify(message), lineNo: index + 2 });
        if (outputText) {
          addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: "message", payloadType: "function_call_output", role: null, toolName, callId, phase: status, summary: null, text: outputText, rawJson: JSON.stringify(message), lineNo: index + 2 });
        }
      }
    }
  });

  if (turns.length === 0) turns.push({ turnId: "turn-1", startedAt, cwd, currentDate: startedAt?.slice(0, 10) || null, approvalPolicy: null, sandboxPolicy: null });
  return {
    id, nativeId, provider: "gemini", sourcePath, archiveState, cwd, originator: "gemini-cli", source: "cli",
    cliVersion: null, modelProvider: "google", startedAt, lastEventAt, bytes: stat.size, mtimeMs: stat.mtimeMs,
    lineCount, parseStatus: errors.length === 0 ? "ok" : items.length > 1 ? "partial" : "error",
    parseError: errors.slice(0, 10).join("\n") || null, firstUserMessage, lastAssistantMessage,
    turns, items, tools, searchText: truncateText([cwd, metadata.summary, ...searchChunks].filter(Boolean).join("\n"), 1_000_000) || ""
  };
}

function decodeGeminiFile(content: string): { metadata: RecordValue; messages: RecordValue[]; lineCount: number; errors: string[] } {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const errors: string[] = [];
  try {
    const whole = JSON.parse(content) as unknown;
    if (isRecord(whole)) return { metadata: whole, messages: Array.isArray(whole.messages) ? whole.messages.filter(isRecord) : [], lineCount: lines.length, errors };
    if (Array.isArray(whole)) return { metadata: {}, messages: whole.filter(isRecord), lineCount: lines.length, errors };
  } catch {
    // Current Gemini sessions are JSONL, so fall through to line parsing.
  }
  const records: RecordValue[] = [];
  lines.forEach((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) records.push(value);
    } catch (error) {
      errors.push(`Line ${index + 1}: ${(error as Error).message}`);
    }
  });
  const metadata = records.shift() || {};
  const inlineMessages = Array.isArray(metadata.messages) ? metadata.messages.filter(isRecord) : [];
  return { metadata, messages: [...inlineMessages, ...records], lineCount: lines.length, errors };
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
