import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import * as d3Force from "d3-force"
import * as d3Selection from "d3-selection"
import * as d3Zoom from "d3-zoom"
import * as d3Drag from "d3-drag"
import { getGraphData } from "@/api/client"
import { toastError } from "@/lib/toast-error"
import type { GraphData, Memory } from "@/types"

interface GraphNode extends d3Force.SimulationNodeDatum {
  id: string
  memory: Memory
}

interface GraphEdge extends d3Force.SimulationLinkDatum<GraphNode> {
  similarity: number
}

const scopeColors: Record<string, string> = {
  global: "#1E40AF",
  project: "#3B82F6",
  user: "#8B5CF6",
  team: "#10B981",
  department: "#F59E0B",
}

export function KnowledgeGraph() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const simulationRef = useRef<d3Force.Simulation<GraphNode, GraphEdge> | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const navigateRef = useRef<ReturnType<typeof useNavigate>>(null!)

  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [minImportance, setMinImportance] = useState(0)

  // Keep navigate ref current without it being an effect dependency. Assign in
  // an effect (not during render — a ref must not be mutated while rendering).
  const navigate = useNavigate()
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

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

    // Attach zoom to SVG — this is the zoom base element
    svg.call(zoom)

    // Disable double-click zoom (we use dblclick for navigation)
    svg.on("dblclick.zoom", null)

    // ── Data ──────────────────────────────────────────────────────
    const nodes: GraphNode[] = data.nodes.map((m) => ({ id: m.id, memory: m }))
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

    simulationRef.current = simulation

    // ── Edges ─────────────────────────────────────────────────────
    const link = g
      .selectAll<SVGLineElement, GraphEdge>("line")
      .data(edges)
      .join("line")
      .attr("stroke", "#e5e7eb")
      .attr("stroke-width", (d) => Math.max(0.5, d.similarity * 3))
      .attr("stroke-opacity", 0.4)

    // ── Nodes ─────────────────────────────────────────────────────
    const node = g
      .selectAll<SVGCircleElement, GraphNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", (d) => 6 + d.memory.importance_score * 14)
      .attr("fill", (d) => scopeColors[d.memory.scope] ?? "#6B7280")
      .attr("stroke", "#fff")
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
      .on("dblclick", (_event, d) => {
        navigateRef.current(`/memory/${d.memory.id}`)
      })

    // ── Labels ────────────────────────────────────────────────────
    const label = g
      .selectAll<SVGTextElement, GraphNode>("text")
      .data(nodes.filter((n) => n.memory.importance_score > 0.5))
      .join("text")
      .text((d) => d.memory.title?.slice(0, 20) ?? d.memory.content.slice(0, 20))
      .attr("font-size", "10px")
      .attr("fill", "#6B7280")
      .attr("dx", 12)
      .attr("dy", 4)
      .attr("pointer-events", "none")

    // ── Drag ──────────────────────────────────────────────────────
    const drag = d3Drag
      .drag<SVGCircleElement, GraphNode>()
      .on("start", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on("drag", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on("end", (event: d3Drag.D3DragEvent<SVGCircleElement, GraphNode, GraphNode>, d: GraphNode) => {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
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
  }, [data]) // deps: ONLY data. Zoom/drag/hover are D3-managed.

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-bold tracking-tight">Knowledge Graph</h1>
        <Skeleton className="h-[600px]" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Knowledge Graph</h1>
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
          <span className="text-sm text-muted-foreground">
            {data?.total ?? 0} nodes · {data?.edges.length ?? 0} edges
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="mb-3 flex gap-3">
        {Object.entries(scopeColors).map(([scope, color]) => (
          <div key={scope} className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs text-muted-foreground">{scope}</span>
          </div>
        ))}
      </div>

      {/* Graph container — ref on the div for reliable dimension measurement */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-card">
        <svg ref={svgRef} style={{ display: "block" }} />

        {/* Tooltip — always in DOM, toggled via D3 */}
        <div
          ref={tooltipRef}
          style={{ display: "none", pointerEvents: "none" }}
          className="absolute bottom-4 left-4 z-10 w-72 rounded-xl border bg-popover p-4 shadow-lg"
        >
          <p data-title className="text-sm font-medium" />
          <p data-content className="mt-1 line-clamp-3 text-xs text-muted-foreground" />
          <div className="mt-2 flex gap-1">
            <span
              data-scope
              className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs"
            />
            <span
              data-namespace
              className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Double-click to open</p>
        </div>
      </div>
    </div>
  )
}
