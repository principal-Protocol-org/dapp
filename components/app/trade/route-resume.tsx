"use client"

import { useState } from "react"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { RouteFlow, type RouteFlowProps } from "@/components/app/route/route-flow"
import { stepGate } from "@/components/app/trade/use-trade-route"
import { useGateContext } from "@/hooks/use-gate-context"
import type { TxNotice } from "@/lib/app/tx-notice"

/**
 * A route host whose form has closed (R2-77): the PT tab beside Redeem and the YT tab beside "YT
 * trading has closed", after maturity. It starts nothing; it shows a run of its kinds resumed from
 * the log (or the one History's Continue names), so a route interrupted between its steps keeps its
 * holdings, Continue and "Back to USDY" on screen. Each step is still gated by 0001's gates with its
 * own simulation, so a step the market no longer takes (a buy after maturity) is refused with its
 * reason, while a withdraw back to USDY stays open. Renders nothing while no such run is waiting.
 */
export function RouteResume({ marketId, kinds, routeId }: { marketId: string; kinds: RouteFlowProps["kinds"]; routeId?: string | null }) {
  const gate = useGateContext(marketId)
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)
  const owner = JSON.stringify(gate.wallet)
  const account = gate.wallet.status === "connected" ? gate.wallet.publicKey : null
  return (
    <>
      <RouteFlow
        account={account}
        marketId={marketId}
        kinds={kinds}
        routeId={routeId}
        gate={stepGate(gate)}
        request={null}
        plans={[]}
        canStart={false}
        blockers={[]}
        showStart={false}
        onNotice={(notice) => setLast({ owner, notice })}
      />
      {last && last.owner === owner ? <TxNoticeView notice={last.notice} /> : null}
    </>
  )
}
