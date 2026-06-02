import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ApiError, getAuthToken, setAuthToken, getStats } from "@/api/client"

const FETCH_RESPONSE = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("auth token plumbing", () => {
  it("getAuthToken reads from localStorage", () => {
    setAuthToken("hunter2")
    expect(getAuthToken()).toBe("hunter2")
  })

  it("setAuthToken(null) clears the stored token", () => {
    setAuthToken("x")
    setAuthToken(null)
    expect(getAuthToken()).toBeNull()
  })
})

describe("fetchJson", () => {
  it("injects Authorization header when a token is set", async () => {
    setAuthToken("the-token")
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      FETCH_RESPONSE({ total_memories: 0, by_scope: {}, by_department: {}, by_document_type: {}, total_chunks: 0, total_documents: 0, total_content_bytes: 0, database_size_bytes: 0, expired_count: 0 }),
    )

    await getStats()

    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("Authorization")).toBe("Bearer the-token")
  })

  it("does not send Authorization when no token is configured", async () => {
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      FETCH_RESPONSE({ total_memories: 0, by_scope: {}, by_department: {}, by_document_type: {}, total_chunks: 0, total_documents: 0, total_content_bytes: 0, database_size_bytes: 0, expired_count: 0 }),
    )

    await getStats()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.has("Authorization")).toBe(false)
  })

  it("throws ApiError with status, code, and requestId on failure", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(
      FETCH_RESPONSE(
        { error: "Not authorized", code: "UNAUTHORIZED", requestId: "abc-123" },
        { status: 401 },
      ),
    )

    await expect(getStats()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "UNAUTHORIZED",
      requestId: "abc-123",
    })
  })

  it("falls back to HTTP status text when the body isn't JSON", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(
      new Response("oops", { status: 503, statusText: "Service Unavailable" }),
    )

    await expect(getStats()).rejects.toBeInstanceOf(ApiError)
  })
})
