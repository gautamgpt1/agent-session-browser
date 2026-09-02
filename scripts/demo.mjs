import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "web" && mode !== "tui") {
  console.error("Usage: node scripts/demo.mjs <web|tui>");
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = path.join(os.tmpdir(), "agent-session-browser-demo", mode);
const sourcesRoot = path.join(demoRoot, "sources");
const dataRoot = path.join(demoRoot, "data");

const featuredSessions = [
  {
    provider: "codex",
    id: "a1000000-0000-4000-8000-000000000001",
    cwd: String.raw`C:\Demo\agent-session-browser`,
    startedAt: "2026-09-01T18:20:00.000Z",
    prompt: "Find where we decided to keep session history local-only",
    progress: "I found the architecture decision and verified how the index is populated.",
    tool: "rg",
    toolInput: { query: "local-only", path: "docs" },
    toolOutput: "docs/architecture.md:12: Session source files remain local and read-only.",
    answer: "The local-only decision lives in `docs/architecture.md`.\n\n- Original session files remain untouched.\n- SQLite stores searchable metadata and normalized text.\n- Full records are read from the source only when requested.\n- Nothing is uploaded and no AI API is required."
  },
  {
    provider: "claude",
    id: "a2000000-0000-4000-8000-000000000002",
    cwd: String.raw`C:\Demo\agent-session-browser`,
    startedAt: "2026-09-01T17:10:00.000Z",
    prompt: "Preserve Claude Code subagent transcripts without losing context",
    progress: "I am tracing parent and subagent records before changing the parser.",
    tool: "Grep",
    toolInput: { pattern: "parentUuid|isSidechain", path: "src/server" },
    toolOutput: "src/server/claude-parser.ts: parent and sidechain metadata are retained",
    answer: "Claude Code subagent transcripts now remain attached to their original session context. Parent IDs, request IDs, model metadata, tool results, and final replies are preserved without rewriting the source JSONL."
  },
  {
    provider: "gemini",
    id: "a3000000-0000-4000-8000-000000000003",
    cwd: String.raw`C:\Demo\agent-session-browser`,
    startedAt: "2026-09-01T16:00:00.000Z",
    prompt: "Add keyboard navigation to the session browser",
    progress: "I am checking the existing focus and selection behavior first.",
    tool: "search_file_content",
    toolInput: { pattern: "keydown", path: "src/client" },
    toolOutput: "Found keyboard handlers in src/client/App.tsx",
    answer: "Keyboard navigation is wired up: arrow keys move through sessions, focus remains visible, and opening a session does not reset the current filters."
  },
  {
    provider: "pi",
    id: "a4000000-0000-4000-8000-000000000004",
    cwd: String.raw`C:\Demo\agent-session-browser`,
    startedAt: "2026-09-01T14:45:00.000Z",
    prompt: "Design a compact TUI layout for narrow terminals",
    progress: "I am measuring the fixed header and shortcut rows before resizing the panes.",
    tool: "read",
    toolInput: { path: "src/tui/layout.ts" },
    toolOutput: "Loaded responsive pane and row calculations.",
    answer: "The TUI now adapts without hiding controls. Wide terminals show both panes, narrow terminals show the focused pane, and the shortcut guide wraps onto additional rows when needed."
  },
  {
    provider: "codex",
    id: "b1000000-0000-4000-8000-000000000005",
    cwd: String.raw`C:\Demo\local-search`,
    startedAt: "2026-08-31T19:30:00.000Z",
    prompt: "Make a 60,000-item transcript scroll smoothly",
    progress: "I reproduced the slowdown and am checking which records remain mounted.",
    tool: "apply_patch",
    toolInput: { patch: "Virtualize transcript pages while retaining every matching record." },
    toolOutput: "Updated transcript paging and sticky header behavior.",
    answer: "Large transcripts now load incrementally while preserving every selected record. Scrolling keeps only the visible page mounted, and search or expansion reads the unchanged source file on demand."
  },
  {
    provider: "claude",
    id: "b2000000-0000-4000-8000-000000000006",
    cwd: String.raw`C:\Demo\local-search`,
    startedAt: "2026-08-31T16:20:00.000Z",
    prompt: "Add conversation and readable export modes",
    progress: "I am comparing the export modes against the browser transcript.",
    tool: "Read",
    toolInput: { file_path: "src/server/session-actions.ts" },
    toolOutput: "Conversation, readable, and trace modes are defined.",
    answer: "Exports now match three practical needs: Conversation keeps user prompts and final replies, Readable adds progress and tool activity, and Trace preserves the complete provider record stream."
  },
  {
    provider: "gemini",
    id: "b3000000-0000-4000-8000-000000000007",
    cwd: String.raw`C:\Demo\local-search`,
    startedAt: "2026-08-30T13:15:00.000Z",
    prompt: "Highlight matched session titles and IDs",
    progress: "I found the shared result-label component and am adding safe highlighting.",
    tool: "replace",
    toolInput: { file_path: "src/client/App.tsx", instruction: "Highlight literal matches." },
    toolOutput: "Updated title and session-ID match rendering.",
    answer: "Search matches are now highlighted in context, making it clear why each session appeared without turning the session finder into a full transcript search."
  },
  {
    provider: "pi",
    id: "b4000000-0000-4000-8000-000000000008",
    cwd: String.raw`C:\Demo\terminal-dashboard`,
    startedAt: "2026-08-29T11:00:00.000Z",
    prompt: "Compare SQLite FTS5 with scanning JSONL for every search",
    progress: "I am comparing query latency while keeping the original files authoritative.",
    tool: "bash",
    toolInput: { command: "npm test -- search" },
    toolOutput: "Search tests passed; indexed lookup remained responsive.",
    answer: "SQLite FTS5 is the better catalog layer: searches remain fast across many sessions, while the original JSONL files stay authoritative for full record display and export."
  },
  {
    provider: "codex",
    id: "b5000000-0000-4000-8000-000000000009",
    cwd: String.raw`C:\Demo\terminal-dashboard`,
    startedAt: "2026-08-28T09:40:00.000Z",
    prompt: "Restore discovery for archived Codex sessions",
    progress: "I am checking both active and archived roots before updating the catalog.",
    tool: "exec",
    toolInput: { command: "list active and archived session roots" },
    toolOutput: "Both session roots were discovered successfully.",
    answer: "Archived Codex sessions are discoverable alongside active sessions and remain clearly labeled, searchable, exportable, and resumable through their native session ID.",
    archived: true
  }
];

const extraSessions = [
  ["pi", "local-search", "Page through matching records without omitting any results", "Every matching record remains reachable through deterministic pages, and changing filters resets paging without losing the selected session."],
  ["claude", "terminal-dashboard", "Sanitize ANSI control sequences in saved transcripts", "Stored terminal control sequences are rendered as harmless text, so opening an old tool result cannot clear or rewrite the TUI."],
  ["gemini", "terminal-dashboard", "Keep pane focus stable while the terminal is resized", "Pane focus now survives resize events and the layout switches cleanly between combined and focused views."],

  ["codex", "release-toolkit", "Package a cross-platform CLI with one short command", "The package exposes `asb` and `agent-session-browser`, includes only runtime files, and works from an unrelated working directory."],
  ["claude", "release-toolkit", "Add a clean-install smoke test for the npm tarball", "The smoke test packs, installs, launches, and verifies the CLI from a temporary directory before a release can pass."],
  ["gemini", "release-toolkit", "Generate release notes from conventional commits", "Release notes now group user-facing changes, fixes, and compatibility updates while omitting internal maintenance noise."],
  ["pi", "release-toolkit", "Verify the packaged web assets before publishing", "The packaged server serves the built client, indexes fixture histories, and reports a useful error when its port is occupied."],

  ["codex", "code-reviewer", "Group review findings by severity and affected file", "Review findings are grouped by blocking risk first, with exact file references and concise remediation guidance."],
  ["claude", "code-reviewer", "Inspect a large diff without losing surrounding context", "The review reads changed hunks alongside their callers, tests, and configuration instead of judging isolated lines."],
  ["gemini", "code-reviewer", "Summarize failing tests and identify the common cause", "The failures share one stale fixture assumption; updating that boundary fixes the suite without weakening assertions."],
  ["pi", "code-reviewer", "Trace an architectural decision across several sessions", "The decision trail links the original requirement, rejected alternative, implementation, and later regression fix."],

  ["codex", "docs-studio", "Build a searchable documentation index", "The documentation index extracts headings and code examples while retaining stable links back to the source pages."],
  ["claude", "docs-studio", "Find broken links across the documentation site", "Internal links are checked against generated routes and anchors; external links are reported separately with timeouts."],
  ["gemini", "docs-studio", "Add full-text search to the API reference", "API reference search now ranks exact symbol matches before descriptive text and highlights the matching fragment."],
  ["pi", "docs-studio", "Export a troubleshooting guide to clean Markdown", "The export preserves headings, lists, tables, and code blocks while removing navigation-only interface text."],

  ["codex", "api-monitor", "Retry transient API failures without duplicating requests", "Retries use bounded exponential backoff and idempotency keys, while permanent client errors fail immediately."],
  ["claude", "api-monitor", "Redact authorization headers from diagnostic logs", "Sensitive request headers and query parameters are removed before structured diagnostics are written."],
  ["gemini", "api-monitor", "Compare endpoint latency across three regions", "The report separates network, server, and serialization time so the regional bottleneck is immediately visible."],
  ["pi", "api-monitor", "Alert only when the rolling error budget is exhausted", "Alerts now use the rolling error budget instead of isolated failures, reducing noise without hiding sustained incidents."],

  ["codex", "image-pipeline", "Generate responsive thumbnails without visible quality loss", "The pipeline creates deterministic AVIF, WebP, and JPEG variants and retains the original color profile."],
  ["claude", "image-pipeline", "Remove private EXIF metadata during export", "Exports strip location, device, author, and comment metadata while preserving orientation and color information."],
  ["gemini", "image-pipeline", "Choose the smallest supported image format at runtime", "The client negotiates AVIF and WebP support, then falls back to optimized JPEG or PNG without layout shifts."],
  ["pi", "image-pipeline", "Bound concurrent image jobs to prevent memory spikes", "Image work now runs through a small queue with per-job limits, cancellation, and predictable memory use."]
].map(([provider, directory, prompt, answer], index) => ({
  provider,
  id: syntheticId(index + 10),
  cwd: `C:\\Demo\\${directory}`,
  startedAt: new Date(Date.parse("2026-08-27T18:00:00.000Z") - index * 7 * 60 * 60 * 1000).toISOString(),
  prompt,
  progress: `I am tracing the current ${directory.replaceAll("-", " ")} behavior and its tests before making the change.`,
  answer,
  archived: index === 5 || index === 17
}));

const extendedConversations = new Map([
  ["a1000000-0000-4000-8000-000000000001", [
    ["Does the index duplicate the original session files?", "No. The index stores searchable metadata and normalized text, while complete records continue to be read from the original JSONL files."],
    ["What happens if someone has hundreds of gigabytes of history?", "Cataloging uses bounded parsing and does not load every transcript into memory. Individual transcript pages are read incrementally when the user opens them."],
    ["Can I hide progress and tool activity when I only want the conversation?", "Yes. Leave only **user** and **assistant final** selected, or export using Conversation mode."],
    ["What happens to provider records the parser does not recognize yet?", "They remain available as provider events instead of being discarded, and their original JSON can still be expanded from the source file."],
    ["How do I continue the session in the original coding agent?", "Use the displayed native resume command. The app also checks that the original working directory still exists before launching it from the TUI."]
  ]],
  ["a2000000-0000-4000-8000-000000000002", [
    ["Do tool results from Claude subagents remain searchable?", "Yes. Tool names, inputs, results, parent IDs, and subagent messages remain attached to the indexed session."],
    ["Can I isolate only Claude Code sessions in the browser?", "Yes. Choose Claude Code in Session filters or cycle to Claude with `Tab` in the TUI."],
    ["How are older Claude history formats handled?", "Known versions are normalized, while unfamiliar records remain visible as provider-specific events rather than silently disappearing."],
    ["Can I export only the human-readable conversation?", "Yes. Conversation export keeps prompts and final replies; Readable export adds progress and tool activity when you need more context."]
  ]],
  ["a3000000-0000-4000-8000-000000000003", [
    ["Does changing the provider filter reset the selected directory?", "No. Provider, directory, archive state, date, and parse-status filters compose without unexpectedly clearing each other."],
    ["Can the session finder search Gemini session IDs?", "Yes. It matches the first prompt and native session ID, then highlights the matching text in the result."],
    ["Where does the displayed Gemini project directory come from?", "The index uses Gemini's project registry and `.project_root` marker when available, with legacy hashed directories handled separately."],
    ["Can I copy the Gemini resume command?", "Yes. The session header exposes the native `gemini --resume` command with a one-click copy action."]
  ]],
  ["a4000000-0000-4000-8000-000000000004", [
    ["What happens when the terminal becomes too narrow for two panes?", "The TUI shows the currently focused pane while preserving the explicit Session, Transcript, and Both view choices."],
    ["Do Pi branches and compaction summaries survive normalization?", "Yes. Branch relationships, session metadata, compactions, reasoning, tools, usage, and final messages remain available."],
    ["Can transcript search use the same input line?", "Yes. Focus the transcript pane and type; the top input changes from session finding to transcript search."],
    ["Will the keyboard guide disappear on a shorter terminal?", "The guide wraps when width is limited and yields body rows only when height is genuinely constrained."]
  ]],
  ["b1000000-0000-4000-8000-000000000005", [
    ["Are records outside the first rendered page omitted?", "No. Every matching record remains addressable; only the currently needed page is mounted in the browser."],
    ["Does changing a content filter search the original source again?", "Yes. The filtered page is produced from the unchanged source session and its complete record stream."],
    ["Can I jump to later transcript pages directly?", "Yes. Page controls use stable offsets and preserve the selected filters while moving through the session."],
    ["Does inline expansion create a duplicate message card?", "No. A shortened preview expands in place and replaces itself with the complete readable record."]
  ]]
]);

const sessions = [...featuredSessions, ...extraSessions].map((session, index) => ({
  ...session,
  tools: demoTools(session, index),
  followUps: extendedConversations.get(session.id) || []
}));

await fs.rm(demoRoot, { recursive: true, force: true });
await Promise.all(sessions.map(writeSession));
await writeGeminiRegistry();

const env = {
  ...process.env,
  NODE_ENV: "development",
  AGENT_SESSION_BROWSER_CODEX_HOME: path.join(sourcesRoot, "codex"),
  AGENT_SESSION_BROWSER_CLAUDE_HOME: path.join(sourcesRoot, "claude"),
  AGENT_SESSION_BROWSER_GEMINI_HOME: path.join(sourcesRoot, "gemini"),
  AGENT_SESSION_BROWSER_PI_HOME: path.join(sourcesRoot, "pi"),
  AGENT_SESSION_BROWSER_DATA_DIR: dataRoot,
  AGENT_SESSION_BROWSER_DISABLE_WATCHER: "1",
  AGENT_SESSION_BROWSER_PORT: process.env.AGENT_SESSION_BROWSER_DEMO_PORT || "4174"
};
const entry = mode === "web" ? "src/server/index.ts" : "src/tui/index.ts";
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", entry], {
  cwd: projectRoot,
  env,
  stdio: "inherit"
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

async function writeSession(session) {
  const records = session.provider === "codex" ? codexRecords(session)
    : session.provider === "claude" ? claudeRecords(session)
      : session.provider === "gemini" ? geminiRecords(session)
        : piRecords(session);
  await writeJsonl(sessionPath(session), records);
  if (session.provider === "gemini") {
    const projectDir = path.dirname(path.dirname(sessionPath(session)));
    await fs.writeFile(path.join(projectDir, ".project_root"), session.cwd, "utf8");
  }
}

function sessionPath(session) {
  const stamp = session.startedAt.slice(0, 10);
  const slug = cwdSlug(session.cwd);
  if (session.provider === "codex") {
    const root = session.archived ? "archived_sessions" : "sessions";
    return path.join(sourcesRoot, "codex", root, ...stamp.split("-"), `rollout-${stamp}T00-00-00-${session.id}.jsonl`);
  }
  if (session.provider === "claude") return path.join(sourcesRoot, "claude", "projects", `C--Demo-${slug}`, `${session.id}.jsonl`);
  if (session.provider === "gemini") return path.join(sourcesRoot, "gemini", "tmp", slug, "chats", `session-${stamp}T00-00-${session.id.slice(0, 8)}.jsonl`);
  return path.join(sourcesRoot, "pi", "agent", "sessions", `--C-Demo-${slug}--`, `${stamp}_${session.id.slice(0, 8)}.jsonl`);
}

function codexRecords(session) {
  const at = timestamps(session.startedAt);
  const turnId = `${session.id}-turn-1`;
  const records = [
    { timestamp: at(0), type: "session_meta", payload: { id: session.id, timestamp: at(0), cwd: session.cwd, originator: "codex-tui", cli_version: "demo", source: "cli", model_provider: "openai" } },
    { timestamp: at(1), type: "turn_context", payload: { turn_id: turnId, cwd: session.cwd, current_date: session.startedAt.slice(0, 10), approval_policy: "never", sandbox_policy: "workspace-write" } },
    { timestamp: at(2), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: session.prompt }] } },
    { timestamp: at(3), type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", model: "gpt-5", content: [{ type: "output_text", text: session.progress }] } },
    { timestamp: at(4), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the relevant implementation, make the smallest change, and verify the result." }] } },
    { timestamp: at(5), type: "event_msg", payload: { type: "plan_update", plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "in_progress" }, { step: "Verify", status: "pending" }] } }
  ];
  session.tools.forEach((tool, index) => {
    const callId = `${session.id}-call-${index + 1}`;
    const callType = tool.kind === "web" ? "web_search_call" : tool.kind === "custom" ? "custom_tool_call" : "function_call";
    const outputType = tool.kind === "web" ? "web_search_output" : tool.kind === "custom" ? "custom_tool_call_output" : "function_call_output";
    records.push({ timestamp: at(6 + index * 2), type: "response_item", payload: { type: callType, name: tool.name, call_id: callId, arguments: JSON.stringify(tool.input), action: tool.input } });
    records.push({ timestamp: at(7 + index * 2), type: "response_item", payload: { type: outputType, call_id: callId, output: tool.output } });
  });
  records.push({ timestamp: at(8 + session.tools.length * 2), type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", model: "gpt-5", content: [{ type: "output_text", text: session.answer }] } });
  session.followUps.forEach(([prompt, answer], index) => {
    const offset = 30 + index * 10;
    const followUpTurnId = `${session.id}-turn-${index + 2}`;
    records.push({ timestamp: at(offset), type: "turn_context", payload: { turn_id: followUpTurnId, cwd: session.cwd, current_date: session.startedAt.slice(0, 10), approval_policy: "never", sandbox_policy: "workspace-write" } });
    records.push({ timestamp: at(offset + 1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });
    records.push({ timestamp: at(offset + 4), type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", model: "gpt-5", content: [{ type: "output_text", text: answer }] } });
  });
  return records;
}

function claudeRecords(session) {
  const at = timestamps(session.startedAt);
  const toolUses = session.tools.map((tool, index) => ({ type: "tool_use", id: `${session.id}-call-${index + 1}`, name: tool.name, input: tool.input }));
  const toolResults = session.tools.map((tool, index) => ({ type: "tool_result", tool_use_id: `${session.id}-call-${index + 1}`, content: tool.output }));
  const records = [
    { type: "user", sessionId: session.id, uuid: `${session.id}-user`, parentUuid: null, timestamp: at(0), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { role: "user", content: [{ type: "text", text: session.prompt }] } },
    { type: "assistant", sessionId: session.id, uuid: `${session.id}-assistant-1`, parentUuid: `${session.id}-user`, requestId: `${session.id}-request-1`, timestamp: at(2), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { id: `${session.id}-message-1`, role: "assistant", model: "claude-sonnet-4-5", stop_reason: "tool_use", content: [{ type: "text", text: session.progress }, { type: "thinking", thinking: "Inspect the relevant code and its tests before making a focused change." }, ...toolUses] } },
    { type: "user", sessionId: session.id, uuid: `${session.id}-result`, parentUuid: `${session.id}-assistant-1`, timestamp: at(4), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { role: "user", content: toolResults } },
    { type: "assistant", sessionId: session.id, uuid: `${session.id}-assistant-2`, parentUuid: `${session.id}-result`, requestId: `${session.id}-request-2`, timestamp: at(8), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { id: `${session.id}-message-2`, role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: session.answer }] } }
  ];
  let parentUuid = `${session.id}-assistant-2`;
  session.followUps.forEach(([prompt, answer], index) => {
    const offset = 30 + index * 10;
    const userUuid = `${session.id}-follow-up-user-${index + 1}`;
    const assistantUuid = `${session.id}-follow-up-assistant-${index + 1}`;
    records.push({ type: "user", sessionId: session.id, uuid: userUuid, parentUuid, timestamp: at(offset), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { role: "user", content: [{ type: "text", text: prompt }] } });
    records.push({ type: "assistant", sessionId: session.id, uuid: assistantUuid, parentUuid: userUuid, requestId: `${session.id}-follow-up-request-${index + 1}`, timestamp: at(offset + 4), cwd: session.cwd, version: "demo", entrypoint: "cli", message: { id: `${session.id}-follow-up-message-${index + 1}`, role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: answer }] } });
    parentUuid = assistantUuid;
  });
  return records;
}

