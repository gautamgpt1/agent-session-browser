import fs from "node:fs";
import path from "node:path";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import { BoundedItemCollector, type BoundedParseOptions, HeadTailBuffer, SearchTextCollector } from "./bounded-parse.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { iterateSourceLines } from "./source-lines.js";
import { compactWhitespace, toDisplayText } from "./text.js";

type JsonObject = Record<string, any>;
type ParsedTool = Omit<ToolCall, "id" | "cwd" | "archiveState">;

const TOOL_RESULT_TYPES = new Set([
  "RUN_COMMAND",
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GREP_SEARCH",
  "SEARCH_WEB",
  "READ_URL_CONTENT",
  "CODE_ACTION",
  "ASK_QUESTION",
  "INVOKE_SUBAGENT",
  "IMAGE_GENERATION"
]);

const TOOL_RESULT_ALIASES: Record<string, string[]> = {
  list_dir: ["LIST_DIRECTORY"],
  write_to_file: ["CODE_ACTION"],
  replace_file_content: ["CODE_ACTION"],
  multi_replace_file_content: ["CODE_ACTION"]
};

export function extractAntigravityConversationId(filePath: string): string {
  const parts = path.resolve(filePath).split(path.sep);
  const brainIndex = parts.lastIndexOf("brain");
  if (brainIndex !== -1 && parts[brainIndex + 1]) {
    return parts[brainIndex + 1];
  }
  const uuidMatch = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  const parentDir = path.basename(path.dirname(filePath));
  return parentDir === "logs" ? path.basename(path.resolve(filePath, "../../..")) : parentDir;
}

export function identifyAntigravitySource(sourcePath: string): "cli" | "ide" | null {
  const normalized = path.resolve(sourcePath).toLowerCase();
  if (normalized.includes(`${path.sep}antigravity-cli${path.sep}`)) return "cli";
  if (normalized.includes(`${path.sep}antigravity${path.sep}`)) return "ide";
  return null;
}

export function cleanAntigravityArgString(val: unknown): string | null {
  if (typeof val !== "string") return null;
  let str = val.trim();
  if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
    str = str.slice(1, -1).replace(/\\"/g, '"');
  }
  return str.trim() || null;
}

export function extractUserPrompt(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (match) return match[1].trim();
  return content.trim();
}

