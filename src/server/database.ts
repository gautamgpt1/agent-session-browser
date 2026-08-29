import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ArchiveState,
  ConversationItem,
  FacetsResponse,
  HumanInputsResponse,
  IndexStatus,
  ParseStatus,
  ResolveSessionResponse,
  SessionDetailResponse,
  SessionListResponse,
  SessionSummary,
  StatsResponse,
  ToolCall,
  ToolsResponse
} from "../shared/types.js";
import type { ParsedSession } from "./parser.js";
import { normalizeFtsQuery } from "./text.js";

type Row = Record<string, any>;
export const PARSER_VERSION = 9;

export interface SessionFilters {
  q?: string;
  cwd?: string;
  from?: string;
  to?: string;
  tool?: string;
  provider?: string;
  modelProvider?: string;
  originator?: string;
  archived?: string;
  hasErrors?: string;
  limit?: string;
  offset?: string;
  sort?: string;
}

export class ViewerDatabase {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        native_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        archive_state TEXT NOT NULL,
        cwd TEXT,
        originator TEXT,
        source TEXT,
        cli_version TEXT,
        model_provider TEXT,
        started_at TEXT,
        last_event_at TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,
        source_mtime_ms REAL NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL,
        parse_status TEXT NOT NULL,
        parse_error TEXT,
        first_user_message TEXT,
        last_assistant_message TEXT,
        tool_names TEXT NOT NULL DEFAULT '[]',
        item_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS turns (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        started_at TEXT,
        cwd TEXT,
        current_date TEXT,
        approval_policy TEXT,
        sandbox_policy TEXT,
        UNIQUE(session_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        timestamp TEXT,
        envelope_type TEXT NOT NULL,
        payload_type TEXT,
        role TEXT,
        tool_name TEXT,
        call_id TEXT,
        phase TEXT,
        native_id TEXT,
        parent_id TEXT,
        request_id TEXT,
        model TEXT,
        stop_reason TEXT,
        usage_json TEXT,
        provider_metadata_json TEXT,
        summary TEXT,
        text TEXT,
        raw_json TEXT NOT NULL,
        line_no INTEGER NOT NULL,
        sequence INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        timestamp TEXT,
        tool_name TEXT NOT NULL,
        call_id TEXT,
        arguments_json TEXT,
        output_text TEXT,
        status TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id UNINDEXED,
        content
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_last_event ON sessions(last_event_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
      CREATE INDEX IF NOT EXISTS idx_sessions_source_path ON sessions(source_path);
      CREATE INDEX IF NOT EXISTS idx_items_session_sequence ON items(session_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_session_sequence_unique ON items(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_items_call_id ON items(call_id);
      CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(tool_name);
      CREATE INDEX IF NOT EXISTS idx_tools_session ON tools(session_id);
    `);
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Existing databases already have the column.
    }
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN native_id TEXT");
    } catch {
      // Existing databases already have the column.
    }
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'");
    } catch {
      // Existing databases already have the column.
    }
    this.db.exec("UPDATE sessions SET native_id = id WHERE native_id IS NULL OR native_id = ''");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider)");
    for (const [column, type] of [
      ["native_id", "TEXT"],
      ["parent_id", "TEXT"],
      ["request_id", "TEXT"],
      ["model", "TEXT"],
      ["stop_reason", "TEXT"],
      ["usage_json", "TEXT"],
      ["provider_metadata_json", "TEXT"]
    ] as const) {
      try {
        this.db.exec(`ALTER TABLE items ADD COLUMN ${column} ${type}`);
      } catch {
        // Existing databases already have the column.
      }
    }
  }

  getKnownFile(sourcePath: string): { id: string; bytes: number; sourceMtimeMs: number; parserVersion: number } | null {
    const row = this.db
      .prepare("SELECT id, bytes, source_mtime_ms AS sourceMtimeMs, parser_version AS parserVersion FROM sessions WHERE source_path = ?")
      .get(sourcePath) as Row | undefined;
    return row ? { id: row.id, bytes: row.bytes, sourceMtimeMs: row.sourceMtimeMs, parserVersion: row.parserVersion } : null;
  }

  upsertParsedSession(session: ParsedSession): void {
    const indexedAt = new Date().toISOString();
    const toolNames = Array.from(new Set(session.tools.map((tool) => tool.toolName))).sort();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT id FROM sessions WHERE source_path = ?").get(session.sourcePath) as Row | undefined;
      if (old && old.id !== session.id) {
        this.deleteSession(old.id);
      }
      this.deleteVolatileSessionChildren(session.id);
      this.db.prepare(`
        INSERT INTO sessions (
          id, native_id, provider, source_path, archive_state, cwd, originator, source, cli_version, model_provider,
          started_at, last_event_at, bytes, source_mtime_ms, line_count, indexed_at, parse_status,
          parse_error, first_user_message, last_assistant_message, tool_names, item_count, tool_count, parser_version
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          native_id = excluded.native_id,
          provider = excluded.provider,
          source_path = excluded.source_path,
          archive_state = excluded.archive_state,
          cwd = excluded.cwd,
          originator = excluded.originator,
          source = excluded.source,
          cli_version = excluded.cli_version,
          model_provider = excluded.model_provider,
          started_at = excluded.started_at,
          last_event_at = excluded.last_event_at,
          bytes = excluded.bytes,
          source_mtime_ms = excluded.source_mtime_ms,
          line_count = excluded.line_count,
          indexed_at = excluded.indexed_at,
          parse_status = excluded.parse_status,
          parse_error = excluded.parse_error,
          first_user_message = excluded.first_user_message,
          last_assistant_message = excluded.last_assistant_message,
          tool_names = excluded.tool_names,
          item_count = excluded.item_count,
          tool_count = excluded.tool_count,
          parser_version = excluded.parser_version
      `).run(
        session.id,
        session.nativeId,
        session.provider,
        session.sourcePath,
        session.archiveState,
        session.cwd,
        session.originator,
        session.source,
        session.cliVersion,
        session.modelProvider,
        session.startedAt,
        session.lastEventAt,
        session.bytes,
        session.mtimeMs,
        session.lineCount,
        indexedAt,
        session.parseStatus,
        session.parseError,
        session.firstUserMessage,
        session.lastAssistantMessage,
        JSON.stringify(toolNames),
        session.items.length,
        session.tools.length,
        PARSER_VERSION
      );

      const insertTurn = this.db.prepare(`
        INSERT OR REPLACE INTO turns (
          session_id, turn_id, started_at, cwd, current_date, approval_policy, sandbox_policy
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const turn of session.turns) {
        insertTurn.run(
          session.id,
          turn.turnId,
          turn.startedAt,
          turn.cwd,
          turn.currentDate,
          turn.approvalPolicy,
          turn.sandboxPolicy
        );
      }

      const insertItem = this.db.prepare(`
        INSERT INTO items (
          session_id, turn_id, timestamp, envelope_type, payload_type, role, tool_name, call_id,
          phase, native_id, parent_id, request_id, model, stop_reason, usage_json, provider_metadata_json,
          summary, text, raw_json, line_no, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, sequence) DO UPDATE SET
          turn_id = excluded.turn_id,
          timestamp = excluded.timestamp,
          envelope_type = excluded.envelope_type,
          payload_type = excluded.payload_type,
          role = excluded.role,
          tool_name = excluded.tool_name,
          call_id = excluded.call_id,
          phase = excluded.phase,
          native_id = excluded.native_id,
          parent_id = excluded.parent_id,
          request_id = excluded.request_id,
          model = excluded.model,
          stop_reason = excluded.stop_reason,
          usage_json = excluded.usage_json,
          provider_metadata_json = excluded.provider_metadata_json,
          summary = excluded.summary,
          text = excluded.text,
          raw_json = excluded.raw_json,
          line_no = excluded.line_no
      `);
      for (const item of session.items) {
        insertItem.run(
          session.id,
          item.turnId,
          item.timestamp,
          item.envelopeType,
          item.payloadType,
          item.role,
          item.toolName,
          item.callId,
          item.phase,
          item.nativeId || null,
          item.parentId || null,
          item.requestId || null,
          item.model || null,
          item.stopReason || null,
          item.usageJson || null,
          item.providerMetadataJson || null,
          item.summary,
          item.text,
          item.rawJson || "{}",
          item.lineNo,
          item.sequence
        );
      }
      this.db.prepare("DELETE FROM items WHERE session_id = ? AND sequence >= ?").run(session.id, session.items.length);

      const insertTool = this.db.prepare(`
        INSERT INTO tools (
          session_id, turn_id, timestamp, tool_name, call_id, arguments_json, output_text, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tool of session.tools) {
        insertTool.run(
          session.id,
          tool.turnId,
          tool.timestamp,
          tool.toolName,
          tool.callId,
          tool.argumentsJson,
          tool.outputText,
          tool.status
        );
      }

      this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(session.id);
      this.db.prepare("INSERT INTO session_fts(session_id, content) VALUES (?, ?)").run(session.id, session.searchText);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteSession(id: string): void {
    this.deleteSessionChildren(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteSessionChildren(id: string): void {
    this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM tools WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM items WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
  }

  deleteVolatileSessionChildren(id: string): void {
    this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM tools WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
  }

  pruneMissingSources(validPaths: Set<string>, roots: string[]): number {
    const rows = this.db.prepare("SELECT id, source_path AS sourcePath FROM sessions").all() as Row[];
    let removed = 0;
    for (const row of rows) {
      const sourcePath = String(row.sourcePath);
      const isManaged = roots.some((root) => {
        const relative = path.relative(root, sourcePath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });
      if (isManaged && !validPaths.has(sourcePath)) {
        this.deleteSession(String(row.id));
        removed += 1;
      }
    }
    return removed;
  }

  listSessions(filters: SessionFilters, status: IndexStatus): SessionListResponse {
    const { where, params } = this.buildSessionWhere(filters);
    const orderBy = filters.sort === "oldest" ? "COALESCE(started_at, last_event_at) ASC" : "COALESCE(last_event_at, started_at) DESC";
    const limit = clamp(Number(filters.limit || 50), 1, 200);
    const offset = Math.max(0, Number(filters.offset || 0));
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Row[];
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM sessions ${where}`).get(...params) as Row;
    return {
      sessions: rows.map(rowToSessionSummary),
      total: Number(totalRow.total || 0),
      status
    };
  }

  getSessionDetail(id: string): SessionDetailResponse | null {
    const sessionRow = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    if (!sessionRow) return null;
    const itemRows = this.db.prepare(`
      SELECT id, session_id AS sessionId, turn_id AS turnId, timestamp, envelope_type AS envelopeType,
        payload_type AS payloadType, role, tool_name AS toolName, call_id AS callId, phase, summary, text,
        native_id AS nativeId, parent_id AS parentId, request_id AS requestId, model,
        stop_reason AS stopReason, usage_json AS usageJson, provider_metadata_json AS providerMetadataJson,
        line_no AS lineNo, sequence
      FROM items
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(id) as Row[];
    const turnRows = this.db.prepare(`
      SELECT turn_id AS turnId, started_at AS startedAt, cwd, current_date AS currentDate,
        approval_policy AS approvalPolicy, sandbox_policy AS sandboxPolicy
      FROM turns
      WHERE session_id = ?
      ORDER BY started_at ASC, row_id ASC
    `).all(id) as Row[];
    const turnMap = new Map<string, any>();
    for (const row of turnRows) {
      turnMap.set(row.turnId, { ...row, items: [] });
    }
    for (const item of itemRows) {
      const turnId = item.turnId || "timeline";
      if (!turnMap.has(turnId)) {
        turnMap.set(turnId, {
          turnId,
          startedAt: item.timestamp,
          cwd: null,
          currentDate: null,
          approvalPolicy: null,
          sandboxPolicy: null,
          items: []
        });
      }
      turnMap.get(turnId).items.push(item);
    }
    return {
      session: rowToSessionSummary(sessionRow),
      turns: Array.from(turnMap.values()),
      tools: this.listTools({ sessionId: id }).tools
    };
  }

  getFacets(): FacetsResponse {
    const singleColumn = (sql: string) =>
      (this.db.prepare(sql).all() as Row[]).map((row) => String(row.value)).filter(Boolean);
    const dateRow = this.db.prepare("SELECT MIN(started_at) AS min, MAX(last_event_at) AS max FROM sessions").get() as Row;
    return {
      providers: singleColumn("SELECT DISTINCT provider AS value FROM sessions ORDER BY provider") as FacetsResponse["providers"],
      cwds: singleColumn("SELECT DISTINCT cwd AS value FROM sessions WHERE cwd IS NOT NULL ORDER BY cwd"),
      toolNames: singleColumn("SELECT DISTINCT tool_name AS value FROM tools ORDER BY tool_name"),
      originators: singleColumn("SELECT DISTINCT originator AS value FROM sessions WHERE originator IS NOT NULL ORDER BY originator"),
      modelProviders: singleColumn("SELECT DISTINCT model_provider AS value FROM sessions WHERE model_provider IS NOT NULL ORDER BY model_provider"),
      archiveStates: singleColumn("SELECT DISTINCT archive_state AS value FROM sessions ORDER BY archive_state") as ArchiveState[],
      parseStatuses: singleColumn("SELECT DISTINCT parse_status AS value FROM sessions ORDER BY parse_status") as ParseStatus[],
      dateRange: {
        min: dateRow?.min || null,
        max: dateRow?.max || null
      }
    };
  }

  listTools(filters: SessionFilters & { sessionId?: string }): ToolsResponse {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filters.sessionId) {
      clauses.push("t.session_id = ?");
      params.push(filters.sessionId);
    }
    const selectedTools = parseFilterList(filters.tool);
    if (selectedTools.length > 0) {
      clauses.push(`t.tool_name IN (${placeholders(selectedTools.length)})`);
      params.push(...selectedTools);
    }
    if (filters.cwd) {
      clauses.push("s.cwd = ?");
      params.push(filters.cwd);
    }
    if (filters.provider) {
      clauses.push("s.provider = ?");
      params.push(filters.provider);
    }
    if (filters.from) {
      clauses.push("COALESCE(t.timestamp, s.started_at) >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push("COALESCE(t.timestamp, s.last_event_at) <= ?");
      params.push(filters.to);
    }
    if (filters.q) {
      clauses.push("(t.tool_name LIKE ? OR t.arguments_json LIKE ? OR t.output_text LIKE ?)");
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = clamp(Number(filters.limit || 100), 1, 500);
    const offset = Math.max(0, Number(filters.offset || 0));
    const rows = this.db.prepare(`
      SELECT t.id, t.session_id AS sessionId, t.turn_id AS turnId, t.timestamp, t.tool_name AS toolName,
        t.call_id AS callId, t.arguments_json AS argumentsJson, t.output_text AS outputText, t.status,
        s.cwd, s.archive_state AS archiveState
      FROM tools t
      JOIN sessions s ON s.id = t.session_id
      ${where}
      ORDER BY COALESCE(t.timestamp, s.last_event_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Row[];
    const count = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM tools t
      JOIN sessions s ON s.id = t.session_id
      ${where}
    `).get(...params) as Row;
    return {
      tools: rows as ToolCall[],
      total: Number(count.total || 0)
    };
  }

  getRawItem(id: number): string | null {
    const row = this.db.prepare("SELECT raw_json AS rawJson FROM items WHERE id = ?").get(id) as Row | undefined;
    return row?.rawJson || null;
  }

  countSessions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM sessions").get() as Row;
    return Number(row.total || 0);
  }

  resolveSession(value: string): ResolveSessionResponse {
    const needle = value.trim();
    if (!needle) return { session: null, matchedBy: null };
    const normalizedPath = path.resolve(needle).toLowerCase();
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE id = ? OR native_id = ? OR LOWER(source_path) = ?
      ORDER BY CASE WHEN id = ? THEN 0 WHEN native_id = ? THEN 1 ELSE 2 END,
        COALESCE(last_event_at, started_at) DESC
      LIMIT 1
    `).all(needle, needle, normalizedPath, needle, needle) as Row[];
    const row = rows[0];
    if (!row) return { session: null, matchedBy: null };
    const matchedBy = row.id === needle ? "id" : row.native_id === needle ? "nativeId" : "path";
    return { session: rowToSessionSummary(row), matchedBy };
  }

  listHumanInputs(limit = 200, offset = 0): HumanInputsResponse {
    const boundedLimit = clamp(limit, 1, 1_000);
    const boundedOffset = Math.max(0, offset);
    const rows = this.db.prepare(`
      SELECT i.id, i.session_id AS sessionId, s.provider, s.cwd, i.timestamp, i.text
      FROM items i
      JOIN sessions s ON s.id = i.session_id
      WHERE i.role = 'user' AND i.text IS NOT NULL AND TRIM(i.text) != ''
      ORDER BY COALESCE(i.timestamp, s.started_at) DESC, i.id DESC
    `).all() as Row[];
    const seen = new Set<string>();
    const inputs = rows.filter((row) => {
      const text = String(row.text).trim();
      if (looksLikeGeneratedContext(text)) return false;
      const key = `${row.sessionId}\u0000${text.replace(/\s+/g, " ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      inputs: inputs.slice(boundedOffset, boundedOffset + boundedLimit) as HumanInputsResponse["inputs"],
      total: inputs.length
    };
  }

  getStats(): StatsResponse {
    const sessionRows = this.db.prepare(`
      SELECT provider, COUNT(*) AS sessions, SUM(item_count) AS items, SUM(tool_count) AS tools
      FROM sessions GROUP BY provider ORDER BY sessions DESC
    `).all() as Row[];
    const usageRows = this.db.prepare(`
      SELECT s.provider, i.usage_json AS usageJson
      FROM items i JOIN sessions s ON s.id = i.session_id
      WHERE i.usage_json IS NOT NULL
    `).all() as Row[];
    const usageByProvider = new Map<string, ReturnType<typeof emptyUsage>>();
    for (const row of usageRows) {
      const aggregate = usageByProvider.get(row.provider) || emptyUsage();
      addUsage(aggregate, row.usageJson);
      usageByProvider.set(row.provider, aggregate);
    }
    const activityByProvider = new Map<string, number>();
    const previousBySession = new Map<string, number>();
    const activityRows = this.db.prepare(`
      SELECT s.provider, i.session_id AS sessionId, i.timestamp
      FROM items i JOIN sessions s ON s.id = i.session_id
      WHERE i.timestamp IS NOT NULL
      ORDER BY i.session_id, i.timestamp, i.sequence
    `).all() as Row[];
    for (const row of activityRows) {
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      const previous = previousBySession.get(row.sessionId);
      if (previous != null) {
        const gapMs = timestamp - previous;
        if (gapMs >= 0) activityByProvider.set(row.provider, (activityByProvider.get(row.provider) || 0) + Math.min(gapMs, 15 * 60_000));
      }
      previousBySession.set(row.sessionId, timestamp);
    }
    const providers = sessionRows.map((row) => {
      const usage = usageByProvider.get(row.provider) || emptyUsage();
      return {
        provider: row.provider,
        sessions: Number(row.sessions || 0),
        items: Number(row.items || 0),
        tools: Number(row.tools || 0),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens || usage.inputTokens + usage.outputTokens,
        estimatedCost: usage.estimatedCost,
        durationHours: Number(((activityByProvider.get(row.provider) || 0) / 3_600_000).toFixed(2))
      };
    }) as StatsResponse["providers"];
    return providers.reduce<StatsResponse>((total, provider) => ({
      providers,
      sessions: total.sessions + provider.sessions,
      items: total.items + provider.items,
      tools: total.tools + provider.tools,
      inputTokens: total.inputTokens + provider.inputTokens,
      outputTokens: total.outputTokens + provider.outputTokens,
      totalTokens: total.totalTokens + provider.totalTokens,
      estimatedCost: total.estimatedCost + provider.estimatedCost,
      durationHours: Number((total.durationHours + provider.durationHours).toFixed(2))
    }), { providers, sessions: 0, items: 0, tools: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, durationHours: 0 });
  }

  getSessionRawItems(id: string): string[] {
    return (this.db.prepare("SELECT raw_json AS rawJson FROM items WHERE session_id = ? ORDER BY sequence").all(id) as Row[])
      .map((row) => String(row.rawJson));
  }

  private buildSessionWhere(filters: SessionFilters): { where: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    const fts = normalizeFtsQuery(filters.q);
    if (fts) {
      clauses.push("id IN (SELECT session_id FROM session_fts WHERE session_fts MATCH ?)");
      params.push(fts);
    }
    if (filters.cwd) {
      clauses.push("cwd = ?");
      params.push(filters.cwd);
    }
    if (filters.provider) {
      clauses.push("provider = ?");
      params.push(filters.provider);
    }
    if (filters.from) {
      clauses.push("COALESCE(started_at, last_event_at) >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push("COALESCE(last_event_at, started_at) <= ?");
      params.push(filters.to);
    }
    const selectedTools = parseFilterList(filters.tool);
    if (selectedTools.length > 0) {
      clauses.push(`EXISTS (SELECT 1 FROM tools t WHERE t.session_id = sessions.id AND t.tool_name IN (${placeholders(selectedTools.length)}))`);
      params.push(...selectedTools);
    }
    if (filters.modelProvider) {
      clauses.push("model_provider = ?");
      params.push(filters.modelProvider);
    }
    if (filters.originator) {
      clauses.push("originator = ?");
      params.push(filters.originator);
    }
    if (filters.archived === "true") {
      clauses.push("archive_state = 'archived'");
    } else if (filters.archived === "false") {
      clauses.push("archive_state = 'active'");
    }
    if (filters.hasErrors === "true") {
      clauses.push("parse_status != 'ok'");
    } else if (filters.hasErrors === "false") {
      clauses.push("parse_status = 'ok'");
    }
    return {
      where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      params
    };
  }
}

function looksLikeGeneratedContext(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("<environment_context>") || value.startsWith("<permissions instructions>") ||
    value.startsWith("<collaboration_mode>") || value.startsWith("<developer") || value.startsWith("<system");
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
}

function addUsage(target: ReturnType<typeof emptyUsage>, raw: string): void {
  try {
    const usage = JSON.parse(raw) as Record<string, unknown>;
    target.inputTokens += numberFrom(usage, ["input_tokens", "inputTokens", "input"]);
    target.outputTokens += numberFrom(usage, ["output_tokens", "outputTokens", "output"]);
    target.totalTokens += numberFrom(usage, ["total_tokens", "totalTokens"]);
    const cost = usage.cost;
    if (typeof cost === "number") target.estimatedCost += cost;
    if (cost && typeof cost === "object") target.estimatedCost += numberFrom(cost as Record<string, unknown>, ["total"]);
  } catch {
    // Provider usage metadata is optional and versioned independently.
  }
}

function numberFrom(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate)) return candidate;
  }
  return 0;
}

function rowToSessionSummary(row: Row): SessionSummary {
  return {
    id: row.id,
    nativeId: row.native_id || row.id,
    provider: row.provider || "codex",
    sourcePath: row.source_path,
    archiveState: row.archive_state,
    cwd: row.cwd,
    originator: row.originator,
    source: row.source,
    cliVersion: row.cli_version,
    modelProvider: row.model_provider,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    bytes: Number(row.bytes || 0),
    lineCount: Number(row.line_count || 0),
    indexedAt: row.indexed_at,
    parseStatus: row.parse_status,
    parseError: row.parse_error,
    firstUserMessage: row.first_user_message,
    lastAssistantMessage: row.last_assistant_message,
    toolNames: safeJsonArray(row.tool_names),
    itemCount: Number(row.item_count || 0),
    toolCount: Number(row.tool_count || 0)
  };
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseFilterList(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value || "";
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
