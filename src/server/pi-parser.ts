import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { compactWhitespace, toDisplayText } from "./text.js";

type JsonObject = Record<string, any>;

export async function parsePiSessionFile(sourcePath: string, archiveState: ArchiveState): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const items: Omit<ConversationItem, "id">[] = [];
  const tools: Omit<ToolCall, "id" | "cwd" | "archiveState">[] = [];
  const toolsByCallId = new Map<string, Omit<ToolCall, "id" | "cwd" | "archiveState">>();
  const searchChunks: string[] = [];
  const errors: string[] = [];
  let header: JsonObject | null = null;
  let lineCount = 0;
  let sequence = 0;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let modelProvider: string | null = null;
  let sessionName: string | null = null;

  const addItem = (entry: JsonObject, values: Partial<Omit<ConversationItem, "id" | "sessionId" | "lineNo" | "sequence">>) => {
    const item: Omit<ConversationItem, "id"> = {
      sessionId: "",
      turnId: "main",
      timestamp: stringOrNull(entry.timestamp),
      envelopeType: String(entry.type || "unknown"),
      payloadType: values.payloadType || String(entry.type || "unknown"),
      role: values.role || null,
      toolName: values.toolName || null,
      callId: values.callId || null,
      phase: values.phase || null,
      nativeId: values.nativeId || stringOrNull(entry.id),
      parentId: values.parentId || stringOrNull(entry.parentId),
      requestId: values.requestId || null,
      model: values.model || null,
      stopReason: values.stopReason || null,
      usageJson: values.usageJson || null,
      providerMetadataJson: values.providerMetadataJson || metadataJson(entry),
      summary: values.summary || null,
      text: values.text || null,
      rawJson: JSON.stringify(entry),
      lineNo: lineCount,
      sequence: sequence++
    };
    items.push(item);
    for (const value of [item.role, item.payloadType, item.toolName, item.summary, item.text]) if (value) searchChunks.push(value);
  };

  const rl = readline.createInterface({ input: fs.createReadStream(sourcePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    lineCount += 1;
    if (!line.trim()) continue;
    let entry: JsonObject;
    try {
      entry = JSON.parse(line) as JsonObject;
    } catch (error) {
      errors.push(`Line ${lineCount}: ${(error as Error).message}`);
      continue;
    }
    const timestamp = stringOrNull(entry.timestamp);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }
    if (entry.type === "session") {
      header = entry;
      addItem(entry, { payloadType: "session_meta", summary: `Pi session format v${entry.version ?? 1}` });
      continue;
    }
    if (entry.type === "session_info") {
      sessionName = stringOrNull(entry.name) || sessionName;
      addItem(entry, { summary: sessionName || "Session metadata updated" });
      continue;
    }
    if (entry.type !== "message") {
      addItem(entry, {
        summary: stringOrNull(entry.summary) || stringOrNull(entry.name) || stringOrNull(entry.label),
        text: stringOrNull(entry.content),
        usageJson: stringifyMaybe(entry.usage)
      });
      continue;
    }

    const message = entry.message && typeof entry.message === "object" ? entry.message as JsonObject : {};
    const role = stringOrNull(message.role);
    const timestampMs = Number(message.timestamp);
    if (!entry.timestamp && Number.isFinite(timestampMs)) entry.timestamp = new Date(timestampMs).toISOString();
    const text = contentText(message.content);
    if (role === "user") {
      if (text && !firstUserMessage) firstUserMessage = compactWhitespace(text).slice(0, 500);
      addItem(entry, { role: "user", payloadType: "message", text });
      continue;
    }
    if (role === "assistant") {
      const stopReason = stringOrNull(message.stopReason);
      const phase = stopReason === "stop" ? "final_answer" : stopReason === "error" || stopReason === "aborted" || stopReason === "length" ? "incomplete" : "commentary";
      modelProvider = stringOrNull(message.provider) || modelProvider;
      if (text) {
        lastAssistantMessage = compactWhitespace(text).slice(0, 500);
        addItem(entry, {
          role: "assistant",
          payloadType: "message",
          text,
          phase,
          model: stringOrNull(message.model),
          stopReason,
          usageJson: stringifyMaybe(message.usage),
          providerMetadataJson: metadataJson({ api: message.api, provider: message.provider, errorMessage: message.errorMessage })
        });
      }
      for (const block of contentBlocks(message.content, "thinking")) {
        addItem(entry, { role: "assistant", payloadType: "reasoning", text: stringOrNull(block.thinking), model: stringOrNull(message.model) });
      }
      for (const block of contentBlocks(message.content, "toolCall")) {
        const callId = stringOrNull(block.id);
        const toolName = stringOrNull(block.name) || "tool";
        addItem(entry, { payloadType: "toolCall", toolName, callId, text: toDisplayText(block.arguments) });
        const tool = {
          sessionId: "",
          turnId: "main",
          timestamp: stringOrNull(entry.timestamp),
          toolName,
          callId,
          argumentsJson: stringifyMaybe(block.arguments),
          outputText: null,
          status: "started"
        };
        tools.push(tool);
        if (callId) toolsByCallId.set(callId, tool);
      }
      continue;
    }
    if (role === "toolResult") {
      const callId = stringOrNull(message.toolCallId);
      const toolName = stringOrNull(message.toolName) || toolsByCallId.get(callId || "")?.toolName || "tool";
      const output = contentText(message.content);
      addItem(entry, { payloadType: "toolResult", toolName, callId, text: output });
      const existing = callId ? toolsByCallId.get(callId) : null;
      if (existing) {
        existing.outputText = output;
        existing.status = message.isError ? "error" : "completed";
      } else {
        tools.push({ sessionId: "", turnId: "main", timestamp: stringOrNull(entry.timestamp), toolName, callId, argumentsJson: null, outputText: output, status: message.isError ? "error" : "completed" });
      }
      continue;
    }
    if (role === "bashExecution") {
      const output = stringOrNull(message.output);
      addItem(entry, { payloadType: "bashExecution", toolName: "bash", text: [message.command, output].filter(Boolean).join("\n\n") });
      tools.push({ sessionId: "", turnId: "main", timestamp: stringOrNull(entry.timestamp), toolName: "bash", callId: stringOrNull(entry.id), argumentsJson: stringifyMaybe({ command: message.command }), outputText: output, status: message.cancelled ? "cancelled" : Number(message.exitCode) === 0 ? "completed" : "error" });
      continue;
    }
    addItem(entry, { role, payloadType: role || "message", text, summary: stringOrNull(message.summary) });
  }

  const nativeId = stringOrNull(header?.id) || path.basename(sourcePath, ".jsonl");
  const cwd = stringOrNull(header?.cwd);
  const turn: ParsedTurn = { turnId: "main", startedAt, cwd, currentDate: null, approvalPolicy: null, sandboxPolicy: null };
  return {
    id: `pi:${nativeId}`,
    nativeId,
    provider: "pi",
    sourcePath,
    archiveState,
    cwd,
    originator: "pi-tui",
    source: stringOrNull(header?.parentSession) ? "fork" : "cli",
    cliVersion: header?.version ? `session-v${header.version}` : null,
    modelProvider,
    startedAt,
    lastEventAt,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount,
    parseStatus: errors.length ? "partial" : "ok",
    parseError: errors.length ? errors.join("\n") : null,
    firstUserMessage: firstUserMessage || sessionName,
    lastAssistantMessage,
    turns: [turn],
    items,
    tools,
    searchText: [cwd, sessionName, ...searchChunks].filter(Boolean).join("\n")
  };
}

function contentBlocks(content: unknown, type: string): JsonObject[] {
  return Array.isArray(content) ? content.filter((value): value is JsonObject => Boolean(value && typeof value === "object" && (value as JsonObject).type === type)) : [];
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const chunks = content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as JsonObject;
    if (value.type === "text") return [String(value.text || "")];
    if (value.type === "image") return [`[image: ${String(value.mimeType || "unknown")}]`];
    return [];
  }).filter(Boolean);
  return chunks.length ? chunks.join("\n") : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function stringifyMaybe(value: unknown): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function metadataJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const object = { ...(value as JsonObject) };
  for (const key of ["message", "content", "summary", "retainedTail", "data"]) delete object[key];
  return Object.keys(object).length ? stringifyMaybe(object) : null;
}
