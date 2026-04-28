import { toast } from "sonner"
import { ApiError } from "@/api/client"

/**
 * Renders an error to a toast and logs the full payload for debugging.
 * Used by every page's fetch error path so a failed API call surfaces
 * to the user instead of leaving the UI stuck in a skeleton.
 */
export function toastError(err: unknown, fallback = "Something went wrong"): void {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      toast.error("Not authorized — set your bearer token to continue.", {
        description: "Run localStorage.setItem('mcp.token', '<token>') in the console, then refresh.",
      })
      return
    }
    if (err.status === 429) {
      toast.error("Rate limited — please retry in a moment.")
      return
    }
    if (err.status === 404) {
      toast.error(err.message || "Not found")
      return
    }
    toast.error(err.message || fallback, {
      description: err.requestId ? `requestId: ${err.requestId}` : undefined,
    })
    return
  }

  const message = err instanceof Error ? err.message : String(err ?? fallback)
  toast.error(message)
  // Surface in the dev console so the requestId / stack is searchable.
  // eslint-disable-next-line no-console
  console.error("[toastError]", err)
}
