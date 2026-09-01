import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Check,
  Clock3,
  Copy,
  Download,
  Filter,
  Folder,
  FolderOpen,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Printer,
  RefreshCw,
  Search,
  Sun,
  X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ConversationItem,
  FacetsResponse,
  IndexStatus,
  SessionDetailResponse,
  SessionSummary,
} from "../shared/types.js";
import {
  defaultFilters,
  exportUrl,
  filtersFromUrl,
  getFacets,
  getIndexStatus,
  getRawItem,
  getSession,
  getSessions,
  refreshIndex,
  resolveSession,
  type SessionFilters,
  writeFiltersToUrl
} from "./api.js";
import { expandedRecordSections } from "./record-display.js";

const TRANSCRIPT_PAGE_SIZE = 100;
const NARROW_VIEWPORT_QUERY = "(max-width: 959px)";

const CATEGORY_GROUPS = [
  {
    heading: "Messages",
    options: [
      { key: "user", label: "user" },
      { key: "assistantFinal", label: "assistant final" },
      { key: "assistantProgress", label: "assistant progress" },
      { key: "assistantIncomplete", label: "assistant incomplete / stopped" },
      { key: "assistantUnclassified", label: "assistant unclassified" },
      { key: "hookPrompt", label: "hookPrompt" }
    ]
  },
  {
    heading: "Instructions / Context",
    options: [
      { key: "developer", label: "developer" },
      { key: "turn_context", label: "turn_context" },
      { key: "session_meta", label: "session_meta" }
    ]
  },
  {
    heading: "Reasoning",
    options: [
      { key: "reasoning", label: "reasoning" },
      { key: "item/reasoning/textDelta", label: "item/reasoning/textDelta" },
      { key: "item/reasoning/summaryTextDelta", label: "item/reasoning/summaryTextDelta" },
      { key: "item/reasoning/summaryPartAdded", label: "item/reasoning/summaryPartAdded" }
    ]
  },
  {
    heading: "Plans",
    options: [
      { key: "plan", label: "plan" },
      { key: "item/plan/delta", label: "item/plan/delta" },
      { key: "turn/plan/updated", label: "turn/plan/updated" }
    ]
  },
  {
    heading: "Tool / Work Items",
    options: [
      { key: "commandExecution", label: "commandExecution" },
      { key: "mcpToolCall", label: "mcpToolCall" },
      { key: "dynamicToolCall", label: "dynamicToolCall" },
      { key: "collabAgentToolCall", label: "collabAgentToolCall" },
      { key: "subAgentActivity", label: "subAgentActivity" },
      { key: "webSearch", label: "webSearch" },
      { key: "imageGeneration", label: "imageGeneration" },
      { key: "imageView", label: "imageView" },
      { key: "sleep", label: "sleep" }
    ]
  },
  {
    heading: "File Changes",
    options: [
      { key: "fileChange", label: "fileChange" },
      { key: "turn/diff/updated", label: "turn/diff/updated" },
      { key: "item/fileChange/outputDelta", label: "item/fileChange/outputDelta" },
      { key: "item/fileChange/patchUpdated", label: "item/fileChange/patchUpdated" }
    ]
  },
  {
    heading: "Run Status",
    options: [
      { key: "task_started", label: "task_started" },
      { key: "task_complete", label: "task_complete" },
      { key: "turn_aborted", label: "turn_aborted" },
      { key: "thread_rolled_back", label: "thread_rolled_back" },
      { key: "compacted", label: "compacted" },
      { key: "context_compacted", label: "context_compacted" },
      { key: "contextCompaction", label: "contextCompaction" },
      { key: "item_completed", label: "item_completed" },
      { key: "thread/started", label: "thread/started" },
      { key: "thread/status/changed", label: "thread/status/changed" },
      { key: "thread/archived", label: "thread/archived" },
      { key: "thread/deleted", label: "thread/deleted" },
      { key: "thread/unarchived", label: "thread/unarchived" },
      { key: "thread/closed", label: "thread/closed" },
      { key: "turn/started", label: "turn/started" },
      { key: "turn/completed", label: "turn/completed" },
      { key: "hook/started", label: "hook/started" },
      { key: "hook/completed", label: "hook/completed" },
      { key: "item/started", label: "item/started" },
      { key: "item/completed", label: "item/completed" },
      { key: "process/exited", label: "process/exited" },
      { key: "thread/compacted", label: "thread/compacted" }
    ]
  },
  {
    heading: "Usage / Counts",
    options: [
      { key: "token_count", label: "token_count" },
      { key: "thread/tokenUsage/updated", label: "thread/tokenUsage/updated" },
      { key: "account/rateLimits/updated", label: "account/rateLimits/updated" }
    ]
  },
  {
    heading: "Streaming / Output Deltas",
    options: [
      { key: "item/agentMessage/delta", label: "item/agentMessage/delta" },
      { key: "command/exec/outputDelta", label: "command/exec/outputDelta" },
      { key: "process/outputDelta", label: "process/outputDelta" },
      { key: "item/commandExecution/outputDelta", label: "item/commandExecution/outputDelta" },
      { key: "item/commandExecution/terminalInteraction", label: "item/commandExecution/terminalInteraction" },
      { key: "item/mcpToolCall/progress", label: "item/mcpToolCall/progress" }
    ]
  },
  {
    heading: "Tool Status Summaries",
    options: [
      { key: "patch_apply_end", label: "patch_apply_end" },
      { key: "web_search_end", label: "web_search_end" },
      { key: "image_generation_end", label: "image_generation_end" },
      { key: "mcp_tool_call_end", label: "mcp_tool_call_end" }
    ]
  },
  {
    heading: "Review / Approval",
    options: [
      { key: "enteredReviewMode", label: "enteredReviewMode" },
      { key: "exitedReviewMode", label: "exitedReviewMode" },
      { key: "item/autoApprovalReview/started", label: "item/autoApprovalReview/started" },
      { key: "item/autoApprovalReview/completed", label: "item/autoApprovalReview/completed" },
      { key: "guardianWarning", label: "guardianWarning" },
      { key: "serverRequest/resolved", label: "serverRequest/resolved" },
      { key: "turn/moderationMetadata", label: "turn/moderationMetadata" }
    ]
  },
  {
    heading: "Environment / App Server",
    options: [
      { key: "skills/changed", label: "skills/changed" },
      { key: "thread/name/updated", label: "thread/name/updated" },
      { key: "thread/goal/updated", label: "thread/goal/updated" },
      { key: "thread/goal/cleared", label: "thread/goal/cleared" },
      { key: "thread/settings/updated", label: "thread/settings/updated" },
      { key: "mcpServer/oauthLogin/completed", label: "mcpServer/oauthLogin/completed" },
      { key: "mcpServer/startupStatus/updated", label: "mcpServer/startupStatus/updated" },
      { key: "account/updated", label: "account/updated" },
      { key: "app/list/updated", label: "app/list/updated" },
      { key: "remoteControl/status/changed", label: "remoteControl/status/changed" },
      { key: "externalAgentConfig/import/completed", label: "externalAgentConfig/import/completed" },
      { key: "fs/changed", label: "fs/changed" },
      { key: "model/rerouted", label: "model/rerouted" },
      { key: "model/verification", label: "model/verification" },
      { key: "fuzzyFileSearch/sessionUpdated", label: "fuzzyFileSearch/sessionUpdated" },
      { key: "fuzzyFileSearch/sessionCompleted", label: "fuzzyFileSearch/sessionCompleted" },
      { key: "account/login/completed", label: "account/login/completed" }
    ]
  },
  {
    heading: "Realtime",
    options: [
      { key: "thread/realtime/started", label: "thread/realtime/started" },
      { key: "thread/realtime/itemAdded", label: "thread/realtime/itemAdded" },
      { key: "thread/realtime/transcript/delta", label: "thread/realtime/transcript/delta" },
      { key: "thread/realtime/transcript/done", label: "thread/realtime/transcript/done" },
      { key: "thread/realtime/outputAudio/delta", label: "thread/realtime/outputAudio/delta" },
      { key: "thread/realtime/sdp", label: "thread/realtime/sdp" },
      { key: "thread/realtime/error", label: "thread/realtime/error" },
      { key: "thread/realtime/closed", label: "thread/realtime/closed" }
    ]
  },
  {
    heading: "Warnings / Errors",
    options: [
      { key: "error", label: "error" },
      { key: "warning", label: "warning" },
      { key: "configWarning", label: "configWarning" },
      { key: "deprecationNotice", label: "deprecationNotice" },
      { key: "windows/worldWritableWarning", label: "windows/worldWritableWarning" },
      { key: "windowsSandbox/setupCompleted", label: "windowsSandbox/setupCompleted" }
    ]
  },
  {
    heading: "Provider Events",
    options: [
      { key: "info", label: "info" },
      { key: "attachment", label: "attachment" },
      { key: "file-history-snapshot", label: "file-history-snapshot" },
      { key: "permission-mode", label: "permission-mode" },
      { key: "last-prompt", label: "last-prompt" },
      { key: "turn_duration", label: "turn_duration" },
      { key: "queue-operation", label: "queue-operation" },
      { key: "progress", label: "progress" },
      { key: "compact_boundary", label: "compact_boundary" }
    ]
  },
  {
    heading: "Other",
    options: [{ key: "other_event", label: "other_event" }]
  }
] as const;