function geminiRecords(session) {
  const at = timestamps(session.startedAt);
  const records = [
    { sessionId: session.id, projectHash: cwdSlug(session.cwd), startTime: at(0), lastUpdated: at(8), summary: session.prompt, kind: "main" },
    { id: `${session.id}-user`, timestamp: at(0), type: "user", content: [{ text: session.prompt }] },
    { id: `${session.id}-assistant-1`, timestamp: at(2), type: "gemini", content: session.progress, thoughts: [{ subject: "Implementation", description: "Inspect the current behavior and keep the change focused." }, { subject: "Verification", description: "Exercise the affected workflow after the change." }], toolCalls: session.tools.map((tool, index) => ({ id: `${session.id}-call-${index + 1}`, name: tool.name, displayName: tool.name, args: tool.input, status: "success", resultDisplay: tool.output })) },
    { id: `${session.id}-assistant-2`, timestamp: at(8), type: "gemini", content: session.answer, thoughts: [], toolCalls: [] }
  ];
  session.followUps.forEach(([prompt, answer], index) => {
    const offset = 30 + index * 10;
    records.push({ id: `${session.id}-follow-up-user-${index + 1}`, timestamp: at(offset), type: "user", content: [{ text: prompt }] });
    records.push({ id: `${session.id}-follow-up-assistant-${index + 1}`, timestamp: at(offset + 4), type: "gemini", content: answer, thoughts: [], toolCalls: [] });
  });
  records[0].lastUpdated = at(session.followUps.length ? 34 + (session.followUps.length - 1) * 10 : 8);
  return records;
}

