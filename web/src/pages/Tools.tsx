import { useEffect, useMemo, useState } from "react"
import { listTools, callTool, type McpTool, type ToolCallResult } from "@/api/mcp"
import { toFormFields, coerceArgs, type FormField, type RawValue } from "@/lib/schema-form"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AlertTriangle, Eye, Pencil, Trash2, Globe } from "lucide-react"

/**
 * Tools console — the dashboard's path to the FULL MCP tool surface.
 *
 * The bespoke pages cover the common read flows over typed REST; everything else
 * (store, ingest, forget, consolidate, vault sync, core memory, insights, …) is
 * reachable here: the page lists every tool the server advertises via tools/list
 * and renders a dynamic form from each tool's JSON-Schema input, then invokes it
 * over the same bearer-authed /mcp transport agents use. No per-tool REST route
 * is required, and the console auto-tracks whatever the server exposes.
 */

type Category = "Read" | "Write" | "Destructive" | "Integration"
const CATEGORY_ORDER: Category[] = ["Read", "Write", "Destructive", "Integration"]
const CATEGORY_ICON: Record<Category, typeof Eye> = {
  Read: Eye,
  Write: Pencil,
  Destructive: Trash2,
  Integration: Globe,
}
const CATEGORY_BLURB: Record<Category, string> = {
  Read: "safe — never mutates",
  Write: "persists or updates data",
  Destructive: "asks before it changes data",
  Integration: "reaches an external system",
}

/** First sentence (or ~80 chars) of a tool description, for the compact list. */
function firstLine(desc: string): string {
  const trimmed = desc.trim()
  const dot = trimmed.search(/[.!?](\s|$)/)
  const sentence = dot > 0 ? trimmed.slice(0, dot + 1) : trimmed
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence
}

function categoryOf(t: McpTool): Category {
  if (t.annotations?.destructiveHint) return "Destructive"
  if (t.annotations?.openWorldHint) return "Integration"
  if (t.annotations?.readOnlyHint) return "Read"
  return "Write"
}

