import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArchiveState, FacetsResponse, IndexStatus, ParseStatus, ResolveSessionResponse, SessionListResponse, SessionSummary } from "../shared/types.js";
import type { ParsedSession } from "./parser.js";
import { normalizeSearchTerms } from "./text.js";

type Row = Record<string, any>;
export const PARSER_VERSION = 11;

export interface SessionFilters {
  q?: string; cwd?: string; from?: string; to?: string; tool?: string; provider?: string;
  modelProvider?: string; originator?: string; archived?: string; hasErrors?: string;
  limit?: string; offset?: string; sort?: string;
}

export class ViewerDatabase {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string, _options: { forcePlainTextSearch?: boolean } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    removeLegacyContentCache(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, native_id TEXT NOT NULL, provider TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE, archive_state TEXT NOT NULL, cwd TEXT,
        originator TEXT, source TEXT, cli_version TEXT, model_provider TEXT,
        started_at TEXT, last_event_at TEXT, bytes INTEGER NOT NULL DEFAULT 0,
        source_mtime_ms REAL NOT NULL DEFAULT 0, line_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL, parse_status TEXT NOT NULL, parse_error TEXT,
        first_user_message TEXT, last_assistant_message TEXT,
        tool_names TEXT NOT NULL DEFAULT '[]', item_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0, parser_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
      CREATE INDEX IF NOT EXISTS idx_sessions_source_path ON sessions(source_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
    `);
  }

  getKnownFile(sourcePath: string): { id: string; bytes: number; sourceMtimeMs: number; parserVersion: number } | null {
    const row = this.db.prepare("SELECT id, bytes, source_mtime_ms AS sourceMtimeMs, parser_version AS parserVersion FROM sessions WHERE source_path = ?").get(sourcePath) as Row | undefined;
    return row ? { id: row.id, bytes: Number(row.bytes), sourceMtimeMs: Number(row.sourceMtimeMs), parserVersion: Number(row.parserVersion) } : null;
  }

  upsertParsedSession(session: ParsedSession): void {
    const old = this.db.prepare("SELECT id FROM sessions WHERE source_path = ?").get(session.sourcePath) as Row | undefined;
    if (old && old.id !== session.id) this.db.prepare("DELETE FROM sessions WHERE id = ?").run(old.id);
    const toolNames = Array.from(new Set(session.tools.map((tool) => tool.toolName))).sort();
    this.db.prepare(`
      INSERT INTO sessions (
        id, native_id, provider, source_path, archive_state, cwd, originator, source, cli_version, model_provider,
        started_at, last_event_at, bytes, source_mtime_ms, line_count, indexed_at, parse_status,
        parse_error, first_user_message, last_assistant_message, tool_names, item_count, tool_count, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_id = excluded.native_id, provider = excluded.provider, source_path = excluded.source_path,
        archive_state = excluded.archive_state, cwd = COALESCE(excluded.cwd, sessions.cwd),
        originator = COALESCE(excluded.originator, sessions.originator), source = COALESCE(excluded.source, sessions.source),
        cli_version = COALESCE(excluded.cli_version, sessions.cli_version), model_provider = COALESCE(excluded.model_provider, sessions.model_provider),
        started_at = COALESCE(excluded.started_at, sessions.started_at), last_event_at = COALESCE(excluded.last_event_at, sessions.last_event_at),
        bytes = excluded.bytes, source_mtime_ms = excluded.source_mtime_ms,
        line_count = CASE WHEN excluded.line_count > 0 THEN excluded.line_count ELSE sessions.line_count END,
        indexed_at = excluded.indexed_at, parse_status = excluded.parse_status, parse_error = excluded.parse_error,
        first_user_message = COALESCE(excluded.first_user_message, sessions.first_user_message),
        last_assistant_message = COALESCE(excluded.last_assistant_message, sessions.last_assistant_message),
        tool_names = CASE WHEN excluded.tool_names != '[]' THEN excluded.tool_names ELSE sessions.tool_names END,
        item_count = CASE WHEN excluded.item_count > 0 THEN excluded.item_count ELSE sessions.item_count END,
        tool_count = CASE WHEN excluded.tool_count > 0 THEN excluded.tool_count ELSE sessions.tool_count END,
        parser_version = excluded.parser_version
    `).run(
      session.id, session.nativeId, session.provider, session.sourcePath, session.archiveState, session.cwd,
      session.originator, session.source, session.cliVersion, session.modelProvider, session.startedAt, session.lastEventAt,
      session.bytes, session.mtimeMs, session.lineCount, new Date().toISOString(), session.parseStatus, session.parseError,
      session.firstUserMessage, session.lastAssistantMessage, JSON.stringify(toolNames), session.items.length + (session.deferredRecords || 0), session.tools.length,
      PARSER_VERSION
    );
  }

  deleteSession(id: string): void { this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id); }

  pruneMissingSources(validPaths: Set<string>, roots: string[]): number {
    const rows = this.db.prepare("SELECT id, source_path AS sourcePath FROM sessions").all() as Row[];
    let removed = 0;
    for (const row of rows) {
      const sourcePath = String(row.sourcePath);
      const isManaged = roots.some((root) => {
        const relative = path.relative(root, sourcePath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
      if (isManaged && !validPaths.has(sourcePath)) { this.deleteSession(String(row.id)); removed += 1; }
    }
    return removed;
  }

  async listSessions(filters: SessionFilters, status: IndexStatus, signal?: AbortSignal): Promise<SessionListResponse> {
    const { where, params } = this.buildSessionWhere(filters);
    const orderBy = filters.sort === "oldest" ? "COALESCE(started_at, last_event_at) ASC" : "COALESCE(last_event_at, started_at) DESC";
    const rows = this.db.prepare(`SELECT * FROM sessions ${where} ORDER BY ${orderBy}`).all(...params) as Row[];
    const queryTerms = normalizeSearchTerms(filters.q).map((term) => term.toLowerCase());
    const toolTerms = parseFilterList(filters.tool).map((term) => term.toLowerCase());
    const candidates = rows.map(rowToSessionSummary);
    const found = queryTerms.length ? findSessions(candidates, queryTerms, filters.q || "") : candidates;
    const matched = toolTerms.length ? await filterSourceFilesByTool(found, toolTerms, signal) : found;
    const limit = filters.limit === "all" ? matched.length : clamp(Number(filters.limit || 50), 1, 200);
    const offset = Math.max(0, Number(filters.offset || 0));
    return { sessions: matched.slice(offset, offset + limit), total: matched.length, status };
  }

  getSession(id: string): SessionSummary | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToSessionSummary(row) : null;
  }

  getFacets(): FacetsResponse {
    const singleColumn = (sql: string) => (this.db.prepare(sql).all() as Row[]).map((row) => String(row.value)).filter(Boolean);
    const rows = this.db.prepare("SELECT tool_names AS toolNames FROM sessions").all() as Row[];
    const toolNames = Array.from(new Set(rows.flatMap((row) => safeJsonArray(row.toolNames)))).sort();
    const dateRow = this.db.prepare("SELECT MIN(started_at) AS min, MAX(last_event_at) AS max FROM sessions").get() as Row;
    return {
      providers: singleColumn("SELECT DISTINCT provider AS value FROM sessions ORDER BY provider") as FacetsResponse["providers"],
      cwds: singleColumn("SELECT DISTINCT cwd AS value FROM sessions WHERE cwd IS NOT NULL ORDER BY cwd"),
      toolNames,
      originators: singleColumn("SELECT DISTINCT originator AS value FROM sessions WHERE originator IS NOT NULL ORDER BY originator"),
      modelProviders: singleColumn("SELECT DISTINCT model_provider AS value FROM sessions WHERE model_provider IS NOT NULL ORDER BY model_provider"),
      archiveStates: singleColumn("SELECT DISTINCT archive_state AS value FROM sessions ORDER BY archive_state") as ArchiveState[],
      parseStatuses: singleColumn("SELECT DISTINCT parse_status AS value FROM sessions ORDER BY parse_status") as ParseStatus[],
      dateRange: { min: dateRow?.min || null, max: dateRow?.max || null }
    };
  }

  countSessions(): number { return Number((this.db.prepare("SELECT COUNT(*) AS total FROM sessions").get() as Row).total || 0); }

  resolveSession(value: string): ResolveSessionResponse {
    const needle = value.trim();
    if (!needle) return { session: null, matchedBy: null };
    const normalizedPath = path.resolve(needle).toLowerCase();
    const rows = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? OR native_id = ? OR LOWER(source_path) = ?
      ORDER BY CASE WHEN id = ? THEN 0 WHEN native_id = ? THEN 1 ELSE 2 END,
        COALESCE(last_event_at, started_at) DESC LIMIT 1
    `).all(needle, needle, normalizedPath, needle, needle) as Row[];
    const row = rows[0];
    if (!row) return { session: null, matchedBy: null };
    const matchedBy = row.id === needle ? "id" : row.native_id === needle ? "nativeId" : "path";
    return { session: rowToSessionSummary(row), matchedBy };
  }

  private buildSessionWhere(filters: SessionFilters): { where: string; params: any[] } {
    const clauses: string[] = []; const params: any[] = [];
    if (filters.cwd) { clauses.push("INSTR(LOWER(cwd), LOWER(?)) > 0"); params.push(filters.cwd); }
    if (filters.provider) { clauses.push("provider = ?"); params.push(filters.provider); }
    if (filters.from) { clauses.push("date(COALESCE(started_at, last_event_at)) >= date(?)"); params.push(filters.from); }
    if (filters.to) { clauses.push("date(COALESCE(last_event_at, started_at)) <= date(?)"); params.push(filters.to); }
    if (filters.modelProvider) { clauses.push("model_provider = ?"); params.push(filters.modelProvider); }
    if (filters.originator) { clauses.push("originator = ?"); params.push(filters.originator); }
    if (filters.archived === "true") clauses.push("archive_state = 'archived'"); else if (filters.archived === "false") clauses.push("archive_state = 'active'");
    if (filters.hasErrors === "true") clauses.push("parse_status != 'ok'"); else if (filters.hasErrors === "false") clauses.push("parse_status = 'ok'");
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }
}

function findSessions(sessions: SessionSummary[], queryTerms: string[], rawQuery: string): SessionSummary[] {
  const query = rawQuery.trim().toLowerCase();
  return sessions
    .map((session, index) => ({ session, index, score: sessionFinderScore(session, queryTerms, query) }))
    .filter((entry) => entry.score != null)
    .sort((left, right) => left.score! - right.score! || left.index - right.index)
    .map((entry) => entry.session);
}

function sessionFinderScore(session: SessionSummary, queryTerms: string[], query: string): number | null {
  const identity = sessionIdentity(session).toLowerCase();
  const prompt = (session.firstUserMessage || "").toLowerCase();
  const nativeId = session.nativeId.toLowerCase();
  const internalId = session.id.toLowerCase();
  const matchedField = [identity, prompt, nativeId, internalId].find((field) => queryTerms.every((term) => field.includes(term)));
  if (matchedField == null) return null;
  if (nativeId === query || internalId === query) return 0;
  if (identity === query) return 1;
  if (prompt === query) return 2;
  if (identity.startsWith(query)) return 3;
  if (prompt.startsWith(query)) return 4;
  if (identity.includes(query)) return 5;
  if (prompt.includes(query)) return 6;
  if (nativeId.startsWith(query) || internalId.startsWith(query)) return 7;
  return 8;
}

function sessionIdentity(session: SessionSummary): string {
  if (session.cwd) {
    const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts.at(-1) || session.cwd;
  }
  const provider = session.provider === "claude" ? "Claude Code" : session.provider === "gemini" ? "Gemini CLI" : session.provider === "pi" ? "Pi" : "Codex";
  return `${provider} session`;
}

async function filterSourceFilesByTool(sessions: SessionSummary[], toolTerms: string[], signal?: AbortSignal): Promise<SessionSummary[]> {
  const results = new Array<boolean>(sessions.length).fill(false); let next = 0;
  const workers = Array.from({ length: Math.min(3, sessions.length) }, async () => {
    while (next < sessions.length) {
      if (signal?.aborted) throw abortError();
      const index = next++; const session = sessions[index];
      if (session.toolNames.some((name) => toolTerms.includes(name.toLowerCase()))) { results[index] = true; continue; }
      results[index] = await sourceContains(session.sourcePath, [], toolTerms, signal);
    }
  });
  await Promise.all(workers);
  return sessions.filter((_session, index) => results[index]);
}

async function sourceContains(sourcePath: string, requiredTerms: string[], anyToolTerms: string[], signal?: AbortSignal): Promise<boolean> {
  const missing = new Set(requiredTerms); let toolMatched = anyToolTerms.length === 0;
  const toolPatterns = anyToolTerms.flatMap((term) => [
    `\"name\":\"${term}\"`, `\"name\": \"${term}\"`,
    `\"displayname\":\"${term}\"`, `\"displayname\": \"${term}\"`,
    `\"toolname\":\"${term}\"`, `\"toolname\": \"${term}\"`
  ]);
  const longest = Math.max(1, ...requiredTerms.map((term) => term.length), ...toolPatterns.map((term) => term.length));
  let carry = "";
  const stream = fs.createReadStream(sourcePath, { encoding: "utf8", highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError();
      const text = (carry + String(chunk)).toLowerCase();
      for (const term of missing) if (text.includes(term)) missing.delete(term);
      if (!toolMatched && toolPatterns.some((term) => text.includes(term))) toolMatched = true;
      if (missing.size === 0 && toolMatched) { stream.destroy(); return true; }
      carry = text.slice(-longest + 1);
    }
    return missing.size === 0 && toolMatched;
  } catch (error) {
    stream.destroy();
    if ((error as Error).name === "AbortError") throw error;
    return false;
  }
}

function removeLegacyContentCache(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  let legacy = false;
  try {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try { legacy = Boolean(probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('items', 'tools', 'session_search') LIMIT 1").get()); }
    finally { probe.close(); }
  } catch { legacy = true; }
  if (!legacy) return;
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
}

function rowToSessionSummary(row: Row): SessionSummary {
  return {
    id: row.id, nativeId: row.native_id || row.id, provider: row.provider || "codex", sourcePath: row.source_path,
    archiveState: row.archive_state, cwd: row.cwd, originator: row.originator, source: row.source,
    cliVersion: row.cli_version, modelProvider: row.model_provider, startedAt: row.started_at, lastEventAt: row.last_event_at,
    bytes: Number(row.bytes || 0), lineCount: Number(row.line_count || 0), indexedAt: row.indexed_at,
    parseStatus: row.parse_status, parseError: row.parse_error, firstUserMessage: row.first_user_message,
    lastAssistantMessage: row.last_assistant_message, toolNames: safeJsonArray(row.tool_names),
    itemCount: Number(row.item_count || 0), toolCount: Number(row.tool_count || 0)
  };
}

function safeJsonArray(value: string): string[] { try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
function parseFilterList(value: string | string[] | undefined): string[] { const raw = Array.isArray(value) ? value.join(",") : value || ""; return Array.from(new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))); }
function clamp(value: number, min: number, max: number): number { if (!Number.isFinite(value)) return min; return Math.max(min, Math.min(max, value)); }
function abortError(): Error { return Object.assign(new Error("Search cancelled"), { name: "AbortError" }); }
