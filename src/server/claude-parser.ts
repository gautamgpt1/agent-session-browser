import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { compactWhitespace, toDisplayText, truncateText } from "./text.js";

type RecordValue = Record<string, unknown>;
type ClaudeMessageOutcome = { stopReasons: Set<string>; hasToolUse: boolean };

export async function parseClaudeJsonlFile(sourcePath: string, archiveState: ArchiveState): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const messageOutcomes = await scanClaudeMessageOutcomes(sourcePath);
  const items: Omit<ConversationItem, "id">[] = [];
  const tools: Omit<ToolCall, "id" | "cwd" | "archiveState">[] = [];
  const toolsByCallId = new Map<string, Omit<ToolCall, "id" | "cwd" | "archiveState">>();
  const turns = new Map<string, ParsedTurn>();
  const searchChunks: string[] = [];
  const parseErrors: string[] = [];
  let lineCount = 0;
  let sequence = 0;
  let nativeId: string | null = null;
  let agentId: string | null = null;
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let originator: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let fallbackAssistantMessage: string | null = null;
  let currentTurnId: string | null = null;
  let turnNumber = 0;

  const addItem = (input: Omit<ConversationItem, "id" | "sessionId" | "sequence">) => {
    items.push({ ...input, sessionId: "", sequence: sequence++ });
    for (const value of [input.role, input.text, input.summary, input.toolName, input.payloadType]) {
      if (value) searchChunks.push(value);
    }
  };

  const stream = fs.createReadStream(sourcePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lineCount += 1;
    if (!line.trim()) continue;
    let record: RecordValue;
    try {
      record = JSON.parse(line) as RecordValue;
    } catch (error) {
      parseErrors.push(`Line ${lineCount}: ${(error as Error).message}`);
      continue;
    }

    nativeId = stringOrNull(record.sessionId) || nativeId;
    agentId = stringOrNull(record.agentId) || agentId;
    cwd = stringOrNull(record.cwd) || cwd;
    cliVersion = stringOrNull(record.version) || cliVersion;
    originator = stringOrNull(record.entrypoint) || originator;
    const timestamp = stringOrNull(record.timestamp);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }

    const recordType = stringOrNull(record.type) || "unknown";
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;
    const messageId = stringOrNull(message?.id);
    const requestId = stringOrNull(record.requestId);
    const stopReason = stringOrNull(message?.stop_reason);
    const outcome = messageOutcomes.get(messageId || requestId || "");
    const assistantPhase = recordType === "assistant" ? classifyClaudeAssistant(outcome, stopReason) : null;
    const nativeFields = {
      nativeId: stringOrNull(record.uuid) || messageId,
      parentId: stringOrNull(record.parentUuid),
      requestId,
      model: stringOrNull(message?.model),
      stopReason,
      usageJson: stringifyMaybe(message?.usage),
      providerMetadataJson: stringifyMaybe({
        record: metadataOnly(record, ["message", "attachment", "snapshot", "toolUseResult"]),
        message: message ? metadataOnly(message, ["content"]) : null,
        messageId
      })
    };
    if (recordType === "user" && !record.isMeta && !containsOnlyToolResults(content)) {
      turnNumber += 1;
      currentTurnId = stringOrNull(record.promptId) || stringOrNull(record.uuid) || `turn-${turnNumber}`;
      turns.set(currentTurnId, {
        turnId: currentTurnId,
        startedAt: timestamp,
        cwd,
        currentDate: timestamp?.slice(0, 10) || null,
        approvalPolicy: null,
        sandboxPolicy: null
      });
    }
    if (!currentTurnId) currentTurnId = `turn-${Math.max(turnNumber, 1)}`;

    const parts = Array.isArray(content) ? content : content == null ? [] : [{ type: "text", text: content }];
    let emitted = false;
    for (const value of parts) {
      if (!isRecord(value)) continue;
      const partType = stringOrNull(value.type) || "message_part";
      if (partType === "text") {
        const text = toDisplayText(value.text);
        const role = recordType === "assistant" ? "assistant" : recordType === "user" && !record.isMeta ? "user" : null;
        const messagePayloadType = recordType === "user" && record.isMeta ? "hookPrompt" : "message";
        if (role === "user" && text && !record.isMeta && !firstUserMessage) firstUserMessage = compactWhitespace(text).slice(0, 500);
        if (role === "assistant" && text) {
          fallbackAssistantMessage = compactWhitespace(text).slice(0, 500);
          if (assistantPhase === "final_answer") lastAssistantMessage = fallbackAssistantMessage;
        }
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType: messagePayloadType, role, toolName: null, callId: null, phase: assistantPhase, summary: null, text, rawJson: line, lineNo: lineCount });
        emitted = true;
      } else if (partType === "thinking") {
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType: "reasoning", role: null, toolName: null, callId: null, phase: null, summary: toDisplayText(value.thinking), text: toDisplayText(value.thinking), rawJson: line, lineNo: lineCount });
        emitted = true;
      } else if (partType === "tool_use") {
        const callId = stringOrNull(value.id);
        const toolName = stringOrNull(value.name) || "tool_use";
        const argumentsJson = stringifyMaybe(value.input);
        const tool = { sessionId: "", turnId: currentTurnId, timestamp, toolName, callId, argumentsJson, outputText: null, status: "started" };
        tools.push(tool);
        if (callId) toolsByCallId.set(callId, tool);
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType: "function_call", role: null, toolName, callId, phase: "started", summary: null, text: argumentsJson, rawJson: line, lineNo: lineCount });
        emitted = true;
      } else if (partType === "tool_result") {
        const callId = stringOrNull(value.tool_use_id);
        const outputText = truncateText(toDisplayText(value.content));
        const existing = callId ? toolsByCallId.get(callId) : undefined;
        if (existing) {
          existing.outputText = outputText;
          existing.status = value.is_error ? "error" : "completed";
        } else {
          tools.push({ sessionId: "", turnId: currentTurnId, timestamp, toolName: "tool_result", callId, argumentsJson: null, outputText, status: value.is_error ? "error" : "completed" });
        }
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType: "function_call_output", role: null, toolName: existing?.toolName || null, callId, phase: value.is_error ? "error" : "completed", summary: null, text: outputText, rawJson: line, lineNo: lineCount });
        emitted = true;
      } else {
        addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType: partType, role: null, toolName: null, callId: null, phase: null, summary: null, text: toDisplayText(value), rawJson: line, lineNo: lineCount });
        emitted = true;
      }
    }

    if (!emitted) {
      const payloadType = stringOrNull(record.subtype) || recordType;
      const text = toDisplayText(record.message) || toDisplayText(record.attachment);
      addItem({ ...nativeFields, turnId: currentTurnId, timestamp, envelopeType: recordType, payloadType, role: null, toolName: null, callId: null, phase: null, summary: null, text, rawJson: line, lineNo: lineCount });
    }
  }

  const fallbackNativeId = extractUuid(sourcePath) || path.basename(sourcePath, ".jsonl");
  nativeId ||= fallbackNativeId;
  const id = `claude:${nativeId}${agentId ? `:${agentId}` : ""}`;
  for (const item of items) item.sessionId = id;
  for (const tool of tools) tool.sessionId = id;

  return {
    id, nativeId, provider: "claude", sourcePath, archiveState, cwd, originator: agentId ? `subagent:${agentId}` : originator,
    source: agentId ? "subagent" : "cli", cliVersion, modelProvider: "anthropic", startedAt, lastEventAt,
    bytes: stat.size, mtimeMs: stat.mtimeMs, lineCount,
    parseStatus: parseErrors.length === 0 ? "ok" : items.length > 0 ? "partial" : "error",
    parseError: parseErrors.slice(0, 10).join("\n") || null,
    firstUserMessage, lastAssistantMessage: lastAssistantMessage || fallbackAssistantMessage, turns: Array.from(turns.values()), items, tools,
    searchText: truncateText(searchChunks.join("\n"), 1_000_000) || ""
  };
}

