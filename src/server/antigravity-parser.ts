import fs from "node:fs";
import path from "node:path";
import type { ArchiveState, ConversationItem, ToolCall } from "../shared/types.js";
import { BoundedItemCollector, BoundedMap, type BoundedParseOptions, HeadTailBuffer, SearchTextCollector } from "./bounded-parse.js";
import type { ParsedSession, ParsedTurn } from "./parser.js";
import { iterateSourceLines } from "./source-lines.js";
import { compactWhitespace, toDisplayText } from "./text.js";

type JsonObject = Record<string, any>;

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
  const toolCollector = new HeadTailBuffer<Omit<ToolCall, "id" | "cwd" | "archiveState">>(collectionLimit);
  const toolsByCallId = new BoundedMap<string, Omit<ToolCall, "id" | "cwd" | "archiveState">>(options.retainItems === false ? 10_000 : undefined);
  const searchText = new SearchTextCollector();
  const errors: string[] = [];

  let lineCount = 0;
  let sequence = 0;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  let firstUserMessage: string | null = null;
  let lastAssistantMessage: string | null = null;
  let detectedCwd: string | null = knownCwd;
  let lastStartedTool: Omit<ToolCall, "id" | "cwd" | "archiveState"> | null = null;

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
      sequence: sequence++
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

    if (type === "USER_INPUT" || entry.source === "USER_EXPLICIT") {
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
      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        for (let i = 0; i < entry.tool_calls.length; i++) {
          const call = entry.tool_calls[i];
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

          const toolRecord: Omit<ToolCall, "id" | "cwd" | "archiveState"> = {
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
          toolsByCallId.set(callId, toolRecord);
          lastStartedTool = toolRecord;
        }
      }

      // 3. Assistant text content
      if (entry.content) {
        const text = String(entry.content);
        lastAssistantMessage = compactWhitespace(text).slice(0, 500);
        addItem(entry, {
          role: "assistant",
          payloadType: "message",
          text,
          phase: "final_answer"
        });
      }
      continue;
    }

    if (type === "GENERIC") {
      const outputText = typeof entry.content === "string" ? entry.content : toDisplayText(entry.content);
      addItem(entry, {
        role: "tool",
        payloadType: "toolResult",
        text: outputText,
        summary: "Tool output"
      });
      if (lastStartedTool) {
        lastStartedTool.outputText = outputText;
        lastStartedTool.status = "completed";
        lastStartedTool = null;
      }
      continue;
    }

    if (type === "ERROR_MESSAGE") {
      const errorText = typeof entry.content === "string" ? entry.content : toDisplayText(entry.content);
      addItem(entry, {
        role: "system",
        payloadType: "error",
        text: errorText,
        summary: "Error"
      });
      if (lastStartedTool) {
        lastStartedTool.outputText = errorText;
        lastStartedTool.status = "error";
        lastStartedTool = null;
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
    source: "cli",
    cliVersion: "antigravity",
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function stringifyMaybe(value: unknown): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return String(value); }
}
