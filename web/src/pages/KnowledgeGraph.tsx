import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { ExternalLink, Maximize2, Minus, Plus } from "lucide-react"
import * as d3Force from "d3-force"
import * as d3Selection from "d3-selection"
import * as d3Zoom from "d3-zoom"
import * as d3Drag from "d3-drag"
import { getGraphData } from "@/api/client"
import { toastError } from "@/lib/toast-error"
import { cn } from "@/lib/utils"
import type { GraphData, Memory } from "@/types"

interface GraphNode extends d3Force.SimulationNodeDatum {
  id: string
  memory: Memory
}

interface GraphEdge extends d3Force.SimulationLinkDatum<GraphNode> {
  similarity: number
}

type ColorAxis = "type" | "scope"

const FALLBACK_COLOR = "#6B7280"
const UNTYPED = "untyped"

// Scope carries inherent meaning → fixed semantic colors (archive palette).
const scopeColors: Record<string, string> = {
  global: "#2F6B4F",
  project: "#34D399",
  user: "#7FB4A8",
  team: "#D9A441",
  department: "#C2703D",
}

// Ordered palette for document_type — assigned to the categories actually
// present so a corpus that is 97% one scope still reads as distinct types.
// Hues kept within the phosphor-green / amber / clay archive family.
const TYPE_PALETTE = [
  "#34D399", // phosphor green
  "#D9A441", // amber
  "#5BB8C4", // teal
  "#C2703D", // clay
  "#7FB4A8", // sage
  "#B98AD9", // muted violet
  "#6F9BD1", // slate blue
  "#E0708A", // rose
  "#9CCB5B", // lime
  "#C9A227", // gold
]

interface LegendEntry {
  key: string
  color: string
  count: number
}

