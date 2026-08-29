import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { AgentProvider, ConversationItem, ExportMode, SessionDetailResponse, SessionSummary } from "../shared/types.js";
import { resolveAppConfig } from "../server/config.js";
import { ViewerDatabase } from "../server/database.js";
import { SessionIndexer } from "../server/indexer.js";
import { conversationItems, exportFileName, exportSession, resumeCommand, resumeInvocation } from "../server/session-actions.js";

const ESC = "\x1b";
const colors = {
  reset: `${ESC}[0m`, bold: `${ESC}[1m`, dim: `${ESC}[2m`, inverse: `${ESC}[7m`,
  green: `${ESC}[38;5;42m`, blue: `${ESC}[38;5;75m`, amber: `${ESC}[38;5;214m`, magenta: `${ESC}[38;5;176m`, gray: `${ESC}[38;5;245m`
};

interface CliOptions {
  query: string;
  provider: AgentProvider | "";
  resolve: string | null;
  printResume: boolean;
  exportFormat: "markdown" | "html" | null;
  mode: ExportMode;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveAppConfig();
  const database = new ViewerDatabase(config.dbPath);
  const indexer = new SessionIndexer(config, database);
  try {
    await indexer.refreshAll();
    if (options.resolve) {
      const match = database.resolveSession(options.resolve);
      if (!match.session) throw new Error(`Session not found: ${options.resolve}`);
      const detail = database.getSessionDetail(match.session.id)!;
      if (options.printResume) {
        process.stdout.write(`${resumeCommand(detail.session.provider, detail.session.nativeId)}\n`);
        return;
      }
      if (options.exportFormat) {
        process.stdout.write(`${writeExport(config.dbPath, database, detail, options.exportFormat, options.mode)}\n`);
        return;
      }
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printPlain(database, options);
      return;
    }
    await runInteractive(database, config.dbPath, options);
  } finally {
    database.close();
  }
}

async function runInteractive(database: ViewerDatabase, dbPath: string, options: CliOptions): Promise<void> {
  let query = options.query;
  let provider = options.provider;
  let filterCandidates = true;
  let selected = 0;
  let mode: ExportMode = options.mode;
  let notice = "";
  let sessions: SessionSummary[] = [];
  let detail: SessionDetailResponse | null = null;
  const providers: Array<AgentProvider | ""> = ["", "codex", "claude", "gemini", "pi"];

  const load = () => {
    sessions = database.listSessions({ q: filterCandidates ? query : "", provider, limit: "200" }, emptyStatus()).sessions;
    selected = Math.max(0, Math.min(selected, sessions.length - 1));
    detail = sessions[selected] ? database.getSessionDetail(sessions[selected].id) : null;
  };
  const render = () => {
    load();
    const width = Math.max(72, process.stdout.columns || 120);
    const height = Math.max(18, process.stdout.rows || 32);
    const leftWidth = Math.max(30, Math.min(52, Math.floor(width * 0.4)));
    const rightWidth = width - leftWidth - 3;
    const header = `${colors.bold}${colors.green}Agent Session Browser${colors.reset}  ${filterCandidates ? "FILTER" : "PREVIEW SEARCH"}  ` +
      `${provider ? provider.toUpperCase() : "ALL AGENTS"}  ${sessions.length} sessions`;
    const queryLine = `${colors.gray}>${colors.reset} ${query || `${colors.dim}type to search all content${colors.reset}`}`;
    const listRows = renderList(sessions, selected, leftWidth, height - 5);
    const previewRows = renderPreview(detail, filterCandidates ? "" : query, rightWidth, height - 5, mode);
    const body: string[] = [];
    for (let i = 0; i < height - 5; i += 1) body.push(`${padAnsi(listRows[i] || "", leftWidth)} ${colors.gray}|${colors.reset} ${padAnsi(previewRows[i] || "", rightWidth)}`);
    const shortcuts = `${colors.dim}Up/Down select  type search  Ctrl+S filter/preview  Tab provider  F2 view  Ctrl+E export  Ctrl+R command  Enter resume  Esc quit${colors.reset}`;
    const status = notice ? `${colors.amber}${notice}${colors.reset}` : `${colors.dim}${detail?.session.sourcePath || ""}${colors.reset}`;
    process.stdout.write(`${ESC}[H${ESC}[2J${header}\n${queryLine}\n${body.join("\n")}\n${shortcuts}\n${truncateAnsi(status, width)}`);
  };

  process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render();

  await new Promise<void>((resolve) => {
    const close = () => {
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
      if (key.ctrl && key.name === "s") filterCandidates = !filterCandidates;
      else if (key.name === "up") selected = Math.max(0, selected - 1);
      else if (key.name === "down") selected = Math.min(sessions.length - 1, selected + 1);
      else if (key.name === "pageup") selected = Math.max(0, selected - 10);
      else if (key.name === "pagedown") selected = Math.min(sessions.length - 1, selected + 10);
      else if (key.name === "backspace") query = query.slice(0, -1);
      else if (key.name === "tab") provider = providers[(providers.indexOf(provider) + 1) % providers.length];
      else if (key.name === "f2") mode = mode === "conversation" ? "readable" : mode === "readable" ? "trace" : "conversation";
      else if (key.ctrl && key.name === "r" && detail) {
        try {
          notice = resumeCommand(detail.session.provider, detail.session.nativeId);
        } catch (error) {
          notice = (error as Error).message;
        }
      }
      else if (key.ctrl && key.name === "e" && detail) notice = `Exported ${writeExport(dbPath, database, detail, "html", mode)}`;
      else if (key.name === "return" && detail) {
        const invocation = resumeInvocation(detail.session.provider, detail.session.nativeId);
        const cwd = detail.session.cwd || process.cwd();
        close();
        const child = spawn(invocation.command, invocation.args, {
          cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
          shell: false,
          stdio: "inherit"
        });
        child.on("error", (error) => process.stderr.write(`Unable to resume session: ${error.message}\n`));
        return;
      } else if (!key.ctrl && !key.meta && value && value >= " " && value !== "\x7f") query += value;
      render();
    });
  });
}

