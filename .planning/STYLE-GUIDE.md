# Web Dashboard Style Guide

Design system and conventions for the MCP Memory Server web dashboard.

Generated from the ui-ux-pro-max skill's "Data-Dense Dashboard" recommendation, adapted for a developer-facing knowledge management tool.

---

## Design Philosophy

**Data-Dense Dashboard** — minimal padding, grid layout, maximum data visibility. Every pixel should serve a purpose. Hover states, tooltips, and chart interactions over decorative elements.

### Principles

1. **Information density over whitespace** — this is a tool, not a marketing page
2. **Consistency through shadcn** — use shadcn/ui components for all interactive elements
3. **Tailwind utility classes** — no custom CSS files beyond index.css theme tokens
4. **D3 for visualization, React for everything else** — D3 owns SVG DOM, React owns the rest

---

## Colors

### Theme Tokens (CSS Variables)

All colors are defined in `web/src/index.css` as oklch values, managed by shadcn. Use the semantic token names, never raw hex/oklch.

| Token | Usage |
|-------|-------|
| `--background` | Page background |
| `--foreground` | Primary text |
| `--card` / `--card-foreground` | Card surfaces |
| `--primary` / `--primary-foreground` | Primary buttons, active nav |
| `--secondary` / `--secondary-foreground` | Secondary badges, namespace chips |
| `--muted` / `--muted-foreground` | Subtle text, descriptions |
| `--accent` / `--accent-foreground` | Hover states, active rows |
| `--destructive` | Delete buttons, error states |
| `--border` | Borders, separators |

### Confidence Level Colors

Used in search results to indicate match quality:

| Level | Light Mode | Dark Mode |
|-------|-----------|-----------|
| High | `bg-green-100 text-green-800` | `bg-green-900 text-green-300` |
| Medium | `bg-yellow-100 text-yellow-800` | `bg-yellow-900 text-yellow-300` |
| Low | `bg-red-100 text-red-800` | `bg-red-900 text-red-300` |

### Match Type Colors

Used in search results to indicate how the match was found:

| Type | Light Mode | Dark Mode |
|------|-----------|-----------|
| Hybrid | `bg-purple-100 text-purple-800` | `bg-purple-900 text-purple-300` |
| Vector | `bg-blue-100 text-blue-800` | `bg-blue-900 text-blue-300` |
| Keyword | `bg-orange-100 text-orange-800` | `bg-orange-900 text-orange-300` |

### Knowledge Graph Node Colors

Nodes are colored by memory scope:

| Scope | Hex | Usage |
|-------|-----|-------|
| global | `#1E40AF` | Deep blue |
| project | `#3B82F6` | Bright blue |
| user | `#8B5CF6` | Purple |
| team | `#10B981` | Green |
| department | `#F59E0B` | Amber |

### Quality Score Indicator

Used in the Browse table:

| Range | Color | Dot |
|-------|-------|-----|
| >= 70% | Green | `bg-green-500` |
| >= 40% | Yellow | `bg-yellow-500` |
| < 40% | Red | `bg-red-500` |

---

## Typography

| Role | Font | Class |
|------|------|-------|
| Body text | Geist Variable | `font-sans` (default) |
| Headings | Geist Variable | `font-heading` (same as sans) |
| Code/content | System monospace | `font-mono` |

### Scale

| Element | Class |
|---------|-------|
| Page title | `text-2xl font-bold tracking-tight` |
| Card title | `text-sm font-medium` |
| Body text | `text-sm` |
| Descriptions | `text-xs text-muted-foreground` |
| Badges | `text-xs` |

---

## Layout

### App Shell

```
┌──────────┬─────────────────────────────┐
│ Sidebar  │ Main Content                │
│ w-56     │ flex-1 overflow-auto        │
│ border-r │                             │
│ bg-card  │ p-6                         │
│          │                             │
│ Logo     │ Page title (text-2xl)       │
│ Nav      │ Content                     │
│ Footer   │                             │
└──────────┴─────────────────────────────┘
```

- Root: `flex h-screen overflow-hidden bg-background`
- Sidebar: `w-56 shrink-0 flex-col border-r bg-card`
- Main: `flex-1 overflow-auto`
- Page content: `p-6` with `space-y-6` for vertical rhythm

### Navigation

Active nav item: `bg-primary text-primary-foreground`
Inactive: `text-muted-foreground hover:bg-accent hover:text-accent-foreground`

---

## Components

### shadcn/ui Components in Use

| Component | Where Used |
|-----------|-----------|
| Card, CardHeader, CardContent, CardTitle | Dashboard stats, memory cards, detail views |
| Badge | Tags, confidence levels, match types, scope indicators |
| Button | Search, pagination, edit/delete actions |
| Input | Search bar, edit forms |
| Select | Search mode, scope filter, sort controls |
| Tabs, TabsList, TabsTrigger, TabsContent | Memory detail (content/versions/related/metadata) |
| Table, TableHeader, TableRow, TableCell | Browse page |
| Dialog, DialogContent, DialogHeader, DialogFooter | Edit memory modal |
| Skeleton | Loading states |
| Separator | Metadata sections |
| Slider | Graph importance filter |
| Sonner (toast) | Success/error notifications |
| Tooltip | Graph node hover info |

### Custom Components

| Component | File | Purpose |
|-----------|------|---------|
| Layout | `components/Layout.tsx` | App shell with sidebar |
| QualityDot | inline in `pages/Browse.tsx` | Color dot + percentage |

---

## Patterns

### Data Fetching

- `useEffect` with `useState` for initial loads
- No external data fetching library (fetch + async/await)
- Loading states use `<Skeleton>` components
- Errors shown via `sonner` toast

### Fuzzy Search (Fuse.js)

- Index built from all memory titles + tags on page load
- Suggestions shown after 2+ characters
- Keyboard navigation (arrow keys + enter + escape)
- Clicking a suggestion navigates to memory detail

### D3 Integration (Knowledge Graph)

- D3 owns SVG DOM, React owns everything else
- Simulation stored in `useRef` (persists across renders)
- Hover tooltip managed via direct DOM manipulation (no React state)
- Navigate ref stored in `useRef` to avoid effect dependencies
- Transparent `<rect>` for zoom/pan event capture
- `useLayoutEffect` for accurate dimension measurement

### REST API Client

- All API calls in `web/src/api/client.ts`
- Thin `fetchJson<T>()` wrapper with error handling
- Query string builder `qs()` for GET params

---

## File Structure Convention

```
web/src/
├── api/client.ts          # All API calls
├── components/
│   ├── ui/                # shadcn components (auto-generated, don't edit)
│   └── Layout.tsx         # App shell
├── hooks/                 # Reusable hooks (shadcn-generated)
├── lib/utils.ts           # cn() utility
├── pages/                 # One file per route
│   ├── Dashboard.tsx
│   ├── Search.tsx
│   ├── Browse.tsx
│   ├── MemoryDetail.tsx
│   └── KnowledgeGraph.tsx
├── types.ts               # Shared TypeScript types (mirrors server types)
├── App.tsx                # Router
└── main.tsx               # Entry point
```

### Naming

- Pages: PascalCase (`Dashboard.tsx`)
- shadcn components: kebab-case (`card.tsx`) — don't rename these
- Custom components: PascalCase
- API functions: camelCase (`getStats`, `searchMemories`)
- Types: PascalCase (`Memory`, `SearchResult`)
