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

const TOKEN_STORAGE_KEY = "mcp.token"

/**
 * Returns the bearer token to use for API requests.
 *   1. localStorage["mcp.token"] (persistent — set via the dashboard's login UI)
 *   2. import.meta.env.VITE_MCP_TOKEN (dev fallback for `npm run dev`)
 */
export function getAuthToken(): string | null {
  try {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY)
    if (stored) return stored
  } catch {
    // localStorage unavailable (SSR, sandbox, private mode) — fall through.
  }
  // VITE_MCP_TOKEN is statically replaced at build time by Vite.
  const env = import.meta.env.VITE_MCP_TOKEN
  return typeof env === "string" && env.length > 0 ? env : null
}

export function setAuthToken(token: string | null): void {
  try {
    if (token === null) {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    } else {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    }
  } catch {
    // Best effort — caller should treat this as a no-op.
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly requestId: string | undefined

  constructor(status: number, code: string | undefined, message: string, requestId?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken()
  const headers = new Headers(init.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: res.statusText, code: undefined, requestId: undefined }))
    throw new ApiError(
      res.status,
      body.code,
      body.error ?? `HTTP ${res.status}`,
      body.requestId,
    )
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
  // The dashboard renders content previews + match badges, so it needs the
  // full nested {memory, ...} projection (the REST default stays 'summary').
  return fetchJson(`${BASE}/search${qs({ ...params, detail: "full" })}`)
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
