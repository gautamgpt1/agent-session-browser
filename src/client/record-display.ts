import type { AgentProvider } from "../shared/types.js";

type JsonRecord = Record<string, unknown>;

export interface ExpandedRecordSection {
  label: string;
  kind: "message" | "reasoning" | "tool" | "event";
  text: string;
}

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call", "web_search_call", "image_generation_call", "tool_search_call"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "web_search_output", "image_generation_output", "tool_search_output"]);

export function expandedRecordSections(provider: AgentProvider, raw: string): ExpandedRecordSection[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [{ label: "Original record", kind: "event", text: raw }];
  }
  if (!isRecord(value)) return [{ label: "Original record", kind: "event", text: displayValue(value) }];
  if (provider === "codex") return codexSections(value);
  if (provider === "claude") return claudeSections(value);
  if (provider === "gemini") return geminiSections(value);
  return piSections(value);
}

function codexSections(envelope: JsonRecord): ExpandedRecordSection[] {
  const params = isRecord(envelope.params) ? envelope.params : {};
  const payload = isRecord(envelope.payload)
    ? envelope.payload
    : isRecord(envelope.item)
      ? envelope.item
      : isRecord(params.item)
        ? params.item
        : params;
  const type = stringValue(payload.type) || stringValue(envelope.type) || stringValue(envelope.method) || "provider event";
  const role = stringValue(payload.role);
  if (type === "message" || type === "user_message" || type === "userMessage" || type === "agent_message" || type === "agentMessage") {
    return section(role === "user" || type.startsWith("user") ? "User message" : "Assistant message", "message", displayFirst(payload, ["content", "message", "text", "input"]));
  }
  if (type === "reasoning") return section("Reasoning", "reasoning", displayFirst(payload, ["summary", "content", "text"]));
  if (TOOL_CALL_TYPES.has(type)) {
    const name = stringValue(payload.name) || humanize(type);
    return section(`Tool call · ${name}`, "tool", displayFirst(payload, ["arguments", "input", "action", "query", "command"]));
  }
  if (TOOL_OUTPUT_TYPES.has(type)) return section("Tool output", "tool", displayFirst(payload, ["output", "content", "result"]));
  return section(humanize(type), "event", displayFirst(payload, ["message", "text", "summary", "content", "output", "command"]));
}

function claudeSections(record: JsonRecord): ExpandedRecordSection[] {
  const message = isRecord(record.message) ? record.message : {};
  const content = Array.isArray(message.content) ? message.content : message.content == null ? [] : [message.content];
  const sections: ExpandedRecordSection[] = [];
  for (const value of content) {
    if (!isRecord(value)) {
      addSection(sections, record.type === "assistant" ? "Assistant message" : "User message", "message", displayValue(value));
      continue;
    }
    const type = stringValue(value.type) || "message";
    if (type === "text") addSection(sections, record.type === "assistant" ? "Assistant message" : "User message", "message", displayValue(value.text));
    else if (type === "thinking") addSection(sections, "Reasoning", "reasoning", displayValue(value.thinking));
    else if (type === "tool_use") addSection(sections, `Tool call · ${stringValue(value.name) || "tool"}`, "tool", displayValue(value.input));
    else if (type === "tool_result") addSection(sections, "Tool output", "tool", displayValue(value.content));
    else addSection(sections, humanize(type), "event", displayValue(value));
  }
  if (!sections.length) addSection(sections, humanize(stringValue(record.type) || "provider event"), "event", displayFirst(record, ["attachment", "message", "summary", "content"]));
  return sections;
}

function geminiSections(message: JsonRecord): ExpandedRecordSection[] {
  if (Array.isArray(message.messages)) {
    const nested = message.messages.flatMap((value) => isRecord(value) ? geminiSections(value) : []);
    if (nested.length) return nested;
  }
  const sections: ExpandedRecordSection[] = [];
  const type = stringValue(message.type) || "provider event";
  const content = displayFirst(message, ["displayContent", "content"]);
  if (content) addSection(sections, type === "user" ? "User message" : type === "gemini" ? "Assistant message" : humanize(type), type === "user" || type === "gemini" ? "message" : "event", content);
  if (Array.isArray(message.thoughts)) {
    for (const thought of message.thoughts) {
      if (!isRecord(thought)) continue;
      addSection(sections, stringValue(thought.subject) || "Reasoning", "reasoning", displayFirst(thought, ["description", "subject"]));
    }
  }
  if (Array.isArray(message.toolCalls)) {
    for (const tool of message.toolCalls) {
      if (!isRecord(tool)) continue;
      const name = stringValue(tool.displayName) || stringValue(tool.name) || "tool";
      addSection(sections, `Tool call · ${name}`, "tool", displayFirst(tool, ["args", "description"]));
      const output = displayFirst(tool, ["resultDisplay", "result"]);
      if (output) addSection(sections, `Tool output · ${name}`, "tool", output);
    }
  }
  if (!sections.length) addSection(sections, humanize(type), "event", displayValue(message));
  return sections;
}

function piSections(entry: JsonRecord): ExpandedRecordSection[] {
  if (entry.type !== "message") return section(humanize(stringValue(entry.type) || "provider event"), "event", displayFirst(entry, ["summary", "content", "name", "label"]));
  const message = isRecord(entry.message) ? entry.message : {};
  const role = stringValue(message.role);
  const sections: ExpandedRecordSection[] = [];
  const content = Array.isArray(message.content) ? message.content : message.content == null ? [] : [message.content];
  for (const value of content) {
    if (!isRecord(value)) {
      addSection(sections, roleLabel(role), role === "assistant" || role === "user" ? "message" : "event", displayValue(value));
      continue;
    }
    const type = stringValue(value.type) || "event";
    if (type === "text") addSection(sections, roleLabel(role), "message", displayValue(value.text));
    else if (type === "thinking") addSection(sections, "Reasoning", "reasoning", displayValue(value.thinking));
    else if (type === "toolCall") addSection(sections, `Tool call · ${stringValue(value.name) || "tool"}`, "tool", displayValue(value.arguments));
    else addSection(sections, humanize(type), "event", displayValue(value));
  }
  if (role === "toolResult") addSection(sections, `Tool output · ${stringValue(message.toolName) || "tool"}`, "tool", displayValue(message.content));
  if (role === "bashExecution") addSection(sections, "Bash execution", "tool", [displayValue(message.command), displayValue(message.output)].filter(Boolean).join("\n\n"));
  if (!sections.length) addSection(sections, roleLabel(role), "event", displayValue(message));
  return sections;
}

function section(label: string, kind: ExpandedRecordSection["kind"], text: string): ExpandedRecordSection[] {
  return [{ label, kind, text: text || "No readable content in this record." }];
}

function addSection(target: ExpandedRecordSection[], label: string, kind: ExpandedRecordSection["kind"], text: string): void {
  if (text) target.push({ label, kind, text });
}

function displayFirst(value: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    if (value[key] != null) {
      const text = displayValue(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function displayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => {
    if (!isRecord(entry)) return displayValue(entry);
    return displayFirst(entry, ["text", "input_text", "output_text", "content", "thinking"]) || displayValue(entry);
  }).filter(Boolean).join("\n");
  if (isRecord(value)) {
    const readable = displayFirst(value, ["text", "message", "output", "content", "summary", "description"]);
    if (readable) return readable;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function roleLabel(role: string | null): string {
  if (role === "user") return "User message";
  if (role === "assistant") return "Assistant message";
  if (role === "toolResult") return "Tool output";
  return humanize(role || "provider event");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("/", " · ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}
