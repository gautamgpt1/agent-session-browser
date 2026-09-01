import fs from "node:fs";
import type { AgentProvider, ConversationItem, ExportMode, SessionDetailResponse, SessionSummary } from "../shared/types.js";

export function resumeCommand(provider: AgentProvider, nativeId: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(nativeId)) {
    throw new Error("Resume command unavailable for an unsafe session identifier");
  }
  const invocation = resumeInvocation(provider, nativeId);
  return [invocation.command, ...invocation.args.map(quoteArg)].join(" ");
}

export function resumeInvocation(provider: AgentProvider, nativeId: string): { command: string; args: string[] } {
  if (provider === "claude") return { command: "claude", args: ["--resume", nativeId] };
  if (provider === "gemini") return { command: "gemini", args: ["--resume", nativeId] };
  if (provider === "pi") return { command: "pi", args: ["--session", nativeId] };
  return { command: "codex", args: ["resume", nativeId] };
}

export function resolveResumeDirectory(recordedCwd: string | null | undefined): { cwd: string | null; error: string | null } {
  if (!recordedCwd) {
    return { cwd: null, error: "Cannot resume: this session has no recorded working directory." };
  }
  try {
    if (fs.statSync(recordedCwd).isDirectory()) return { cwd: recordedCwd, error: null };
    return { cwd: null, error: `Cannot resume: the original working directory is not a directory.\n${recordedCwd}` };
  } catch {
    return { cwd: null, error: `Cannot resume: the original working directory no longer exists.\n${recordedCwd}` };
  }
}

export function exportSession(
  detail: SessionDetailResponse,
  format: "markdown" | "html",
  mode: ExportMode,
  rawItems: string[] = []
): string {
  const entries = exportEntries(detail, mode);
  return format === "html" ? renderHtml(detail, entries, mode, rawItems) : renderMarkdown(detail, entries, mode, rawItems);
}

export function exportFileName(detail: Pick<SessionDetailResponse, "session">, format: "markdown" | "html", mode: ExportMode = "conversation"): string {
  const title = (detail.session.firstUserMessage || detail.session.nativeId)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "session";
  const id = detail.session.nativeId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 12) || "unknown";
  return `${title}-${id}-${mode}.${format === "html" ? "html" : "md"}`;
}

export class StreamingSessionExport {
  private readonly file: number;
  private rawStarted = false;
  private closed = false;

  constructor(
    outputPath: string,
    private readonly session: SessionSummary,
    private readonly format: "markdown" | "html",
    private readonly mode: ExportMode
  ) {
    this.file = fs.openSync(outputPath, "wx");
    this.write(format === "html" ? streamingHtmlStart(session, mode) : streamingMarkdownStart(session, mode));
  }

  writeItem(item: Omit<ConversationItem, "id">): void {
    if (!shouldExportItem(item, this.mode)) return;
    const body = item.text || item.summary || item.toolName || item.payloadType || item.envelopeType;
    if (this.format === "html") {
      this.write(`\n    <article class="entry ${htmlClass(item.role || "event")}">\n      <header><strong>${escapeHtml(itemLabel(item))}</strong><time>${escapeHtml(item.timestamp || "")}</time></header>\n      <pre>${escapeHtml(body)}</pre>\n    </article>`);
    } else {
      this.write(`## ${escapeMarkdown(itemLabel(item))}\n\n${item.timestamp ? `_${item.timestamp}_\n\n` : ""}${body}\n\n`);
    }
  }

  startRaw(): void {
    if (this.rawStarted) return;
    this.rawStarted = true;
    this.write(this.format === "html"
      ? '\n<details class="raw"><summary>Raw source records</summary><pre>'
      : "## Raw source records\n\n");
  }

  writeRawLine(line: string): void {
    if (!this.rawStarted) this.startRaw();
    this.write(this.format === "html" ? `${escapeHtml(line)}\n` : `    ${line}\n`);
  }