export function Tools() {
  const [tools, setTools] = useState<McpTool[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<McpTool | null>(null)
  const [values, setValues] = useState<Record<string, RawValue>>({})
  const [result, setResult] = useState<ToolCallResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState("")

  useEffect(() => {
    let ignore = false
    listTools()
      .then((t) => {
        if (!ignore) setTools(t)
      })
      .catch((e) => {
        if (!ignore) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      ignore = true
    }
  }, [])

  const fields = useMemo<FormField[]>(
    () => (selected ? toFormFields(selected.inputSchema) : []),
    [selected],
  )

  function selectTool(t: McpTool) {
    setSelected(t)
    setResult(null)
    setFormError(null)
    const init: Record<string, RawValue> = {}
    for (const f of toFormFields(t.inputSchema)) {
      init[f.name] = f.kind === "boolean" ? Boolean(f.default) : f.default !== undefined ? String(f.default) : ""
    }
    setValues(init)
  }

  function setValue(name: string, v: RawValue) {
    setValues((prev) => ({ ...prev, [name]: v }))
  }

  async function run() {
    if (!selected) return
    let args: Record<string, unknown>
    try {
      args = coerceArgs(fields, values)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
      return
    }
    setFormError(null)
    if (
      selected.annotations?.destructiveHint &&
      !window.confirm(`Run destructive tool "${selected.name}"? This may permanently change data.`)
    ) {
      return
    }
    setRunning(true)
    setResult(null)
    try {
      const r = await callTool(selected.name, args)
      setResult(r)
    } finally {
      setRunning(false)
    }
  }

  const grouped = useMemo(() => {
    const f = filter.toLowerCase()
    const list = (tools ?? []).filter(
      (t) => t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f),
    )
    const by = {} as Record<Category, McpTool[]>
    for (const t of list) (by[categoryOf(t)] ??= []).push(t)
    return CATEGORY_ORDER.filter((c) => by[c]?.length).map((c) => [c, by[c]!] as const)
  }, [tools, filter])

  return (
    <div className="flex h-full flex-col">
      <header className="mb-4">
        <p className="microlabel">operator console</p>
        <h1 className="font-display mt-1 flex items-center gap-2 text-4xl italic">
          Tools
        </h1>
        <p className="text-sm text-muted-foreground">
          Run any of the server's {tools?.length ?? ""} tools directly. Reads are safe; destructive
          tools ask for confirmation.
        </p>
      </header>

      {loadError && (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load tools: {loadError}
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-[18rem_1fr]">
        {/* ── Tool picker ─────────────────────────────────────────────── */}
        <aside className="flex min-h-0 flex-col rounded-lg border">
          <div className="border-b p-2">
            <input
              aria-label="Filter tools"
              placeholder="Filter tools…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded-md border bg-transparent px-2 py-1 text-sm"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!tools && !loadError && <p className="p-2 text-sm text-muted-foreground">Loading tools…</p>}
            {grouped.map(([cat, list]) => {
              const Icon = CATEGORY_ICON[cat]
              return (
                <div key={cat} className="mb-3">
                  <p className="mb-1 flex items-center gap-1 px-1 text-xs font-medium uppercase text-muted-foreground">
                    <Icon className="h-3 w-3" /> {cat}
                  </p>
                  {list.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => selectTool(t)}
                      className={cn(
                        "block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent",
                        selected?.name === t.name && "bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "block truncate font-mono text-xs",
                          selected?.name === t.name && "font-semibold",
                        )}
                      >
                        {t.name}
                      </span>
                      <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                        {firstLine(t.description)}
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── Selected tool form + result ─────────────────────────────── */}
        <section className="min-w-0 rounded-lg border p-4">
          {!selected ? (
            <div className="reveal flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="microlabel">no tool selected</p>
              <h2 className="font-display text-3xl italic text-muted-foreground">Pick a tool to begin</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Every tool the server advertises is listed at left. Selecting one renders its
                arguments from the live JSON-Schema; running it calls the same MCP transport agents
                use — directly against this on-device archive.
              </p>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-left text-xs text-muted-foreground sm:grid-cols-2">
                {CATEGORY_ORDER.map((c) => {
                  const Icon = CATEGORY_ICON[c]
                  return (
                    <div key={c} className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <dt className="font-mono">{c}</dt>
                      <dd className="opacity-70">{CATEGORY_BLURB[c]}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="flex items-center gap-2 font-mono text-lg font-semibold">
                  {selected.name}
                  {selected.annotations?.destructiveHint && (
                    <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
                      <AlertTriangle className="h-3 w-3" /> destructive
                    </span>
                  )}
                </h2>
                <p className="text-sm text-muted-foreground">{selected.description}</p>
              </div>

              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run()
                }}
              >
                {fields.length === 0 && (
                  <p className="text-sm text-muted-foreground">This tool takes no arguments.</p>
                )}
                {fields.map((f) => (
                  <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => setValue(f.name, v)} />
                ))}

                {formError && (
                  <p role="alert" className="text-sm text-destructive">
                    {formError}
                  </p>
                )}

                <Button type="submit" disabled={running}>
                  {running ? "Running…" : "Run"}
                </Button>
              </form>

              {result && (
                <div data-testid="tool-result">
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    {result.isError ? "Error" : "Result"}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[28rem] overflow-auto rounded-md border p-3 text-xs",
                      result.isError
                        ? "border-destructive/50 bg-destructive/10 text-destructive"
                        : "bg-muted/50",
                    )}
                  >
                    {result.text || "(empty result)"}
                  </pre>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField
  value: RawValue
  onChange: (v: RawValue) => void
}) {
  const id = `field-${field.name}`
  const label = (
    <label htmlFor={id} className="block text-sm font-medium">
      {field.name}
      {field.required && <span className="text-destructive"> *</span>}
    </label>
  )
  const help = field.description && (
    <p className="text-xs text-muted-foreground">{field.description}</p>
  )
  const inputClass = "w-full rounded-md border bg-transparent px-2 py-1 text-sm"

  if (field.kind === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {label}
      {help}
      {field.kind === "enum" ? (
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">—</option>
          {field.enumValues?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.kind === "array" || field.kind === "object" ? (
        <textarea
          id={id}
          rows={field.kind === "object" ? 4 : 2}
          placeholder={field.kind === "array" ? "comma or newline separated" : "JSON"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, "font-mono")}
        />
      ) : (
        <input
          id={id}
          type={field.kind === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
    </div>
  )
}
