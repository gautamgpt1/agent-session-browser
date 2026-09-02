import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import type { AgentProvider, ConversationItem, ExportMode, SessionDetailResponse, SessionSummary } from "../shared/types.js";
import { resolveAppConfig } from "../server/config.js";
import { ViewerDatabase } from "../server/database.js";
import { SessionIndexer } from "../server/indexer.js";
import { conversationItems, exportFileName, resolveResumeDirectory, resumeCommand, resumeInvocation, resumeLaunchInvocation } from "../server/session-actions.js";
import { SessionSourceReader } from "../server/source-reader.js";
import { expandedMessageText } from "../client/record-display.js";
import { availableTuiBodyRows, sanitizeTuiText, tuiFrameLayout, tuiPageStep, tuiWidthLayout, visibleTuiView, wrapTuiSegments, wrapTuiSourceText, wrapTuiText, type TuiView } from "./layout.js";

const ESC = "\x1b";
const colors = {
  reset: `${ESC}[0m`, bold: `${ESC}[1m`, dim: `${ESC}[2m`, inverse: `${ESC}[7m`,
  green: `${ESC}[38;5;42m`, blue: `${ESC}[38;5;75m`, amber: `${ESC}[38;5;214m`, magenta: `${ESC}[38;5;176m`, gray: `${ESC}[38;5;245m`, white: `${ESC}[38;5;255m`
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
    await runInteractive(database, reader, options);
  } finally {
    database.close();
  }
}

