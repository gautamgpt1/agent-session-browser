export type ArchiveState = "active" | "archived";
export type ParseStatus = "ok" | "partial" | "error";
export type AgentProvider = "codex" | "claude" | "gemini" | "pi";
export type ExportFormat = "markdown" | "html";
export type ExportMode = "conversation" | "readable" | "trace";

export interface SessionRoot {
  provider: AgentProvider;
  kind: ArchiveState;
  path: string;
  exists: boolean;
}

export interface IndexStatus {
  running: boolean;
  lastRunAt: string | null;
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  sessions: number;
  parseErrors: number;
  error: string | null;
}

export interface SessionSummary {
  id: string;
  nativeId: string;
  provider: AgentProvider;
  sourcePath: string;
  archiveState: ArchiveState;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  cliVersion: string | null;
  modelProvider: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  bytes: number;
  lineCount: number;
  indexedAt: string;
  parseStatus: ParseStatus;
  parseError: string | null;
  firstUserMessage: string | null;
  lastAssistantMessage: string | null;
  toolNames: string[];
  itemCount: number;
  toolCount: number;
}

export interface FacetsResponse {
  providers: AgentProvider[];
  cwds: string[];
  toolNames: string[];
  originators: string[];
  modelProviders: string[];
  archiveStates: ArchiveState[];
  parseStatuses: ParseStatus[];
  dateRange: {
    min: string | null;
    max: string | null;
  };
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  status: IndexStatus;
}

export interface ConversationItem {
  id: number;
  sessionId: string;
  turnId: string | null;
  timestamp: string | null;
  envelopeType: string;
  payloadType: string | null;
  role: string | null;
  toolName: string | null;
  callId: string | null;
  phase: string | null;
  nativeId?: string | null;
  parentId?: string | null;
  requestId?: string | null;
  model?: string | null;
  stopReason?: string | null;
  usageJson?: string | null;
  providerMetadataJson?: string | null;
  summary: string | null;
  text: string | null;
  lineNo: number;
  sequence: number;
  rawJson?: string;
  contentPreview?: boolean;
}

export interface TurnGroup {
  turnId: string;
  turnNumber?: number;
  startedAt: string | null;
  cwd: string | null;
  currentDate: string | null;
  approvalPolicy: string | null;
  sandboxPolicy: string | null;
  items: ConversationItem[];
}

export interface ToolCall {
  id: number;
  sessionId: string;
  turnId: string | null;
  timestamp: string | null;
  toolName: string;
  callId: string | null;
  argumentsJson: string | null;
  outputText: string | null;
  status: string | null;
  cwd: string | null;
  archiveState: ArchiveState;
}

export interface SessionDetailResponse {
  session: SessionSummary;
  turns: TurnGroup[];
  tools: ToolCall[];
  loadedItemCount: number;
  pageOffset: number;
  pageLimit: number;
  totalMatchingItems: number;
  totalMatchingTurns: number;
  nextOffset: number | null;
  sourceVersion: string;
  categoryCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  availableTools: string[];
  expandableRecordCount: number;
}

export interface RawItemResponse {
  id: number;
  rawJson: string;
}

export interface ToolsResponse {
  tools: ToolCall[];
  total: number;
}

export interface ResolveSessionResponse {
  session: SessionSummary | null;
  matchedBy: "id" | "nativeId" | "path" | null;
}

export interface HumanInput {
  id: number;
  sessionId: string;
  provider: AgentProvider;
  cwd: string | null;
  timestamp: string | null;
  text: string;
}

export interface HumanInputsResponse {
  inputs: HumanInput[];
  total: number;
}

export interface ProviderStats {
  provider: AgentProvider;
  sessions: number;
  items: number;
  tools: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  durationHours: number;
}

export interface StatsResponse {
  providers: ProviderStats[];
  sessions: number;
  items: number;
  tools: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  durationHours: number;
}
