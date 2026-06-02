import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Top-level boundary that catches render-time errors in the dashboard
 * tree. Without this, a thrown error in any page leaves the user with a
 * blank white screen.
 *
 * Network errors are handled per-page via `toastError`; this is for
 * non-recoverable component failures (bad JSON shape, undefined access,
 * etc.).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-[80vh] items-center justify-center p-8">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Something broke</h1>
          <p className="text-sm text-muted-foreground">
            The dashboard hit an unexpected error. The details are in your browser console.
          </p>
          <pre className="overflow-auto rounded bg-muted p-3 text-left text-xs">
            {this.state.error.message}
          </pre>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={this.handleReset}>
              Try again
            </Button>
            <Button onClick={this.handleReload}>Reload page</Button>
          </div>
        </div>
      </div>
    )
  }
}
