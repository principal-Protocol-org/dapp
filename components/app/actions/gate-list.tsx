import type { Blocker } from "@/lib/protocol/gates"

/**
 * Why signing is off, in `BLOCKER_ORDER` (the first is the most fundamental), or that every check
 * passes. Announced politely so a gate that flips while the user waits is read out.
 */
export function GateList({ blockers, className }: { blockers: Blocker[]; className?: string }) {
  return (
    <div aria-live="polite" className={className}>
      {blockers.length === 0 ? (
        <p className="text-sm text-positive">Every check passes.</p>
      ) : (
        <div className="grid gap-2 rounded-lg border border-line bg-surface-sunk p-3 text-sm text-ink wrap-anywhere">
          <p className="label">Signing is off</p>
          <ul className="grid gap-2">
            {blockers.map((b, i) => (
              <li key={`${b.code}-${i}`} className={i === 0 ? "font-medium" : "text-ink-muted"}>
                {b.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
