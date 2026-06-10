import { useEffect, useState, useCallback } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react"
import { listMemories } from "@/api/client"
import { toastError } from "@/lib/toast-error"
import type { Memory, SortField, SortOrder } from "@/types"

const PAGE_SIZE = 20
const VALID_SORT: SortField[] = [
  "created_at", "updated_at", "title", "importance_score", "confidence_score", "access_count",
]

export function Browse() {
  // URL state replaces ephemeral useState so refresh / back-button keeps the
  // user's pagination and filters. ?offset=20&sort_by=importance_score&...
  const [params, setParams] = useSearchParams()

  const offset = Number.parseInt(params.get("offset") ?? "0", 10) || 0
  const sortBy = (VALID_SORT.includes(params.get("sort_by") as SortField)
    ? (params.get("sort_by") as SortField)
    : "updated_at")
  const sortOrder: SortOrder = params.get("sort_order") === "asc" ? "asc" : "desc"
  const scopeFilter = params.get("scope") ?? "all"

  const [memories, setMemories] = useState<Memory[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const updateParams = useCallback(
    (next: Record<string, string | undefined>) => {
      setParams((prev) => {
        const out = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(next)) {
          if (v === undefined || v === "" || v === "all") out.delete(k)
          else out.set(k, v)
        }
        return out
      })
    },
    [setParams],
  )

  // Re-fetches whenever a filter/sort/page changes. The `ignore` flag drops a
  // stale response so a slow earlier request can't clobber a newer result set
  // (WEB-2).
  useEffect(() => {
    let ignore = false
    setLoading(true)
    listMemories({
      limit: PAGE_SIZE,
      offset,
      sort_by: sortBy,
      sort_order: sortOrder,
      scope: scopeFilter === "all" ? undefined : (scopeFilter as Memory["scope"]),
    })
      .then((data) => {
        if (ignore) return
        setMemories(data.items)
        setTotal(data.total)
      })
      .catch((err) => {
        if (!ignore) toastError(err, "Couldn't load memories")
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [offset, sortBy, sortOrder, scopeFilter])

  const toggleSort = (field: SortField) => {
    const nextOrder: SortOrder = sortBy === field ? (sortOrder === "asc" ? "desc" : "asc") : "desc"
    updateParams({ sort_by: field, sort_order: nextOrder, offset: "0" })
  }
  const setOffset = (next: number) => updateParams({ offset: String(Math.max(0, next)) })
  const setScopeFilter = (next: string) => updateParams({ scope: next, offset: "0" })

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div><p className="microlabel">the stacks</p><h1 className="font-display mt-1 text-4xl italic">Browse</h1></div>
        <div className="flex items-center gap-2">
          <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v ?? "all")}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All scopes</SelectItem>
              <SelectItem value="global">global</SelectItem>
              <SelectItem value="project">project</SelectItem>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="team">team</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            {total} memor{total !== 1 ? "ies" : "y"}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("title")}>
                      Title <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Namespace</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>
                    <button className="flex items-center gap-1" onClick={() => toggleSort("importance_score")}>
                      Quality <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button className="flex items-center gap-1" onClick={() => toggleSort("updated_at")}>
                      Updated <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button className="flex items-center gap-1" onClick={() => toggleSort("access_count")}>
                      Accesses <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map((m) => (
                  <TableRow key={m.id} className="cursor-pointer">
                    <TableCell>
                      <Link to={`/memory/${m.id}`} className="font-medium hover:underline">
                        {m.title || m.content.slice(0, 60)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{m.scope}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.namespace || "—"}
                    </TableCell>
                    <TableCell className="text-sm">{m.document_type || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {m.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                        ))}
                        {m.tags.length > 3 && (
                          <Badge variant="secondary" className="text-xs">+{m.tags.length - 3}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <QualityDot score={m.importance_score} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(m.updated_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-sm">{m.access_count}</TableCell>
                  </TableRow>
                ))}
                {memories.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      No memories found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function QualityDot({ score }: { score: number }) {
  const color =
    score >= 0.7 ? "bg-green-500" : score >= 0.4 ? "bg-yellow-500" : "bg-red-500"
  return (
    <div className="flex items-center gap-1.5">
      <div className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-xs">{(score * 100).toFixed(0)}%</span>
    </div>
  )
}
