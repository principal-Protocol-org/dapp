export function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="label">{label}</dt>
      <dd className="font-mono text-[15px]/6 tabular-nums text-ink">{children}</dd>
    </div>
  )
}
