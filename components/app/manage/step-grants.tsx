"use client"

import { useId } from "react"
import { useManifest } from "@/components/app/manifest-provider"
import { RoleCalls, type RoleItem } from "@/components/app/manage/role-calls"
import type { ChainStepProps } from "@/components/app/manage/wizard"
import { useContractAdmin } from "@/hooks/use-wizard"
import { grantAccountCall, grantAssetCall, setAuthorizedCall } from "@/lib/protocol/manager-calls"
import type { Grant, GrantHolder } from "@/lib/protocol/market-progress"
import { knownUnderlyings } from "@/lib/protocol/factory"

const HOLDER: Record<GrantHolder, string> = {
  sy: "The SY wrapper",
  manager: "The PrincipalManager",
  pool: "The pool",
  recoveryEscrow: "The recovery escrow",
  treasury: "The treasury",
  admin: "The admin",
}

/**
 * Step 5 (spec 0002 §5, R5-10): the compliance grants `requiredGrants` lists (deploy.sh step 11), each
 * read from the chain. Only the missing ones are offered. The asset's admin signs the asset's
 * `set_authorized`; the Permissioning admin signs `grant_account` and `grant_asset`. A grant whose
 * signer is another account names it, and can be finished from that wallet.
 */
export function StepGrants({ progress, account, ledgerTime }: ChainStepProps) {
  const id = useId()
  const manifest = useManifest()
  const permissioningAdmin = useContractAdmin(manifest.shared.permissioning)
  const { live, predicted } = progress
  const perm = permissioningAdmin.data ?? (permissioningAdmin.isError ? { status: "unavailable" as const, error: permissioningAdmin.error.message } : undefined)
  // The asset's admin is read with the progress (`live.admin`, the SAC's own `admin()`).
  const sacAdmin = { status: "live" as const, value: live.admin, ledger: 0 }
  const code = knownUnderlyings(manifest).get(live.underlying)?.code ?? "the asset"
  const ptYt = (asset: string) => (asset === predicted.pt ? "PT" : "YT")

  const textOf = (g: Grant): string => {
    switch (g.kind) {
      case "authorized":
        return `${HOLDER[g.holder]} is authorized to hold ${code}`
      case "account":
        return `${HOLDER[g.holder]} has a Principal permissioning grant`
      case "asset":
        return `${HOLDER[g.holder]} may hold ${ptYt(g.asset as string)}`
    }
  }
  const items: RoleItem[] = live.grants.map((g) => ({
    key: `${g.kind}:${g.holder}:${g.asset ?? ""}`,
    text: textOf(g),
    held: g.held,
    admin: g.kind === "authorized" ? sacAdmin : perm,
    build: (source) =>
      g.kind === "authorized"
        ? setAuthorizedCall(manifest, { source, sac: live.underlying, account: g.account, authorize: true })
        : g.kind === "account"
          ? grantAccountCall(manifest, { source, account: g.account })
          : grantAssetCall(manifest, { source, account: g.account, asset: g.asset as string }),
  }))

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 5 of 7: Grants
        </h2>
        <p className="text-sm text-ink-muted">
          The market&apos;s contracts and its treasury need {code} authorization and Principal permissioning before the pool can be
          seeded. The {code} issuer signs the authorizations and the Permissioning admin signs the rest, each in their own wallet. Only
          what is still missing is offered.
        </p>
      </div>
      <RoleCalls listLabel="Grants" items={items} label="Sign the grants" account={account} ledgerTime={ledgerTime} network={manifest.network} />
    </section>
  )
}