export function KnowledgeGraph() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const simulationRef = useRef<d3Force.Simulation<GraphNode, GraphEdge> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  // Refs the toolbar reads to drive zoom without re-running the build effect.
  const zoomRef = useRef<d3Zoom.ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const dimsRef = useRef<{ w: number; h: number } | null>(null)
  const nodesRef = useRef<GraphNode[]>([])

  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [minImportance, setMinImportance] = useState(0)
  const [colorAxis, setColorAxis] = useState<ColorAxis>("type")
  const [active, setActive] = useState<Memory | null>(null)

  // Read colorAxis inside the (data-only) build effect without making it a dep —
  // toggling the axis recolors in place instead of re-running the simulation.
  const colorAxisRef = useRef(colorAxis)
  useEffect(() => { colorAxisRef.current = colorAxis }, [colorAxis])

  const navigate = useNavigate()

  // ── Color resolution ──────────────────────────────────────────────
  // typeColorMap is stable for a given node set: sort the present types and
  // assign palette slots in order, so the legend and fills always agree.
  const typeColorMap = useMemo(() => {
    const types = [...new Set((data?.nodes ?? []).map((m) => m.document_type ?? UNTYPED))].sort()
    return new Map(types.map((t, i) => [t, TYPE_PALETTE[i % TYPE_PALETTE.length]]))
  }, [data])

  const colorOf = useMemo(() => {
    return (m: Memory) =>
      colorAxis === "scope"
        ? scopeColors[m.scope] ?? FALLBACK_COLOR
        : typeColorMap.get(m.document_type ?? UNTYPED) ?? FALLBACK_COLOR
  }, [colorAxis, typeColorMap])

  // Legend: only the categories present in the current data, with counts.
  const legend = useMemo<LegendEntry[]>(() => {
    const nodes = data?.nodes ?? []
    const counts = new Map<string, number>()
    for (const m of nodes) {
      const key = colorAxis === "scope" ? m.scope : m.document_type ?? UNTYPED
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({
        key,
        count,
        color:
          colorAxis === "scope"
            ? scopeColors[key] ?? FALLBACK_COLOR
            : typeColorMap.get(key) ?? FALLBACK_COLOR,
      }))
  }, [data, colorAxis, typeColorMap])

  // ── Fetch data ────────────────────────────────────────────────────
  // Guard against stale responses: a fast slider change can resolve an older
  // request after a newer one, clobbering state. `ignore` drops late results.
  useEffect(() => {
    setLoading(true)
    let ignore = false
    getGraphData({ limit: 150, min_importance: minImportance })
      .then((d) => { if (!ignore) setData(d) })
      .catch((err) => { if (!ignore) toastError(err, "Couldn't load knowledge graph") })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [minImportance])

  // ── Build graph ONCE when data arrives ────────────────────────────
  // useLayoutEffect so the DOM is measured before browser paint
  useLayoutEffect(() => {
    if (!data || !svgRef.current || !containerRef.current) return

    // Stop previous simulation
    simulationRef.current?.stop()

    const svg = d3Selection.select(svgRef.current)
    svg.selectAll("*").remove()

    // Measure the PARENT div (reliable), not the SVG (often 0 in flex)
    const rect = containerRef.current.getBoundingClientRect()
    const width = rect.width
    const height = rect.height
    dimsRef.current = { w: width, h: height }

    // Give SVG explicit dimensions so it fills the container
    svg.attr("width", width).attr("height", height)

    // ── Transparent rect to capture zoom/pan pointer events ───────
    // Without this, zoom only works when the cursor is directly over
    // a drawn element (circle/line). The rect covers the full area.
    svg
      .append("rect")
      .attr("width", width)
      .attr("height", height)
      .attr("fill", "transparent")
      .attr("pointer-events", "all")

    // ── Zoom container <g> ────────────────────────────────────────
    const g = svg.append("g")

    const zoom = d3Zoom
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
      .on("zoom", (event: d3Zoom.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", event.transform.toString())
      })
    zoomRef.current = zoom

    // Attach zoom to SVG — this is the zoom base element
    svg.call(zoom)

    // Disable double-click zoom (we use dblclick for navigation)
    svg.on("dblclick.zoom", null)

    // ── Data ──────────────────────────────────────────────────────
    const nodes: GraphNode[] = data.nodes.map((m) => ({ id: m.id, memory: m }))
    nodesRef.current = nodes
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    const edges: GraphEdge[] = data.edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
        similarity: e.similarity,
      }))

    // ── Simulation ────────────────────────────────────────────────
    const simulation = d3Force
      .forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3Force
          .forceLink<GraphNode, GraphEdge>(edges)
          .id((d) => d.id)
          .distance((d) => 100 * (1 - d.similarity)),
      )
      .force("charge", d3Force.forceManyBody().strength(-200))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collision", d3Force.forceCollide(20))
      // Gentle per-node pull toward center so edge-less orphans rest at the
      // cluster's rim instead of being flung to a corner by charge repulsion
      // (forceCenter only fixes the centroid, not individual nodes).
      .force("x", d3Force.forceX(width / 2).strength(0.06))
      .force("y", d3Force.forceY(height / 2).strength(0.06))

    simulationRef.current = simulation

    // ── Edges ─────────────────────────────────────────────────────
    const link = g
      .selectAll<SVGLineElement, GraphEdge>("line")
      .data(edges)
      .join("line")
      .attr("stroke", "color-mix(in oklch, currentColor 25%, transparent)")
      .attr("stroke-width", (d) => Math.max(0.5, d.similarity * 3))
      .attr("stroke-opacity", 0.4)

    // ── Nodes ─────────────────────────────────────────────────────
    // Initial fill via the ref so first paint honors the active axis; the
    // recolor effect keeps it in sync on toggle.
    const resolve0 = (m: Memory) =>
      colorAxisRef.current === "scope"
        ? scopeColors[m.scope] ?? FALLBACK_COLOR
        : typeColorMap.get(m.document_type ?? UNTYPED) ?? FALLBACK_COLOR
    const node = g
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", (d) => 6 + d.memory.importance_score * 14)
      .attr("fill", (d) => resolve0(d.memory))
      .attr("stroke", "var(--background)")
      .attr("stroke-width", 1.5)
      .attr("cursor", "pointer")

    // ── Hover (D3 direct DOM — no React state) ────────────────────
    node
      .on("mouseover", (_event, d) => {
        const tip = tooltipRef.current
        if (!tip) return
        tip.style.display = "block"
        tip.querySelector("[data-title]")!.textContent =
          d.memory.title || "Untitled"
        tip.querySelector("[data-content]")!.textContent =
          d.memory.content.slice(0, 150)
        tip.querySelector("[data-scope]")!.textContent = d.memory.scope
        const typeEl = tip.querySelector("[data-type]") as HTMLElement
        if (d.memory.document_type) {
          typeEl.textContent = d.memory.document_type
          typeEl.style.display = "inline-flex"
        } else {
          typeEl.style.display = "none"
        }
        const nsEl = tip.querySelector("[data-namespace]") as HTMLElement
        if (d.memory.namespace) {
          nsEl.textContent = d.memory.namespace
          nsEl.style.display = "inline-flex"
        } else {
          nsEl.style.display = "none"
        }
      })
      .on("mouseout", () => {
        const tip = tooltipRef.current
        if (tip) tip.style.display = "none"
      })

    // ── Labels ────────────────────────────────────────────────────
    // Ellipsis instead of a hard slice, plus a background-coloured halo
    // (paint-order: stroke) so titles stay legible over crossing edges.
    const labelText = (d: GraphNode) => {
      const raw = d.memory.title || d.memory.content
      return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw
    }
    const label = g
      .selectAll<SVGTextElement, GraphNode>("text")
      .data(nodes.filter((n) => n.memory.importance_score > 0.5))
      .join("text")
      .text(labelText)
      .attr("font-size", "10px")
      .attr("font-family", "var(--font-mono)")
      .attr("fill", "var(--foreground)")
      .attr("stroke", "var(--card)")
      .attr("stroke-width", 3)
      .attr("paint-order", "stroke")
      .attr("stroke-linejoin", "round")
      .attr("dx", 12)
      .attr("dy", 4)
      .attr("pointer-events", "none")

    // ── Drag (with click detection) ───────────────────────────────
    // A press that moves < 4px is treated as a click → open the detail
    // drawer; anything more is a real drag. Avoids a separate click handler
    // racing d3-drag's pointer capture.
    let downX = 0
    let downY = 0
    let moved = false
    const drag = d3Drag
      .drag<SVGCircleElement, GraphNode>()
      .on("start", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        moved = false
        downX = event.x
        downY = event.y
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on("drag", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        if (Math.hypot(event.x - downX, event.y - downY) > 4) moved = true
        d.fx = event.x
        d.fy = event.y
      })
      .on("end", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
        if (!moved) setActive(d.memory)
      })
    node.call(drag)

    // ── Tick ──────────────────────────────────────────────────────
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x!)
        .attr("y1", (d) => (d.source as GraphNode).y!)
        .attr("x2", (d) => (d.target as GraphNode).x!)
        .attr("y2", (d) => (d.target as GraphNode).y!)

      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!)
      label.attr("x", (d) => d.x!).attr("y", (d) => d.y!)
    })

    return () => {
      simulation.stop()
    }
  }, [data, typeColorMap]) // deps: data + stable color map. Axis toggle handled below.

  // ── Recolor in place when the axis toggles (no simulation restart) ──
  useEffect(() => {
    if (!svgRef.current) return
    d3Selection
      .select(svgRef.current)
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .attr("fill", (d) => colorOf(d.memory))
  }, [colorOf])

  // ── Zoom toolbar handlers ──────────────────────────────────────────
  function zoomBy(k: number) {
    if (!svgRef.current || !zoomRef.current) return
    zoomRef.current.scaleBy(d3Selection.select(svgRef.current), k)
  }

  function fitView() {
    const ns = nodesRef.current
    const dims = dimsRef.current
    const zoom = zoomRef.current
    if (!svgRef.current || !zoom || !dims || ns.length === 0) return
    const xs = ns.map((n) => n.x ?? NaN).filter(Number.isFinite)
    const ys = ns.map((n) => n.y ?? NaN).filter(Number.isFinite)
    if (xs.length === 0) return
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const pad = 48
    const dx = maxX - minX || 1
    const dy = maxY - minY || 1
    const scale = Math.min(6, 0.9 * Math.min(dims.w / (dx + pad * 2), dims.h / (dy + pad * 2)))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const t = d3Zoom.zoomIdentity.translate(dims.w / 2, dims.h / 2).scale(scale).translate(-cx, -cy)
    zoom.transform(d3Selection.select(svgRef.current), t)
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="mb-4"><p className="microlabel">entity graph</p><h1 className="font-display mt-1 text-4xl italic">Knowledge Graph</h1></div>
        <Skeleton className="h-[600px]" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div><p className="microlabel">entity graph</p><h1 className="font-display mt-1 text-4xl italic">Knowledge Graph</h1></div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Min importance:</span>
            <div className="w-32">
              <Slider
                value={[minImportance]}
                min={0}
                max={0.8}
                step={0.1}
                onValueChange={(v) => setMinImportance(Array.isArray(v) ? v[0] : v)}
              />
            </div>
            <span className="text-sm">{(minImportance * 100).toFixed(0)}%</span>
          </div>
          <span className="text-sm text-muted-foreground tnum">
            {data?.total ?? 0} nodes · {data?.edges.length ?? 0} edges
          </span>
        </div>
      </div>

      {/* Color axis toggle + dynamic legend (present categories only) */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex items-center gap-1 rounded-md border p-0.5">
          <span className="microlabel px-1.5">color</span>
          {(["type", "scope"] as ColorAxis[]).map((axis) => (
            <button
              key={axis}
              onClick={() => setColorAxis(axis)}
              className={cn(
                "rounded px-2 py-0.5 font-mono text-xs lowercase transition-colors",
                colorAxis === axis ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {axis}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {legend.map((e) => (
            <div key={e.key} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: e.color }} />
              <span className="text-xs text-muted-foreground">
                {e.key} <span className="tnum opacity-60">{e.count}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Graph container — ref on the div for reliable dimension measurement */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-card">
        <svg ref={svgRef} style={{ display: "block" }} />

        {/* Zoom / fit controls */}
        <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-md border bg-popover/90 backdrop-blur-sm">
          <button onClick={() => zoomBy(1.3)} aria-label="Zoom in" className="p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Plus className="h-4 w-4" />
          </button>
          <button onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out" className="border-t p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Minus className="h-4 w-4" />
          </button>
          <button onClick={fitView} aria-label="Fit to view" className="border-t p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>

        {/* Tooltip — always in DOM, toggled via D3 */}
        <div
          ref={tooltipRef}
          style={{ display: "none", pointerEvents: "none" }}
          className="absolute bottom-4 left-4 z-10 w-72 rounded-xl border bg-popover p-4 shadow-lg"
        >
          <p data-title className="text-sm font-medium" />
          <p data-content className="mt-1 line-clamp-3 text-xs text-muted-foreground" />
          <div className="mt-2 flex flex-wrap gap-1">
            <span
              data-scope
              className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs"
            />
            <span
              data-type
              className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            />
            <span
              data-namespace
              className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Click for details</p>
        </div>
      </div>

      {/* Detail drawer — opens on node click; data comes straight from the
          node's Memory object, so no fetch is needed. */}
      <Sheet open={!!active} onOpenChange={(open) => { if (!open) setActive(null) }}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
          {active && (
            <>
              <SheetHeader className="border-b">
                <p className="microlabel">memory</p>
                <SheetTitle className="font-display text-2xl italic leading-tight">
                  {active.title || "Untitled"}
                </SheetTitle>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(active) }} />
                    {active.document_type ?? "untyped"}
                  </span>
                  <Badge variant="outline">{active.scope}</Badge>
                  {active.namespace && <Badge variant="secondary">{active.namespace}</Badge>}
                </div>
              </SheetHeader>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">
                  {active.content}
                </pre>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {[
                    ["Importance", `${(active.importance_score * 100).toFixed(0)}%`],
                    ["Confidence", `${(active.confidence_score * 100).toFixed(0)}%`],
                    ["Access count", String(active.access_count)],
                    ["Version", `v${active.version}`],
                    ["Created", new Date(active.created_at).toLocaleDateString()],
                    ["Updated", new Date(active.updated_at).toLocaleDateString()],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="tnum font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>

                {active.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {active.tags.map((t) => (
                      <Badge key={t} variant="outline">{t}</Badge>
                    ))}
                  </div>
                )}
              </div>

              <SheetFooter className="border-t">
                <Button variant="outline" onClick={() => navigate(`/memory/${active.id}`)}>
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                  Open full record
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
