export type MemoryScope = "global" | "project" | "user" | "team" | "department"
export type AccessLevel = "public" | "internal" | "confidential" | "restricted"
export type SearchMode = "hybrid" | "vector" | "keyword"
export type ConfidenceLevel = "high" | "medium" | "low"
export type SortField = "created_at" | "updated_at" | "title" | "importance_score" | "confidence_score" | "access_count"
export type SortOrder = "asc" | "desc"

export interface Memory {
  id: string
  scope: MemoryScope
  namespace: string | null
  title: string | null
  content: string
  document_type: string | null
  source: string | null
  author: string | null
  department: string | null
  tags: string[]
  access_level: AccessLevel
  language: string
  metadata: Record<string, unknown> | null
  parent_id: string | null
  chunk_index: number | null
  version: number
  created_at: string
  updated_at: string
  expires_at: string | null
  access_count: number
  last_accessed_at: string | null
  importance_score: number
  confidence_score: number
}

export interface SearchResult {
  memory: Memory
  score: number
  confidence: number
  confidence_level: ConfidenceLevel
  match_type: "vector" | "keyword" | "hybrid"
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  has_more: boolean
}

export interface MemoryStats {
  total_memories: number
  total_chunks: number
  total_documents: number
  by_scope: Record<string, number>
  by_department: Record<string, number>
  by_document_type: Record<string, number>
  total_content_bytes: number
  database_size_bytes: number
  expired_count: number
}

export interface VersionRecord {
  id: string
  memory_id: string
  content: string
  title: string | null
  metadata: string | null
  version: number
  changed_by: string | null
  changed_at: string
}

export interface GraphData {
  nodes: Memory[]
  edges: Array<{ source: string; target: string; similarity: number }>
  total: number
}
