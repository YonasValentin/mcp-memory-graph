import { BrowserRouter, Routes, Route } from "react-router-dom"
import { lazy, Suspense } from "react"
import { ThemeProvider } from "next-themes"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { Layout } from "@/components/Layout"

// Route-level code splitting: each page (and its heavy deps — D3 in the graph,
// recharts in the dashboard) ships as its own lazy chunk, so the initial load
// isn't a single 600 kB bundle. The Layout shell stays eager.
const Dashboard = lazy(() => import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })))
const Search = lazy(() => import("@/pages/Search").then((m) => ({ default: m.Search })))
const Browse = lazy(() => import("@/pages/Browse").then((m) => ({ default: m.Browse })))
const MemoryDetail = lazy(() => import("@/pages/MemoryDetail").then((m) => ({ default: m.MemoryDetail })))
const KnowledgeGraph = lazy(() => import("@/pages/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph })))

function RouteFallback() {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="search" element={<Search />} />
                  <Route path="browse" element={<Browse />} />
                  <Route path="memory/:id" element={<MemoryDetail />} />
                  <Route path="graph" element={<KnowledgeGraph />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}
