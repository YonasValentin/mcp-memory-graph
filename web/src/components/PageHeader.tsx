import type { ReactNode } from "react"

/**
 * Page voice of the Archive Terminal identity: a tracked-out mono kicker over
 * a large Instrument Serif italic title, with an optional right-aligned slot.
 */
export function PageHeader({
  kicker,
  title,
  children,
}: {
  kicker: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="microlabel">{kicker}</p>
        <h1 className="font-display mt-1 text-4xl italic">{title}</h1>
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  )
}
