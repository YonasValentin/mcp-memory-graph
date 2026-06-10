import { NavLink, Outlet } from "react-router-dom"
import { Brain, Search, List, GitGraph, LayoutDashboard, Terminal } from "lucide-react"
import { cn } from "@/lib/utils"
import { ThemeToggle } from "@/components/ThemeToggle"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", code: "01" },
  { to: "/search", icon: Search, label: "Search", code: "02" },
  { to: "/browse", icon: List, label: "Browse", code: "03" },
  { to: "/graph", icon: GitGraph, label: "Graph", code: "04" },
  { to: "/tools", icon: Terminal, label: "Tools", code: "05" },
]

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar">
        <div className="border-b px-4 py-5">
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            <span className="font-display text-xl italic leading-none">mcp-memory</span>
          </div>
          <p className="microlabel mt-2">local-first archive</p>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {navItems.map(({ to, icon: Icon, label, code }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary transition-opacity",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <Icon className={cn("h-4 w-4", isActive && "text-primary")} />
                  {label}
                  <span className="ml-auto font-mono text-[10px] tracking-widest text-muted-foreground/60">
                    {code}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-2">
          <ThemeToggle />
          <p className="microlabel mt-2 px-3 pb-1">
            on-device · $0/token
          </p>
        </div>
      </aside>

      {/* Main content */}
      <main className="bg-archive flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