  finish(): void {
    if (this.closed) return;
    if (this.format === "html") this.write(`${this.rawStarted ? "</pre></details>" : ""}</main></body></html>`);
    this.closed = true;
    fs.closeSync(this.file);
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.file);
  }

  private write(value: string): void {
    fs.writeSync(this.file, value, undefined, "utf8");
  }
}

export function conversationItems(detail: SessionDetailResponse): ConversationItem[] {
  return detail.turns.flatMap((turn) => turn.items).filter((item) =>
    (item.role === "user" && !looksLikeGeneratedContext(item.text || "")) ||
    (item.role === "assistant" && item.phase === "final_answer")
  );
}

function exportEntries(detail: SessionDetailResponse, mode: ExportMode): ConversationItem[] {
  const all = detail.turns.flatMap((turn) => turn.items);
  if (mode === "conversation") return conversationItems(detail);
  if (mode === "readable") {
    return all.filter((item) => item.role === "user" || item.role === "assistant" || item.payloadType === "reasoning" || item.toolName);
  }
  return all;
}

function shouldExportItem(item: Omit<ConversationItem, "id">, mode: ExportMode): boolean {
  if (mode === "trace") return true;
  if (mode === "conversation") {
    return (item.role === "user" && !looksLikeGeneratedContext(item.text || "")) ||
      (item.role === "assistant" && item.phase === "final_answer");
  }
  return item.role === "user" || item.role === "assistant" || item.payloadType === "reasoning" || Boolean(item.toolName);
}

function streamingMarkdownStart(session: SessionSummary, mode: ExportMode): string {
  return [
    `# ${escapeMarkdown(session.firstUserMessage || session.nativeId)}`,
    "",
    `- Provider: ${providerLabel(session.provider)}`,
    `- Session: \`${escapeCode(session.nativeId)}\``,
    `- Workspace: ${session.cwd ? `\`${escapeCode(session.cwd)}\`` : "Unknown"}`,
    `- Started: ${session.startedAt || "Unknown"}`,
    `- View: ${mode}`,
    "",
    ""
  ].join("\n");
}

function streamingHtmlStart(session: SessionSummary, mode: ExportMode): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(session.firstUserMessage || session.nativeId)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--panel:#fff;--text:#17201b;--muted:#68736d;--line:#dce1de;--user:#e8f2ff;--assistant:#f2f4f3;--accent:#087f5b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,sans-serif}main{max-width:920px;margin:auto;padding:40px 24px}h1{font-size:24px;margin:0 0 8px;letter-spacing:0}.meta{color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}.entry{background:var(--panel);border:1px solid var(--line);border-left:3px solid #98a29d;border-radius:6px;margin:12px 0;padding:14px 16px}.entry.user{background:var(--user);border-left-color:#2374c6}.entry.assistant{background:var(--assistant);border-left-color:var(--accent)}header{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px;text-transform:uppercase}header strong{color:var(--text)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:10px 0 0}.raw{margin-top:28px}.raw pre{font:12px/1.5 ui-monospace,monospace}@media print{body{background:#fff}main{max-width:none;padding:0}.entry{break-inside:avoid}}@media(prefers-color-scheme:dark){:root{--bg:#111512;--panel:#181d1a;--text:#e5ebe7;--muted:#9aa69f;--line:#303832;--user:#14283b;--assistant:#1c2420;--accent:#54c99b}}
</style></head><body><main><h1>${escapeHtml(session.firstUserMessage || session.nativeId)}</h1>
<div class="meta"><span>${escapeHtml(providerLabel(session.provider))}</span><span>${escapeHtml(session.cwd || "Unknown workspace")}</span><span>${escapeHtml(session.startedAt || "Unknown date")}</span><span>${escapeHtml(mode)}</span></div>`;
}

