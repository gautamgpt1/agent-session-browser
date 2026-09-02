import fs from "node:fs";
import type { ConversationItem, ExportMode, SessionDetailResponse, SessionSummary, ToolCall, TurnGroup } from "../shared/types.js";
import { getEffectiveToolName, getTranscriptCategory, isTranscriptToolItem, isVisibleTranscriptItem } from "../shared/transcript.js";
import type { BoundedParseOptions } from "./bounded-parse.js";
import { parseClaudeJsonlFile } from "./claude-parser.js";
import type { ViewerDatabase } from "./database.js";
import { parseGeminiSessionFile, readGeminiJsonSourceRecord } from "./gemini-parser.js";
import { parseCodexJsonlFile, type ParsedSession } from "./parser.js";
import { parsePiSessionFile } from "./pi-parser.js";
import { StreamingSessionExport } from "./session-actions.js";
import { buildSourceLineIndex, iterateSourceLines, readSourceLineAt, type SourceLineOffset } from "./source-lines.js";
import { truncateText } from "./text.js";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
export const LARGE_SOURCE_BYTES = 64 * 1024 * 1024;

export interface DetailPageOptions {
  offset?: number;
  limit?: number;
  tools?: string[];
  categories?: string[];
  knownCategories?: string[];
  includeTools?: boolean;
}

interface ParsedCache {
  sourcePath: string;
  size: number;
  mtimeMs: number;
  sourceVersion: string;
  indexedAt: string;
  parsed: ParsedSession;
  rawItems: Map<number, string>;
  lineOffsets: SourceLineOffset[] | null;
  lineOffsetsPending: Promise<SourceLineOffset[]> | null;
}

export class SessionSourceReader {
  private cache: ParsedCache | null = null;
  private readonly pendingParses = new Map<string, Promise<ParsedCache | null>>();

  constructor(private readonly database: ViewerDatabase) {}

  async getPage(id: string, options: DetailPageOptions = {}): Promise<SessionDetailResponse | null> {
    const cached = await this.getParsed(id);
    if (!cached) return null;
    const applyFilters = options.categories !== undefined || options.tools !== undefined;
    return toDetailPage(cached, options, applyFilters);
  }

  async getDetail(id: string): Promise<SessionDetailResponse | null> {
    const cached = await this.getParsed(id);
    if (!cached) return null;
    return toDetailPage(cached, { offset: 0, limit: cached.parsed.items.length, includeTools: true }, false);
  }

  async writeExport(id: string, outputPath: string, format: "markdown" | "html", mode: ExportMode): Promise<SessionSummary | null> {
    const summary = this.database.getSession(id);
    if (!summary) return null;
    const writer = new StreamingSessionExport(outputPath, summary, format, mode);
    try {
      await parseSource(summary, { retainItems: false, onItem: (item) => writer.writeItem(item) });
      if (mode === "trace") {
        writer.startRaw();
        for await (const { line } of iterateSourceLines(summary.sourcePath)) writer.writeRawLine(line);
      }
      writer.finish();
      return summary;
    } catch (error) {
      writer.abort();
      await fs.promises.rm(outputPath, { force: true });
      throw error;
    }
  }

  async getRawItem(sessionId: string, itemId: number): Promise<string | null> {
    const cached = await this.getParsed(sessionId);
    if (!cached) return null;
    const inline = cached.rawItems.get(itemId);
    if (inline) return inline;
    const item = cached.parsed.items.find((candidate) => candidate.sequence + 1 === itemId);
    if (!item) return null;
    if (cached.parsed.provider === "gemini" && cached.parsed.sourcePath.toLowerCase().endsWith(".json")) {
      const raw = await readGeminiJsonSourceRecord(cached.parsed.sourcePath, item.lineNo);
      if (raw != null) {
        for (const candidate of cached.parsed.items) {
          if (candidate.lineNo === item.lineNo) cached.rawItems.set(candidate.sequence + 1, raw);
        }
      }
      return raw;
    }
    if (!cached.lineOffsets) {
      cached.lineOffsetsPending ||= buildSourceLineIndex(cached.parsed.sourcePath);
      cached.lineOffsets = await cached.lineOffsetsPending;
      cached.lineOffsetsPending = null;
    }
    const line = cached.lineOffsets[item.lineNo - 1];
    return line ? readSourceLineAt(cached.parsed.sourcePath, line) : null;
  }

  private async getParsed(id: string): Promise<ParsedCache | null> {
    const pending = this.pendingParses.get(id);
    if (pending) return pending;
    const request = this.loadParsed(id);
    this.pendingParses.set(id, request);
    try {
      return await request;
    } finally {
      if (this.pendingParses.get(id) === request) this.pendingParses.delete(id);
    }
  }

  private async loadParsed(id: string): Promise<ParsedCache | null> {
    const summary = this.database.getSession(id);
    if (!summary) return null;
    const stat = await fs.promises.stat(summary.sourcePath);
    if (this.cache?.sourcePath === summary.sourcePath && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) {
      return this.cache;
    }
    const parsed = await parseSource(summary, { compactItems: true });
    this.database.upsertParsedSession(parsed);
    for (const tool of parsed.tools) {
      tool.argumentsJson = null;
      tool.outputText = null;
    }
    const rawItems = new Map(parsed.items.flatMap((item) => item.rawJson ? [[item.sequence + 1, item.rawJson] as const] : []));
    this.cache = {
      sourcePath: summary.sourcePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sourceVersion: `${stat.size}:${stat.mtimeMs}`,
      indexedAt: summary.indexedAt,
      parsed,
      rawItems,
      lineOffsets: null,
      lineOffsetsPending: null
    };
    return this.cache;
  }
}

