import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { AgentProvider, ConversationItem, ExportMode, SessionDetailResponse, SessionSummary } from "../shared/types.js";
import { resolveAppConfig } from "../server/config.js";
import { ViewerDatabase } from "../server/database.js";
import { SessionIndexer } from "../server/indexer.js";
import { conversationItems, exportFileName, resolveResumeDirectory, resumeCommand, resumeInvocation } from "../server/session-actions.js";
import { SessionSourceReader } from "../server/source-reader.js";
import { expandedRecordSections } from "../client/record-display.js";

const ESC = "\x1b";
const colors = {
  reset: `${ESC}[0m`, bold: `${ESC}[1m`, dim: `${ESC}[2m`, inverse: `${ESC}[7m`,
  green: `${ESC}[38;5;42m`, blue: `${ESC}[38;5;75m`, amber: `${ESC}[38;5;214m`, magenta: `${ESC}[38;5;176m`, gray: `${ESC}[38;5;245m`
};

interface CliOptions {
  query: string; provider: AgentProvider | ""; resolve: string | null; printResume: boolean;
  exportFormat: "markdown" | "html" | null; mode: ExportMode; help: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const config = resolveAppConfig();
  const database = new ViewerDatabase(config.dbPath);
  const indexer = new SessionIndexer(config, database);
  const reader = new SessionSourceReader(database);
  try {
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write("Cataloging local sessions (metadata only)...");
    await indexer.refreshAll();
    if (process.stdin.isTTY && process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    if (options.resolve) {
      const match = database.resolveSession(options.resolve);
      if (!match.session) throw new Error(`Session not found: ${options.resolve}`);
      if (options.printResume) {
        process.stdout.write(`${resumeCommand(match.session.provider, match.session.nativeId)}\n`);
        return;
      }
      if (options.exportFormat) {
        const detail = await reader.getDetail(match.session.id);
        if (!detail) throw new Error(`Session not found: ${options.resolve}`);
        process.stdout.write(`${await writeExport(config.dbPath, reader, detail, options.exportFormat, options.mode)}\n`);
        return;
      }
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await printPlain(database, options);
      return;
    }
    await runInteractive(database, reader, config.dbPath, options);
  } finally {
    database.close();
  }
}

async function runInteractive(database: ViewerDatabase, reader: SessionSourceReader, dbPath: string, options: CliOptions): Promise<void> {
  let query = options.query;
  let provider = options.provider;
  let filterCandidates = true;
  let selected = 0;
  let activePane: "sessions" | "transcript" = "sessions";
  let previewItem = 0;
  let previewLine = 0;
  let mode: ExportMode = options.mode;
  let notice = "";
  let busy = "";
  let sessions: SessionSummary[] = [];
  let detail: SessionDetailResponse | null = null;
  let previewItems: ConversationItem[] = [];
  let searchAbort: AbortController | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let generation = 0;
  const providers: Array<AgentProvider | ""> = ["", "codex", "claude", "gemini", "pi"];
  let initialSessionId = options.resolve ? database.resolveSession(options.resolve).session?.id || null : null;

  const refreshPreviewItems = (reset = false) => {
    previewItems = detail ? getPreviewItems(detail, mode, filterCandidates ? "" : query) : [];
    if (reset) { previewItem = 0; previewLine = 0; }
    previewItem = Math.max(0, Math.min(previewItem, Math.max(0, previewItems.length - 1)));
  };

  const render = () => {
    const width = Math.max(72, process.stdout.columns || 120);
    const height = Math.max(18, process.stdout.rows || 32);
    const leftWidth = Math.max(30, Math.min(52, Math.floor(width * 0.4)));
    const rightWidth = width - leftWidth - 3;
    const header = `${colors.bold}${colors.green}Agent Session Browser${colors.reset}  ${filterCandidates ? "FILTER" : "PREVIEW SEARCH"}  ` +
      `${provider ? provider.toUpperCase() : "ALL AGENTS"}  ${sessions.length} sessions  ${activePane.toUpperCase()}`;
    const queryLine = `${colors.gray}>${colors.reset} ${query || `${colors.dim}type to search original session files${colors.reset}`}`;
    const listRows = renderList(sessions, selected, leftWidth, height - 5, activePane === "sessions");
    const previewRows = renderPreview(detail, previewItems, filterCandidates ? "" : query, rightWidth, height - 5, mode, previewItem, previewLine);
    const body: string[] = [];
    for (let index = 0; index < height - 5; index += 1) body.push(`${padAnsi(listRows[index] || "", leftWidth)} ${colors.gray}|${colors.reset} ${padAnsi(previewRows[index] || "", rightWidth)}`);
    const shortcuts = `${colors.dim}Left/Right pane  Up/Down scroll  PgUp/PgDn page  type search  Ctrl+S filter/preview  Tab provider  F2 view  Ctrl+O expand  Ctrl+E export  Enter resume  Esc quit${colors.reset}`;
    const status = busy ? `${colors.amber}${busy}${colors.reset}` : notice ? `${colors.amber}${notice}${colors.reset}` : `${colors.dim}${detail?.session.sourcePath || ""}${colors.reset}`;
    process.stdout.write(`${ESC}[H${ESC}[2J${header}\n${queryLine}\n${body.join("\n")}\n${shortcuts}\n${truncateAnsi(status, width)}`);
  };

  const loadDetail = async () => {
    const current = ++generation;
    detail = null;
    if (!sessions[selected]) { busy = ""; render(); return; }
    busy = "Reading selected original session file...";
    render();
    try {
      const loaded = await reader.getDetail(sessions[selected].id);
      if (current === generation) {
        detail = loaded;
        refreshPreviewItems(true);
      }
    } catch (error) {
      if (current === generation) notice = (error as Error).message;
    } finally {
      if (current === generation) { busy = ""; render(); }
    }
  };

  const loadSessions = async () => {
    searchAbort?.abort();
    const abort = new AbortController();
    searchAbort = abort;
    const current = ++generation;
    busy = filterCandidates && query ? "Searching original session files..." : "Loading session catalog...";
    render();
    try {
      const response = await database.listSessions({ q: filterCandidates ? query : "", provider, limit: "all" }, emptyStatus(), abort.signal);
      if (abort.signal.aborted || current !== generation) return;
      sessions = response.sessions;
      if (initialSessionId) {
        const initialIndex = sessions.findIndex((session) => session.id === initialSessionId);
        if (initialIndex >= 0) selected = initialIndex;
        initialSessionId = null;
      }
      selected = Math.max(0, Math.min(selected, sessions.length - 1));
      busy = "";
      await loadDetail();
    } catch (error) {
      if ((error as Error).name !== "AbortError" && current === generation) notice = (error as Error).message;
    } finally {
      if (current === generation) { busy = ""; render(); }
    }
  };

  const scheduleSessionLoad = () => {
    if (!filterCandidates) {
      refreshPreviewItems(true);
      render();
      return;
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void loadSessions(), query && filterCandidates ? 400 : 0);
  };

  process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await loadSessions();

  await new Promise<void>((resolve) => {
    const close = () => {
      generation += 1;
      searchAbort?.abort();
      if (debounce) clearTimeout(debounce);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
      process.stdin.removeAllListeners("keypress");
      process.stdout.removeListener("resize", render);
      resolve();
    };
    process.stdout.on("resize", render);
    process.stdin.on("keypress", (value, key: readline.Key) => {
      notice = "";
      if ((key.ctrl && key.name === "c") || key.name === "escape") return close();
      if (key.ctrl && key.name === "s") { filterCandidates = !filterCandidates; scheduleSessionLoad(); }
      else if (key.name === "left") activePane = "sessions";
      else if (key.name === "right") activePane = "transcript";
      else if (key.name === "up" && activePane === "sessions") { selected = Math.max(0, selected - 1); void loadDetail(); }
      else if (key.name === "down" && activePane === "sessions") { selected = Math.min(sessions.length - 1, selected + 1); void loadDetail(); }
      else if (key.name === "pageup" && activePane === "sessions") { selected = Math.max(0, selected - 10); void loadDetail(); }
      else if (key.name === "pagedown" && activePane === "sessions") { selected = Math.min(sessions.length - 1, selected + 10); void loadDetail(); }
      else if (key.name === "up" && activePane === "transcript") movePreviewCursor(previewItems, -1, currentPreviewWidth());
      else if (key.name === "down" && activePane === "transcript") movePreviewCursor(previewItems, 1, currentPreviewWidth());
      else if (key.name === "pageup" && activePane === "transcript") movePreviewCursor(previewItems, -Math.max(1, (process.stdout.rows || 32) - 9), currentPreviewWidth());
      else if (key.name === "pagedown" && activePane === "transcript") movePreviewCursor(previewItems, Math.max(1, (process.stdout.rows || 32) - 9), currentPreviewWidth());
      else if (key.name === "backspace") { query = query.slice(0, -1); scheduleSessionLoad(); }
      else if (key.name === "tab") { provider = providers[(providers.indexOf(provider) + 1) % providers.length]; scheduleSessionLoad(); }
      else if (key.name === "f2") { mode = mode === "conversation" ? "readable" : mode === "readable" ? "trace" : "conversation"; refreshPreviewItems(true); }
      else if (key.ctrl && key.name === "o" && detail && previewItems[previewItem]?.contentPreview) {
        const item = previewItems[previewItem];
        const sessionId = detail.session.id;
        const sessionProvider = detail.session.provider;
        busy = "Expanding the complete original record..."; render();
        void reader.getRawItem(sessionId, item.id)
          .then((raw) => {
            if (raw == null) throw new Error("Original source record is unavailable.");
            item.text = expandedRecordSections(sessionProvider, raw).map((section) => `${section.label}\n${section.text}`).join("\n\n");
            item.summary = null;
            item.contentPreview = false;
            previewLine = 0;
            busy = "";
            render();
          })
          .catch((error) => { busy = ""; notice = (error as Error).message; render(); });
      }
      else if (key.ctrl && key.name === "r" && detail) {
        try { notice = resumeCommand(detail.session.provider, detail.session.nativeId); } catch (error) { notice = (error as Error).message; }
      } else if (key.ctrl && key.name === "e" && detail) {
        busy = "Exporting from original session file..."; render();
        void writeExport(dbPath, reader, detail, "html", mode)
          .then((output) => { busy = ""; notice = `Exported ${output}`; render(); })
          .catch((error) => { busy = ""; notice = (error as Error).message; render(); });
      } else if (key.name === "return" && detail) {
        const directory = resolveResumeDirectory(detail.session.cwd);
        if (directory.error || !directory.cwd) { notice = directory.error || "Cannot resume without an original working directory."; render(); return; }
        const invocation = resumeInvocation(detail.session.provider, detail.session.nativeId);
        close();
        const child = spawn(invocation.command, invocation.args, { cwd: directory.cwd, shell: false, stdio: "inherit" });
        child.on("error", (error) => process.stderr.write(`Unable to resume session: ${error.message}\n`));
        return;
      } else if (!key.ctrl && !key.meta && value && value >= " " && value !== "\x7f") { query += value; scheduleSessionLoad(); }
      render();

      function currentPreviewWidth(): number {
        const width = Math.max(72, process.stdout.columns || 120);
        const leftWidth = Math.max(30, Math.min(52, Math.floor(width * 0.4)));
        return width - leftWidth - 3;
      }

      function movePreviewCursor(items: ConversationItem[], delta: number, width: number): void {
        const direction = Math.sign(delta);
        for (let step = 0; step < Math.abs(delta) && items.length; step += 1) {
          if (direction > 0) {
            const lines = Math.max(1, wrap(itemBody(items[previewItem]), width).length);
            if (previewLine + 1 < lines) previewLine += 1;
            else if (previewItem + 1 < items.length) { previewItem += 1; previewLine = 0; }
          } else if (previewLine > 0) {
            previewLine -= 1;
          } else if (previewItem > 0) {
            previewItem -= 1;
            previewLine = Math.max(0, wrap(itemBody(items[previewItem]), width).length - 1);
          }
        }
      }
    });
  });
}

function renderList(sessions: SessionSummary[], selected: number, width: number, rows: number, focused: boolean): string[] {
  if (!sessions.length) return [`${colors.dim}No sessions match${colors.reset}`];
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, sessions.length - rows)));
  return sessions.slice(start, start + rows).map((session, offset) => {
    const active = start + offset === selected;
    const provider = providerColor(session.provider, session.provider.padEnd(6));
    const date = compactDate(session.lastEventAt || session.startedAt);
    const title = truncate(session.firstUserMessage || session.nativeId, Math.max(8, width - 20));
    const line = `${active ? ">" : " "} ${provider} ${colors.gray}${date}${colors.reset} ${title}`;
    return active && focused ? `${colors.inverse}${stripAnsi(line)}${colors.reset}` : line;
  });
}