async function runInteractive(database: ViewerDatabase, reader: SessionSourceReader, options: CliOptions): Promise<void> {
  let sessionQuery = options.query;
  let transcriptQuery = "";
  let provider = options.provider;
  let selected = 0;
  let activePane: "sessions" | "transcript" = "sessions";
  let view: TuiView = "both";
  let previewItem = 0;
  let previewLine = 0;
  let notice = "";
  let busy = "";
  let sessions: SessionSummary[] = [];
  let detail: SessionDetailResponse | null = null;
  let previewItems: ConversationItem[] = [];
  let searchAbort: AbortController | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let generation = 0;
  let visibleBodyRows = 1;
  const providers: Array<AgentProvider | ""> = ["", "codex", "claude", "gemini", "pi"];
  let initialSessionId = options.resolve ? database.resolveSession(options.resolve).session?.id || null : null;

  const refreshPreviewItems = (reset = false) => {
    previewItems = detail ? getPreviewItems(detail, transcriptQuery) : [];
    if (reset) { previewItem = 0; previewLine = 0; }
    previewItem = Math.max(0, Math.min(previewItem, Math.max(0, previewItems.length - 1)));
  };

  const render = () => {
    const widthLayout = tuiWidthLayout(process.stdout.columns);
    const width = widthLayout.width;
    const layout = tuiFrameLayout(process.stdout.rows);
    const visibleView = visibleTuiView(view, widthLayout.twoPane, activePane);
    const activeQuery = activePane === "sessions" ? sessionQuery : transcriptQuery;
    const settingsText = [
      ["provider", provider || "all"],
      ["sessions", String(sessions.length)],
      ["view", visibleView === "sessions" ? "session" : visibleView]
    ].map(([label, value]) => `${colors.bold}${colors.white}${label}${colors.reset} ${colors.gray}${value}${colors.reset}`).join("   ");
    const settingsWidth = Math.min(stripAnsi(settingsText).length, Math.max(0, width - 4));
    const topGap = settingsWidth ? Math.min(2, Math.max(0, width - settingsWidth - 1)) : 0;
    const searchWidth = Math.max(1, width - settingsWidth - topGap);
    const search = `${colors.gray}>${colors.reset} ${activeQuery || `${colors.dim}${activePane === "sessions" ? "find by first prompt or session ID" : "search this transcript"}${colors.reset}`}`;
    const topBar = `${padAnsi(search, searchWidth)}${" ".repeat(topGap)}${truncateAnsi(settingsText, settingsWidth)}`;
    const topDivider = `${colors.white}${"─".repeat(width)}${colors.reset}`;
    const shortcutEntries = [
      ["←/→", "focus"], ["↑/↓", "scroll"], ["pgup/pgdn", "jump page"],
      ["tab", "provider"], ["ctrl+l", "view"], ["enter", "resume"], ["esc", "quit"]
    ].map(([key, action]) => `${colors.bold}${colors.white}${key}${colors.reset} ${colors.gray}${action}${colors.reset}`);
    const status = busy ? `${colors.amber}${sanitizeTuiText(busy)}${colors.reset}` : notice ? `${colors.amber}${sanitizeTuiText(notice)}${colors.reset}` : "";
    const shortcutLines = layout.showShortcuts ? wrapTuiSegments(shortcutEntries, width) : [];
    const shortcutDivider = shortcutLines.length ? `${colors.white}${"─".repeat(width)}${colors.reset}` : "";
    const statusLines = layout.showStatus && stripAnsi(status) ? wrapTuiText(status, width) : [];
    const fixedRows = 2 + Number(Boolean(shortcutDivider)) + shortcutLines.length + statusLines.length;
    const bodyRows = availableTuiBodyRows(process.stdout.rows, fixedRows);
    visibleBodyRows = bodyRows;
    const body: string[] = [];
    if (visibleView === "both") {
      const leftWidth = Math.max(1, Math.min(52, Math.max(30, Math.floor(width * 0.4)), Math.max(1, width - 4)));
      const rightWidth = Math.max(1, width - leftWidth - 3);
      const listRows = renderList(sessions, selected, leftWidth, bodyRows, activePane === "sessions", sessionQuery);
      const previewRows = renderPreview(detail, previewItems, transcriptQuery, rightWidth, bodyRows, previewItem, previewLine);
      for (let index = 0; index < bodyRows; index += 1) body.push(`${padAnsi(listRows[index] || "", leftWidth)} ${colors.gray}|${colors.reset} ${padAnsi(previewRows[index] || "", rightWidth)}`);
    } else if (visibleView === "sessions") {
      body.push(...renderList(sessions, selected, width, bodyRows, true, sessionQuery));
    } else {
      body.push(...renderPreview(detail, previewItems, transcriptQuery, width, bodyRows, previewItem, previewLine));
    }
    const frame = [topBar, topDivider];
    frame.push(...body);
    if (shortcutDivider) frame.push(shortcutDivider);
    frame.push(...shortcutLines, ...statusLines);
    process.stdout.write(`${ESC}[H${ESC}[2J${frame.map((line) => truncateAnsi(line, width)).join("\n")}`);
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
    busy = sessionQuery ? "Finding sessions..." : "Loading session catalog...";
    render();
    try {
      const response = await database.listSessions({ q: sessionQuery, provider, limit: "all" }, emptyStatus(), abort.signal);
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

  const scheduleSessionLoad = (delay = sessionQuery ? 400 : 0) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void loadSessions(), delay);
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
      if (key.name === "left") { activePane = "sessions"; if (view !== "both") view = "sessions"; }
      else if (key.name === "right") { activePane = "transcript"; if (view !== "both") view = "transcript"; }
      else if (key.name === "up" && activePane === "sessions") { selected = Math.max(0, selected - 1); void loadDetail(); }
      else if (key.name === "down" && activePane === "sessions") { selected = Math.min(sessions.length - 1, selected + 1); void loadDetail(); }
      else if (key.name === "pageup" && activePane === "sessions") { selected = Math.max(0, selected - tuiPageStep(visibleBodyRows, "sessions")); void loadDetail(); }
      else if (key.name === "pagedown" && activePane === "sessions") { selected = Math.min(sessions.length - 1, selected + tuiPageStep(visibleBodyRows, "sessions")); void loadDetail(); }
      else if (key.name === "up" && activePane === "transcript") movePreviewCursor(previewItems, -1, currentPreviewWidth());
      else if (key.name === "down" && activePane === "transcript") movePreviewCursor(previewItems, 1, currentPreviewWidth());
      else if (key.name === "pageup" && activePane === "transcript") movePreviewCursor(previewItems, -tuiPageStep(visibleBodyRows, "transcript"), currentPreviewWidth());
      else if (key.name === "pagedown" && activePane === "transcript") movePreviewCursor(previewItems, tuiPageStep(visibleBodyRows, "transcript"), currentPreviewWidth());
      else if (key.name === "backspace" && activePane === "sessions") { sessionQuery = sessionQuery.slice(0, -1); scheduleSessionLoad(); }
      else if (key.name === "backspace") { transcriptQuery = transcriptQuery.slice(0, -1); refreshPreviewItems(true); }
      else if (key.name === "tab") { provider = providers[(providers.indexOf(provider) + 1) % providers.length]; scheduleSessionLoad(0); }
      else if (key.ctrl && key.name === "l") {
        view = view === "both" ? "sessions" : view === "sessions" ? "transcript" : "both";
        if (view !== "both") activePane = view;
      }
      else if (key.ctrl && key.name === "o" && detail && previewItems[previewItem]?.contentPreview) {
        const item = previewItems[previewItem];
        const sessionId = detail.session.id;
        const sessionProvider = detail.session.provider;
        busy = "Loading the complete message..."; render();
        void reader.getRawItem(sessionId, item.id)
          .then((raw) => {
            if (raw == null) throw new Error("Original source record is unavailable.");
            if (item.role !== "user" && item.role !== "assistant") throw new Error("Only user and assistant messages can be expanded here.");
            const message = expandedMessageText(sessionProvider, raw, item.role);
            if (!message) throw new Error("The complete message is unavailable in the original record.");
            item.text = message;
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
      } else if (key.name === "return" && detail) {
        const directory = resolveResumeDirectory(detail.session.cwd);
        if (directory.error || !directory.cwd) { notice = directory.error || "Cannot resume without an original working directory."; render(); return; }
        let invocation: ReturnType<typeof resumeLaunchInvocation>;
        try {
          const providerInvocation = resumeInvocation(detail.session.provider, detail.session.nativeId);
          if (process.platform === "win32" && spawnSync("where.exe", [providerInvocation.command], { stdio: "ignore", windowsHide: true }).status !== 0) {
            notice = `Cannot resume: ${providerLabel(detail.session.provider)} command "${providerInvocation.command}" is not available on PATH.`;
            render();
            return;
          }
          invocation = resumeLaunchInvocation(detail.session.provider, detail.session.nativeId);
        } catch (error) {
          notice = (error as Error).message;
          render();
          return;
        }
        close();
        const child = spawn(invocation.command, invocation.args, { cwd: directory.cwd, shell: false, stdio: "inherit" });
        child.on("error", (error) => process.stderr.write(`Unable to resume session: ${error.message}\n`));
        return;
      } else if (!key.ctrl && !key.meta && value && value >= " " && value !== "\x7f" && activePane === "sessions") {
        sessionQuery += value;
        scheduleSessionLoad();
      } else if (!key.ctrl && !key.meta && value && value >= " " && value !== "\x7f") {
        transcriptQuery += value;
        refreshPreviewItems(true);
      }
      render();

      function currentPreviewWidth(): number {
        const widthLayout = tuiWidthLayout(process.stdout.columns);
        if (visibleTuiView(view, widthLayout.twoPane, activePane) !== "both") return widthLayout.width;
        const leftWidth = Math.max(1, Math.min(52, Math.max(30, Math.floor(widthLayout.width * 0.4)), Math.max(1, widthLayout.width - 4)));
        return Math.max(1, widthLayout.width - leftWidth - 3);
      }

      function movePreviewCursor(items: ConversationItem[], delta: number, width: number): void {
        const direction = Math.sign(delta);
        for (let step = 0; step < Math.abs(delta) && items.length; step += 1) {
          if (direction > 0) {
            const lines = Math.max(1, wrapTuiSourceText(itemBody(items[previewItem]), width).length);
            if (previewLine + 1 < lines) previewLine += 1;
            else if (previewItem + 1 < items.length) { previewItem += 1; previewLine = 0; }
          } else if (previewLine > 0) {
            previewLine -= 1;
          } else if (previewItem > 0) {
            previewItem -= 1;
            previewLine = Math.max(0, wrapTuiSourceText(itemBody(items[previewItem]), width).length - 1);
          }
        }
      }
    });
  });
}

