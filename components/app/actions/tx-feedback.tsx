"use client"

import { toast } from "sonner"
import { cn } from "cn"
import type { TxNotice } from "@/lib/app/tx-notice"

const TONE: Record<TxNotice["tone"], string> = {
  success: "border-positive",
  warning: "border-line-strong",
  error: "border-negative",
}

function ExplorerLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-3 hover:text-ink">
      View on stellar.expert
    </a>
  )
}

/** The panel's last result: kept until the next one, with the hash of anything that was submitted. */
export function TxNoticeView({ notice }: { notice: TxNotice }) {
  return (
    <div role="status" className={cn("grid gap-1 rounded-lg border bg-surface p-3 text-sm text-ink", TONE[notice.tone])}>
      <p className="font-medium">{notice.title}</p>
      {notice.detail ? <p className="text-ink-muted">{notice.detail}</p> : null}
      {notice.hash ? (
        <p className="break-all text-ink-muted">
          Transaction hash: <code className="font-mono text-xs text-ink">{notice.hash}</code>
        </p>
      ) : null}
      {notice.url ? <ExplorerLink url={notice.url} /> : null}
    </div>
  )
}

/** Toasts a result; a success stays briefly, anything else until dismissed. */
export function showTxToast(notice: TxNotice): void {
  const description = (
    <span className="grid gap-1">
      {notice.detail ? <span>{notice.detail}</span> : null}
      {notice.url ? <ExplorerLink url={notice.url} /> : notice.hash ? <span className="break-all font-mono text-xs">{notice.hash}</span> : null}
    </span>
  )
  const show = notice.tone === "success" ? toast.success : notice.tone === "warning" ? toast.warning : toast.error
  show(notice.title, { description, duration: notice.tone === "success" ? 8_000 : Infinity })
}