function renderList(sessions: SessionSummary[], selected: number, width: number, rows: number): string[] {
  if (!sessions.length) return [`${colors.dim}No sessions match${colors.reset}`];
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, sessions.length - rows)));
  return sessions.slice(start, start + rows).map((session, offset) => {
    const active = start + offset === selected;
    const provider = providerColor(session.provider, session.provider.padEnd(6));
    const date = compactDate(session.lastEventAt || session.startedAt);
    const title = truncate(session.firstUserMessage || session.nativeId, Math.max(8, width - 20));
    const line = `${active ? ">" : " "} ${provider} ${colors.gray}${date}${colors.reset} ${title}`;
    return active ? `${colors.inverse}${stripAnsi(line)}${colors.reset}` : line;
  });
}

function renderPreview(detail: SessionDetailResponse | null, query: string, width: number, rows: number, mode: ExportMode): string[] {
  if (!detail) return [`${colors.dim}Select a session${colors.reset}`];
  const session = detail.session;
  const output = [
    `${colors.bold}${providerColor(session.provider, providerLabel(session.provider))}${colors.reset}  ${colors.gray}${mode}${colors.reset}`,
    `${colors.bold}${truncate(session.firstUserMessage || session.nativeId, width)}${colors.reset}`,
    `${colors.dim}${truncate(session.cwd || "Unknown workspace", width)}${colors.reset}`,
    ""
  ];
  let items = mode === "conversation" ? conversationItems(detail) : detail.turns.flatMap((turn) => turn.items).filter((item) =>
    mode === "trace" || item.role === "user" || item.role === "assistant" || item.payloadType === "reasoning" || item.toolName
  );
  if (query) items = items.filter((item) => itemBody(item).toLowerCase().includes(query.toLowerCase()));
  for (const item of items) {
    const color = item.role === "user" ? colors.blue : item.role === "assistant" ? colors.green : colors.amber;
    output.push(`${color}${colors.bold}${itemLabel(item)}${colors.reset} ${colors.dim}${compactTime(item.timestamp)}${colors.reset}`);
    output.push(...wrap(itemBody(item), width).map((line) => highlight(line, query)), "");
  }
  return output.slice(0, rows);
}

function writeExport(dbPath: string, database: ViewerDatabase, detail: SessionDetailResponse, format: "markdown" | "html", mode: ExportMode): string {
  const outputDir = path.join(path.dirname(dbPath), "exports");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, exportFileName(detail, format));
  fs.writeFileSync(outputPath, exportSession(detail, format, mode, mode === "trace" ? database.getSessionRawItems(detail.session.id) : []), "utf8");
  return outputPath;
}

function printPlain(database: ViewerDatabase, options: CliOptions): void {
  const sessions = database.listSessions({ q: options.query, provider: options.provider, limit: "200" }, emptyStatus()).sessions;
  for (const session of sessions) process.stdout.write(`${session.id}\t${session.provider}\t${session.lastEventAt || session.startedAt || ""}\t${session.cwd || ""}\t${compactWhitespace(session.firstUserMessage || session.nativeId)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { query: "", provider: "", resolve: null, printResume: false, exportFormat: null, mode: "conversation" };
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if ((value === "--query" || value === "-q") && args[i + 1]) options.query = args[++i];
    else if (value === "--provider" && args[i + 1]) options.provider = args[++i] as AgentProvider;
    else if (value === "--session" && args[i + 1]) options.resolve = args[++i];
    else if (value === "--print-resume") options.printResume = true;
    else if (value === "--export" && args[i + 1]) options.exportFormat = args[++i] === "md" ? "markdown" : "html";
    else if (value === "--mode" && args[i + 1]) options.mode = args[++i] as ExportMode;
  }
  return options;
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
function wrap(value: string, width: number): string[] { const lines: string[] = []; for (const paragraph of value.split("\n")) { if (!paragraph) { lines.push(""); continue; } for (let i = 0; i < paragraph.length; i += width) lines.push(paragraph.slice(i, i + width)); } return lines; }
function itemBody(item: ConversationItem): string { return item.text || item.summary || item.toolName || item.payloadType || item.envelopeType; }
function highlight(value: string, query: string): string { if (!query) return value; return value.replace(new RegExp(escapeRegex(query), "ig"), (match) => `${colors.inverse}${match}${colors.reset}`); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
