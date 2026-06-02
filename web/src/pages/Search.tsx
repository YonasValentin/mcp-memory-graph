import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import Fuse from "fuse.js"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Search as SearchIcon } from "lucide-react"
import { searchMemories, listMemories } from "@/api/client"
import { toastError } from "@/lib/toast-error"
import type { SearchResult, SearchMode } from "@/types"

const confidenceColor: Record<string, string> = {
  high: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  low: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
}

const matchTypeColor: Record<string, string> = {
  hybrid: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  vector: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  keyword: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
}

interface Suggestion {
  id: string
  title: string
  scope: string
  namespace: string | null
  tags: string[]
}

export function Search() {
  const navigate = useNavigate()
  // URL state: ?q=...&mode=hybrid keeps refresh / share-link working.
  const [params, setParams] = useSearchParams()
  const initialQuery = params.get("q") ?? ""
  const initialMode: SearchMode = ((): SearchMode => {
    const m = params.get("mode")
    return m === "vector" || m === "keyword" ? m : "hybrid"
  })()
  const [query, setQuery] = useState(initialQuery)
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  // Monotonic id of the most recent search; results from older ones are dropped.
  const searchReqIdRef = useRef(0)

  // ── Fuzzy suggestion state ──────────────────────────────────────────
  const [allMemories, setAllMemories] = useState<Suggestion[]>([])
  const [suggestions, setSuggestions] = useState<{ item: Suggestion; score?: number }[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  // Load memory titles once for the fuzzy index. The /api/memories endpoint
  // caps `limit` at 100 (ApiListQuerySchema) — requesting more returns a 400
  // INVALID_INPUT, which silently broke the type-ahead suggestion index. Pull
  // the top 100 most-accessed memories, which is the relevant suggestion set.
  useEffect(() => {
    listMemories({ limit: 100, sort_by: "access_count", sort_order: "desc" })
      .then((data) => {
        setAllMemories(
          data.items.map((m) => ({
            id: m.id,
            title: m.title || m.content.slice(0, 80),
            scope: m.scope,
            namespace: m.namespace,
            tags: m.tags,
          })),
        )
      })
      .catch((err) => toastError(err, "Couldn't load suggestion index"))
  }, [])

  // Build Fuse index (re-created only when allMemories changes)
  const fuse = useMemo(
    () =>
      new Fuse(allMemories, {
        keys: [
          { name: "title", weight: 0.7 },
          { name: "tags", weight: 0.3 },
        ],
        threshold: 0.4,
        includeScore: true,
        minMatchCharLength: 2,
      }),
    [allMemories],
  )

  // Update suggestions as user types
  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    const hits = fuse.search(query, { limit: 8 })
    setSuggestions(hits)
    setShowSuggestions(hits.length > 0)
    setSelectedIdx(-1)
  }, [query, fuse])

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const doSearch = useCallback(async () => {
    if (!query.trim()) return
    setShowSuggestions(false)
    setLoading(true)
    // Persist query + mode to the URL so refresh keeps the result set.
    setParams({ q: query, mode }, { replace: true })
    // Latest-request guard: only the most recent search applies, so a slow
    // earlier query can't overwrite a newer one's results (WEB-3).
    const myId = ++searchReqIdRef.current
    try {
      const data = await searchMemories({ q: query, mode, limit: 30 })
      if (searchReqIdRef.current !== myId) return
      setResults(data.results)
      setTotal(data.total)
      setSearched(true)
    } catch (err) {
      if (searchReqIdRef.current === myId) toastError(err, "Search failed")
    } finally {
      if (searchReqIdRef.current === myId) setLoading(false)
    }
  }, [query, mode, setParams])

  // Auto-run when the user lands with ?q= in the URL (e.g. shared link).
  useEffect(() => {
    if (initialQuery.trim()) {
      void doSearch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickSuggestion = (s: Suggestion) => {
    setQuery(s.title)
    setShowSuggestions(false)
    // Navigate directly to memory detail
    navigate(`/memory/${s.id}`)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) {
      if (e.key === "Enter") doSearch()
      return
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1))
        break
      case "ArrowUp":
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, -1))
        break
      case "Enter":
        e.preventDefault()
        if (selectedIdx >= 0 && suggestions[selectedIdx]) {
          pickSuggestion(suggestions[selectedIdx].item)
        } else {
          doSearch()
        }
        break
      case "Escape":
        setShowSuggestions(false)
        break
    }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold tracking-tight">Search</h1>

      {/* Search bar with suggestions dropdown */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Search memories by meaning or keywords..."
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (suggestions.length > 0) setShowSuggestions(true)
            }}
          />

          {/* Fuzzy suggestions dropdown */}
          {showSuggestions && (
            <div
              ref={suggestionsRef}
              className="absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover shadow-lg"
            >
              {suggestions.map((s, i) => (
                <button
                  key={s.item.id}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                    i === selectedIdx
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSuggestion(s.item)
                  }}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.item.scope}
                      {s.item.namespace ? `/${s.item.namespace}` : ""}
                    </p>
                  </div>
                  <div className="ml-2 flex shrink-0 gap-1">
                    {s.item.tags.slice(0, 2).map((tag: string) => (
                      <Badge key={tag} variant="outline" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </button>
              ))}
              <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                <kbd className="rounded border bg-muted px-1">Enter</kbd> to search ·{" "}
                <kbd className="rounded border bg-muted px-1">↑↓</kbd> to navigate
              </div>
            </div>
          )}
        </div>
        <Select value={mode} onValueChange={(v) => setMode(v as SearchMode)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hybrid">Hybrid</SelectItem>
            <SelectItem value="vector">Vector</SelectItem>
            <SelectItem value="keyword">Keyword</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={doSearch} disabled={!query.trim() || loading}>
          Search
        </Button>
      </div>

      {/* Results */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}

      {!loading && searched && (
        <p className="text-sm text-muted-foreground">
          {total} result{total !== 1 ? "s" : ""} found
        </p>
      )}

      {!loading && results.length > 0 && (
        <div className="space-y-3">
          {results.map((r) => (
            <Link key={r.memory.id} to={`/memory/${r.memory.id}`}>
              <Card className="transition-colors hover:bg-accent/50">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {r.memory.title || r.memory.content.slice(0, 100)}
                      </p>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {r.memory.content.slice(0, 200)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {r.memory.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge className={confidenceColor[r.confidence_level]}>
                        {r.confidence_level} ({(r.confidence * 100).toFixed(0)}%)
                      </Badge>
                      <Badge className={matchTypeColor[r.match_type]}>
                        {r.match_type}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {r.memory.scope}/{r.memory.namespace}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {!loading && searched && results.length === 0 && (
        <div className="py-12 text-center text-muted-foreground">
          <SearchIcon className="mx-auto mb-3 h-12 w-12 opacity-20" />
          <p>No results found for &quot;{query}&quot;</p>
          <p className="mt-1 text-sm">Try different keywords or switch search mode</p>
        </div>
      )}
    </div>
  )
}