function piRecords(session) {
  const at = timestamps(session.startedAt);
  const records = [
    { type: "session", version: 3, id: session.id, timestamp: at(0), cwd: session.cwd },
    { type: "session_info", id: `${session.id}-info`, parentId: null, timestamp: at(0), name: session.prompt },
    { type: "message", id: `${session.id}-user`, parentId: `${session.id}-info`, timestamp: at(1), message: { role: "user", content: session.prompt, timestamp: Date.parse(at(1)) } },
    { type: "message", id: `${session.id}-assistant-1`, parentId: `${session.id}-user`, timestamp: at(3), message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "toolUse", content: [{ type: "thinking", thinking: "Inspect the current behavior and keep the implementation focused." }, { type: "text", text: session.progress }, ...session.tools.map((tool, index) => ({ type: "toolCall", id: `${session.id}-call-${index + 1}`, name: tool.name, arguments: tool.input }))] } }
  ];
  session.tools.forEach((tool, index) => {
    records.push({ type: "message", id: `${session.id}-result-${index + 1}`, parentId: `${session.id}-assistant-1`, timestamp: at(4 + index), message: { role: "toolResult", toolCallId: `${session.id}-call-${index + 1}`, toolName: tool.name, content: [{ type: "text", text: tool.output }], isError: false } });
  });
  records.push({ type: "compaction", id: `${session.id}-compaction`, parentId: `${session.id}-assistant-1`, timestamp: at(7), summary: "Inspected the relevant files, applied the focused change, and retained the verification result." });
  records.push({ type: "message", id: `${session.id}-assistant-2`, parentId: `${session.id}-result-${session.tools.length}`, timestamp: at(8), message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "stop", usage: { input: 120, output: 80, totalTokens: 200, cost: { total: 0.002 } }, content: [{ type: "text", text: session.answer }] } });
  let parentId = `${session.id}-assistant-2`;
  session.followUps.forEach(([prompt, answer], index) => {
    const offset = 30 + index * 10;
    const userId = `${session.id}-follow-up-user-${index + 1}`;
    const assistantId = `${session.id}-follow-up-assistant-${index + 1}`;
    records.push({ type: "message", id: userId, parentId, timestamp: at(offset), message: { role: "user", content: prompt, timestamp: Date.parse(at(offset)) } });
    records.push({ type: "message", id: assistantId, parentId: userId, timestamp: at(offset + 4), message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "stop", usage: { input: 80, output: 60, totalTokens: 140, cost: { total: 0.001 } }, content: [{ type: "text", text: answer }] } });
    parentId = assistantId;
  });
  return records;
}