function isRecord(value: unknown): value is RecordValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function stringifyMaybe(value: unknown): string | null { if (value == null) return null; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function extractUuid(value: string): string | null { return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null; }
function containsOnlyToolResults(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.every((part) => isRecord(part) && part.type === "tool_result"); }

async function scanClaudeMessageOutcomes(sourcePath: string): Promise<Map<string, ClaudeMessageOutcome>> {
  const outcomes = new Map<string, ClaudeMessageOutcome>();
  const stream = fs.createReadStream(sourcePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: RecordValue;
    try { record = JSON.parse(line) as RecordValue; } catch { continue; }
    if (record.type !== "assistant") continue;
    const message = isRecord(record.message) ? record.message : null;
    const key = stringOrNull(message?.id) || stringOrNull(record.requestId);
    if (!key) continue;
    const outcome = outcomes.get(key) || { stopReasons: new Set<string>(), hasToolUse: false };
    const stopReason = stringOrNull(message?.stop_reason);
    if (stopReason) outcome.stopReasons.add(stopReason);
    if (Array.isArray(message?.content) && message.content.some((part) => isRecord(part) && part.type === "tool_use")) outcome.hasToolUse = true;
    outcomes.set(key, outcome);
  }
  return outcomes;
}

function classifyClaudeAssistant(outcome: ClaudeMessageOutcome | undefined, rowStopReason: string | null): string {
  const reasons = outcome?.stopReasons || new Set(rowStopReason ? [rowStopReason] : []);
  if (reasons.has("end_turn")) return "final_answer";
  if (reasons.has("tool_use") || reasons.has("pause_turn") || outcome?.hasToolUse) return "commentary";
  if (["max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"].some((reason) => reasons.has(reason))) return "incomplete";
  return "unclassified";
}

function metadataOnly(value: RecordValue, excluded: string[]): RecordValue {
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => !excluded.includes(key) && entry !== undefined));
}
