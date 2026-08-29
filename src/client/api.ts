import type {
  FacetsResponse,
  IndexStatus,
  RawItemResponse,
  ResolveSessionResponse,
  SessionDetailResponse,
  SessionListResponse
} from "../shared/types.js";

export interface SessionFilters {
  q: string;
  cwd: string;
  from: string;
  to: string;
  tool: string;
  provider: string;
  modelProvider: string;
  originator: string;
  archived: string;
  hasErrors: string;
  sort: string;
}

export const defaultFilters: SessionFilters = {
  q: "",
  cwd: "",
  from: "",
  to: "",
  tool: "",
  provider: "",
  modelProvider: "",
  originator: "",
  archived: "",
  hasErrors: "",
  sort: "newest"
};

export async function getIndexStatus(): Promise<IndexStatus> {
  return getJson("/api/index/status");
}

export async function refreshIndex(): Promise<IndexStatus> {
  return getJson("/api/index/refresh", { method: "POST" });
}

export async function getFacets(): Promise<FacetsResponse> {
  return getJson("/api/facets");
}

export async function getSessions(filters: SessionFilters): Promise<SessionListResponse> {
  const params = toParams({ ...filters, tool: "" });
  params.set("limit", "100");
  return getJson(`/api/sessions?${params.toString()}`);
}

export async function getSession(id: string): Promise<SessionDetailResponse> {
  return getJson(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function resolveSession(value: string): Promise<ResolveSessionResponse> {
  return getJson(`/api/resolve?value=${encodeURIComponent(value)}`);
}

export function exportUrl(id: string, format: "markdown" | "html", mode: "conversation" | "readable" | "trace"): string {
  return `/api/sessions/${encodeURIComponent(id)}/export?format=${format}&mode=${mode}`;
}

export async function getRawItem(id: number): Promise<RawItemResponse> {
  return getJson(`/api/raw/${id}`);
}

export function filtersFromUrl(): SessionFilters {
  const params = new URLSearchParams(window.location.search);
  return {
    ...defaultFilters,
    q: params.get("q") || "",
    cwd: params.get("cwd") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    tool: params.get("tool") || "",
    provider: params.get("provider") || "",
    modelProvider: params.get("modelProvider") || "",
    originator: params.get("originator") || "",
    archived: params.get("archived") || "",
    hasErrors: params.get("hasErrors") || "",
    sort: params.get("sort") || "newest"
  };
}

export function writeFiltersToUrl(filters: SessionFilters): void {
  const params = toParams(filters);
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", next);
}

function toParams(filters: SessionFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
