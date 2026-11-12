"use client"

import { createContext, useContext, useEffect } from "react"

/**
 * The wizard's pin (plan 0005 Task 7 fix): a step must never unmount under a review dialog or a sign
 * flow, even when the chain moves on (another admin finished the last item, or this wallet's own last
 * signature landed). A `ManagerSignFlow` reports `busy` while it is open; the wizard then keeps showing
 * the step that started it and moves to the chain's step only once every flow is closed.
 */
export type FlowBusy = { enter(): void; leave(): void }
export const FlowBusyContext = createContext<FlowBusy | null>(null)

/** Report busy while `active`; outside a wizard this does nothing. */
export function useReportFlowBusy(active: boolean) {
  const busy = useContext(FlowBusyContext)
  useEffect(() => {
    if (!active || !busy) return
    busy.enter()
    return () => busy.leave()
  }, [active, busy])
}
