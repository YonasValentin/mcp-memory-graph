import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { ArrowLeft, Pencil, Trash2, Clock, GitBranch } from "lucide-react"
import { toast } from "sonner"
import { getMemory, getVersions, getRelated, updateMemory, deleteMemory } from "@/api/client"
import type { Memory, VersionRecord, SearchResult } from "@/types"

export function MemoryDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [memory, setMemory] = useState<Memory | null>(null)
  const [versions, setVersions] = useState<VersionRecord[]>([])
  const [currentVersion, setCurrentVersion] = useState(0)
  const [related, setRelated] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(true)

  // Edit state
  const [editOpen, setEditOpen] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editContent, setEditContent] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      getMemory(id, true),
      getVersions(id),
      getRelated(id, 8),
    ])
      .then(([memData, verData, relData]) => {
        setMemory(memData.memory)
        setVersions(verData.history)
        setCurrentVersion(verData.current_version)
        setRelated(relData.related)
      })
      .finally(() => setLoading(false))
  }, [id])

  const handleEdit = async () => {
    if (!id) return
    setSaving(true)
    try {
      const result = await updateMemory(id, {
        title: editTitle || undefined,
        content: editContent,
      })
      setMemory(result.memory)
      setEditOpen(false)
      toast.success("Memory updated")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!id || !confirm("Delete this memory? This cannot be undone.")) return
    try {
      await deleteMemory(id)
      toast.success("Memory deleted")
      navigate("/browse")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed")
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!memory) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Memory not found</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/browse")}>
          Back to Browse
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate(-1)} className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="font-display text-3xl italic">
            {memory.title || "Untitled Memory"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{memory.scope}</Badge>
            {memory.namespace && <Badge variant="secondary">{memory.namespace}</Badge>}
            {memory.document_type && <Badge>{memory.document_type}</Badge>}
            <span className="text-xs text-muted-foreground">
              v{currentVersion} · Updated {new Date(memory.updated_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger
              render={<Button variant="outline" size="sm" />}
              onClick={() => {
                setEditTitle(memory.title ?? "")
                setEditContent(memory.content)
              }}
            >
              <Pencil className="mr-1 h-4 w-4" />
              Edit
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Edit Memory</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <Input
                  placeholder="Title"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <Textarea
                  placeholder="Content"
                  className="min-h-[200px] font-mono text-sm"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
                <Button onClick={handleEdit} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="destructive" size="sm" onClick={handleDelete}>
            <Trash2 className="mr-1 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Tabs: Content | Versions | Related */}
      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="versions">
            <Clock className="mr-1 h-4 w-4" />
            Versions ({versions.length})
          </TabsTrigger>
          <TabsTrigger value="related">
            <GitBranch className="mr-1 h-4 w-4" />
            Related ({related.length})
          </TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                {memory.content}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <div className="space-y-3">
            {versions.length === 0 && (
              <p className="text-sm text-muted-foreground">No previous versions</p>
            )}
            {versions.map((v) => (
              <Card key={v.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">
                      Version {v.version}
                    </CardTitle>
                    <span className="text-xs text-muted-foreground">
                      {new Date(v.changed_at).toLocaleString()}
                      {v.changed_by && ` by ${v.changed_by}`}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="line-clamp-6 whitespace-pre-wrap text-xs text-muted-foreground">
                    {v.content}
                  </pre>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="related" className="mt-4">
          <div className="space-y-3">
            {related.length === 0 && (
              <p className="text-sm text-muted-foreground">No related memories found</p>
            )}
            {related.map((r) => (
              <Link key={r.memory.id} to={`/memory/${r.memory.id}`}>
                <Card className="transition-colors hover:bg-accent/50">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {r.memory.title || r.memory.content.slice(0, 80)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.memory.scope}/{r.memory.namespace}
                      </p>
                    </div>
                    <Badge variant="secondary" className="ml-3">
                      {(r.score * 100).toFixed(0)}% similar
                    </Badge>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="metadata" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {[
                  ["ID", memory.id],
                  ["Scope", memory.scope],
                  ["Namespace", memory.namespace],
                  ["Document Type", memory.document_type],
                  ["Source", memory.source],
                  ["Author", memory.author],
                  ["Department", memory.department],
                  ["Access Level", memory.access_level],
                  ["Language", memory.language],
                  ["Created", new Date(memory.created_at).toLocaleString()],
                  ["Updated", new Date(memory.updated_at).toLocaleString()],
                  ["Expires", memory.expires_at ? new Date(memory.expires_at).toLocaleString() : null],
                  ["Access Count", memory.access_count],
                  ["Importance", `${(memory.importance_score * 100).toFixed(0)}%`],
                  ["Confidence", `${(memory.confidence_score * 100).toFixed(0)}%`],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value ?? "—"}</dd>
                  </div>
                ))}
              </dl>
              {memory.tags.length > 0 && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">Tags</p>
                    <div className="flex flex-wrap gap-1">
                      {memory.tags.map((tag) => (
                        <Badge key={tag} variant="outline">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {memory.metadata && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">Custom Metadata</p>
                    <pre className="rounded bg-muted p-3 text-xs">
                      {JSON.stringify(memory.metadata, null, 2)}
                    </pre>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
