/**
 * MCP Streamable-HTTP client for the dashboard.
 *
 * The dashboard's bespoke pages cover the common read flows over the typed REST
 * `/api/*` surface. To reach the FULL 49-tool surface (store/ingest/forget/
 * consolidate/vault/core-memory/insights/…), the Tools console talks to the
 * server's existing bearer-authed `POST /mcp` endpoint — the same MCP transport
 * every agent client uses — so no per-tool REST route has to be added and the UI
 * auto-tracks whatever tools the server advertises.
 *
 * Protocol (confirmed against the running server):
 *   1. initialize (no session)   → 200, SSE body, `mcp-session-id` response header
 *   2. notifications/initialized → 202, empty body
 *   3. tools/list / tools/call   → 200, SSE body (`event: message\ndata: <json>`)
 * The session id is cached for the page's lifetime and transparently
 * re-established if the server forgets it (e.g. a restart → 400/404).
 */
import { getAuthToken } from "./client"

const MCP_URL = "/mcp"

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: unknown[]
  default?: unknown
  description?: string
  minimum?: number
  maximum?: number
  [k: string]: unknown
}

export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchema
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
  }
}

export interface ToolCallResult {
  /** Concatenated text of the result's text content (or the error message). */
  text: string
  /** True when the tool reported a failure or the JSON-RPC layer returned an error. */
  isError: boolean
  /** The raw `result` (or `error`) object for callers that want structured data. */
  raw: unknown
}

interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: number | string | null
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean; tools?: McpTool[] }
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Parse a single MCP HTTP response body. Responses are SSE frames
 * (`event: message\ndata: <json>`), but a defensive plain-JSON fallback keeps
 * the client working if a transport ever answers with `application/json`.
 */
export function parseSseMessage(text: string): JsonRpcMessage {
  const dataLines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      // strip "data:" + an optional single leading space (SSE spec)
      dataLines.push(line.slice(5).replace(/^ /, ""))
    }
  }
  if (dataLines.length > 0) {
    return JSON.parse(dataLines.join("")) as JsonRpcMessage
  }
  const trimmed = text.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as JsonRpcMessage
  }
  throw new Error("MCP response carried no JSON payload")
}

// ── Session state (module singleton for the page's lifetime) ────────────────
let sessionId: string | null = null
let nextId = 1

/** Test seam: drop the cached session + id counter so each test starts clean. */
export function resetMcpSessionForTests(): void {
  sessionId = null
  nextId = 1
}

function postMcp(body: Record<string, unknown>, withSession: boolean): Promise<Response> {
  const headers = new Headers()
  headers.set("Content-Type", "application/json")
  headers.set("Accept", "application/json, text/event-stream")
  const token = getAuthToken()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (withSession && sessionId) headers.set("mcp-session-id", sessionId)
  return fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) })
}

async function initialize(): Promise<void> {
  const res = await postMcp(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-memory-dashboard", version: "1.0" },
      },
    },
    false,
  )
  const sid = res.headers.get("mcp-session-id")
  const msg = parseSseMessage(await res.text())
  if (msg.error) throw new Error(`MCP initialize failed: ${msg.error.message}`)
  if (!sid) throw new Error("MCP initialize returned no session id")
  sessionId = sid
  // Required handshake step; the server replies 202 with an empty body.
  await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, true)
}

async function ensureSession(): Promise<void> {
  if (!sessionId) await initialize()
}

/** Issue a JSON-RPC request, transparently (re)establishing the session once. */
async function rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
  await ensureSession()
  let res = await postMcp({ jsonrpc: "2.0", id: nextId++, method, params }, true)
  // A forgotten/expired session (server restart) → re-initialize once and retry.
  if (res.status === 400 || res.status === 404) {
    sessionId = null
    await ensureSession()
    res = await postMcp({ jsonrpc: "2.0", id: nextId++, method, params }, true)
  }
  return parseSseMessage(await res.text())
}

/** List every tool the server advertises (name + description + JSON-Schema input). */
export async function listTools(): Promise<McpTool[]> {
  const msg = await rpc("tools/list", {})
  if (msg.error) throw new Error(msg.error.message)
  return msg.result?.tools ?? []
}

/** Invoke a tool by name with the given arguments; never throws on a tool error. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const msg = await rpc("tools/call", { name, arguments: args })
  if (msg.error) {
    return { isError: true, text: msg.error.message ?? "Unknown error", raw: msg.error }
  }
  const result = msg.result ?? {}
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
  return { isError: Boolean(result.isError), text, raw: result }
}