function renderMarkdown(detail: SessionDetailResponse, entries: ConversationItem[], mode: ExportMode, rawItems: string[]): string {
  const session = detail.session;
  const lines = [
    `# ${escapeMarkdown(session.firstUserMessage || session.nativeId)}`,
    "",
    `- Provider: ${providerLabel(session.provider)}`,
    `- Session: \`${escapeCode(session.nativeId)}\``,
    `- Workspace: ${session.cwd ? `\`${escapeCode(session.cwd)}\`` : "Unknown"}`,
    `- Started: ${session.startedAt || "Unknown"}`,
    `- View: ${mode}`,
    ""
  ];
  for (const item of entries) {
    lines.push(`## ${escapeMarkdown(itemLabel(item))}`, "");
    if (item.timestamp) lines.push(`_${item.timestamp}_`, "");
    lines.push(item.text || item.summary || item.toolName || item.payloadType || item.envelopeType, "");
  }
  if (mode === "trace" && rawItems.length) {
    lines.push("## Raw JSONL", "", fence(rawItems.join("\n"), "jsonl"), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderHtml(detail: SessionDetailResponse, entries: ConversationItem[], mode: ExportMode, rawItems: string[]): string {
  const session = detail.session;
  const transcript = entries.map((item) => `
    <article class="entry ${htmlClass(item.role || "event")}">
      <header><strong>${escapeHtml(itemLabel(item))}</strong><time>${escapeHtml(item.timestamp || "")}</time></header>
      <pre>${escapeHtml(item.text || item.summary || item.toolName || item.payloadType || item.envelopeType)}</pre>
    </article>`).join("");
  const raw = mode === "trace" && rawItems.length
    ? `<details class="raw"><summary>Raw JSONL</summary><pre>${escapeHtml(rawItems.join("\n"))}</pre></details>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(session.firstUserMessage || session.nativeId)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f8;--panel:#fff;--text:#17201b;--muted:#68736d;--line:#dce1de;--user:#e8f2ff;--assistant:#f2f4f3;--accent:#087f5b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,sans-serif}main{max-width:920px;margin:auto;padding:40px 24px}h1{font-size:24px;margin:0 0 8px;letter-spacing:0}.meta{color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}.entry{background:var(--panel);border:1px solid var(--line);border-left:3px solid #98a29d;border-radius:6px;margin:12px 0;padding:14px 16px}.entry.user{background:var(--user);border-left-color:#2374c6}.entry.assistant{background:var(--assistant);border-left-color:var(--accent)}header{display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:12px;text-transform:uppercase}header strong{color:var(--text)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:10px 0 0}.raw{margin-top:28px}.raw pre{font:12px/1.5 ui-monospace,monospace}@media print{body{background:#fff}main{max-width:none;padding:0}.entry{break-inside:avoid}}@media(prefers-color-scheme:dark){:root{--bg:#111512;--panel:#181d1a;--text:#e5ebe7;--muted:#9aa69f;--line:#303832;--user:#14283b;--assistant:#1c2420;--accent:#54c99b}}
</style></head><body><main><h1>${escapeHtml(session.firstUserMessage || session.nativeId)}</h1>
<div class="meta"><span>${escapeHtml(providerLabel(session.provider))}</span><span>${escapeHtml(session.cwd || "Unknown workspace")}</span><span>${escapeHtml(session.startedAt || "Unknown date")}</span><span>${escapeHtml(mode)}</span></div>
${transcript}${raw}</main></body></html>`;
}

function itemLabel(item: Pick<ConversationItem, "role" | "phase" | "toolName" | "payloadType" | "envelopeType">): string {
  if (item.role === "assistant") return item.phase === "final_answer" ? "Assistant final" : item.phase === "commentary" ? "Assistant progress" : "Assistant";
  if (item.role === "user") return "User";
  if (item.toolName) return `Tool: ${item.toolName}`;
  return item.payloadType || item.envelopeType;
}

function looksLikeGeneratedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("<environment_context>") || value.startsWith("<permissions instructions>") || value.startsWith("<collaboration_mode>");
}

function providerLabel(provider: AgentProvider): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "gemini") return "Gemini CLI";
  if (provider === "pi") return "Pi";
  return "Codex";
}

function quoteArg(value: string): string {
  return /[\s"']/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function htmlClass(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "-");
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function fence(value: string, language: string): string {
  const longest = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length + 1));
  const marker = "`".repeat(longest);
  return `${marker}${language}\n${value}\n${marker}`;
}