export async function parseAntigravitySessionFile(
  sourcePath: string,
  archiveState: ArchiveState,
  knownCwd: string | null = null,
  options: BoundedParseOptions = {}
): Promise<ParsedSession> {
  const stat = await fs.promises.stat(sourcePath);
  const collectionLimit = options.retainItems === false ? 0 : undefined;
  const itemCollector = new BoundedItemCollector(options);
  const toolCollector = new HeadTailBuffer<ParsedTool>(collectionLimit);
  const searchText = new SearchTextCollector();
  const errors: string[] = [];

  let lineCount = 0;
  let sequence = 0;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let detectedCwd: string | null = knownCwd;
  const pendingTools: ParsedTool[] = [];

  const addItem = (entry: JsonObject, values: Partial<Omit<ConversationItem, "id" | "sessionId" | "lineNo" | "sequence">>) => {
    const item: Omit<ConversationItem, "id"> = {
      sessionId: "",
      turnId: "main",
      timestamp: stringOrNull(entry.created_at || entry.timestamp),
      envelopeType: String(entry.type || "unknown"),
      payloadType: values.payloadType || String(entry.type || "unknown"),
      role: values.role || null,
      toolName: values.toolName || null,
      callId: values.callId || null,
      phase: values.phase || null,
      nativeId: values.nativeId || null,
      parentId: values.parentId || null,
      requestId: values.requestId || null,
      model: values.model || null,
      stopReason: values.stopReason || null,
      usageJson: values.usageJson || null,
      providerMetadataJson: values.providerMetadataJson || null,
      summary: values.summary || null,
      text: values.text || null,
      rawJson: undefined,
      lineNo: lineCount,
      sequence: sequence++,
      contentPreview: values.contentPreview || false
    };
    itemCollector.add(item);
    searchText.add([item.role, item.payloadType, item.toolName, item.summary, item.text]);
  };

  for await (const sourceLine of iterateSourceLines(sourcePath)) {
    const { line, lineNo } = sourceLine;
    lineCount = lineNo;
    if (!line.trim()) continue;
    let entry: JsonObject;
    try {
      entry = JSON.parse(line) as JsonObject;
    } catch (error) {
      const message = `Line ${lineCount}: ${(error as Error).message}`;
      if (errors.length < 10) errors.push(message);
      addItem({ type: "parse_error" }, { payloadType: "error", summary: message });
      continue;
    }

    const timestamp = stringOrNull(entry.created_at || entry.timestamp);
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
    }

    const type = String(entry.type || "");
    if (Array.isArray(entry.truncated_fields) && entry.truncated_fields.length > 0) {
      addItem(entry, {
        role: "system",
        payloadType: "warning",
        summary: "Provider-shortened record",
        text: `Antigravity shortened these fields in its local transcript: ${entry.truncated_fields.map(String).join(", ")}`
      });
    }

    if (type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      const rawContent = typeof entry.content === "string" ? entry.content : "";
      const text = extractUserPrompt(rawContent);
      if (text && !firstUserMessage) {
        firstUserMessage = compactWhitespace(text).slice(0, 500);
      }
      if (!detectedCwd && rawContent) {
        const workspaceMatch = rawContent.match(/(?:file:\/\/|['"]\/|[\s])(\/(?:Users|home|workspace|projects)[^\s'")\n]+)/i);
        if (workspaceMatch) {
          const matched = workspaceMatch[1].replace(/->.*$/, "").trim();
          if (matched && !matched.includes("<")) detectedCwd = matched;
        }
      }
      addItem(entry, {
        role: "user",
        payloadType: "message",
        text
      });
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      // 1. Thinking / reasoning block
      if (entry.thinking) {
        addItem(entry, {
          role: null,
          payloadType: "reasoning",
          text: String(entry.thinking)
        });
      }

      // 2. Tool calls
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      if (toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          if (!call || typeof call !== "object") continue;
          const toolName = stringOrNull(call.name) || "tool";
          const callId = `step-${entry.step_index ?? lineCount}-${i}`;
          const args = call.args;

          if (!detectedCwd && args && typeof args === "object") {
            const cwdCandidate = cleanAntigravityArgString(args.Cwd) || cleanAntigravityArgString(args.cwd);
            if (cwdCandidate) {
              detectedCwd = cwdCandidate;
            } else {
              const absCandidate = cleanAntigravityArgString(args.AbsolutePath) || cleanAntigravityArgString(args.TargetFile);
              if (absCandidate) detectedCwd = path.dirname(absCandidate);
            }
          }

          const summary = stringOrNull(cleanAntigravityArgString(args?.toolAction)) ||
            stringOrNull(cleanAntigravityArgString(args?.toolSummary)) ||
            toolName;

          const toolText = typeof args === "object" ? JSON.stringify(args, null, 2) : String(args || "");

          addItem(entry, {
            role: "tool",
            payloadType: "toolCall",
            toolName,
            callId,
            text: toolText,
            summary
          });

          const toolRecord: ParsedTool = {
            sessionId: "",
            turnId: "main",
            timestamp,
            toolName,
            callId,
            argumentsJson: stringifyMaybe(args),
            outputText: null,
            status: "started"
          };
          toolCollector.add(toolRecord);
          pendingTools.push(toolRecord);
        }
      }

      // 3. Assistant text content
      if (entry.content) {
        const text = String(entry.content);
        const completedFinal = entry.source === "MODEL" && entry.status === "DONE" && toolCalls.length === 0;
        if (completedFinal) lastAssistantMessage = compactWhitespace(text).slice(0, 500);
        addItem(entry, {
          role: "assistant",
          payloadType: "message",
          text,
          phase: completedFinal ? "final_answer" : entry.status === "RUNNING" ? "incomplete" : "commentary"
        });
      }
      continue;
    }

    if (TOOL_RESULT_TYPES.has(type) || (type === "GENERIC" && pendingTools.length > 0)) {
      const outputText = typeof entry.content === "string" ? entry.content : toDisplayText(entry.content);
      const pendingTool = takePendingTool(pendingTools, type);
      const failed = entry.status === "ERROR";
      addItem(entry, {
        role: "tool",
        payloadType: "toolResult",
        toolName: pendingTool?.toolName || null,
        callId: pendingTool?.callId || null,
        text: outputText,
        summary: pendingTool ? `${pendingTool.toolName} output` : "Tool output"
      });
      if (pendingTool) {
        pendingTool.outputText = outputText;
        pendingTool.status = failed ? "error" : "completed";
      }
      continue;
    }

    if (type === "ERROR_MESSAGE") {
      const errorText = typeof entry.content === "string" ? entry.content : toDisplayText(entry.content);
      addItem(entry, {
        role: "system",
        payloadType: "error",
        toolName: pendingTools[0]?.toolName || null,
        callId: pendingTools[0]?.callId || null,
        text: errorText,
        summary: "Error"
      });
      const failedTool = pendingTools.shift();
      if (failedTool) {
        failedTool.outputText = errorText;
        failedTool.status = "error";
      }
      continue;
    }

    if (type === "SYSTEM_MESSAGE") {
      const sysText = typeof entry.content === "string" ? entry.content : toDisplayText(entry.content);
      addItem(entry, {
        role: "system",
        payloadType: "system_message",
        text: sysText,
        summary: sysText ? compactWhitespace(sysText).slice(0, 100) : "System message"
      });
      continue;
    }

    if (type === "CHECKPOINT") {
      addItem(entry, {
        role: null,
        payloadType: "checkpoint",
        summary: "Checkpoint saved"
      });
      continue;
    }

    // Default fallback
    addItem(entry, {
      payloadType: type || "event",
      summary: stringOrNull(entry.status) || type || "Antigravity event",
      text: typeof entry.content === "string" ? entry.content : toDisplayText(entry.content)
    });
  }

  const nativeId = extractAntigravityConversationId(sourcePath);
  const cwd = detectedCwd || null;
  const turn: ParsedTurn = { turnId: "main", startedAt, cwd, currentDate: null, approvalPolicy: null, sandboxPolicy: null };
  const id = `antigravity:${nativeId}`;
  const items = itemCollector.values();
  const tools = toolCollector.values();
  for (const item of items) item.sessionId = id;
  for (const tool of tools) tool.sessionId = id;

  return {
    id,
    nativeId,
    provider: "antigravity",
    sourcePath,
    archiveState,
    cwd,
    originator: "antigravity",
    source: identifyAntigravitySource(sourcePath),
    cliVersion: null,
    modelProvider: "google",
    startedAt,
    lastEventAt,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount,
    parseStatus: errors.length ? "partial" : "ok",
    parseError: errors.length ? errors.join("\n") : null,
    firstUserMessage,
    lastAssistantMessage,
    turns: [turn],
    items,
    tools,
    searchText: [cwd, firstUserMessage, searchText.value()].filter(Boolean).join("\n"),
    deferredRecords: itemCollector.deferredCount
  };
}

function takePendingTool(pendingTools: ParsedTool[], resultType: string): ParsedTool | null {
  if (!pendingTools.length) return null;
  const matchingIndex = pendingTools.findIndex((tool) => toolResultTypes(tool.toolName).includes(resultType));
  return pendingTools.splice(matchingIndex >= 0 ? matchingIndex : 0, 1)[0] || null;
}

function toolResultTypes(toolName: string): string[] {
  const normalized = toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return [normalized.toUpperCase(), ...(TOOL_RESULT_ALIASES[normalized] || [])];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function stringifyMaybe(value: unknown): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return String(value); }
}