function renderPreview(detail: SessionDetailResponse | null, items: ConversationItem[], query: string, width: number, rows: number, mode: ExportMode, itemOffset: number, lineOffset: number): string[] {
  if (!detail) return [`${colors.dim}Select a session${colors.reset}`];
  const session = detail.session;
  const output = [
    `${colors.bold}${providerColor(session.provider, providerLabel(session.provider))}${colors.reset}  ${colors.gray}${mode}${colors.reset}`,
    `${colors.bold}${truncate(session.firstUserMessage || session.nativeId, width)}${colors.reset}`,
    `${colors.dim}${truncate(session.cwd || "Unknown workspace", width)}${colors.reset}`,
    `${colors.gray}${items.length ? `Item ${itemOffset + 1}/${items.length}${lineOffset ? `, wrapped line ${lineOffset + 1}` : ""}` : "No matching transcript items"}${colors.reset}`
  ];
  for (let index = itemOffset; index < items.length && output.length < rows; index += 1) {
    const item = items[index];
    const color = item.role === "user" ? colors.blue : item.role === "assistant" ? colors.green : colors.amber;
    output.push(`${color}${colors.bold}${itemLabel(item)}${index === itemOffset && lineOffset ? " (continued)" : ""}${colors.reset} ${colors.dim}${compactTime(item.timestamp)}${item.contentPreview ? "  preview; Ctrl+O expands" : ""}${colors.reset}`);
    const remaining = Math.max(0, rows - output.length);
    const wrapped = wrap(itemBody(item), width).slice(index === itemOffset ? lineOffset : 0, (index === itemOffset ? lineOffset : 0) + remaining);
    output.push(...wrapped.map((line) => highlight(line, query)));
    if (output.length < rows) output.push("");
  }
  return output.slice(0, rows);
}