function renderList(sessions: SessionSummary[], selected: number, width: number, rows: number, focused: boolean, query: string): string[] {
  if (rows <= 0) return [];
  if (!sessions.length) return [`${colors.dim}No sessions match${colors.reset}`];
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, sessions.length - rows)));
  return sessions.slice(start, start + rows).map((session, offset) => {
    const active = start + offset === selected;
    const provider = providerColor(session.provider, session.provider.padEnd(6));
    const date = compactDate(session.lastEventAt || session.startedAt);
    const title = highlight(truncate(compactWhitespace(sanitizeTuiText(sessionFinderPreview(session, query))), Math.max(8, width - 20)), query);
    const line = `${active ? ">" : " "} ${provider} ${colors.gray}${date}${colors.reset} ${title}`;
    return active && focused ? `${colors.inverse}${stripAnsi(line)}${colors.reset}` : line;
  });
}

function renderPreview(detail: SessionDetailResponse | null, items: ConversationItem[], query: string, width: number, rows: number, itemOffset: number, lineOffset: number): string[] {
  if (rows <= 0) return [];
  if (!detail) return [`${colors.dim}Select a session${colors.reset}`];
  const session = detail.session;
  const provider = providerLabel(session.provider);
  const directoryWidth = Math.max(0, width - provider.length - 1);
  const directory = directoryWidth ? truncate(compactWhitespace(sanitizeTuiText(sessionIdentity(session))), directoryWidth) : "";
  const headerGap = directory ? " ".repeat(Math.max(1, width - provider.length - directory.length)) : "";
  const output = [
    `${colors.bold}${providerColor(session.provider, provider)}${colors.reset}${headerGap}${colors.bold}${directory}${colors.reset}`,
    `${colors.dim}${truncate(compactWhitespace(sanitizeTuiText(session.firstUserMessage || "No user prompt recorded")), width)}${colors.reset}`
  ];
  if (!items.length) output.push(`${colors.gray}No matching transcript items${colors.reset}`);
  for (let index = itemOffset; index < items.length && output.length < rows; index += 1) {
    const item = items[index];
    const color = item.role === "user" ? colors.blue : item.role === "assistant" ? colors.green : colors.amber;
    const previewHint = item.contentPreview ? index === itemOffset ? "  shortened; Ctrl+O full message" : "  shortened" : "";
    output.push(`${color}${colors.bold}${compactWhitespace(sanitizeTuiText(itemLabel(item)))}${index === itemOffset && lineOffset ? " (continued)" : ""}${colors.reset} ${colors.dim}${compactTime(item.timestamp)}${previewHint}${colors.reset}`);
    const remaining = Math.max(0, rows - output.length);
    const wrapped = wrapTuiSourceText(itemBody(item), width).slice(index === itemOffset ? lineOffset : 0, (index === itemOffset ? lineOffset : 0) + remaining);
    output.push(...wrapped.map((line) => highlight(line, query)));
    if (output.length < rows) output.push("");
  }
  return output.slice(0, rows);
}

