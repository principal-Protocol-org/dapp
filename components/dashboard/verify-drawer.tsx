"use client"

import { Fragment, type ReactNode } from "react"
import { CopyIcon, ExternalLink } from "lucide-react"
import { useManifest } from "@/components/app/manifest-provider"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useNow } from "@/hooks/use-dashboard"
import { contractLabel, figureEvidence, verifyCommand, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import type { Live, Manifest, Network, ReadSource } from "@/lib/protocol/types"
import { copyText } from "./copy-evidence"

type AnySource = ReadSource | Omit<ReadSource, "rawXdr" | "ledger">

/** The reads to repeat: every input of a live figure, or the call a failed read attempted. */
function readsFor(live: Live<unknown>): AnySource[] {
  if (live.status === "live") return live.sources ?? (live.source ? [live.source] : [])
  return live.source ? [live.source] : []
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="label">{label}</dt>
      <dd className="min-w-0 font-mono text-[13px]/5 text-ink wrap-anywhere">{children}</dd>
    </div>
  )
}

function ContractId({ network, id }: { network: Network; id: string }) {
  const url = explorerUrl(network, "contract", id)
  if (!url) return <span className="block wrap-anywhere">{id}</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block text-ink underline decoration-line-strong underline-offset-3 wrap-anywhere hover:decoration-ink">
      {id}
      <ExternalLink aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
      <span className="sr-only"> (opens stellar.expert)</span>
    </a>
  )
}

/** One read's `stellar contract invoke … --send=no` command, under its contract's role and function, with a copy button; or why there is none. */
function Command({ manifest, source, copyLabel }: { manifest: Manifest; source: AnySource; copyLabel: string }) {
  const title = <p className="font-mono text-xs/5 font-semibold text-ink">{`${contractLabel(manifest, source.contractId)} · ${source.fn}`}</p>
  let command: string
  try {
    command = verifyCommand(manifest.network, source)
  } catch (error) {
    return (
      <div className="grid gap-1">
        {title}
        <p className="text-sm text-ink">No command: {error instanceof Error ? error.message : String(error)}</p>
      </div>
    )
  }
  return (
    <div className="grid gap-2 rounded-md border border-line bg-surface-sunk p-3">
      {title}
      {/* Flags stay whole ("--source-account" never splits at its hyphens); long ids may wrap anywhere. The text is the command as is. */}
      <code className="font-mono text-xs/5 text-ink wrap-anywhere">
        {command.split(" ").map((word, i) => (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            <span className={word.startsWith("--") ? "whitespace-nowrap" : undefined}>{word}</span>
          </Fragment>
        ))}
      </code>
      <button
        type="button"
        aria-label={copyLabel}
        onClick={() => copyText(command, "Command copied")}
        className="inline-flex w-fit items-center gap-1.5 rounded-sm text-xs font-semibold text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <CopyIcon aria-hidden="true" className="size-3.5" />
        Copy
      </button>
    </div>
  )
}

function DrawerBody({ figure, scale }: { figure: VerifiableFigure; scale?: string }) {
  const m = useManifest()
  const now = useNow()
  const e = figureEvidence(figure, { manifest: m, now: now ?? undefined })
  const reads = readsFor(figure.live)
  const contracts = [...new Set(reads.map((r) => r.contractId))]
  const fallbacks = m.rpcFallbackUrls ?? []
  const fnCounts = new Map<string, number>()
  for (const r of reads) fnCounts.set(r.fn, (fnCounts.get(r.fn) ?? 0) + 1)
  const warn = figure.live.status === "unavailable" || e.status.startsWith("Stale")
  return (
    <>
      <DialogHeader className="pr-8">
        <p className="label">How to verify</p>
        <DialogTitle className="font-serif text-2xl/8 font-normal text-ink">{figure.label}</DialogTitle>
        <DialogDescription className="text-ink-muted">
          Each value below comes from a contract read you can repeat. The command only simulates the call: nothing is signed or sent.
        </DialogDescription>
      </DialogHeader>
      <dl className="grid gap-3">
        <Item label="Value">{figure.display}</Item>
        <Item label="Raw value">{e.raw}</Item>
        {scale ? <Item label="Scale">{scale}</Item> : null}
        <Item label={contracts.length > 1 ? "Contracts" : "Contract"}>
          {contracts.length > 0 ? contracts.map((id) => <ContractId key={id} network={m.network} id={id} />) : "—"}
        </Item>
        <Item label="Function and arguments">{e.call}</Item>
        <Item label="Ledger">{e.ledger}</Item>
        <Item label="RPC endpoint">
          <span className="block">{e.coverage}</span>
          <span className="block text-ink-muted">{fallbacks.length > 0 ? `Fallback: ${fallbacks.join(", ")}` : "No fallback RPC configured"}</span>
        </Item>
        <Item label="Status">
          <span className={warn ? "text-negative" : undefined}>{e.status}</span>
        </Item>
      </dl>
      <section aria-labelledby="verify-commands" className="grid gap-2">
        <h3 id="verify-commands" className="label">
          {reads.length > 1 ? `Re-read it: ${reads.length} calls` : "Re-read it"}
        </h3>
        {reads.length === 0 ? <p className="text-sm text-ink">No contract call is recorded for this figure.</p> : null}
        {reads.map((r, i) => (
          <Command
            key={`${r.contractId}-${r.fn}-${i}`}
            manifest={m}
            source={r}
            copyLabel={`Copy the ${r.fn} command${(fnCounts.get(r.fn) ?? 0) > 1 ? ` for ${contractLabel(m, r.contractId)}${r.args.length > 0 ? ` (${i + 1})` : ""}` : ""}`}
          />
        ))}
      </section>
      {e.rawXdr.length > 0 ? (
        <details className="rounded-md border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Raw XDR (base64)</summary>
          <p className="mt-2 text-xs text-ink-muted">The return value of each read as the RPC sent it, in read order. Decode it with `stellar xdr decode --type ScVal`.</p>
          <ol className="mt-2 grid gap-2">
            {e.rawXdr.map((x, i) => (
              <li key={`${i}-${x}`} className="font-mono text-xs/5 text-ink wrap-anywhere">
                {x}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  )
}

/**
 * The "How to verify" drawer (D-7), opened by `trigger`: the figure's label, value, raw value and
 * scale, contracts (stellar.expert links), function and arguments, ledger, RPC endpoint and status,
 * one copyable `stellar contract invoke … --send=no` command per read, and the raw XDR, folded.
 *
 * It is a Radix Dialog docked to the right: focus is trapped inside while it is open, Esc and the
 * close button close it, and focus returns to the trigger. Its body mounts only while open.
 */
export function VerifyDrawer({ figure, scale, trigger }: { figure: VerifiableFigure; scale?: string; trigger: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="top-0 right-0 left-auto h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 content-start gap-5 overflow-y-auto rounded-none border-l border-line p-5 ring-0 sm:max-w-[32rem]">
        <DrawerBody figure={figure} scale={scale} />
      </DialogContent>
    </Dialog>
  )
}
