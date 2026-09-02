import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../src/server/config.js";
import { ViewerDatabase } from "../src/server/database.js";
import { CodexIndexer } from "../src/server/indexer.js";
import { parseCodexJsonlFile } from "../src/server/parser.js";
import { parseClaudeJsonlFile } from "../src/server/claude-parser.js";
import { parseGeminiSessionFile, readGeminiJsonSourceRecord } from "../src/server/gemini-parser.js";
import { parsePiSessionFile } from "../src/server/pi-parser.js";
import { catalogSessionFile } from "../src/server/catalog.js";
import { expandedMessageText, expandedRecordSections } from "../src/client/record-display.js";
import { exportSession, resolveResumeDirectory, resumeCommand, resumeInvocation, resumeLaunchInvocation } from "../src/server/session-actions.js";
import { LARGE_SOURCE_BYTES, SessionSourceReader } from "../src/server/source-reader.js";
import { buildSourceLineIndex, readSourceLineAt } from "../src/server/source-lines.js";
import { getTranscriptCategory, isTranscriptToolItem } from "../src/shared/transcript.js";
import type { ConversationItem } from "../src/shared/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.AGENT_SESSION_BROWSER_CODEX_HOME;
  delete process.env.AGENT_SESSION_BROWSER_CLAUDE_HOME;
  delete process.env.AGENT_SESSION_BROWSER_GEMINI_HOME;
  delete process.env.AGENT_SESSION_BROWSER_PI_HOME;
  delete process.env.AGENT_SESSION_BROWSER_DATA_DIR;
});