async function writeGeminiRegistry() {
  const projects = Object.fromEntries(sessions.filter((session) => session.provider === "gemini").map((session) => [session.cwd, cwdSlug(session.cwd)]));
  const target = path.join(sourcesRoot, "gemini", "projects.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ projects }, null, 2)}\n`, "utf8");
}

async function writeJsonl(target, records) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function demoTools(session, sessionIndex) {
  const palettes = {
    codex: [
      { name: "read_file", input: { path: "src/server/indexer.ts" }, output: "Read the indexing flow and source boundaries." },
      { name: "exec", input: { command: "npm test" }, output: "All focused tests passed." },
      { name: "web_search", kind: "web", input: { query: "SQLite FTS5 prefix query documentation" }, output: "Found the relevant FTS5 query syntax and tokenizer notes." },
      { name: "apply_patch", kind: "custom", input: { patch: "Apply the focused implementation change." }, output: "Patch applied successfully." },
      { name: "wait", kind: "custom", input: { task: "production smoke test" }, output: "Production smoke test completed successfully." },
      { name: "view_image", input: { path: "tests/fixtures/demo-screen.png" }, output: "Verified the rendered layout at the target viewport." }
    ],
    claude: [
      { name: "Read", input: { file_path: "src/server/parser.ts" }, output: "Read the parser and its data-retention rules." },
      { name: "Grep", input: { pattern: "session|transcript", path: "src" }, output: "Found the relevant session and transcript references." },
      { name: "Edit", input: { file_path: "src/client/App.tsx", change: "Apply the focused UI update." }, output: "Updated the selected implementation block." },
      { name: "Bash", input: { command: "npm test" }, output: "All focused tests passed." },
      { name: "Glob", input: { pattern: "tests/**/*.test.ts" }, output: "Located parser, release, and layout tests." },
      { name: "WebSearch", input: { query: "portable local-first application patterns" }, output: "Collected the relevant primary documentation." }
    ],
    gemini: [
      { name: "read_file", input: { file_path: "src/client/App.tsx" }, output: "Read the current component behavior." },
      { name: "search_file_content", input: { pattern: "filter|highlight", path: "src" }, output: "Found the matching filter and highlight code." },
      { name: "replace", input: { file_path: "src/client/App.tsx", instruction: "Apply the focused update." }, output: "Replacement completed successfully." },
      { name: "run_shell_command", input: { command: "npm test" }, output: "All focused tests passed." },
      { name: "list_directory", input: { path: "tests" }, output: "Listed fixture, integration, and browser tests." },
      { name: "google_web_search", input: { query: "SQLite FTS5 official documentation" }, output: "Found the official FTS5 documentation." }
    ],
    pi: [
      { name: "read", input: { path: "src/tui/layout.ts" }, output: "Read the responsive terminal layout helpers." },
      { name: "grep", input: { query: "visibleView", path: "src/tui" }, output: "Found the focused-pane selection logic." },
      { name: "edit", input: { path: "src/tui/index.ts", change: "Apply the focused terminal update." }, output: "Updated the terminal rendering logic." },
      { name: "bash", input: { command: "npm test" }, output: "All focused tests passed." },
      { name: "find", input: { path: "tests", pattern: "*.test.ts" }, output: "Found the relevant regression tests." },
      { name: "web", input: { query: "ANSI terminal resize behavior" }, output: "Found the relevant terminal behavior references." }
    ]
  };
  const primary = session.tool ? [{ name: session.tool, input: session.toolInput, output: session.toolOutput }] : [];
  const palette = palettes[session.provider];
  const rotated = palette.map((_, index) => palette[(index + sessionIndex) % palette.length]);
  const unique = [...primary, ...rotated].filter((tool, index, tools) => tools.findIndex((candidate) => candidate.name === tool.name) === index);
  return unique.slice(0, sessionIndex === 0 ? 6 : 3);
}

function syntheticId(index) {
  const prefix = `d${index.toString(16).padStart(7, "0")}`;
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function timestamps(start) {
  const base = Date.parse(start);
  return (seconds) => new Date(base + seconds * 1000).toISOString();
}

function cwdSlug(cwd) {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1);
}
