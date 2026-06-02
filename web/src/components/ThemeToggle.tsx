import { Moon, Sun, Monitor } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

const ORDER = ["light", "dark", "system"] as const
type Theme = (typeof ORDER)[number]

const ICONS: Record<Theme, React.ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  system: <Monitor className="h-4 w-4" />,
}

const LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const current = (theme as Theme) ?? "system"

  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-full justify-start gap-2 text-xs text-muted-foreground"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABELS[current]}. Click to switch to ${LABELS[next]}`}
      title={`Theme: ${LABELS[current]}`}
    >
      {ICONS[current]}
      <span>{LABELS[current]} theme</span>
    </Button>
  )
}