describe("Codex JSONL parser and indexer", () => {
  it("normalizes messages, tool calls, unknown events, and malformed lines", async () => {
    const root = makeTempCodexHome();
    const activeFile = writeJsonl(
      path.join(root, "sessions", "2026", "06", "01", "rollout-2026-06-01T00-00-00-11111111-1111-4111-8111-111111111111.jsonl"),
      [
        {
          timestamp: "2026-06-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "11111111-1111-4111-8111-111111111111",
            timestamp: "2026-06-01T00:00:00.000Z",
            cwd: "C:\\Projects\\fixture",
            originator: "codex-tui",
            cli_version: "0.141.0",
            source: "cli",
            model_provider: "openai"
          }
        },
        {
          timestamp: "2026-06-01T00:00:01.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            cwd: "C:\\Projects\\fixture",
            current_date: "2026-06-01",
            model: "gpt-test",
            approval_policy: "never",
            sandbox_policy: "workspace-write"
          }
        },
        {
          timestamp: "2026-06-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            turn_id: "turn-1",
            message: "Implement JSONL viewer fixture prompt"
          }
        },
        {
          timestamp: "2026-06-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Fixture progress update" }]
          }
        },
        {
          timestamp: "2026-06-01T00:00:03.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell_command",
            call_id: "call-1",
            arguments: "{\"command\":\"Get-ChildItem\"}"
          }
        },
        {
          timestamp: "2026-06-01T00:00:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Directory listing output"
          }
        },
        {
          timestamp: "2026-06-01T00:00:04.500Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Legacy Codex final response" }
        },
        {
          timestamp: "2026-06-01T00:00:04.501Z",
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Legacy Codex final response" }] }
        },
        {
          timestamp: "2026-06-01T00:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Fixture assistant response" }]
          }
        },
        {
          timestamp: "2026-06-01T00:00:06.000Z",
          type: "future_event",
          payload: { type: "new_payload", message: "Preserve future event" }
        },
        {
          timestamp: "2026-06-01T00:00:06.500Z",
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }
        },
        {
          timestamp: "2026-06-01T00:00:06.750Z",
          type: "event_msg",
          payload: { type: "agent_reasoning", message: "Reason through the fixture" }
        },
        {
          timestamp: "2026-06-01T00:00:07.000Z",
          type: "item.completed",
          item: {
            id: "item-command",
            type: "command_execution",
            command: "npm test",
            status: "completed"
          }
        },
        {
          method: "item/completed",
          params: {
            threadId: "11111111-1111-4111-8111-111111111111",
            turnId: "turn-1",
            completedAtMs: 1780272008000,
            item: {
              id: "item-file",
              type: "fileChange",
              summary: "Future file change summary"
            }
          }
        },
        "{not valid json"
      ]
    );

    const parsed = await parseCodexJsonlFile(activeFile, "active");
    expect(parsed.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.parseStatus).toBe("partial");
    expect(parsed.firstUserMessage).toContain("Implement JSONL viewer");
    expect(parsed.lastAssistantMessage).toContain("Fixture assistant response");
    expect(parsed.items.find((item) => item.text === "Fixture progress update")?.phase).toBe("commentary");
    expect(parsed.items.find((item) => item.text === "Fixture assistant response")?.phase).toBe("final_answer");
    expect(parsed.items.filter((item) => item.text === "Legacy Codex final response").map((item) => item.phase)).toEqual(["final_answer", "final_answer"]);
    expect(parsed.items.find((item) => item.text === "Fixture assistant response")?.model).toBe("gpt-test");
    expect(parsed.tools[0].toolName).toBe("shell_command");
    expect(parsed.tools[0].outputText).toContain("Directory listing output");
    expect(parsed.items.some((item) => item.envelopeType === "future_event")).toBe(true);
    expect(parsed.items.some((item) => item.envelopeType === "parse_error" && item.payloadType === "error")).toBe(true);
    expect(parsed.items.find((item) => item.payloadType === "token_count")?.usageJson).toContain('"total_tokens":15');
    expect(getTranscriptCategory(parsed.items.find((item) => item.payloadType === "agent_reasoning") as ConversationItem)).toBe("reasoning");
    expect(isTranscriptToolItem(parsed.items.find((item) => item.payloadType === "function_call") as ConversationItem, new Map())).toBe(true);
    expect(isTranscriptToolItem(parsed.items.find((item) => item.payloadType === "function_call_output") as ConversationItem, new Map())).toBe(true);
    expect(parsed.items.some((item) => item.envelopeType === "item.completed" && item.payloadType === "command_execution")).toBe(true);
    expect(parsed.items.some((item) => item.envelopeType === "item/completed" && item.payloadType === "fileChange")).toBe(true);
    expect(parsed.searchText).toContain("npm test");
  });

  it("indexes active and archived sessions, supports filters, raw lookup, and incremental skips", async () => {
    const root = makeTempCodexHome();
    const claudeRoot = path.join(root, "claude-home");
    const geminiRoot = path.join(root, "gemini-home");
    const piRoot = path.join(root, "pi-home");
    fs.mkdirSync(path.join(piRoot, "agent", "sessions"), { recursive: true });
    const activeFile = writeFixtureSession(root, "sessions", "11111111-1111-4111-8111-111111111111", "C:\\Projects\\fixture", "shell_command");
    writeFixtureSession(root, "archived_sessions", "22222222-2222-4222-8222-222222222222", "C:\\Projects\\archive", "apply_patch");
    writeClaudeFixture(claudeRoot);
    writeGeminiFixture(geminiRoot);

    process.env.AGENT_SESSION_BROWSER_CODEX_HOME = root;
    process.env.AGENT_SESSION_BROWSER_CLAUDE_HOME = claudeRoot;
    process.env.AGENT_SESSION_BROWSER_GEMINI_HOME = geminiRoot;
    process.env.AGENT_SESSION_BROWSER_PI_HOME = piRoot;
    process.env.AGENT_SESSION_BROWSER_DATA_DIR = path.join(root, "browser-data");
    const config = resolveAppConfig();
    const db = new ViewerDatabase(config.dbPath, { forcePlainTextSearch: true });
    try {
      const indexer = new CodexIndexer(config, db);
      const reader = new SessionSourceReader(db);

      const first = await indexer.refreshAll();
      expect(first.filesSeen).toBe(4);
      expect(first.filesIndexed).toBe(4);
      expect(first.sessions).toBe(4);

      expect((await db.listSessions({ provider: "claude" }, indexer.getStatus())).sessions[0].nativeId).toBe("33333333-3333-4333-8333-333333333333");
      expect((await db.listSessions({ provider: "gemini" }, indexer.getStatus())).sessions[0].cwd).toBe("C:\\Projects\\gemini");

      const partialDirectoryResults = await db.listSessions({ cwd: "PROJECTS\\FIXT" }, indexer.getStatus());
      expect(partialDirectoryResults.total).toBe(1);
      expect(partialDirectoryResults.sessions[0].cwd).toBe("C:\\Projects\\fixture");

      const dateRangeResults = await db.listSessions({ from: "2026-06-01", to: "2026-06-01" }, indexer.getStatus());
      expect(dateRangeResults.total).toBe(2);

      const cleanResults = await db.listSessions({ hasErrors: "false" }, indexer.getStatus());
      expect(cleanResults.total).toBe(4);
      expect((await db.listSessions({ hasErrors: "true" }, indexer.getStatus())).total).toBe(0);

      const combinedResults = await db.listSessions({
        provider: "codex",
        cwd: "fixture",
        from: "2026-06-01",
        to: "2026-06-01",
        archived: "false",
        hasErrors: "false"
      }, indexer.getStatus());
      expect(combinedResults.total).toBe(1);
      expect(combinedResults.sessions[0].nativeId).toBe("11111111-1111-4111-8111-111111111111");

      const shellResults = await db.listSessions({ tool: "shell_command" }, indexer.getStatus());
      expect(shellResults.total).toBe(1);
      expect(shellResults.sessions[0].cwd).toBe("C:\\Projects\\fixture");

      const multiToolResults = await db.listSessions({ tool: "shell_command,apply_patch" }, indexer.getStatus());
      expect(multiToolResults.total).toBe(2);

      const archivedResults = await db.listSessions({ archived: "true" }, indexer.getStatus());
      expect(archivedResults.total).toBe(1);
      expect(archivedResults.sessions[0].archiveState).toBe("archived");

      const searchResults = await db.listSessions({ q: "JSONL VIEWER" }, indexer.getStatus());
      expect(searchResults.total).toBe(2);
      expect((await db.listSessions({ q: "ARCHIVE" }, indexer.getStatus())).sessions[0].nativeId).toBe("22222222-2222-4222-8222-222222222222");
      expect((await db.listSessions({ q: "11111111" }, indexer.getStatus())).sessions[0].nativeId).toBe("11111111-1111-4111-8111-111111111111");
      expect((await db.listSessions({ q: "Fixture assistant response" }, indexer.getStatus())).total).toBe(0);
      expect((await db.listSessions({ q: "shell_COMMAND OUTPUT" }, indexer.getStatus())).total).toBe(0);

      const [detail, concurrentDetail] = await Promise.all([
        reader.getDetail("11111111-1111-4111-8111-111111111111"),
        reader.getDetail("11111111-1111-4111-8111-111111111111")
      ]);
      expect(concurrentDetail).toStrictEqual(detail);
      expect(detail?.turns.flatMap((turn) => turn.items).some((item) => item.text?.includes("Fixture assistant response"))).toBe(true);
      expect(detail?.tools[0].toolName).toBe("shell_command");

      const geminiDetail = await reader.getDetail("gemini:44444444-4444-4444-8444-444444444444");
      const geminiMessage = geminiDetail!.turns.flatMap((turn) => turn.items).find((item) => item.role === "assistant");
      expect(await reader.getRawItem(geminiDetail!.session.id, geminiMessage!.id)).toContain("Inspection complete");

      expect(db.resolveSession(activeFile).session?.nativeId).toBe("11111111-1111-4111-8111-111111111111");
      expect(db.resolveSession("11111111-1111-4111-8111-111111111111").matchedBy).toBe("id");
      expect(fs.statSync(config.dbPath).size).toBeLessThan(1_000_000);

      const markdown = exportSession(detail!, "markdown", "conversation");
      expect(markdown).toContain("## User");
      expect(markdown).toContain("## Assistant final");
      expect(markdown).not.toContain("Fixture progress update");
      const html = exportSession(detail!, "html", "trace", ['{"unsafe":"<script>alert(1)</script>"}']);
      expect(html).not.toContain("<script>alert(1)</script>");

      const metaItem = detail!.turns.flatMap((turn) => turn.items).find((item) => item.envelopeType === "session_meta");
      expect(metaItem).toBeTruthy();
      const raw = await reader.getRawItem(detail!.session.id, metaItem!.id);
      expect(raw).toContain("session_meta");

      const second = await indexer.refreshAll();
      expect(second.filesSkipped).toBe(4);

      fs.rmSync(activeFile);
      const third = await indexer.refreshAll();
      expect(third.sessions).toBe(3);
      expect(db.resolveSession("11111111-1111-4111-8111-111111111111").session).toBeNull();
    } finally {
      db.close();
    }
  });

  it("streams a large file and preserves valid records before a truncated final line", async () => {
    const root = makeTempCodexHome();
    const id = "66666666-6666-4666-8666-666666666666";
    const entries: Array<object | string> = [
      { timestamp: "2026-06-06T00:00:00.000Z", type: "session_meta", payload: { id, cwd: "C:\\Projects\\large" } },
      { timestamp: "2026-06-06T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Large fixture" } },
      ...Array.from({ length: 5_000 }, (_, index) => ({
        timestamp: `2026-06-06T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: { type: "reasoning", summary: [`Reasoning item ${index}`] }
      })),
      '{"timestamp":"2026-06-06T01:30:00.000Z","type":"response_item"'
    ];
    const file = writeJsonl(path.join(root, "sessions", "2026", "06", "06", `rollout-${id}.jsonl`), entries);

    const parsed = await parseCodexJsonlFile(file, "active");
    expect(parsed.parseStatus).toBe("partial");
    expect(parsed.parseError).toContain("Line 5003");
    expect(parsed.lineCount).toBe(5_003);
    expect(parsed.items).toHaveLength(5_003);
    expect(parsed.firstUserMessage).toBe("Large fixture");

  });

  it("replaces the legacy transcript cache with a metadata-only catalog", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-legacy-"));
    tempDirs.push(root);
    const dbPath = path.join(root, "index.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE items (raw_json TEXT NOT NULL); INSERT INTO items VALUES ('copied transcript');");
    legacy.close();

    const db = new ViewerDatabase(dbPath);
    db.close();
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    probe.close();

    expect(tables).toEqual(["sessions"]);
    expect(fs.statSync(dbPath).size).toBeLessThan(1_000_000);
  });

  it("validates resume identifiers before constructing a process invocation", () => {
    const hostileId = 'session\" & calc.exe & \"';
    expect(() => resumeInvocation("codex", hostileId)).toThrow("unsafe session identifier");
    expect(() => resumeCommand("codex", hostileId)).toThrow("unsafe session identifier");
  });

  it("launches npm-installed provider shims through the Windows command processor", () => {
    const commandProcessor = "C:\\Windows\\System32\\cmd.exe";
    expect(resumeLaunchInvocation("codex", "codex-id", "win32", commandProcessor)).toEqual({
      command: commandProcessor,
      args: ["/d", "/s", "/c", "codex", "resume", "codex-id"]
    });
    expect(resumeLaunchInvocation("claude", "claude-id", "win32", commandProcessor).args).toEqual(["/d", "/s", "/c", "claude", "--resume", "claude-id"]);
    expect(resumeLaunchInvocation("gemini", "gemini-id", "win32", commandProcessor).args).toEqual(["/d", "/s", "/c", "gemini", "--resume", "gemini-id"]);
    expect(resumeLaunchInvocation("pi", "pi-id", "win32", commandProcessor).args).toEqual(["/d", "/s", "/c", "pi", "--session", "pi-id"]);
    expect(resumeLaunchInvocation("codex", "codex-id", "linux")).toEqual({ command: "codex", args: ["resume", "codex-id"] });
  });

  it("refuses to resume without an available original working directory", () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-resume-"));
    tempDirs.push(existing);
    const missing = path.join(existing, "deleted-project");

    expect(resolveResumeDirectory(existing)).toEqual({ cwd: existing, error: null });
    expect(resolveResumeDirectory(missing)).toEqual({
      cwd: null,
      error: `Cannot resume: the original working directory no longer exists.\n${missing}`
    });
    expect(resolveResumeDirectory(null)).toEqual({
      cwd: null,
      error: "Cannot resume: this session has no recorded working directory."
    });
  });
});

describe("Claude and Gemini parsers", () => {
  it("normalizes Claude thinking, tools, results, and messages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-claude-"));
    tempDirs.push(root);
    const file = writeClaudeFixture(root);
    const parsed = await parseClaudeJsonlFile(file, "active");
    expect(parsed.provider).toBe("claude");
    expect(parsed.firstUserMessage).toContain("Claude fixture");
    expect(parsed.items.some((item) => item.payloadType === "reasoning")).toBe(true);
    expect(parsed.items.find((item) => item.text === "I will inspect the project first.")?.phase).toBe("commentary");
    expect(parsed.items.find((item) => item.text === "The Claude fixture inspection is complete.")?.phase).toBe("final_answer");
    expect(parsed.items.find((item) => item.text === "The Claude fixture inspection is complete.")).toMatchObject({
      model: "claude-test",
      stopReason: "end_turn",
      requestId: "claude-request-2",
      parentId: "claude-result"
    });
    expect(parsed.tools[0]).toMatchObject({ toolName: "Bash", outputText: "Claude fixture listing", status: "completed" });
  });

  it("keeps Claude subagents distinct from their parent while resuming the parent session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-claude-subagent-"));
    tempDirs.push(root);
    const file = writeJsonl(path.join(root, "agent-sub.jsonl"), [
      { type: "user", sessionId: "33333333-3333-4333-8333-333333333333", agentId: "agent-sub", timestamp: "2026-06-03T00:00:00.000Z", cwd: "C:\\Projects\\claude", message: { role: "user", content: [{ type: "text", text: "Subagent task" }] } }
    ]);
    const parsed = await parseClaudeJsonlFile(file, "active");
    expect(parsed.id).toBe("claude:33333333-3333-4333-8333-333333333333:agent-sub");
    expect(parsed.nativeId).toBe("33333333-3333-4333-8333-333333333333");
    expect(parsed.source).toBe("subagent");
  });

  it("normalizes Gemini thoughts, tool calls, output, and project metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-gemini-"));
    tempDirs.push(root);
    const file = writeGeminiFixture(root);
    const parsed = await parseGeminiSessionFile(file, "active", "C:\\Projects\\gemini");
    expect(parsed.provider).toBe("gemini");
    expect(parsed.firstUserMessage).toContain("Gemini fixture");
    expect(parsed.items.find((item) => item.text === "Inspection complete")?.phase).toBe("final_answer");
    expect(parsed.items.some((item) => item.payloadType === "reasoning")).toBe(true);
    expect(parsed.tools[0]).toMatchObject({ toolName: "Shell", outputText: "Gemini fixture listing", status: "success" });
  });
});

describe("Pi parser", () => {
  it("normalizes v3 branches, reasoning, tool calls, usage, and compaction metadata", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-pi-"));
    tempDirs.push(root);
    const file = writeJsonl(path.join(root, "agent", "sessions", "--fixture--", "2026-06-05_fixture.jsonl"), [
      { type: "session", version: 3, id: "pi-session-id", timestamp: "2026-06-05T00:00:00.000Z", cwd: "C:\\Projects\\pi" },
      { type: "message", id: "user0001", parentId: null, timestamp: "2026-06-05T00:00:01.000Z", message: { role: "user", content: "Inspect the Pi fixture", timestamp: 1780617601000 } },
      { type: "message", id: "asst0001", parentId: "user0001", timestamp: "2026-06-05T00:00:02.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "toolUse", usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } }, content: [{ type: "thinking", thinking: "Inspect files" }, { type: "text", text: "I will inspect." }, { type: "toolCall", id: "pi-call", name: "bash", arguments: { command: "dir" } }] } },
      { type: "message", id: "tool0001", parentId: "asst0001", timestamp: "2026-06-05T00:00:03.000Z", message: { role: "toolResult", toolCallId: "pi-call", toolName: "bash", content: [{ type: "text", text: "fixture listing" }], isError: false } },
      { type: "message", id: "asst0002", parentId: "tool0001", timestamp: "2026-06-05T00:00:04.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-test", stopReason: "stop", usage: { input: 12, output: 7, totalTokens: 19 }, content: [{ type: "text", text: "Pi fixture complete." }] } },
      { type: "branch_summary", id: "branch01", parentId: "user0001", timestamp: "2026-06-05T00:00:05.000Z", fromId: "asst0002", summary: "Alternate branch" },
      { type: "compaction", id: "compact1", parentId: "asst0002", timestamp: "2026-06-05T00:00:06.000Z", summary: "Prior context", firstKeptEntryId: "tool0001", tokensBefore: 500 }
    ]);
    const parsed = await parsePiSessionFile(file, "active");
    expect(parsed).toMatchObject({ id: "pi:pi-session-id", nativeId: "pi-session-id", provider: "pi", cwd: "C:\\Projects\\pi", modelProvider: "anthropic" });
    expect(parsed.items.find((item) => item.payloadType === "reasoning")?.text).toBe("Inspect files");
    expect(parsed.items.find((item) => item.text === "Pi fixture complete.")?.phase).toBe("final_answer");
    expect(parsed.items.find((item) => item.envelopeType === "branch_summary")?.parentId).toBe("user0001");
    expect(parsed.tools[0]).toMatchObject({ toolName: "bash", outputText: "fixture listing", status: "completed" });
    expect(resumeCommand("pi", parsed.nativeId)).toBe("pi --session pi-session-id");
  });
});

describe("large source safeguards", () => {
  it("indexes source byte ranges once and directly reads a requested line", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-source-line-"));
    tempDirs.push(root);
    const file = path.join(root, "source.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ skipped: "x".repeat(2 * 1024 * 1024) })}\r\n${JSON.stringify({ text: "Readable 你好" })}\r\n`);

    const lines = await buildSourceLineIndex(file);
    expect(lines).toHaveLength(2);
    expect(await readSourceLineAt(file, lines[1])).toBe(JSON.stringify({ text: "Readable 你好" }));
  });

  it("keeps every large-session item available through the source reader and preserves exact raw access", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-large-reader-"));
    tempDirs.push(root);
    const piFile = writeJsonl(path.join(root, "pi.jsonl"), [
      { type: "session", version: 3, id: "pi-large-session", timestamp: "2026-06-05T00:00:00.000Z", cwd: "C:\\Projects\\pi" },
      { type: "message", id: "pi-user", timestamp: "2026-06-05T00:00:01.000Z", message: { role: "user", content: "Large Pi prompt" } },
      ...Array.from({ length: 502 }, (_, index) => ({ type: "branch_summary", id: `trace-${index}`, summary: `Trace ${index}` })),
      { type: "message", id: "pi-final", timestamp: "2026-06-05T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: "Large Pi final answer" } }
    ]);
    const pi = await parsePiSessionFile(piFile, "active");
    pi.bytes = LARGE_SOURCE_BYTES;
    const db = new ViewerDatabase(path.join(root, "index.sqlite"));
    try {
      db.upsertParsedSession(pi);
      const reader = new SessionSourceReader(db);
      const detail = await reader.getDetail(pi.id);
      expect(detail?.loadedItemCount).toBe(detail?.session.itemCount);
      expect(detail?.totalMatchingItems).toBe(detail?.session.itemCount);
      expect(detail?.nextOffset).toBeNull();
      const traceIds = new Set<number>();
      let offset = 0;
      do {
        const page = await reader.getPage(pi.id, {
          offset,
          limit: 100,
          tools: [],
          categories: ["branch_summary"],
          knownCategories: ["branch_summary"],
          includeTools: offset === 0
        });
        expect(page).toBeTruthy();
        for (const item of page!.turns.flatMap((turn) => turn.items)) traceIds.add(item.id);
        if (page!.nextOffset == null) break;
        offset = page!.nextOffset;
      } while (true);
      expect(traceIds.size).toBe(502);
      const final = detail!.turns.flatMap((turn) => turn.items).find((item) => item.role === "assistant" && item.phase === "final_answer");
      expect(final?.text).toBe("Large Pi final answer");
      expect(await reader.getRawItem(detail!.session.id, final!.id)).toContain("Large Pi final answer");
      const tracePath = path.join(root, "complete-trace.md");
      await reader.writeExport(pi.id, tracePath, "markdown", "trace");
      const trace = fs.readFileSync(tracePath, "utf8");
      expect(trace).toContain("Large Pi final answer");
      expect(trace).toContain("## Raw source records");
    } finally {
      db.close();
    }
  });

  it("normalizes an oversized monolithic Gemini record without collapsing its messages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-gemini-monolith-"));
    tempDirs.push(root);
    const file = path.join(root, "legacy.json");
    const completeMessage = `gemini-start-${"x".repeat(300_000)}-gemini-end`;
    fs.writeFileSync(file, JSON.stringify({
      sessionId: "legacy-gemini",
      messages: [
        { type: "user", content: "Legacy Gemini prompt" },
        { type: "gemini", content: completeMessage, thoughts: [{ subject: "Plan", description: "Inspect everything" }] }
      ]
    }));
    const parsed = await parseGeminiSessionFile(file, "active", null, { compactItems: true });
    expect(parsed.parseStatus).toBe("ok");
    expect(parsed.parseError).toBeNull();
    expect(parsed.items.find((item) => item.role === "assistant")?.contentPreview).toBe(true);
    expect(parsed.items.find((item) => item.role === "assistant")?.text).not.toContain("gemini-end");
    expect(parsed.items.some((item) => item.payloadType === "reasoning")).toBe(true);
    const catalog = await catalogSessionFile("gemini", file, "active", "C:\\Projects\\gemini");
    expect(catalog).toMatchObject({
      id: "gemini:legacy-gemini",
      firstUserMessage: "Legacy Gemini prompt",
      cwd: "C:\\Projects\\gemini",
      parseStatus: "ok"
    });
    expect(await readGeminiJsonSourceRecord(file, 3)).toContain("gemini-end");
    expect(await readGeminiJsonSourceRecord(file, 3)).not.toContain("Legacy Gemini prompt");
  });

  it("keeps oversized semantic records pageable and fully exportable for every provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-viewer-lossless-providers-"));
    tempDirs.push(root);
    const largeText = (provider: string) => `${provider}-start-${"x".repeat(300_000)}-${provider}-end`;

    const codexFile = writeJsonl(path.join(root, "codex.jsonl"), [
      { timestamp: "2026-06-12T00:00:00.000Z", type: "session_meta", payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", cwd: "C:\\Projects\\codex" } },
      { timestamp: "2026-06-12T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Codex large prompt" } },
      { timestamp: "2026-06-12T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: largeText("codex") }] } }
    ]);
    const claudeFile = writeJsonl(path.join(root, "claude.jsonl"), [
      { type: "user", sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", uuid: "claude-user", timestamp: "2026-06-12T00:00:00.000Z", cwd: "C:\\Projects\\claude", message: { role: "user", content: [{ type: "text", text: "Claude large prompt" }] } },
      { type: "assistant", sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", uuid: "claude-assistant", timestamp: "2026-06-12T00:00:01.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [
        { type: "text", text: largeText("claude") },
        { type: "thinking", thinking: "Claude complete reasoning" },
        { type: "tool_use", id: "claude-call", name: "Read", input: { file_path: "README.md" } }
      ] } }
    ]);
    const geminiFile = path.join(root, "gemini.json");
    fs.writeFileSync(geminiFile, JSON.stringify({
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      startTime: "2026-06-12T00:00:00.000Z",
      messages: [
        { id: "gemini-user", type: "user", timestamp: "2026-06-12T00:00:01.000Z", content: "Gemini large prompt" },
        { id: "gemini-assistant", type: "gemini", timestamp: "2026-06-12T00:00:02.000Z", content: largeText("gemini"), thoughts: [{ subject: "Plan", description: "Gemini complete reasoning" }], toolCalls: [{ id: "gemini-call", name: "Shell", args: { command: "dir" }, resultDisplay: "Gemini complete output" }] }
      ]
    }), "utf8");
    const piFile = writeJsonl(path.join(root, "pi.jsonl"), [
      { type: "session", version: 3, id: "pi-lossless", timestamp: "2026-06-12T00:00:00.000Z", cwd: "C:\\Projects\\pi" },
      { type: "message", id: "pi-user", timestamp: "2026-06-12T00:00:01.000Z", message: { role: "user", content: "Pi large prompt" } },
      { type: "message", id: "pi-assistant", timestamp: "2026-06-12T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [
        { type: "text", text: largeText("pi") },
        { type: "thinking", thinking: "Pi complete reasoning" },
        { type: "toolCall", id: "pi-call", name: "bash", arguments: { command: "dir" } }
      ] } }
    ]);

    const parsedSessions = [
      await parseCodexJsonlFile(codexFile, "active"),
      await parseClaudeJsonlFile(claudeFile, "active"),
      await parseGeminiSessionFile(geminiFile, "active", "C:\\Projects\\gemini"),
      await parsePiSessionFile(piFile, "active")
    ];
    const expectedCounts = { codex: 3, claude: 4, gemini: 6, pi: 5 };
    const db = new ViewerDatabase(path.join(root, "index.sqlite"));
    try {
      for (const parsed of parsedSessions) db.upsertParsedSession(parsed);
      const reader = new SessionSourceReader(db);
      for (const parsed of parsedSessions) {
        expect(parsed.items).toHaveLength(expectedCounts[parsed.provider]);
        expect(parsed.items.some((item) => item.text?.includes(`${parsed.provider}-end`))).toBe(true);

        const ids = new Set<number>();
        let offset = 0;
        do {
          const page = await reader.getPage(parsed.id, { offset, limit: 2, includeTools: false });
          expect(page).toBeTruthy();
          for (const item of page!.turns.flatMap((turn) => turn.items)) ids.add(item.id);
          if (page!.nextOffset == null) break;
          offset = page!.nextOffset;
        } while (true);
        expect(ids.size).toBe(expectedCounts[parsed.provider]);

        const preview = await reader.getPage(parsed.id, { offset: 0, limit: 500, includeTools: false });
        const previewItem = preview!.turns.flatMap((turn) => turn.items).find((item) => item.text?.includes(`${parsed.provider}-start`));
        expect(previewItem?.contentPreview).toBe(true);
        expect(previewItem?.text).not.toContain(`${parsed.provider}-end`);
        expect(await reader.getRawItem(parsed.id, previewItem!.id)).toContain(`${parsed.provider}-end`);

        const allCategories = Object.keys(preview!.categoryCounts);
        const fullySelected = await reader.getPage(parsed.id, {
          offset: 0,
          limit: 500,
          tools: preview!.availableTools,
          categories: allCategories,
          knownCategories: allCategories,
          includeTools: false
        });
        expect(fullySelected?.totalMatchingItems).toBe(expectedCounts[parsed.provider]);
        expect(fullySelected?.loadedItemCount).toBe(expectedCounts[parsed.provider]);

        const exportPath = path.join(root, `${parsed.provider}-complete.md`);
        await reader.writeExport(parsed.id, exportPath, "markdown", "readable");
        expect(fs.readFileSync(exportPath, "utf8")).toContain(`${parsed.provider}-end`);
      }
    } finally {
      db.close();
    }
  });

  it("renders an expanded oversized record as provider content instead of raw JSON", () => {
    const completeText = `Readable full assistant response ${"x".repeat(250_000)} complete-end`;
    const sections = expandedRecordSections("codex", JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: completeText }] }
    }));
    expect(sections).toEqual([{ label: "Assistant message", kind: "message", text: completeText }]);
    expect(sections[0].text).toContain("complete-end");

    const gemini = expandedRecordSections("gemini", JSON.stringify({
      sessionId: "legacy-gemini",
      messages: [
        { type: "user", content: "Readable Gemini prompt" },
        { type: "gemini", content: completeText, thoughts: [{ subject: "Plan", description: "Readable Gemini reasoning" }] }
      ]
    }));
    expect(gemini.map((section) => section.label)).toEqual(["User message", "Assistant message", "Plan"]);
    expect(gemini[1].text).toContain("complete-end");
    expect(expandedMessageText("gemini", JSON.stringify({
      sessionId: "legacy-gemini",
      messages: [
        { type: "user", content: "Readable Gemini prompt" },
        { type: "gemini", content: completeText, thoughts: [{ subject: "Plan", description: "Readable Gemini reasoning" }] }
      ]
    }), "assistant")).toBe(completeText);
  });
});

function makeTempCodexHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-jsonl-viewer-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "archived_sessions"), { recursive: true });
  return root;
}

function writeFixtureSession(root: string, bucket: "sessions" | "archived_sessions", id: string, cwd: string, tool: string): string {
  return writeJsonl(
    path.join(root, bucket, "2026", "06", "01", `rollout-2026-06-01T00-00-00-${id}.jsonl`),
    [
      {
        timestamp: "2026-06-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id,
          timestamp: "2026-06-01T00:00:00.000Z",
          cwd,
          originator: "codex-tui",
          cli_version: "0.141.0",
          source: "cli",
          model_provider: "openai"
        }
      },
      {
        timestamp: "2026-06-01T00:00:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd, current_date: "2026-06-01" }
      },
      {
        timestamp: "2026-06-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", turn_id: "turn-1", message: "Implement JSONL viewer fixture prompt" }
      },
      {
        timestamp: "2026-06-01T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Fixture progress update" }]
        }
      },
      {
        timestamp: "2026-06-01T00:00:03.500Z",
        type: "response_item",
        payload: { type: "function_call", name: tool, call_id: `call-${tool}`, arguments: `{"tool":"${tool}"}` }
      },
      {
        timestamp: "2026-06-01T00:00:04.000Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: `call-${tool}`, output: `${tool} output` }
      },
      {
        timestamp: "2026-06-01T00:00:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Fixture assistant response" }]
        }
      }
    ]
  );
}

