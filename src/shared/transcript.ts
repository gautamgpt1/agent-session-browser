import type { ConversationItem } from "./types.js";

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

const PAYLOAD_CATEGORY_ALIASES: Record<string, string> = {
  agent_message: "assistant",
  agentMessage: "assistant",
  command_execution: "commandExecution",
  commandExecution: "commandExecution",
  context_compaction: "contextCompaction",
  contextCompaction: "contextCompaction",
  dynamic_tool_call: "dynamicToolCall",
  dynamicToolCall: "dynamicToolCall",
  entered_review_mode: "enteredReviewMode",
  enteredReviewMode: "enteredReviewMode",
  exited_review_mode: "exitedReviewMode",
  exitedReviewMode: "exitedReviewMode",
  file_change: "fileChange",
  fileChange: "fileChange",
  hook_prompt: "hookPrompt",
  hookPrompt: "hookPrompt",
  image_generation: "imageGeneration",
  imageGeneration: "imageGeneration",
  image_view: "imageView",
  imageView: "imageView",
  mcp_tool_call: "mcpToolCall",
  mcpToolCall: "mcpToolCall",
  plan_update: "plan",
  sub_agent_activity: "subAgentActivity",
  subAgentActivity: "subAgentActivity",
  user_message: "user",
  userMessage: "user",
  web_search: "webSearch",
  webSearch: "webSearch",
  info: "info",
  warning: "warning",
  error: "error"
};

const ENVELOPE_CATEGORY_ALIASES: Record<string, string> = {
  "thread.started": "thread/started",
  "thread.status.changed": "thread/status/changed",
  "thread.archived": "thread/archived",
  "thread.deleted": "thread/deleted",
  "thread.unarchived": "thread/unarchived",
  "thread.closed": "thread/closed",
  "turn.started": "turn/started",
  "turn.completed": "turn/completed",
  "turn.failed": "turn/completed",
  "item.started": "item/started",
  "item.completed": "item/completed",
  "item.agent_message.delta": "item/agentMessage/delta",
  "item.agentMessage.delta": "item/agentMessage/delta",
  "item.plan.delta": "item/plan/delta",
  "turn.plan.updated": "turn/plan/updated",
  "turn.diff.updated": "turn/diff/updated",
  "thread.compacted": "thread/compacted"
};

export function isVisibleTranscriptItem(
  item: ConversationItem,
  selectedTools: readonly string[],
  visibleCategories: readonly string[],
  callToolMap: ReadonlyMap<string, string>,
  knownCategories: readonly string[] = visibleCategories
): boolean {
  const effectiveToolName = getEffectiveToolName(item, callToolMap);
  const isToolItem =
    Boolean(effectiveToolName) ||
    (item.payloadType != null && (TOOL_CALL_TYPES.has(item.payloadType) || TOOL_OUTPUT_TYPES.has(item.payloadType)));
  if (!isToolItem) return visibleCategories.includes(getTranscriptCategory(item, knownCategories));
  if (selectedTools.length === 0) return false;
  return effectiveToolName != null && selectedTools.includes(effectiveToolName);
}

export function getEffectiveToolName(item: ConversationItem, callToolMap: ReadonlyMap<string, string>): string | null {
  if (item.callId && callToolMap.has(item.callId)) return callToolMap.get(item.callId)!;
  if (item.toolName && !TOOL_OUTPUT_TYPES.has(item.toolName)) return item.toolName;
  return null;
}

export function getTranscriptCategory(item: ConversationItem, knownCategories: readonly string[] = []): string {
  if (item.role === "user" && looksLikeInjectedContext(item.text)) return "turn_context";
  if (item.role === "assistant") {
    if (item.phase === "final_answer") return "assistantFinal";
    if (item.phase === "commentary") return "assistantProgress";
    if (item.phase === "incomplete") return "assistantIncomplete";
    return "assistantUnclassified";
  }
  if (item.role === "user" || item.role === "developer") return item.role;
  if (item.envelopeType === "session_meta") return "session_meta";
  if (item.envelopeType === "turn_context") return "turn_context";
  if (item.envelopeType === "compacted") return "compacted";

  const payloadType = item.payloadType || "";
  const mappedPayloadType = PAYLOAD_CATEGORY_ALIASES[payloadType];
  if (mappedPayloadType) return mappedPayloadType;
  const mappedEnvelopeType = ENVELOPE_CATEGORY_ALIASES[item.envelopeType];
  if (mappedEnvelopeType) return mappedEnvelopeType;
  if (knownCategories.includes(item.envelopeType)) return item.envelopeType;
  if (
    payloadType === "reasoning" ||
    payloadType === "token_count" ||
    payloadType === "task_started" ||
    payloadType === "task_complete" ||
    payloadType === "turn_aborted" ||
    payloadType === "thread_rolled_back" ||
    payloadType === "context_compacted" ||
    payloadType === "item_completed" ||
    payloadType === "patch_apply_end" ||
    payloadType === "web_search_end" ||
    payloadType === "image_generation_end" ||
    payloadType === "mcp_tool_call_end"
  ) return payloadType;
  return `providerEvent|${item.envelopeType}|${payloadType || "none"}`;
}

function looksLikeInjectedContext(value: string | null | undefined): boolean {
  const text = (value || "").trimStart();
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<codex_internal_context") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<collaboration_mode>")
  );
}
