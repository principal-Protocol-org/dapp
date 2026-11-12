"use client"

import { useId } from "react"
import { useManifest } from "@/components/app/manifest-provider"
import { RoleCalls, type RoleItem } from "@/components/app/manage/role-calls"
import type { ChainStepProps } from "@/components/app/manage/wizard"
import { useContractAdmin } from "@/hooks/use-wizard"
import { addConsumerCall, registerMarketCall } from "@/lib/protocol/manager-calls"

/**
 * Step 4 (spec 0002 §5, R5-10): RiskControl `add_consumer` for the SY wrapper and the PrincipalManager
 * and Router `register_market` for the pool, each signed by that contract's admin in the connected
 * wallet. The admin is read from `get_admin` on each contract: when it is not the connected wallet,
 * the step names who must sign, and can be finished later from that wallet.
 */
export function StepWire({ progress, account, ledgerTime }: ChainStepProps) {
  const id = useId()
  const manifest = useManifest()
  const riskControlAdmin = useContractAdmin(manifest.shared.riskControl)
  const routerAdmin = useContractAdmin(manifest.shared.router)
  const { predicted, live } = progress
  const rc = riskControlAdmin.data ?? (riskControlAdmin.isError ? { status: "unavailable" as const, error: riskControlAdmin.error.message } : undefined)
  const router = routerAdmin.data ?? (routerAdmin.isError ? { status: "unavailable" as const, error: routerAdmin.error.message } : undefined)

  const items: RoleItem[] = [
    {
      key: "sy",
      text: "RiskControl lists the SY wrapper as a consumer",
      held: live.wiring.syConsumer,
      admin: rc,
      build: (source) => addConsumerCall(manifest, { source, consumer: predicted.sy }),
    },
    {
      key: "manager",
      text: "RiskControl lists the PrincipalManager as a consumer",
      held: live.wiring.managerConsumer,
      admin: rc,
      build: (source) => addConsumerCall(manifest, { source, consumer: predicted.manager }),
    },
    {
      key: "pool",
      text: "The Router registers the pool",
      held: live.wiring.registered,
      admin: router,
      build: (source) => registerMarketCall(manifest, { source, pool: predicted.pool }),
    },
  ]

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 4 of 7: Wire
        </h2>
        <p className="text-sm text-ink-muted">
          Every contract of the market is deployed. RiskControl must list the SY wrapper and the PrincipalManager as consumers, and the
          Router must register the pool. Each is signed by that contract&apos;s admin in your wallet; if that is another account, it can
          finish this step from its own wallet.
        </p>
      </div>
      <RoleCalls listLabel="Wiring" items={items} label="Wire the market" account={account} ledgerTime={ledgerTime} network={manifest.network} />
    </section>
  )
}
