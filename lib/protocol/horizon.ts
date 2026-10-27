import { liveValue, unavailable } from "./reader"
import type { Live } from "./types"

export type HorizonBalance = {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  balance: string
  is_authorized?: boolean
}

export type HorizonAccount = { balances: HorizonBalance[] }

export type IssuerFlags = { authRequired: boolean; authRevocable: boolean; clawbackEnabled: boolean }

/** The two Horizon reads the dApp makes, bound to one network (see `createHorizon`). */
export type Horizon = {
  /** `live null` is a 404: the account does not exist. */
  fetchAccount(id: string): Promise<Live<HorizonAccount | null>>
  fetchIssuerFlags(issuer: string): Promise<Live<IssuerFlags>>
}

type FetchLike = typeof fetch

function accountUrl(horizonUrl: string, id: string) {
  return `${horizonUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(id)}`
}

async function getAccountJson(
  horizonUrl: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<Live<Record<string, unknown> | null>> {
  try {
    const response = await fetchImpl(accountUrl(horizonUrl, id), { headers: { Accept: "application/json" } })
    if (response.status === 404) return liveValue(null, 0)
    if (!response.ok) return unavailable(`Horizon responded ${response.status} for account ${id}`)
    const body: unknown = await response.json()
    if (!body || typeof body !== "object") return unavailable("Horizon returned an unreadable account")
    const record = body as Record<string, unknown>
    const ledger = typeof record.last_modified_ledger === "number" ? record.last_modified_ledger : 0
    return liveValue(record, ledger)
  } catch (error) {
    return unavailable(error)
  }
}

export async function fetchAccount(
  horizonUrl: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<Live<HorizonAccount | null>> {
  const result = await getAccountJson(horizonUrl, id, fetchImpl)
  if (result.status === "unavailable" || result.value === null) return result as Live<null>
  const balances = result.value.balances
  if (!Array.isArray(balances)) return unavailable("Horizon account has no balances list")
  return liveValue({ balances: balances as HorizonBalance[] }, result.ledger)
}

export async function fetchIssuerFlags(
  horizonUrl: string,
  issuer: string,
  fetchImpl: FetchLike = fetch,
): Promise<Live<IssuerFlags>> {
  const result = await getAccountJson(horizonUrl, issuer, fetchImpl)
  if (result.status === "unavailable") return result
  if (result.value === null) return unavailable(`Issuer account ${issuer} was not found on Horizon`)
  const flags = result.value.flags as Record<string, unknown> | undefined
  if (!flags || typeof flags !== "object") return unavailable("Horizon issuer account has no flags")
  return liveValue(
    {
      authRequired: flags.auth_required === true,
      authRevocable: flags.auth_revocable === true,
      clawbackEnabled: flags.auth_clawback_enabled === true,
    },
    result.ledger,
  )
}

export function createHorizon(horizonUrl: string, fetchImpl?: FetchLike): Horizon {
  return {
    fetchAccount: (id) => fetchAccount(horizonUrl, id, fetchImpl),
    fetchIssuerFlags: (issuer) => fetchIssuerFlags(horizonUrl, issuer, fetchImpl),
  }
}