const KNOWN_CATEGORIES = CATEGORY_GROUPS.flatMap((group) => group.options.map((option) => option.key));
const DEFAULT_VISIBLE_CATEGORIES = ["user", "assistantFinal"];

export function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = window.localStorage.getItem("agent-session-browser-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [facets, setFacets] = useState<FacetsResponse | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [filters, setFilters] = useState<SessionFilters>(() => filtersFromUrl());
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#session=(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  });
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [sessionLoadingMore, setSessionLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadingMore, setDetailLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawItem, setRawItem] = useState<{ id: number; rawJson: string } | null>(null);
  const [visibleCategories, setVisibleCategories] = useState<string[]>(() => [...DEFAULT_VISIBLE_CATEGORIES]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarFilterOpen, setSidebarFilterOpen] = useState(false);
  const [transcriptFilterOpen, setTranscriptFilterOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(() => window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const listAbort = useRef<AbortController | null>(null);
  const detailRequest = useRef(0);
  const rawDialogRef = useModalFocus<HTMLElement>(rawItem !== null, () => setRawItem(null));

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("agent-session-browser-theme", theme);
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const update = () => setNarrowViewport(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    writeFiltersToUrl(filters);
    const timer = window.setTimeout(() => void loadLists(false), filters.q ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [filters]);

  useEffect(() => {
    if (!sidebarFilterOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarFilterOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarFilterOpen]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, filters.tool, visibleCategories]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const next = await getIndexStatus();
      setStatus(next);
      if (next.running !== status?.running || next.sessions !== status?.sessions) {
        await loadLists(false);
      }
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [status?.running, status?.sessions, filters]);

  async function boot() {
    try {
      setLoading(true);
      const statusResponse = await getIndexStatus();
      setStatus(statusResponse);
      await loadLists(false);
    } catch (bootError) {
      setError((bootError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadLists(append: boolean) {
    listAbort.current?.abort();
    const abort = new AbortController();
    listAbort.current = abort;
    try {
      if (append) setSessionLoadingMore(true);
      else if (filters.q) setSearching(true);
      const offset = append ? sessions.length : 0;
      const [facetResponse, sessionResponse] = await Promise.all([
        append && facets ? Promise.resolve(facets) : getFacets(),
        getSessions(filters, offset, abort.signal)
      ]);
      if (abort.signal.aborted) return;
      setFacets(facetResponse);
      setSessions((current) => append
        ? [...current, ...sessionResponse.sessions.filter((session) => !current.some((item) => item.id === session.id))]
        : sessionResponse.sessions);
      setSessionTotal(sessionResponse.total);
      setStatus(sessionResponse.status);
      if (!append && !selectedId && sessionResponse.sessions[0]) {
        setSelectedId(sessionResponse.sessions[0].id);
      }
    } catch (listError) {
      if ((listError as Error).name === "AbortError") return;
      setError((listError as Error).message);
    } finally {
      if (listAbort.current === abort) {
        setSearching(false);
        setSessionLoadingMore(false);
      }
    }
  }

  async function loadDetail(id: string, offset = 0, pageChange = false) {
    const request = ++detailRequest.current;
    try {
      if (pageChange) {
        setDetailLoadingMore(true);
      } else {
        setDetailLoading(true);
        setDetail(null);
      }
      const next = await getSession(id, {
        offset,
        limit: TRANSCRIPT_PAGE_SIZE,
        tools: parseToolSelection(filters.tool),
        categories: visibleCategories,
        knownCategories: KNOWN_CATEGORIES,
        includeTools: false
      });
      if (request === detailRequest.current) {
        setDetail(next);
        if (pageChange) document.querySelector<HTMLElement>(".detail-pane")?.scrollTo({ top: 0 });
      }
    } catch (detailError) {
      if (request === detailRequest.current) setError((detailError as Error).message);
    } finally {
      if (request === detailRequest.current) {
        setDetailLoading(false);
        setDetailLoadingMore(false);
      }
    }
  }

  async function onRefresh() {
    try {
      setStatus(await refreshIndex());
      await loadLists(false);
      if (selectedId) await loadDetail(selectedId);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }

  async function openExactSession() {
    if (!filters.q.trim()) return;
    const match = await resolveSession(filters.q);
    if (!match.session) return;
    setFilters((current) => ({ ...current, q: "" }));
    selectSession(match.session.id);
  }

  function selectSession(id: string) {
    setSelectedId(id);
    if (narrowViewport) setSidebarOpen(false);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#session=${encodeURIComponent(id)}`);
  }

  function updateFilter<K extends keyof SessionFilters>(key: K, value: SessionFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  const selectedTools = parseToolSelection(filters.tool);
  function toggleTool(tool: string) {
    const next = new Set(selectedTools);
    if (next.has(tool)) {
      next.delete(tool);
    } else {
      next.add(tool);
    }
    updateFilter("tool", Array.from(next).sort().join(","));
  }

  function setTools(tools: string[]) {
    updateFilter("tool", Array.from(new Set(tools)).sort().join(","));
  }

  function clearSessionFilters() {
    setFilters({ ...defaultFilters, q: filters.q, tool: filters.tool });
  }

  function toggleCategory(category: string) {
    setVisibleCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return Array.from(next);
    });
  }

  function setCategoryGroupVisibility(categories: readonly string[], visible: boolean) {
    setVisibleCategories((current) => {
      const next = new Set(current);
      let changed = false;
      for (const category of categories) {
        if (visible) {
          if (!next.has(category)) {
            next.add(category);
            changed = true;
          }
        } else {
          if (next.delete(category)) changed = true;
        }
      }
      return changed ? Array.from(next) : current;
    });
  }

  const selectedSession = detail?.session || sessions.find((session) => session.id === selectedId) || null;
  const sessionFilterCount = [filters.provider, filters.cwd, filters.from, filters.to, filters.archived, filters.hasErrors]
    .filter(Boolean).length;

  return (
    <main className="app-shell">
      {error && (
        <div className="error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button className="icon-only" onClick={() => setError(null)} title="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      <section className={`workspace ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
        {sidebarOpen && <aside className="list-pane">
          <div className="sidebar-search-row">
            <div className="sidebar-search">
              <Search size={15} />
              <input
                value={filters.q}
                onChange={(event) => updateFilter("q", event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void openExactSession(); }}
                placeholder="Search sessions"
                aria-label="Search sessions"
                title="Search content, or press Enter with a session ID or JSONL path"
              />
              {filters.q && <button type="button" onClick={() => updateFilter("q", "")} title="Clear search" aria-label="Clear search"><X size={14} /></button>}
            </div>
            <button
              className={`sidebar-filter-trigger ${sidebarFilterOpen || sessionFilterCount ? "active" : ""}`}
              type="button"
              onClick={() => setSidebarFilterOpen((current) => !current)}
              title={sessionFilterCount ? `Session filters (${sessionFilterCount} active)` : "Session filters"}
              aria-label="Session filters"
            >
              <Filter size={15} />
              {sessionFilterCount > 0 && <span aria-hidden="true" />}
            </button>
          </div>
          {sidebarFilterOpen && <>
            <button className="sidebar-filter-backdrop" type="button" onClick={() => setSidebarFilterOpen(false)} aria-label="Close session filters" />
            <aside className="sidebar-filter-popover" aria-label="Session filters">
              <div className="sidebar-filter-header">
                <strong>Session filters</strong>
                <button className="icon-only" type="button" onClick={() => setSidebarFilterOpen(false)} aria-label="Close session filters"><X size={14} /></button>
              </div>
              <div className="sidebar-filter-grid">
              <label>Agent
                <select aria-label="Agent" value={filters.provider} onChange={(event) => updateFilter("provider", event.target.value)}>
                  <option value="">All agents</option>
                  {facets?.providers.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
                </select>
              </label>
              <DirectoryCombobox
                directories={facets?.cwds || []}
                value={filters.cwd}
                onChange={(cwd) => updateFilter("cwd", cwd)}
              />
              <div className="date-filter-row">
                <label>From<input type="date" value={filters.from.slice(0, 10)} onChange={(event) => updateFilter("from", event.target.value)} /></label>
                <label>To<input type="date" value={filters.to.slice(0, 10)} onChange={(event) => updateFilter("to", event.target.value)} /></label>
              </div>
              <details className="advanced-session-filters">
                <summary><span>Advanced</span><ChevronDown size={13} /></summary>
                <div>
                  <label>Archive
                    <select value={filters.archived} onChange={(event) => updateFilter("archived", event.target.value)}>
                      <option value="">Active + archived</option><option value="false">Active</option><option value="true">Archived</option>
                    </select>
                  </label>
                  <label>Parse status
                    <select value={filters.hasErrors} onChange={(event) => updateFilter("hasErrors", event.target.value)}>
                      <option value="">Any status</option><option value="false">Clean</option><option value="true">Needs review</option>
                    </select>
                  </label>
                </div>
              </details>
              <div className="sidebar-filter-footer">
                <button className="sidebar-clear" type="button" onClick={clearSessionFilters}>Clear</button>
                <button className="sidebar-filter-done" type="button" onClick={() => setSidebarFilterOpen(false)}>Done</button>
              </div>
              </div>
            </aside>
          </>}
          <SessionList
            loading={loading}
            sessions={sessions}
            total={sessionTotal}
            selectedId={selectedId}
            onSelect={selectSession}
            loadingMore={sessionLoadingMore}
            onLoadMore={() => void loadLists(true)}
          />
          {(status?.running || searching) && <div className="sidebar-status"><RefreshCw size={13} /> {searching ? "Searching original session files..." : "Cataloging sessions..."}</div>}
        </aside>}

        <section className="detail-pane">
          {selectedSession && detail ? (
            <SessionDetail
              detail={detail}
              selectedTools={selectedTools}
              visibleCategories={visibleCategories}
              onToggleTool={toggleTool}
              onSetTools={setTools}
              onToggleCategory={toggleCategory}
              onSetCategoryGroupVisibility={setCategoryGroupVisibility}
              filterOpen={transcriptFilterOpen}
              onFilterClose={() => setTranscriptFilterOpen(false)}
              onFilterToggle={() => setTranscriptFilterOpen((current) => !current)}
              theme={theme}
              onThemeToggle={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              onRefresh={onRefresh}
              sidebarOpen={sidebarOpen}
              onSidebarToggle={() => setSidebarOpen((current) => !current)}
              loadingPage={detailLoadingMore}
              onLoadPage={(offset) => void loadDetail(detail.session.id, offset, true)}
              loadRaw={async (item) => (await getRawItem(detail.session.id, item.id)).rawJson}
              onViewRaw={async (item, loadedRaw) => {
                try {
                  const rawJson = loadedRaw || (await getRawItem(detail.session.id, item.id)).rawJson;
                  setRawItem({ id: item.id, rawJson });
                } catch (rawError) {
                  setError((rawError as Error).message);
                }
              }}
            />
          ) : (
            <div className="empty-state">{detailLoading
              ? selectedSession && selectedSession.bytes >= 64 * 1024 * 1024
                ? `Reading ${formatBytes(selectedSession.bytes)} from the original session file… Large sessions can take a few seconds on first open.`
                : "Reading the original session file..."
              : status?.running ? "Cataloging agent sessions..." : "No session selected"}</div>
          )}
        </section>
      </section>

      {rawItem && (
        <div className="drawer-backdrop" onClick={() => setRawItem(null)}>
          <aside ref={rawDialogRef} className="raw-drawer" role="dialog" aria-modal="true" aria-label={`Raw JSON ${rawItem.id}`} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <strong>Raw JSON #{rawItem.id}</strong>
              <button
                className="icon-only"
                onClick={() => setRawItem(null)}
                title="Close raw JSON"
                aria-label="Close raw JSON"
              >
                <X size={16} />
              </button>
            </div>
            <pre>{formatJson(rawItem.rawJson)}</pre>
          </aside>
        </div>
      )}
    </main>
  );
}

function DirectoryCombobox({ directories, value, onChange }: {
  directories: string[];
  value: string;
  onChange: (directory: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return directories
      .filter((directory) => !needle || directory.toLocaleLowerCase().includes(needle) || projectName(directory).toLocaleLowerCase().includes(needle))
      .sort((left, right) => projectName(left).localeCompare(projectName(right)) || left.localeCompare(right));
  }, [directories, query]);

  useEffect(() => {
    setQuery(value);
    setActiveIndex(-1);
  }, [value]);

  function choose(directory: string) {
    onChange(directory);
    setQuery(directory);
    setOpen(false);
    setActiveIndex(-1);
  }

  return (
    <div
      className="directory-combobox"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
        setQuery(value);
        setActiveIndex(-1);
      }}
    >
      <label htmlFor="working-directory-filter">Working directory</label>
      <div className="directory-combobox-input">
        <Search size={13} aria-hidden="true" />
        <input
          id="working-directory-filter"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="working-directory-options"
          aria-activedescendant={open && activeIndex >= 0 ? `working-directory-option-${activeIndex}` : undefined}
          autoComplete="off"
          placeholder="Search directories"
          title={value || "All directories"}
          value={query}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            setActiveIndex(-1);
            if (!next) onChange("");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) => Math.min(options.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter" && open && activeIndex >= 0 && options[activeIndex]) {
              event.preventDefault();
              choose(options[activeIndex]);
            } else if (event.key === "Escape") {
              setOpen(false);
              setQuery(value);
              setActiveIndex(-1);
            }
          }}
        />
        {value && (
          <button type="button" onClick={() => choose("")} aria-label="Clear working directory" title="All directories">
            <X size={13} />
          </button>
        )}
      </div>
      {open && (
        <div id="working-directory-options" className="directory-combobox-options" role="listbox" aria-label="Working directory suggestions">
          {options.length ? options.map((directory, index) => (
            <button
              id={`working-directory-option-${index}`}
              type="button"
              role="option"
              aria-selected={directory === value}
              className={index === activeIndex ? "active" : ""}
              key={directory}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(directory)}
            >
              <strong>{projectName(directory)}</strong>
              <span>{directory}</span>
            </button>
          )) : <div className="directory-combobox-empty">No matching directories</div>}
        </div>
      )}
    </div>
  );
}

function SessionList({
  loading,
  sessions,
  total,
  selectedId,
  onSelect,
  loadingMore,
  onLoadMore
}: {
  loading: boolean;
  sessions: SessionSummary[];
  total: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [openProjects, setOpenProjects] = useState<Set<string>>(() => new Set());
  const projectGroups = useMemo(() => {
    const groups = new Map<string, { path: string; sessions: SessionSummary[] }>();
    for (const session of sessions) {
      const project = session.cwd || "No working directory";
      const key = normalizeProjectPath(project);
      const group = groups.get(key) || { path: project, sessions: [] };
      group.sessions.push(session);
      groups.set(key, group);
    }
    return Array.from(groups.values())
      .map(({ path, sessions: projectSessions }) => [path, [...projectSessions].sort((a, b) => sessionTime(b) - sessionTime(a))] as const)
      .sort((a, b) => sessionTime(b[1][0]) - sessionTime(a[1][0]));
  }, [sessions]);
  const recentGroups = useMemo(() => {
    return [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a)).slice(0, 18);
  }, [sessions]);

  useEffect(() => {
    const selected = sessions.find((session) => session.id === selectedId);
    if (!selected?.cwd) return;
    setOpenProjects((current) => {
      const projectKey = normalizeProjectPath(selected.cwd!);
      if (current.has(projectKey)) return current;
      return new Set([...current, projectKey]);
    });
  }, [selectedId, sessions]);

  if (loading) return <div className="empty-state">Loading sessions...</div>;
  if (sessions.length === 0) return <div className="empty-state">No sessions match the current filters</div>;
  return (
    <div className="session-list">
      <section className="sidebar-section projects-section">
        <div className="sidebar-section-heading"><span>Working directories</span><small>{projectGroups.length}</small></div>
        {projectGroups.map(([project, projectSessions]) => {
          const projectKey = normalizeProjectPath(project);
          const isOpen = openProjects.has(projectKey);
          return (
            <details
              key={project}
              className="project-group"
              open={isOpen}
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setOpenProjects((current) => {
                  const next = new Set(current);
                  if (open) next.add(projectKey); else next.delete(projectKey);
                  return next;
                });
              }}
            >
              <summary>
                <span className="project-chevron">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span title={project}>{projectName(project)}</span>
                <small>{projectSessions.length}</small>
              </summary>
              <div className="project-sessions">
                {projectSessions.map((session) => <SessionRow key={session.id} session={session} selected={session.id === selectedId} onSelect={onSelect} compact />)}
              </div>
            </details>
          );
        })}
      </section>

      <section className="sidebar-section recent-section">
        <div className="sidebar-section-heading"><span>Recent sessions</span><small>{recentGroups.length}</small></div>
        {recentGroups.map((session) => <SessionRow key={session.id} session={session} selected={session.id === selectedId} onSelect={onSelect} />)}
      </section>
      {sessions.length < total && (
        <div className="session-list-pagination">
          <span>Showing {formatNumber(sessions.length)} of {formatNumber(total)} sessions</span>
          <button className="command-button" type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : `Load ${formatNumber(Math.min(100, total - sessions.length))} more`}
          </button>
        </div>
      )}
    </div>
  );
}

function SessionRow({ session, selected, onSelect, compact = false }: {
  session: SessionSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <button className={`session-card ${selected ? "selected" : ""} ${compact ? "compact" : ""}`} onClick={() => onSelect(session.id)}>
      <span className="session-card-content">
        <strong>{session.firstUserMessage || session.nativeId}</strong>
        <small title={session.cwd || "No working directory"}>{session.cwd || "No working directory"}</small>
      </span>
      <span className="session-card-meta">
        <time>{formatRelativeDate(session.lastEventAt || session.startedAt)}</time>
        <small>{session.itemCount ? formatNumber(session.itemCount) : formatBytes(session.bytes)}</small>
      </span>
    </button>
  );
}

function SessionDetail({
  detail,
  selectedTools,
  visibleCategories,
  onToggleTool,
  onSetTools,
  onToggleCategory,
  onSetCategoryGroupVisibility,
  filterOpen,
  onFilterClose,
  onFilterToggle,
  theme,
  onThemeToggle,
  onRefresh,
  sidebarOpen,
  onSidebarToggle,
  loadingPage,
  onLoadPage,
  loadRaw,
  onViewRaw
}: {
  detail: SessionDetailResponse;
  selectedTools: string[];
  visibleCategories: string[];
  onToggleTool: (tool: string) => void;
  onSetTools: (tools: string[]) => void;
  onToggleCategory: (category: string) => void;
  onSetCategoryGroupVisibility: (categories: readonly string[], visible: boolean) => void;
  filterOpen: boolean;
  onFilterClose: () => void;
  onFilterToggle: () => void;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  onRefresh: () => void;
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
  loadingPage: boolean;
  onLoadPage: (offset: number) => void;
  loadRaw: (item: ConversationItem) => Promise<string>;
  onViewRaw: (item: ConversationItem, loadedRaw?: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  const resumeCommand = getResumeCommand(detail.session.provider, detail.session.nativeId);
  const copy = async (key: string, label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setCopyNotice(`${label} copied`);
      window.setTimeout(() => {
        setCopiedKey((current) => current === key ? null : current);
        setCopyNotice((current) => current === `${label} copied` ? null : current);
      }, 1_800);
    } catch {
      setCopyNotice("Clipboard access failed");
    }
  };
  const availableTools = detail.availableTools;
  const additionalCategories = useMemo(
    () => Object.keys(detail.categoryCounts)
      .filter((category) => !KNOWN_CATEGORIES.includes(category as (typeof KNOWN_CATEGORIES)[number]))
      .sort(),
    [detail.categoryCounts]
  );
  const categoryCounts = detail.categoryCounts;
  const toolCounts = detail.toolCounts;
  useEffect(() => {
    if (additionalCategories.length) onSetCategoryGroupVisibility(additionalCategories, true);
  }, [detail.session.id]);
  const visibleTurns = detail.turns;
  const renderedTurns = visibleTurns.map((turn, turnNumber) => ({ ...turn, turnNumber: turn.turnNumber || turnNumber + 1 }));
  const totalItems = detail.totalMatchingItems;
  const renderedItemCount = detail.turns.reduce((sum, turn) => sum + turn.items.length, 0);
  const pageCount = Math.max(1, Math.ceil(totalItems / TRANSCRIPT_PAGE_SIZE));
  const pageNumber = Math.min(pageCount, Math.floor(detail.pageOffset / TRANSCRIPT_PAGE_SIZE) + 1);
  const firstVisibleItem = totalItems === 0 ? 0 : detail.pageOffset + 1;
  const lastVisibleItem = Math.min(totalItems, detail.pageOffset + renderedItemCount);
  const visibleToolCount = selectedTools.reduce((sum, tool) => sum + (detail.toolCounts[tool] || 0), 0);
  const sessionTokens = useMemo(() => getSessionTokenCount(detail.turns.flatMap((turn) => turn.items)), [detail.turns]);
  const sessionModel = useMemo(
    () => detail.turns.flatMap((turn) => turn.items).find((item) => item.model)?.model || detail.session.modelProvider,
    [detail.turns, detail.session.modelProvider]
  );
  const sessionDuration = getSessionActiveDuration(detail.turns.flatMap((turn) => turn.items));
  useEffect(() => setPageInput(String(pageNumber)), [detail.session.id, pageNumber]);
  const goToPage = () => {
    const requested = Number(pageInput);
    if (!Number.isInteger(requested)) {
      setPageInput(String(pageNumber));
      return;
    }
    const target = Math.max(1, Math.min(pageCount, requested));
    setPageInput(String(target));
    if (target !== pageNumber) onLoadPage((target - 1) * TRANSCRIPT_PAGE_SIZE);
  };

  return (
    <div className="session-detail">
      <div className="detail-header">
        <div className="detail-heading-row">
          <div className="detail-toolbar-left">
            <button
              className="icon-only"
              type="button"
              onClick={onSidebarToggle}
              title={sidebarOpen ? "Collapse sessions" : "Open sessions"}
              aria-label={sidebarOpen ? "Collapse sessions" : "Open sessions"}
            >
              {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <div className="path-breadcrumb" title={detail.session.cwd || detail.session.sourcePath}>
              <Folder size={14} />
              <span>{detail.session.cwd || detail.session.sourcePath}</span>
            </div>
          </div>
          <div className="detail-actions">
            <button className={`command-button ${filterOpen ? "active" : ""}`} type="button" onClick={onFilterToggle} title="Filter transcript">
              <Filter size={16} /><span>Filter</span>
            </button>
            <details className="export-menu">
              <summary className="command-button" title="Export session"><Download size={16} /><span>Export</span></summary>
              <div className="export-options">
                <a href={exportUrl(detail.session.id, "html", "readable")}><strong>Offline HTML</strong><span>Styled, shareable reader</span></a>
                <a href={exportUrl(detail.session.id, "markdown", "readable")}><strong>Markdown</strong><span>Portable plain-text document</span></a>
                <a href={exportUrl(detail.session.id, "html", "readable", true)} target="_blank" rel="noreferrer"><Printer size={15} /><span><strong>Print / PDF</strong><small>Open the complete printable transcript</small></span></a>
              </div>
            </details>
            <span className="command-separator" aria-hidden="true" />
            <button className="icon-only" type="button" onClick={onThemeToggle} title={theme === "dark" ? "Use light mode" : "Use dark mode"} aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}>
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="icon-only" type="button" onClick={onRefresh} title="Refresh sessions" aria-label="Refresh">
              <RefreshCw size={17} />
            </button>
          </div>
        </div>
        <div className="detail-title">
          <h2>{detail.session.firstUserMessage || detail.session.nativeId}</h2>
          <div className="session-meta-line">
            <span className={`provider-text provider-${detail.session.provider}`}>{providerLabel(detail.session.provider)}</span>
            <span>{formatDate(detail.session.startedAt)}</span>
            {sessionTokens > 0 && <span>{formatNumber(sessionTokens)} page tokens</span>}
            {sessionModel && <span>{sessionModel}</span>}
            {sessionDuration && <span className="session-duration"><Clock3 size={13} /> {sessionDuration} on this page</span>}
            <span><strong>{detail.totalMatchingTurns}</strong> matching turns</span>
            <span><strong>{formatNumber(firstVisibleItem)}–{formatNumber(lastVisibleItem)}</strong> / {formatNumber(totalItems)} visible items</span>
            <span><strong>{visibleToolCount}</strong> tool calls</span>
            <span><strong>{detail.session.itemCount}</strong> indexed items</span>
            {detail.session.archiveState === "archived" && <span>Archived</span>}
          </div>
          <div className="session-command-line">
            <CopyValue label="Session ID" value={detail.session.nativeId} copied={copiedKey === "id"} onCopy={() => copy("id", "Session ID", detail.session.nativeId)} />
            {resumeCommand && <CopyValue label="Resume" value={resumeCommand} copied={copiedKey === "resume"} onCopy={() => copy("resume", "Resume command", resumeCommand)} />}
          </div>
        </div>
      </div>

      {detail.session.parseError && <pre className="parse-error">{detail.session.parseError}</pre>}
      {detail.expandableRecordCount > 0 && (
        <div className="source-notice">
          {formatNumber(detail.expandableRecordCount)} matching {detail.expandableRecordCount === 1 ? "record has" : "records have"} a shortened preview to keep scrolling responsive. Every record is present; expand any preview to read its complete contents from the original session file.
        </div>
      )}
      <div className="turns">
        {visibleTurns.length === 0 ? (
          <div className="empty-state">No transcript items match the current filters</div>
        ) : (
          renderedTurns.map((turn) => (
            <section key={turn.turnId} className="turn-block">
              {turn.items.map((item) => (
                <TranscriptItem key={item.id} item={item} provider={detail.session.provider} turnNumber={turn.turnNumber} loadRaw={loadRaw} onViewRaw={onViewRaw} />
              ))}
            </section>
          ))
        )}
        {pageCount > 1 && (
          <div className="transcript-pagination">
            <span>Showing {formatNumber(firstVisibleItem)}–{formatNumber(lastVisibleItem)} of {formatNumber(totalItems)}</span>
            <div className="page-controls">
              <button className="command-button" type="button" onClick={() => onLoadPage(0)} disabled={loadingPage || pageNumber === 1}>First</button>
              <button className="command-button" type="button" onClick={() => onLoadPage(Math.max(0, detail.pageOffset - TRANSCRIPT_PAGE_SIZE))} disabled={loadingPage || pageNumber === 1}>Previous</button>
              <label>Page <input type="number" min="1" max={pageCount} value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={goToPage} onKeyDown={(event) => { if (event.key === "Enter") goToPage(); }} /> of {formatNumber(pageCount)}</label>
              <button className="command-button" type="button" onClick={() => onLoadPage(detail.nextOffset!)} disabled={loadingPage || detail.nextOffset == null}>Next</button>
              <button className="command-button" type="button" onClick={() => onLoadPage((pageCount - 1) * TRANSCRIPT_PAGE_SIZE)} disabled={loadingPage || pageNumber === pageCount}>Last</button>
            </div>
            {loadingPage && <span role="status">Loading from source…</span>}
          </div>
        )}
      </div>

      {filterOpen && (
        <FilterPopover
          availableTools={availableTools}
          selectedTools={selectedTools}
          visibleCategories={visibleCategories}
          additionalCategories={additionalCategories}
          categoryCounts={categoryCounts}
          toolCounts={toolCounts}
          onToggleTool={onToggleTool}
          onSetTools={onSetTools}
          onToggleCategory={onToggleCategory}
          onSetCategoryGroupVisibility={onSetCategoryGroupVisibility}
          onClose={onFilterClose}
        />
      )}
      {copyNotice && <div className="copy-toast" role="status">{copyNotice}</div>}
    </div>
  );
}

function CopyValue({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="copy-value">
      <span>{label}</span>
      <button className={`inline-copy ${copied ? "copied" : ""}`} onClick={onCopy} title={`Copy ${label.toLowerCase()}`} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <code title={value}>{value}</code>
      {copied && <small>Copied</small>}
    </div>
  );
}

function FilterPopover({
  availableTools,
  selectedTools,
  visibleCategories,
  additionalCategories,
  categoryCounts,
  toolCounts,
  onToggleTool,
  onSetTools,
  onToggleCategory,
  onSetCategoryGroupVisibility,
  onClose
}: {
  availableTools: string[];
  selectedTools: string[];
  visibleCategories: string[];
  additionalCategories: string[];
  categoryCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  onToggleTool: (tool: string) => void;
  onSetTools: (tools: string[]) => void;
  onToggleCategory: (category: string) => void;
  onSetCategoryGroupVisibility: (categories: readonly string[], visible: boolean) => void;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);
  return (
    <div className="filter-popover-backdrop" onClick={onClose}>
      <aside ref={dialogRef} className="filter-popover" role="dialog" aria-modal="true" tabIndex={-1} onClick={(event) => event.stopPropagation()} aria-label="Transcript filters">
        <div className="drawer-header">
          <strong>Filters</strong>
          <button className="icon-only" onClick={onClose} title="Close filters" aria-label="Close filters">
            <X size={16} />
          </button>
        </div>

        <fieldset className="tool-filter visibility-tools">
          <legend className="sr-only">Tools</legend>
          <div className="filter-group-heading">
            <strong>Tools</strong>
            <span>{selectedTools.length} selected / {availableTools.length} tools</span>
            <div className="group-actions">
              <button className="link-button" type="button" onClick={() => onSetTools(availableTools)} disabled={availableTools.length === 0}>
                All
              </button>
              <button className="link-button" type="button" onClick={() => onSetTools([])}>
                None
              </button>
            </div>
          </div>
          <div className="tool-checkboxes">
            {availableTools.length ? (
              availableTools.map((tool) => (
                <label key={tool} className="checkbox-row">
                  <input aria-label={tool} type="checkbox" checked={selectedTools.includes(tool)} onChange={() => onToggleTool(tool)} />
                  <span>{tool}</span>
                  <span className="option-count">{toolCounts[tool] || 0}</span>
                </label>
              ))
            ) : (
              <div className="muted">No tool calls indexed</div>
            )}
          </div>
        </fieldset>

        <fieldset className="category-filter">
          <legend className="sr-only">Transcript items</legend>
          {CATEGORY_GROUPS.map((group) => {
            const groupKeys = group.options.map((option) => option.key);
            const selectedCount = groupKeys.filter((key) => visibleCategories.includes(key)).length;
            return (
              <section className="category-group" key={group.heading}>
                <div className="filter-group-heading">
                  <h3>{group.heading}</h3>
                  <span>{selectedCount} selected / {groupKeys.reduce((sum, key) => sum + (categoryCounts[key] || 0), 0)} items</span>
                  <div className="group-actions">
                    <button className="link-button" type="button" onClick={() => onSetCategoryGroupVisibility(groupKeys, true)}>All</button>
                    <button className="link-button" type="button" onClick={() => onSetCategoryGroupVisibility(groupKeys, false)}>None</button>
                  </div>
                </div>
                <div className="category-group-body">
                {group.options.map((option) => (
                  <label key={option.key} className="checkbox-row">
                    <input
                      aria-label={option.label}
                      type="checkbox"
                      checked={visibleCategories.includes(option.key)}
                      onChange={() => onToggleCategory(option.key)}
                    />
                    <span>{option.label}</span>
                    <span className="option-count">{categoryCounts[option.key] || 0}</span>
                  </label>
                ))}
                </div>
              </section>
            );
          })}
        </fieldset>

        {additionalCategories.length > 0 && (
          <fieldset className="category-filter" aria-label="Additional provider events">
            <legend className="sr-only">Additional provider events</legend>
            <section className="category-group">
              <div className="filter-group-heading">
                <h3>Source-specific / new</h3>
                <span>{additionalCategories.filter((key) => visibleCategories.includes(key)).length} selected / {additionalCategories.length} types</span>
                <div className="group-actions">
                  <button className="link-button" type="button" onClick={() => onSetCategoryGroupVisibility(additionalCategories, true)}>All</button>
                  <button className="link-button" type="button" onClick={() => onSetCategoryGroupVisibility(additionalCategories, false)}>None</button>
                </div>
              </div>
              <div className="category-group-body">
              {additionalCategories.map((category) => (
                <label key={category} className="checkbox-row">
                  <input aria-label={formatProviderCategory(category)} type="checkbox" checked={visibleCategories.includes(category)} onChange={() => onToggleCategory(category)} />
                  <span>{formatProviderCategory(category)}</span>
                  <span className="option-count">{categoryCounts[category] || 0}</span>
                </label>
              ))}
              </div>
            </section>
          </fieldset>
        )}
      </aside>
    </div>
  );
}

function TranscriptItem({ item, provider, turnNumber, loadRaw, onViewRaw }: {
  item: ConversationItem;
  provider: SessionSummary["provider"];
  turnNumber: number;
  loadRaw: (item: ConversationItem) => Promise<string>;
  onViewRaw: (item: ConversationItem, loadedRaw?: string) => void;
}) {
  const [expandedRaw, setExpandedRaw] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const role = item.role === "assistant"
    ? providerLabel(provider)
    : item.role === "user"
      ? "You"
      : item.toolName || item.payloadType || item.envelopeType;
  const body = item.text || item.summary || item.toolName || "";
  const isLong = body.length > 1_500;
  const isMessage = item.role === "user" || item.role === "assistant";
  const isExpandableRecord = Boolean(item.contentPreview);
  const toggleExpansion = async () => {
    if (expandedRaw != null) {
      setExpandedRaw(null);
      return;
    }
    try {
      setExpandError(null);
      setExpanding(true);
      setExpandedRaw(await loadRaw(item));
    } catch (error) {
      setExpandError((error as Error).message);
    } finally {
      setExpanding(false);
    }
  };
  return (
    <article className={`transcript-item role-${item.role || "event"} ${item.phase ? `phase-${item.phase}` : ""}`}>
      <div className="item-meta">
        <strong>{role}</strong>
        <time>{formatDate(item.timestamp)}</time>
        <span className="turn-label">Turn {turnNumber}</span>
        {item.role === "assistant" && item.phase && <span>{formatPhase(item.phase)}</span>}
        {item.role && item.toolName && <span>{item.toolName}</span>}
        {isExpandableRecord ? (
          <button className="raw-action expand-record-action" onClick={() => void toggleExpansion()} disabled={expanding} aria-expanded={expandedRaw != null}>
            {expandedRaw != null ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{expanding ? "Loading…" : expandedRaw != null ? "Collapse" : "Expand"}</span>
          </button>
        ) : (
          <button className="raw-action raw-text-action" onClick={() => onViewRaw(item)} title="View raw JSON" aria-label="View raw JSON">Raw</button>
        )}
      </div>
      {body && (isLong && !isMessage ? (
        <details>
          <summary>{body.slice(0, 500)}...</summary>
          <pre>{body}</pre>
        </details>
      ) : isMessage ? (
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div>
      ) : (
        <pre>{body}</pre>
      ))}
      {expandError && <div className="inline-record-error">Could not expand this record: {expandError}</div>}
      {expandedRaw != null && <ExpandedRecordView provider={provider} raw={expandedRaw} onViewRaw={() => onViewRaw(item, expandedRaw)} />}
    </article>
  );
}

function ExpandedRecordView({ provider, raw, onViewRaw }: {
  provider: SessionSummary["provider"];
  raw: string;
  onViewRaw: () => void;
}) {
  const sections = useMemo(() => expandedRecordSections(provider, raw), [provider, raw]);
  return (
    <section className="inline-record-expansion">
      <div className="inline-record-header">
        <strong>Readable original record</strong>
        <button type="button" onClick={onViewRaw}>View raw JSON</button>
      </div>
      {sections.map((section, index) => (
        <section className={`expanded-record-section kind-${section.kind}`} key={`${section.label}-${index}`}>
          <strong>{section.label}</strong>
          {section.kind === "message" ? (
            <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.text}</ReactMarkdown></div>
          ) : (
            <pre>{section.text}</pre>
          )}
        </section>
      ))}
    </section>
  );
}

function formatPhase(phase: string): string {
  if (phase === "final_answer") return "Final answer";
  if (phase === "commentary") return "Progress";
  if (phase === "incomplete") return "Incomplete";
  return phase.replaceAll("_", " ");
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || []);
    (focusable()[0] || dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open]);
  return dialogRef;
}

function formatRelativeDate(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "Now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sessionTime(session: SessionSummary): number {
  const value = session.lastEventAt || session.startedAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function projectName(path: string): string {
  if (path === "No working directory") return path;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || path;
}

function normalizeProjectPath(path: string): string {
  return path.replace(/[\\/]+$/, "").replaceAll("/", "\\").toLocaleLowerCase();
}

function getSessionActiveDuration(items: ConversationItem[]): string | null {
  const timestamps = items
    .map((item) => item.timestamp ? new Date(item.timestamp).getTime() : Number.NaN)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (timestamps.length < 2) return null;
  let milliseconds = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    milliseconds += Math.min(Math.max(0, timestamps[index] - timestamps[index - 1]), 15 * 60_000);
  }
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function getSessionTokenCount(items: ConversationItem[]): number {
  let maximum = 0;
  for (const item of items) {
    if (!item.usageJson) continue;
    try {
      maximum = Math.max(maximum, findTokenTotal(JSON.parse(item.usageJson)));
    } catch {
      // Preserve the session even when a provider writes malformed usage metadata.
    }
  }
  return maximum;
}

function findTokenTotal(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  let maximum = 0;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "total_tokens" || key === "totalTokens") && typeof child === "number") {
      maximum = Math.max(maximum, child);
    } else {
      maximum = Math.max(maximum, findTokenTotal(child));
    }
  }
  return maximum;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function parseToolSelection(value: string): string[] {
  return value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function formatProviderCategory(category: string): string {
  const [, envelope, payload] = category.split("|");
  return payload && payload !== "none" && payload !== envelope ? `${envelope} / ${payload}` : envelope || category;
}

function providerLabel(provider: SessionSummary["provider"]): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "gemini") return "Gemini CLI";
  if (provider === "pi") return "Pi";
  return "Codex";
}

function getResumeCommand(provider: SessionSummary["provider"], nativeId: string): string | null {
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/i.test(nativeId)) return null;
  if (provider === "claude") return `claude --resume ${nativeId}`;
  if (provider === "gemini") return `gemini --resume ${nativeId}`;
  if (provider === "pi") return `pi --session ${nativeId}`;
  return `codex resume ${nativeId}`;
}
