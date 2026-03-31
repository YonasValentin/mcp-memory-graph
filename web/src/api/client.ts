import type {
  Memory,
  SearchResult,
  PaginatedResult,
  MemoryStats,
  VersionRecord,
  GraphData,
  MemoryScope,
  SortField,
  SortOrder,
  SearchMode,
} from "@/types"

const BASE = "/api"

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return ""
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

// ── Stats ────────────────────────────────────────────────────────────────
export function getStats(filters?: {
  scope?: MemoryScope
  namespace?: string
  department?: string
}): Promise<MemoryStats> {
  return fetchJson(`${BASE}/stats${qs(filters ?? {})}`)
}

// ── Search ───────────────────────────────────────────────────────────────
export function searchMemories(params: {
  q: string
  scope?: MemoryScope
  namespace?: string
  department?: string
  document_type?: string
  tags?: string
  mode?: SearchMode
  limit?: number
  offset?: number
  min_confidence?: number
}): Promise<{ results: SearchResult[]; total: number }> {
  return fetchJson(`${BASE}/search${qs(params)}`)
}

// ── List ─────────────────────────────────────────────────────────────────
export function listMemories(params?: {
  scope?: MemoryScope
  namespace?: string
  department?: string
  document_type?: string
  limit?: number
  offset?: number
  sort_by?: SortField
  sort_order?: SortOrder
}): Promise<PaginatedResult<Memory>> {
  return fetchJson(`${BASE}/memories${qs(params ?? {})}`)
}

// ── Get ──────────────────────────────────────────────────────────────────
export function getMemory(
  id: string,
  includeChunks = false,
): Promise<{ memory: Memory; chunks?: Memory[] }> {
  return fetchJson(`${BASE}/memories/${id}${qs({ include_chunks: includeChunks })}`)
}

// ── Versions ─────────────────────────────────────────────────────────────
export function getVersions(
  id: string,
  limit = 50,
): Promise<{ current_version: number; history: VersionRecord[] }> {
  return fetchJson(`${BASE}/memories/${id}/versions${qs({ limit })}`)
}

// ── Related ──────────────────────────────────────────────────────────────
export function getRelated(
  id: string,
  limit = 10,
): Promise<{ related: SearchResult[]; count: number }> {
  return fetchJson(`${BASE}/memories/${id}/related${qs({ limit })}`)
}

// ── Update ───────────────────────────────────────────────────────────────
export function updateMemory(
  id: string,
  updates: {
    content?: string
    title?: string
    tags?: string[]
    metadata?: Record<string, unknown>
    expires_at?: string | null
  },
): Promise<{ updated: boolean; memory: Memory }> {
  return fetchJson(`${BASE}/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  })
}

// ── Delete ───────────────────────────────────────────────────────────────
export function deleteMemory(id: string): Promise<{ deleted: number }> {
  return fetchJson(`${BASE}/memories/${id}`, { method: "DELETE" })
}

// ── Graph ────────────────────────────────────────────────────────────────
export function getGraphData(params?: {
  limit?: number
  min_importance?: number
}): Promise<GraphData> {
  return fetchJson(`${BASE}/graph${qs(params ?? {})}`)
}
