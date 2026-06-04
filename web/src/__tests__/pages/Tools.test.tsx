/**
 * TDD — Tools console page (web/src/pages/Tools.tsx).
 *
 * The console is the dashboard's path to the FULL 49-tool surface: it lists every
 * tool the server advertises, renders a dynamic form from each tool's JSON-Schema
 * input, and invokes it via the MCP client. These tests drive the real component
 * with the mcp client module mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { Tools } from "@/pages/Tools"
import * as mcp from "@/api/mcp"

vi.mock("@/api/mcp", () => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
}))

const TOOLS: mcp.McpTool[] = [
  {
    name: "memory_stats",
    description: "Aggregate statistics.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_store",
    description: "Persist one fact.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "the fact" },
        scope: { type: "string", enum: ["global", "project"] },
        dry_run: { type: "boolean", default: false },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_delete",
    description: "Hard delete.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
]

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  asMock(mcp.listTools).mockResolvedValue(TOOLS)
  asMock(mcp.callTool).mockResolvedValue({ isError: false, text: "ok-result", raw: {} })
})

const runButton = () => screen.getByRole("button", { name: /^Run/ })

describe("Tools console", () => {
  it("loads and lists every advertised tool", async () => {
    render(<Tools />)
    expect(await screen.findByRole("button", { name: /memory_stats/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /memory_store/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /memory_delete/ })).toBeInTheDocument()
  })

  it("surfaces a tools/list failure", async () => {
    asMock(mcp.listTools).mockRejectedValue(new Error("unauthorized"))
    render(<Tools />)
    expect(await screen.findByText(/unauthorized/)).toBeInTheDocument()
  })

  it("renders a dynamic form for the selected tool", async () => {
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_store/ }))
    expect(screen.getByLabelText(/content/)).toBeInTheDocument()
    expect(screen.getByLabelText(/scope/)).toBeInTheDocument()
    expect(screen.getByLabelText(/dry_run/)).toBeInTheDocument()
  })

  it("runs a read tool and shows the result", async () => {
    asMock(mcp.callTool).mockResolvedValue({ isError: false, text: '{"total_memories":7}', raw: {} })
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_stats/ }))
    fireEvent.click(runButton())
    await waitFor(() => expect(mcp.callTool).toHaveBeenCalledWith("memory_stats", {}))
    expect(await screen.findByText(/total_memories/)).toBeInTheDocument()
  })

  it("coerces typed args from the form on run", async () => {
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_store/ }))
    fireEvent.change(screen.getByLabelText(/content/), { target: { value: "a durable fact" } })
    fireEvent.click(runButton())
    await waitFor(() =>
      expect(mcp.callTool).toHaveBeenCalledWith("memory_store", { content: "a durable fact", dry_run: false }),
    )
  })

  it("confirms before a destructive tool and aborts when declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_delete/ }))
    fireEvent.change(screen.getByLabelText(/id/), { target: { value: "abc" } })
    fireEvent.click(runButton())
    expect(confirmSpy).toHaveBeenCalled()
    expect(mcp.callTool).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    fireEvent.click(runButton())
    await waitFor(() => expect(mcp.callTool).toHaveBeenCalledWith("memory_delete", { id: "abc" }))
  })

  it("shows an error result distinctly", async () => {
    asMock(mcp.callTool).mockResolvedValue({ isError: true, text: "Field required", raw: {} })
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_store/ }))
    fireEvent.click(runButton())
    expect(await screen.findByText(/Field required/)).toBeInTheDocument()
  })

  it("blocks run with a clear message when an object field holds invalid JSON", async () => {
    const withObj: mcp.McpTool = {
      name: "memory_query_structured",
      description: "filter",
      inputSchema: { type: "object", properties: { filter: { type: "object" } } },
    }
    asMock(mcp.listTools).mockResolvedValue([withObj])
    render(<Tools />)
    fireEvent.click(await screen.findByRole("button", { name: /memory_query_structured/ }))
    fireEvent.change(screen.getByLabelText(/filter/), { target: { value: "{not json" } })
    fireEvent.click(runButton())
    expect(await screen.findByText(/must be valid JSON/)).toBeInTheDocument()
    expect(mcp.callTool).not.toHaveBeenCalled()
  })
})
