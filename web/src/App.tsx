import { BrowserRouter, Routes, Route } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { Layout } from "@/components/Layout"
import { Dashboard } from "@/pages/Dashboard"
import { Search } from "@/pages/Search"
import { Browse } from "@/pages/Browse"
import { MemoryDetail } from "@/pages/MemoryDetail"
import { KnowledgeGraph } from "@/pages/KnowledgeGraph"

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="search" element={<Search />} />
                <Route path="browse" element={<Browse />} />
                <Route path="memory/:id" element={<MemoryDetail />} />
                <Route path="graph" element={<KnowledgeGraph />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  )
}