function getPreviewItems(detail: SessionDetailResponse, mode: ExportMode, query: string): ConversationItem[] {
  let items = mode === "conversation" ? conversationItems(detail) : detail.turns.flatMap((turn) => turn.items).filter((item) => mode === "trace" || item.role === "user" || item.role === "assistant" || item.payloadType === "reasoning" || item.toolName);
  if (query) items = items.filter((item) => itemBody(item).toLowerCase().includes(query.toLowerCase()));
  return items;
}

async function writeExport(dbPath: string, reader: SessionSourceReader, detail: SessionDetailResponse, format: "markdown" | "html", mode: ExportMode): Promise<string> {
  const outputDir = path.join(path.dirname(dbPath), "exports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = nextAvailablePath(outputDir, exportFileName(detail, format, mode));
  const exported = await reader.writeExport(detail.session.id, outputPath, format, mode);
  if (!exported) throw new Error(`Session not found: ${detail.session.id}`);
  return outputPath;
}

async function printPlain(database: ViewerDatabase, options: CliOptions): Promise<void> {
  const sessions = (await database.listSessions({ q: options.query, provider: options.provider, limit: "all" }, emptyStatus())).sessions;
  for (const session of sessions) process.stdout.write(`${session.id}\t${session.provider}\t${session.lastEventAt || session.startedAt || ""}\t${session.cwd || ""}\t${compactWhitespace(session.firstUserMessage || session.nativeId)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { query: "", provider: "", resolve: null, printResume: false, exportFormat: null, mode: "conversation", help: false };
  const nextValue = (index: number, option: string): string => {
    const next = args[index + 1];
    if (!next || next.startsWith("-")) throw new Error(`${option} requires a value\n\n${usage()}`);
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--query" || value === "-q") options.query = nextValue(index++, value);
    else if (value === "--provider") {
      const provider = nextValue(index++, value);
      if (!(["codex", "claude", "gemini", "pi"] as string[]).includes(provider)) throw new Error(`Invalid provider: ${provider}\n\n${usage()}`);
      options.provider = provider as AgentProvider;
    }
    else if (value === "--session") options.resolve = nextValue(index++, value);
    else if (value === "--print-resume") options.printResume = true;
    else if (value === "--export") {
      const format = nextValue(index++, value);
      if (!(["md", "markdown", "html"] as string[]).includes(format)) throw new Error(`Invalid export format: ${format}\n\n${usage()}`);
      options.exportFormat = format === "html" ? "html" : "markdown";
    }
    else if (value === "--mode") {
      const mode = nextValue(index++, value);
      if (!(["conversation", "readable", "trace"] as string[]).includes(mode)) throw new Error(`Invalid mode: ${mode}\n\n${usage()}`);
      options.mode = mode as ExportMode;
    } else throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  if ((options.printResume || options.exportFormat) && !options.resolve) throw new Error(`--print-resume and --export require --session\n\n${usage()}`);
  if (options.printResume && options.exportFormat) throw new Error(`Choose either --print-resume or --export\n\n${usage()}`);
  return options;
}

function usage(): string {
  return `Agent Session Browser TUI\n\nUsage:\n  asb [tui] [--query text] [--provider codex|claude|gemini|pi]\n  asb [tui] --session <id-or-path> --print-resume\n  asb [tui] --session <id-or-path> --export md|html [--mode conversation|readable|trace]\n\nOptions:\n  -q, --query <text>       Search session files\n  --provider <provider>    Restrict the session list\n  --session <id-or-path>   Open, resume, or export one session\n  --print-resume           Print its native resume command\n  --export <md|html>       Export without opening the TUI\n  --mode <mode>            conversation, readable, or trace\n  -h, --help               Show this help\n`;
}

function nextAvailablePath(directory: string, filename: string): string {
  const extension = path.extname(filename);
  const stem = filename.slice(0, -extension.length);
  let candidate = path.join(directory, filename);
  for (let suffix = 2; fs.existsSync(candidate); suffix += 1) candidate = path.join(directory, `${stem}-${suffix}${extension}`);
  return candidate;
}

function emptyStatus() { return { running: false, lastRunAt: null, filesSeen: 0, filesIndexed: 0, filesSkipped: 0, sessions: 0, parseErrors: 0, error: null }; }
function providerLabel(provider: AgentProvider): string { return provider === "claude" ? "Claude Code" : provider === "gemini" ? "Gemini CLI" : provider === "pi" ? "Pi" : "Codex"; }
function providerColor(provider: AgentProvider, text: string): string { const color = provider === "codex" ? colors.green : provider === "claude" ? colors.amber : provider === "gemini" ? colors.blue : colors.magenta; return `${color}${text}${colors.reset}`; }
function itemLabel(item: ConversationItem): string { if (item.role === "user") return "USER"; if (item.role === "assistant") return item.phase === "final_answer" ? "ASSISTANT FINAL" : "ASSISTANT"; return (item.toolName || item.payloadType || item.envelopeType).toUpperCase(); }
function compactDate(value: string | null): string { if (!value) return "----------"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toISOString().slice(0, 10); }
function compactTime(value: string | null): string { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function compactWhitespace(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function truncate(value: string, width: number): string { return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 3))}...`; }
function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function truncateAnsi(value: string, width: number): string { return truncate(stripAnsi(value), width); }
function padAnsi(value: string, width: number): string { const length = stripAnsi(value).length; return length >= width ? truncateAnsi(value, width) : value + " ".repeat(width - length); }
function wrap(value: string, width: number): string[] { const lines: string[] = []; for (const paragraph of value.split("\n")) { if (!paragraph) { lines.push(""); continue; } for (let index = 0; index < paragraph.length; index += width) lines.push(paragraph.slice(index, index + width)); } return lines; }
function itemBody(item: ConversationItem): string { return item.text || item.summary || item.toolName || item.payloadType || item.envelopeType; }
function highlight(value: string, query: string): string { if (!query) return value; return value.replace(new RegExp(escapeRegex(query), "ig"), (match) => `${colors.inverse}${match}${colors.reset}`); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

main().catch((error) => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
