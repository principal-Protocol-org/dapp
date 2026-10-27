import type { AccountState, ComplianceKind } from "./account-state"
import type { Horizon } from "./horizon"
import { isContractError, liveValue, readLive, toAddress, unavailable } from "./reader"
import type { Live, Market } from "./types"
import type { ContractReader } from "./reader"

export type MarketCompliance =
  | {
      kind: "sac"
      authRequired: boolean
      authRevocable: boolean
      clawbackEnabled: boolean
      administrator: string
    }
  | {
      /** SEP-57 has no classic issuer flags and no `admin()`: authority is a role, not an address. */
      kind: "sep57"
      administrator: null
    }

export type ComplianceItem = {
  id: "account" | "trustline" | "authorized" | "permissioning" | "perm_pt" | "perm_yt"
  status: "ok" | "missing" | "blocked" | "unavailable"
  message: string
  fix?: "friendbot" | "trustline" | "onboarding" | "issuer"
}

/**
 * Positive evidence only. `sac`: `admin()` returns a valid address. `sep57`: `admin()` fails with a
 * contract-level trap AND `identity_verifier()` returns a valid address. Anything else (archived
 * entries, storage or budget errors, transport failures) is unavailable, never a guessed kind.
 */
export async function fetchMarketCompliance(
  horizon: Horizon,
  reader: ContractReader,
  market: Market,
): Promise<Live<MarketCompliance>> {
  const token = market.underlying.sac
  const admin = await readLive<unknown, string>(reader, { contractId: token, functionName: "admin" }, toAddress)
  if (admin.status === "unavailable") {
    if (!isContractError(admin.error)) return admin
    const verifier = await readLive<unknown, string>(reader, { contractId: token, functionName: "identity_verifier" }, toAddress)
    if (verifier.status === "unavailable") {
      return unavailable(`Could not tell whether the underlying is a SAC or a SEP-57 token: ${admin.error}`)
    }
    return liveValue({ kind: "sep57", administrator: null }, verifier.ledger)
  }
  const flags = await horizon.fetchIssuerFlags(market.underlying.issuer)
  if (flags.status === "unavailable") return flags
  return liveValue(
    { kind: "sac", ...flags.value, administrator: admin.value },
    Math.max(admin.ledger, flags.ledger),
  )
}

function unavailableItem(id: ComplianceItem["id"], what: string, input: { status: "unavailable"; error: string }): ComplianceItem {
  return { id, status: "unavailable", message: `${what} could not be checked right now (${input.error}).` }
}

/**
 * `kind` is null when the market's compliance read is unavailable; `kindError` is then its cause.
 * The trustline and authorization items are unavailable (not guessed) in that case.
 */
export function evaluateAccountCompliance(
  acc: AccountState,
  kind: ComplianceKind | null,
  kindError = "compliance model unknown",
): ComplianceItem[] {
  return [
    accountItem(acc),
    kind === null ? unknownKindItem("trustline", kindError) : trustlineItem(acc, kind),
    kind === null ? unknownKindItem("authorized", kindError) : authorizedItem(acc, kind),
    permissionItem("permissioning", acc.permAllowed, "Principal permissioning", "your account"),
    permissionItem("perm_pt", acc.permPt, "PT permissioning", "PT"),
    permissionItem("perm_yt", acc.permYt, "YT permissioning", "YT"),
  ]
}

function unknownKindItem(id: ComplianceItem["id"], cause: string): ComplianceItem {
  return {
    id,
    status: "unavailable",
    message: `This check depends on the underlying asset's compliance model, which could not be determined (${cause}).`,
  }
}

function accountItem(acc: AccountState): ComplianceItem {
  const { accountExists } = acc
  if (accountExists.status === "unavailable") return unavailableItem("account", "Whether your account exists", accountExists)
  return accountExists.value
    ? { id: "account", status: "ok", message: "Your account exists on the network." }
    : {
        id: "account",
        status: "missing",
        fix: "friendbot",
        message: "Your account does not exist on the network yet. Fund it first (on Testnet, use Friendbot).",
      }
}

function trustlineItem(acc: AccountState, kind: ComplianceKind): ComplianceItem {
  if (kind === "sep57") {
    return { id: "trustline", status: "ok", message: "No trustline is needed: the underlying is a SEP-57 token." }
  }
  const { trustline } = acc
  if (trustline.status === "unavailable") return unavailableItem("trustline", "Your trustline", trustline)
  return trustline.value === "none"
    ? {
        id: "trustline",
        status: "missing",
        fix: "trustline",
        message: "You have no trustline to the underlying asset. Add one before you can hold it.",
      }
    : { id: "trustline", status: "ok", message: "You have a trustline to the underlying asset." }
}

function authorizedItem(acc: AccountState, kind: ComplianceKind): ComplianceItem {
  if (kind === "sep57") return sep57Item(acc)
  const { sacAuthorized, trustline } = acc
  if (sacAuthorized.status === "unavailable") return unavailableItem("authorized", "The issuer's authorization", sacAuthorized)
  if (sacAuthorized.value) {
    return { id: "authorized", status: "ok", message: "The issuer has authorized your account for the underlying asset." }
  }
  if (trustline.status === "live" && trustline.value === "none") {
    return {
      id: "authorized",
      status: "missing",
      fix: "trustline",
      message: "The issuer cannot authorize you until you add a trustline.",
    }
  }
  if (trustline.status === "live" && trustline.value === "unauthorized") {
    return {
      id: "authorized",
      status: "blocked",
      fix: "onboarding",
      message: "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it.",
    }
  }
  return {
    id: "authorized",
    status: "blocked",
    fix: "issuer",
    message: "Blocked by the issuer: the underlying asset does not authorize your account. Contact the issuer.",
  }
}

function sep57Item(acc: AccountState): ComplianceItem {
  const reads = acc.sep57
  if (!reads) {
    return { id: "authorized", status: "unavailable", message: "The SEP-57 frozen and identity checks were not read." }
  }
  if (reads.frozen.status === "unavailable") return unavailableItem("authorized", "Whether your account is frozen", reads.frozen)
  if (reads.identityVerified.status === "unavailable") {
    return unavailableItem("authorized", "Your identity verification", reads.identityVerified)
  }
  if (reads.frozen.value) {
    return { id: "authorized", status: "blocked", fix: "issuer", message: "Blocked by the issuer: your account is frozen on the underlying token." }
  }
  if (!reads.identityVerified.value) {
    return {
      id: "authorized",
      status: "blocked",
      fix: "issuer",
      message: "Blocked by the issuer: your identity is not verified for the underlying token.",
    }
  }
  return { id: "authorized", status: "ok", message: "Your account is not frozen and your identity is verified." }
}

function permissionItem(id: ComplianceItem["id"], input: Live<boolean>, what: string, subject: string): ComplianceItem {
  if (input.status === "unavailable") return unavailableItem(id, what, input)
  return input.value
    ? { id, status: "ok", message: `${what}: ${subject} is allowed.` }
    : {
        id,
        status: "missing",
        fix: "onboarding",
        message: `${what}: ${subject} is not allowed yet. Get test tokens grants it on Testnet.`,
      }
}
