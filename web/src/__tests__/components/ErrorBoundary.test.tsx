import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ErrorBoundary } from "@/components/ErrorBoundary"

function Boom(): never {
  throw new Error("kaboom")
}

beforeEach(() => {
  // Suppress React's expected error logging during boundary tests so the
  // CI output stays focused on assertions.
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>safe content</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText("safe content")).toBeInTheDocument()
  })

  it("renders the fallback when a child throws and includes the error message", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/something broke/i)).toBeInTheDocument()
    expect(screen.getByText(/kaboom/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument()
  })
})