async function parseSource(summary: SessionSummary, options: BoundedParseOptions = {}): Promise<ParsedSession> {
  if (summary.provider === "claude") return parseClaudeJsonlFile(summary.sourcePath, summary.archiveState, options);
  if (summary.provider === "gemini") return parseGeminiSessionFile(summary.sourcePath, summary.archiveState, summary.cwd, options);
  if (summary.provider === "pi") return parsePiSessionFile(summary.sourcePath, summary.archiveState, options);
  return parseCodexJsonlFile(summary.sourcePath, summary.archiveState, options);
}

function toDetailPage(cached: ParsedCache, options: DetailPageOptions, applyFilters = true): SessionDetailResponse {
  const { parsed } = cached;
  const knownCategories = options.knownCategories || [];
  const selectedTools = options.tools || [];
  const visibleCategories = options.categories || [];
  const callToolMap = new Map<string, string>();
  const toolCounts: Record<string, number> = {};
  for (const tool of parsed.tools) {
    if (tool.callId) callToolMap.set(tool.callId, tool.toolName);
    toolCounts[tool.toolName] = (toolCounts[tool.toolName] || 0) + 1;
  }

  const categoryCounts: Record<string, number> = {};
  const availableToolSet = new Set(Object.keys(toolCounts));
  for (const item of parsed.items) {
    const conversationItem = item as ConversationItem;
    const toolName = getEffectiveToolName(conversationItem, callToolMap);
    if (toolName) availableToolSet.add(toolName);
    if (!isTranscriptToolItem(conversationItem, callToolMap)) {
      const category = getTranscriptCategory(conversationItem, knownCategories);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }
  }

  const matchingItems = applyFilters
    ? parsed.items.filter((item) => isVisibleTranscriptItem(item as ConversationItem, selectedTools, visibleCategories, callToolMap, knownCategories))
    : parsed.items;
  const offset = clamp(options.offset ?? 0, 0, matchingItems.length);
  const requestedLimit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const limit = applyFilters ? clamp(requestedLimit, 1, MAX_PAGE_LIMIT) : Math.max(0, requestedLimit);
  const pageItems = matchingItems.slice(offset, offset + limit);
  const selectedItems = pageItems.map((item) => toConversationItem(item, callToolMap));
  const matchingTurnNumbers = new Map<string, number>();
  for (const item of matchingItems) {
    const turnId = item.turnId || "timeline";
    if (!matchingTurnNumbers.has(turnId)) matchingTurnNumbers.set(turnId, matchingTurnNumbers.size + 1);
  }
  const turnMap = new Map<string, TurnGroup>();
  for (const turn of parsed.turns) turnMap.set(turn.turnId, { ...turn, turnNumber: matchingTurnNumbers.get(turn.turnId), items: [] });
  for (const item of selectedItems) {
    const turnId = item.turnId || "timeline";
    if (!turnMap.has(turnId)) {
      turnMap.set(turnId, {
        turnId,
        turnNumber: matchingTurnNumbers.get(turnId),
        startedAt: item.timestamp,
        cwd: null,
        currentDate: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        items: []
      });
    }
    turnMap.get(turnId)!.items.push(item);
  }

  const nextOffset = offset + selectedItems.length < matchingItems.length ? offset + selectedItems.length : null;
  const tools: ToolCall[] = options.includeTools === false ? [] : parsed.tools.map((tool, index) => ({
    ...tool,
    id: index + 1,
    cwd: parsed.cwd,
    archiveState: parsed.archiveState,
    argumentsJson: null,
    outputText: null
  }));
  return {
    session: parsedSummary(parsed, cached.indexedAt),
    turns: Array.from(turnMap.values()).filter((turn) => turn.items.length > 0),
    tools,
    loadedItemCount: selectedItems.length,
    pageOffset: offset,
    pageLimit: limit,
    totalMatchingItems: matchingItems.length,
    totalMatchingTurns: matchingTurnNumbers.size,
    nextOffset,
    sourceVersion: cached.sourceVersion,
    categoryCounts,
    toolCounts,
    availableTools: Array.from(availableToolSet).sort(),
    expandableRecordCount: matchingItems.filter((item) => item.contentPreview).length
  };
}

function toConversationItem(item: Omit<ConversationItem, "id">, callToolMap: ReadonlyMap<string, string>): ConversationItem {
  const text = truncateText(item.text, item.role === "user" || item.role === "assistant" ? 12_000 : 2_000);
  const summary = truncateText(item.summary, 2_000);
  return {
    ...item,
    id: item.sequence + 1,
    toolName: getEffectiveToolName(item as ConversationItem, callToolMap) || item.toolName,
    text,
    summary,
    providerMetadataJson: null,
    rawJson: undefined,
    contentPreview: Boolean(item.contentPreview) || text !== item.text || summary !== item.summary
  };
}

function parsedSummary(parsed: ParsedSession, indexedAt: string): SessionSummary {
  return {
    id: parsed.id,
    nativeId: parsed.nativeId,
    provider: parsed.provider,
    sourcePath: parsed.sourcePath,
    archiveState: parsed.archiveState,
    cwd: parsed.cwd,
    originator: parsed.originator,
    source: parsed.source,
    cliVersion: parsed.cliVersion,
    modelProvider: parsed.modelProvider,
    startedAt: parsed.startedAt,
    lastEventAt: parsed.lastEventAt,
    bytes: parsed.bytes,
    lineCount: parsed.lineCount,
    indexedAt,
    parseStatus: parsed.parseStatus,
    parseError: parsed.parseError,
    firstUserMessage: parsed.firstUserMessage,
    lastAssistantMessage: parsed.lastAssistantMessage,
    toolNames: Array.from(new Set(parsed.tools.map((tool) => tool.toolName))).sort(),
    itemCount: parsed.items.length,
    toolCount: parsed.tools.length
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