function getPreviewItems(detail: SessionDetailResponse, query: string): ConversationItem[] {
  let items = conversationItems(detail);
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
  return `Agent Session Browser TUI\n\nUsage:\n  asb [tui] [--query text] [--provider codex|claude|gemini|pi]\n  asb [tui] --session <id-or-path> --print-resume\n  asb [tui] --session <id-or-path> --export md|html [--mode conversation|readable|trace]\n\nOptions:\n  -q, --query <text>       Find sessions by first prompt or ID\n  --provider <provider>    Restrict the session list\n  --session <id-or-path>   Open, resume, or export one session\n  --print-resume           Print its native resume command\n  --export <md|html>       Export without opening the TUI\n  --mode <mode>            conversation, readable, or trace\n  -h, --help               Show this help\n`;
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
function sessionIdentity(session: SessionSummary): string {
  if (!session.cwd) return `${providerLabel(session.provider)} session`;
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || session.cwd;
}
function finderTerms(query: string): string[] { return query.trim().split(/\s+/).map((term) => term.replace(/"/g, "").toLowerCase()).filter(Boolean).slice(0, 8); }
function matchesFinderQuery(value: string, query: string): boolean { const normalized = value.toLowerCase(); const terms = finderTerms(query); return terms.length > 0 && terms.every((term) => normalized.includes(term)); }
function sessionFinderPreview(session: SessionSummary, query: string): string {
  const prompt = session.firstUserMessage || "No user prompt recorded";
  const identity = sessionIdentity(session);
  if (!query) return prompt;
  if (matchesFinderQuery(identity, query)) return identity;
  if (matchesFinderQuery(prompt, query)) return prompt;
  return [session.nativeId, session.id].find((identifier) => matchesFinderQuery(identifier, query)) || prompt;
}
function truncate(value: string, width: number): string { return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 3))}...`; }
function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return "";
  let output = "";
  let visible = 0;
  for (let index = 0; index < value.length && visible < width;) {
    if (value[index] === ESC) {
      const sequence = value.slice(index).match(/^\x1b\[[0-9;]*m/)?.[0];
      if (sequence) { output += sequence; index += sequence.length; continue; }
    }
    const character = String.fromCodePoint(value.codePointAt(index)!);
    output += character;
    index += character.length;
    visible += 1;
  }
  return value.includes(ESC) ? `${output}${colors.reset}` : output;
}
function padAnsi(value: string, width: number): string { const length = stripAnsi(value).length; return length >= width ? truncateAnsi(value, width) : value + " ".repeat(width - length); }
function itemBody(item: ConversationItem): string { return item.text || item.summary || item.toolName || item.payloadType || item.envelopeType; }
function highlight(value: string, query: string): string {
  const terms = Array.from(new Set(finderTerms(query))).sort((left, right) => right.length - left.length);
  if (!terms.length) return value;
  return value.replace(new RegExp(terms.map(escapeRegex).join("|"), "ig"), (match) => `${colors.inverse}${match}${colors.reset}`);
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

main().catch((error) => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
