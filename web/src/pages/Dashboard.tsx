import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Database, FileText, Clock, AlertTriangle } from "lucide-react"
import { getStats, listMemories } from "@/api/client"
import { toastError } from "@/lib/toast-error"
import type { MemoryStats, Memory } from "@/types"

export function Dashboard() {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [recent, setRecent] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    Promise.all([
      getStats(),
      listMemories({ limit: 10, sort_by: "updated_at", sort_order: "desc" }),
    ])
      .then(([s, r]) => {
        setStats(s)
        setRecent(r.items)
      })
      .catch((err) => {
        toastError(err, "Couldn't load dashboard")
        setError(err)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="space-y-3 p-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Couldn't load dashboard stats
          {error instanceof Error ? `: ${error.message}` : ""}.
        </p>
      </div>
    )
  }

  const statCards = [
    {
      label: "Total Memories",
      value: stats.total_documents,
      icon: Database,
      description: `${stats.total_chunks} chunks`,
    },
    {
      label: "Content Size",
      value: formatBytes(stats.total_content_bytes),
      icon: FileText,
      description: `DB: ${formatBytes(stats.database_size_bytes)}`,
    },
    {
      label: "Scopes",
      value: Object.keys(stats.by_scope).length,
      icon: Clock,
      description: Object.entries(stats.by_scope)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    },
    {
      label: "Expired",
      value: stats.expired_count,
      icon: AlertTriangle,
      description: stats.expired_count > 0 ? "Run consolidation" : "All current",
    },
  ]

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid gap-4 md:grid-cols-4">
        {statCards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
              <p className="text-xs text-muted-foreground">{card.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Breakdowns */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">By Document Type</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(stats.by_document_type).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-sm">{type}</span>
                  <Badge variant="secondary">{count}</Badge>
                </div>
              ))}
              {Object.keys(stats.by_document_type).length === 0 && (
                <p className="text-sm text-muted-foreground">No types yet</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">By Department</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {Object.entries(stats.by_department).map(([dept, count]) => (
                <div key={dept} className="flex items-center justify-between">
                  <span className="text-sm">{dept}</span>
                  <Badge variant="secondary">{count}</Badge>
                </div>
              ))}
              {Object.keys(stats.by_department).length === 0 && (
                <p className="text-sm text-muted-foreground">No departments yet</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent memories */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent Memories</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {recent.map((m) => (
              <Link
                key={m.id}
                to={`/memory/${m.id}`}
                className="flex items-start justify-between rounded-md border p-3 transition-colors hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.title || m.content.slice(0, 80)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.scope}/{m.namespace} · {new Date(m.updated_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="ml-3 flex shrink-0 gap-1">
                  {m.tags.slice(0, 2).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Link>
            ))}
            {recent.length === 0 && (
              <p className="text-sm text-muted-foreground">No memories stored yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}
