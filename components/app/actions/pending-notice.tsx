"use client"

import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import type { PendingTx } from "@/lib/app/pending-tx"
import { noticeForPending } from "@/lib/app/tx-notice"
import type { Network } from "@/lib/protocol/types"

/**
 * The panel's last send, still not confirmed (M-21): what is being checked, until when it can land,
 * and its hash and explorer link. Shown in place of the panel's last result while it is pending.
 */
export function PendingNotice({ label, tx, network }: { label: string; tx: PendingTx; network: Network }) {
  return <TxNoticeView notice={noticeForPending(label, tx, network)} />
}
