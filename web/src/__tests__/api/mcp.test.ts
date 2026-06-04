/**
 * TDD — MCP Streamable-HTTP client (web/src/api/mcp.ts).
 *
 * The dashboard reaches the FULL 49-tool surface through the server's existing
 * bearer-authed POST /mcp endpoint (no per-tool REST route needed). This locks
 * the real protocol the probe confirmed against the running server:
 *   1. initialize (no session)        → 200, SSE body, `mcp-session-id` header
 *   2. notifications/initialized      → 202, empty body
 *   3. tools/list (with session)      → 200, SSE body { result: { tools: [...] } }
 *   4. tools/call (with session)      → 200, SSE body { result: { content: [...] } }
 * Responses are SSE frames: `event: message\ndata: <json>\n\n`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  parseSseMessage,
  listTools,
  callTool,
  resetMcpSessionForTests,
} from "@/api/mcp"
import { setAuthToken } from "@/api/client"

const SID = "sess-123"

function sse(obj: unknown): string {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`
}

/** A minimal Response stand-in good enough for the client (text() + headers + ok). */
function res(
  body: string,
  { status = 200, sessionId }: { status?: number; sessionId?: string } = {},
): Response {
  const headers = new Map<string, string>()
  if (sessionId) headers.set("mcp-session-id", sessionId)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
  } as unknown as Response
}

/** Build a fetch mock that answers the 3-4 calls of a typical flow by JSON-RPC method. */
function mockFlow(toolsOrResult: {
  tools?: unknown[]
  callResult?: unknown
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const reqBody = JSON.parse(String(init.body))
    const method = reqBody.method as string
    if (method === "initialize") {
      return res(sse({ jsonrpc: "2.0", id: reqBody.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mcp-memory-graph", version: "2.0.0" } } }), { sessionId: SID })
    }
    if (method === "notifications/initialized") {
      return res("", { status: 202 })
    }
    if (method === "tools/list") {
      return res(sse({ jsonrpc: "2.0", id: reqBody.id, result: { tools: toolsOrResult.tools ?? [] } }))
    }
    if (method === "tools/call") {
      return res(sse({ jsonrpc: "2.0", id: reqBody.id, result: toolsOrResult.callResult }))
    }
    throw new Error(`unexpected method ${method}`)
  })
}

beforeEach(() => {
  resetMcpSessionForTests()
  setAuthToken(null)
  vi.restoreAllMocks()
})

describe("parseSseMessage", () => {
  it("extracts the JSON payload from a single data frame", () => {
    expect(parseSseMessage(sse({ a: 1 }))).toEqual({ a: 1 })
  })
  it("joins multi-line data fields and ignores event/id/comment lines", () => {
    const frame = `: keep-alive\nevent: message\nid: 7\ndata: {"x":\ndata: 42}\n\n`
    expect(parseSseMessage(frame)).toEqual({ x: 42 })
  })
  it("falls back to plain JSON when there is no SSE framing (defensive)", () => {
    expect(parseSseMessage(`{"plain":true}`)).toEqual({ plain: true })
  })
  it("throws on a frame with no JSON payload", () => {
    expect(() => parseSseMessage(`event: message\n\n`)).toThrow()
  })
})

describe("listTools", () => {
  it("runs initialize → initialized → tools/list and returns the tools", async () => {
    const tools = [
      { name: "memory_stats", description: "stats", inputSchema: { type: "object", properties: {} } },
      { name: "memory_store", description: "store", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
    ]
    const f = mockFlow({ tools })
    vi.stubGlobal("fetch", f)

    const got = await listTools()
    expect(got).toHaveLength(2)
    expect(got[0].name).toBe("memory_stats")

    // initialize, initialized, tools/list — in order.
    const methods = f.mock.calls.map((c) => JSON.parse(String(c[1].body)).method)
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"])
    // every non-initialize call carries the session id from initialize.
    const sessioned = f.mock.calls.filter((c) => JSON.parse(String(c[1].body)).method !== "initialize")
    for (const c of sessioned) {
      expect(new Headers(c[1].headers).get("mcp-session-id")).toBe(SID)
    }
  })

  it("reuses the established session on a second call (no re-initialize)", async () => {
    const f = mockFlow({ tools: [{ name: "memory_get", description: "", inputSchema: { type: "object", properties: {} } }] })
    vi.stubGlobal("fetch", f)
    await listTools()
    f.mockClear()
    await listTools()
    const methods = f.mock.calls.map((c) => JSON.parse(String(c[1].body)).method)
    expect(methods).toEqual(["tools/list"]) // no second initialize handshake
  })
})

describe("callTool", () => {
  it("returns the text content of a successful tool result", async () => {
    const f = mockFlow({ callResult: { content: [{ type: "text", text: '{"total_memories":0}' }] } })
    vi.stubGlobal("fetch", f)
    const out = await callTool("memory_stats", {})
    expect(out.isError).toBe(false)
    expect(out.text).toContain("total_memories")
    const callBody = JSON.parse(String(f.mock.calls.find((c) => JSON.parse(String(c[1].body)).method === "tools/call")![1].body))
    expect(callBody.params).toEqual({ name: "memory_stats", arguments: {} })
  })

  it("flags an error result (isError) and still surfaces its text", async () => {
    const f = mockFlow({ callResult: { isError: true, content: [{ type: "text", text: "boom" }] } })
    vi.stubGlobal("fetch", f)
    const out = await callTool("memory_delete", { id: "x" })
    expect(out.isError).toBe(true)
    expect(out.text).toBe("boom")
  })

  it("surfaces a JSON-RPC error as an error result", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body))
      if (b.method === "initialize") return res(sse({ jsonrpc: "2.0", id: b.id, result: {} }), { sessionId: SID })
      if (b.method === "notifications/initialized") return res("", { status: 202 })
      return res(sse({ jsonrpc: "2.0", id: b.id, error: { code: -32602, message: "Invalid params" } }))
    })
    vi.stubGlobal("fetch", f)
    const out = await callTool("memory_store", {})
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/Invalid params/)
  })

  it("injects the bearer token from getAuthToken on every request", async () => {
    setAuthToken("secret-tok")
    const f = mockFlow({ callResult: { content: [{ type: "text", text: "ok" }] } })
    vi.stubGlobal("fetch", f)
    await callTool("memory_stats", {})
    for (const c of f.mock.calls) {
      expect(new Headers(c[1].headers).get("authorization")).toBe("Bearer secret-tok")
    }
  })

  it("re-initializes and retries once when the session is rejected (400)", async () => {
    let phase = 0
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body))
      if (b.method === "initialize") return res(sse({ jsonrpc: "2.0", id: b.id, result: {} }), { sessionId: `sid-${++phase}` })
      if (b.method === "notifications/initialized") return res("", { status: 202 })
      if (b.method === "tools/call") {
        // First established session is rejected once, forcing a re-init + retry.
        if (new Headers(init.headers).get("mcp-session-id") === "sid-1") {
          return res(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "No valid session" }, id: null }), { status: 400 })
        }
        return res(sse({ jsonrpc: "2.0", id: b.id, result: { content: [{ type: "text", text: "recovered" }] } }))
      }
      throw new Error("unexpected")
    })
    vi.stubGlobal("fetch", f)
    const out = await callTool("memory_stats", {})
    expect(out.text).toBe("recovered")
    const inits = f.mock.calls.filter((c) => JSON.parse(String(c[1].body)).method === "initialize")
    expect(inits.length).toBe(2) // initial + one re-init after the 400
  })
})