function writeJsonl(filePath: string, entries: Array<object | string>): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"),
    "utf8"
  );
  return filePath;
}

function writeClaudeFixture(root: string): string {
  return writeJsonl(path.join(root, "projects", "C--Projects-claude", "33333333-3333-4333-8333-333333333333.jsonl"), [
    { type: "user", sessionId: "33333333-3333-4333-8333-333333333333", uuid: "claude-user", timestamp: "2026-06-03T00:00:00.000Z", cwd: "C:\\Projects\\claude", version: "2.1.140", entrypoint: "cli", message: { role: "user", content: [{ type: "text", text: "Inspect the Claude fixture project" }] } },
    { type: "assistant", sessionId: "33333333-3333-4333-8333-333333333333", uuid: "claude-assistant", requestId: "claude-request-1", timestamp: "2026-06-03T00:00:01.000Z", cwd: "C:\\Projects\\claude", version: "2.1.140", entrypoint: "cli", message: { id: "claude-message-1", role: "assistant", model: "claude-test", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "I will inspect the project first." }, { type: "thinking", thinking: "Inspect first" }, { type: "tool_use", id: "claude-call", name: "Bash", input: { command: "Get-ChildItem" } }] } },
    { type: "user", sessionId: "33333333-3333-4333-8333-333333333333", uuid: "claude-result", timestamp: "2026-06-03T00:00:02.000Z", cwd: "C:\\Projects\\claude", version: "2.1.140", entrypoint: "cli", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-call", content: "Claude fixture listing" }] } },
    { type: "assistant", sessionId: "33333333-3333-4333-8333-333333333333", uuid: "claude-final", parentUuid: "claude-result", requestId: "claude-request-2", timestamp: "2026-06-03T00:00:03.000Z", cwd: "C:\\Projects\\claude", version: "2.1.140", entrypoint: "cli", message: { id: "claude-message-2", role: "assistant", model: "claude-test", stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: "text", text: "The Claude fixture inspection is complete." }] } }
  ]);
}

function writeGeminiFixture(root: string): string {
  const projectRoot = path.join(root, "tmp", "gemini-fixture");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".project_root"), "C:\\Projects\\gemini", "utf8");
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: { "C:\\Projects\\gemini": "gemini-fixture" } }), "utf8");
  return writeJsonl(path.join(projectRoot, "chats", "session-2026-06-04T00-00-44444444.jsonl"), [
    { sessionId: "44444444-4444-4444-8444-444444444444", startTime: "2026-06-04T00:00:00.000Z", lastUpdated: "2026-06-04T00:00:03.000Z", summary: "Gemini fixture" },
    { id: "gemini-user", timestamp: "2026-06-04T00:00:00.000Z", type: "user", content: [{ text: "Inspect the Gemini fixture project" }] },
    { id: "gemini-agent", timestamp: "2026-06-04T00:00:01.000Z", type: "gemini", content: "Inspection complete", thoughts: [{ subject: "Inspect", description: "Read files" }], toolCalls: [{ id: "gemini-call", name: "run_shell_command", displayName: "Shell", args: { command: "Get-ChildItem" }, status: "success", resultDisplay: "Gemini fixture listing" }] }
  ]);
}
