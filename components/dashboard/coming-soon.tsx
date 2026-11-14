import Link from "next/link"

/**
 * A dashboard view whose page lands later in this release: its title, what it will show, and a way
 * back. Each later page replaces its placeholder file; nothing else links here.
 */
export function ComingSoon({ title, summary }: { title: string; summary: string }) {
  return (
    <section aria-labelledby="coming-heading" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <h1 id="coming-heading" className="font-serif text-3xl text-ink">
        {title}
      </h1>
      <p className="max-w-[68ch] text-ink-muted">{summary}</p>
      <p className="rounded-lg border border-line bg-surface p-5 text-ink">
        Coming in this release. The{" "}
        <Link href="/dashboard" className="underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          overview
        </Link>{" "}
        already shows the protocol totals, the safety summary and the latest compliance events.
      </p>
    </section>
  )
}
