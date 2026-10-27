import type { Horizon, HorizonAccount } from "./horizon"
import { getMarket } from "./manifest"
import { isContractError, liveValue, readLive, toAddress, toBigint, toBool, unavailable, type ContractReader } from "./reader"
import type { ScArg } from "./stellar"
import type { Live, Manifest, Market } from "./types"

/** The compliance model of the underlying: a classic asset behind a SAC, or a SEP-57 (T-REX) token. */
export type ComplianceKind = "sac" | "sep57"

export type Trustline = "none" | "unauthorized" | "authorized"

export type AccountState = {
  underlying: Live<bigint>
  sy: Live<bigint>
  pt: Live<bigint>
  yt: Live<bigint>
  lp: Live<bigint>
  ytLastClaimedIndex: Live<bigint>
  ytPendingClaim: Live<bigint>
  depositCap: Live<bigint>
  netDeposited: Live<bigint>
  /** SAC `authorized(account)`. A contract trap (no trustline) reads as `false`, as the contracts do. */
  sacAuthorized: Live<boolean>
  /** SEP-57 underlyings: `is_frozen` and the identity verifier, in place of `authorized`. Null for a SAC. */
  sep57: { frozen: Live<boolean>; identityVerified: Live<boolean> } | null
  permAllowed: Live<boolean>
  permPt: Live<boolean>
  permYt: Live<boolean>
  trustline: Live<Trustline>
  accountExists: Live<boolean>
}

const address = (value: string): ScArg => ({ type: "address", value })

/**
 * A view whose contract-level failure is itself the answer ("not authorized", "not verified").
 * Transport, rate-limit and archival failures stay unavailable.
 */
async function readAnswer(
  reader: ContractReader,
  call: { contractId: string; functionName: string; args?: ScArg[] },
  map: (value: unknown) => boolean,
): Promise<Live<boolean>> {
  const result = await readLive<unknown, boolean>(reader, call, map)
  if (result.status === "unavailable" && isContractError(result.error)) return liveValue(false, 0)
  return result
}

function deriveTrustline(account: Live<HorizonAccount | null>, market: Market): Live<Trustline> {
  if (account.status === "unavailable") return account
  if (account.value === null) return liveValue("none", account.ledger)
  const { code, issuer } = market.underlying
  const entry = account.value.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer)
  if (!entry) return liveValue("none", account.ledger)
  if (entry.is_authorized === true) return liveValue("authorized", account.ledger)
  if (entry.is_authorized === false) return liveValue("unauthorized", account.ledger)
  return unavailable(`Horizon did not report whether the ${code} trustline is authorized`)
}

async function readSep57(
  reader: ContractReader,
  token: string,
  account: string,
): Promise<NonNullable<AccountState["sep57"]>> {
  const who = [address(account)]
  const frozen = readLive<unknown, boolean>(reader, { contractId: token, functionName: "is_frozen", args: who }, toBool)
  const identityVerified = readLive<unknown, string>(reader, { contractId: token, functionName: "identity_verifier" }, toAddress).then(
    (verifier) =>
      verifier.status === "unavailable"
        ? verifier
        : // verify_identity returns nothing and reverts when the account is not verified.
          readAnswer(reader, { contractId: verifier.value, functionName: "verify_identity", args: who }, () => true),
  )
  return { frozen: await frozen, identityVerified: await identityVerified }
}

export async function fetchAccountState(
  reader: ContractReader,
  horizon: Horizon,
  m: Manifest,
  marketId: string,
  account: string,
  /** The market's compliance kind; null when that read is unavailable (no default is assumed). */
  kind: ComplianceKind | null,
): Promise<AccountState> {
  const market = getMarket(m, marketId)
  if (!market) throw new Error(`Unknown market "${marketId}"`)
  const c = market.contracts
  const sac = market.underlying.sac
  const perm = m.shared.permissioning
  const who = [address(account)]

  const big = (contractId: string, functionName: string, args?: ScArg[]) =>
    readLive<unknown, bigint>(reader, { contractId, functionName, args }, toBigint)
  const allowed = (functionName: string, args: ScArg[]) =>
    readLive<unknown, boolean>(reader, { contractId: perm, functionName, args }, toBool)

  const [
    underlying, sy, pt, yt, lp, ytLastClaimedIndex, ytPendingClaim, depositCap, netDeposited,
    sacAuthorized, sep57, permAllowed, permPt, permYt, horizonAccount,
  ] = await Promise.all([
    // SEP-41 tokens expose `balance`; SYWrapper keeps its own ledger (`balance_of`); LP is `MarketPool.lp_balance`.
    big(sac, "balance", who),
    big(c.sy, "balance_of", who),
    big(c.pt, "balance", who),
    big(c.yt, "balance", who),
    big(c.pool, "lp_balance", who),
    big(c.yt, "last_claimed_index", who),
    big(c.yt, "pending_claim", who),
    big(c.sy, "deposit_cap"),
    big(c.sy, "net_deposited", who),
    kind === "sac"
      ? readAnswer(reader, { contractId: sac, functionName: "authorized", args: who }, toBool)
      : Promise.resolve(
          unavailable(
            kind === null
              ? "the underlying's compliance model is unknown"
              : "SAC authorized() does not apply to a SEP-57 underlying",
          ),
        ),
    kind === "sep57" ? readSep57(reader, sac, account) : Promise.resolve(null),
    allowed("is_allowed", who),
    allowed("is_allowed_for_asset", [address(account), address(c.pt)]),
    allowed("is_allowed_for_asset", [address(account), address(c.yt)]),
    horizon.fetchAccount(account),
  ])

  const accountExists: Live<boolean> =
    horizonAccount.status === "unavailable" ? horizonAccount : liveValue(horizonAccount.value !== null, horizonAccount.ledger)

  return {
    underlying, sy, pt, yt, lp, ytLastClaimedIndex, ytPendingClaim, depositCap, netDeposited,
    sacAuthorized, sep57, permAllowed, permPt, permYt,
    trustline: deriveTrustline(horizonAccount, market),
    accountExists,
  }
}
