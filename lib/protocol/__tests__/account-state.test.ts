// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { fetchAccountState } from "../account-state"
import type { Horizon, HorizonAccount } from "../horizon"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import type { ScArg } from "../stellar"
import type { Live } from "../types"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const c = market.contracts
const sac = market.underlying.sac
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

type Calls = { key: string; args: ScArg[] }[]
function fakeReader(table: Record<string, unknown>, calls: Calls = []): ContractReader {
  return (async <T,>({ contractId, functionName, args = [] }: { contractId: string; functionName: string; args?: ScArg[] }) => {
    const key = `${contractId}.${functionName}`
    calls.push({ key, args })
    if (!(key in table)) throw new Error(`no fixture for ${key}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return { value: value as T, latestLedger: 9, minResourceFee: "1" }
  }) as ContractReader
}

function healthy(): Record<string, unknown> {
  return {
    [`${sac}.balance`]: 1n,
    [`${c.sy}.balance_of`]: 2n,
    [`${c.pt}.balance`]: 3n,
    [`${c.yt}.balance`]: 4n,
    [`${c.pool}.lp_balance`]: 5n,
    [`${c.yt}.last_claimed_index`]: 6n,
    [`${c.yt}.pending_claim`]: 7n,
    [`${c.sy}.deposit_cap`]: 8n,
    [`${c.sy}.net_deposited`]: 9n,
    [`${sac}.authorized`]: true,
    [`${manifest.shared.permissioning}.is_allowed`]: true,
    [`${manifest.shared.permissioning}.is_allowed_for_asset`]: true,
  }
}

function horizonWith(account: Live<HorizonAccount | null>): Horizon {
  return {
    fetchAccount: async () => account,
    fetchIssuerFlags: async () => ({ status: "unavailable", error: "unused" }),
  }
}
const trusted = (authorized: boolean | undefined): Live<HorizonAccount | null> => ({
  status: "live",
  ledger: 1,
  value: {
    balances: [
      { asset_type: "native", balance: "1" },
      {
        asset_type: "credit_alphanum4",
        asset_code: market.underlying.code,
        asset_issuer: market.underlying.issuer,
        balance: "1",
        ...(authorized === undefined ? {} : { is_authorized: authorized }),
      },
    ],
  },
})

describe("fetchAccountState", () => {
  it("ports the balance reads: SEP-41 balance, SYWrapper balance_of, pool lp_balance", async () => {
    const calls: Calls = []
    const s = await fetchAccountState(fakeReader(healthy(), calls), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    expect(s.underlying).toMatchObject({ status: "live", value: 1n })
    expect(s.sy).toMatchObject({ value: 2n })
    expect(s.pt).toMatchObject({ value: 3n })
    expect(s.yt).toMatchObject({ value: 4n })
    expect(s.lp).toMatchObject({ value: 5n })
    expect(s.ytLastClaimedIndex).toMatchObject({ value: 6n })
    expect(s.ytPendingClaim).toMatchObject({ value: 7n })
    expect(s.depositCap).toMatchObject({ value: 8n })
    expect(s.netDeposited).toMatchObject({ value: 9n })
    const who = [{ type: "address", value: ACCOUNT }]
    for (const k of [
      `${sac}.balance`, `${c.sy}.balance_of`, `${c.pt}.balance`, `${c.yt}.balance`, `${c.pool}.lp_balance`,
      `${c.yt}.last_claimed_index`, `${c.yt}.pending_claim`, `${c.sy}.net_deposited`, `${sac}.authorized`,
      `${manifest.shared.permissioning}.is_allowed`,
    ]) {
      expect(calls.find((x) => x.key === k)?.args).toEqual(who)
    }
  })

  it("checks per-asset permissioning for the PT and the YT token addresses", async () => {
    const calls: Calls = []
    await fetchAccountState(fakeReader(healthy(), calls), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    const perAsset = calls.filter((x) => x.key.endsWith(".is_allowed_for_asset")).map((x) => x.args[1])
    expect(perAsset).toEqual(
      expect.arrayContaining([
        { type: "address", value: c.pt },
        { type: "address", value: c.yt },
      ]),
    )
  })

  it("unavailable read is Live unavailable not zero", async () => {
    const table = healthy()
    table[`${c.pt}.balance`] = new Error("rpc down")
    const s = await fetchAccountState(fakeReader(table), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    expect(s.pt).toEqual({ status: "unavailable", error: "rpc down" })
    expect(s.underlying.status).toBe("live")
  })

  it("trustline none vs unauthorized vs authorized", async () => {
    const run = (a: Live<HorizonAccount | null>) =>
      fetchAccountState(fakeReader(healthy()), horizonWith(a), manifest, market.marketId, ACCOUNT)
    const none = await run({ status: "live", ledger: 1, value: { balances: [{ asset_type: "native", balance: "1" }] } })
    expect(none.trustline).toMatchObject({ status: "live", value: "none" })
    expect(none.accountExists).toMatchObject({ value: true })
    expect((await run(trusted(false))).trustline).toMatchObject({ value: "unauthorized" })
    expect((await run(trusted(true))).trustline).toMatchObject({ value: "authorized" })
  })

  it("trustline is matched by code and issuer, not code alone", async () => {
    const s = await fetchAccountState(
      fakeReader(healthy()),
      horizonWith({
        status: "live",
        ledger: 1,
        value: {
          balances: [
            { asset_type: "credit_alphanum4", asset_code: market.underlying.code, asset_issuer: "GOTHER", balance: "1", is_authorized: true },
          ],
        },
      }),
      manifest,
      market.marketId,
      ACCOUNT,
    )
    expect(s.trustline).toMatchObject({ value: "none" })
  })

  it("a 404 account does not exist and has no trustline", async () => {
    const s = await fetchAccountState(fakeReader(healthy()), horizonWith({ status: "live", ledger: 1, value: null }), manifest, market.marketId, ACCOUNT)
    expect(s.accountExists).toMatchObject({ status: "live", value: false })
    expect(s.trustline).toMatchObject({ status: "live", value: "none" })
  })

  it("a Horizon failure makes accountExists and trustline unavailable", async () => {
    const s = await fetchAccountState(
      fakeReader(healthy()),
      horizonWith({ status: "unavailable", error: "horizon 503" }),
      manifest,
      market.marketId,
      ACCOUNT,
    )
    expect(s.accountExists).toEqual({ status: "unavailable", error: "horizon 503" })
    expect(s.trustline).toEqual({ status: "unavailable", error: "horizon 503" })
  })

  it("a trustline entry without is_authorized is unavailable, not authorized", async () => {
    const s = await fetchAccountState(fakeReader(healthy()), horizonWith(trusted(undefined)), manifest, market.marketId, ACCOUNT)
    expect(s.trustline.status).toBe("unavailable")
  })

  it("SAC authorized() trapping with a contract error means not authorized", async () => {
    const table = healthy()
    table[`${sac}.authorized`] = new Error("HostError: Error(Contract, #12)\n trustline entry is missing")
    const s = await fetchAccountState(fakeReader(table), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    expect(s.sacAuthorized).toMatchObject({ status: "live", value: false })
  })

  it("SAC authorized() failing for any other reason is unavailable", async () => {
    const table = healthy()
    table[`${sac}.authorized`] = new Error("Request failed with status code 429")
    const s = await fetchAccountState(fakeReader(table), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    expect(s.sacAuthorized.status).toBe("unavailable")
  })

  it("sep57 kind uses frozen and identity", async () => {
    const calls: Calls = []
    const table = healthy()
    delete table[`${sac}.authorized`]
    table[`${sac}.is_frozen`] = false
    table[`${sac}.identity_verifier`] = "CVERIFIER"
    table["CVERIFIER.verify_identity"] = undefined
    const s = await fetchAccountState(fakeReader(table, calls), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT, "sep57")
    expect(s.sep57).toEqual({
      frozen: { status: "live", value: false, ledger: 9 },
      identityVerified: { status: "live", value: true, ledger: 9 },
    })
    expect(calls.some((x) => x.key === `${sac}.authorized`)).toBe(false)
    expect(calls.find((x) => x.key === "CVERIFIER.verify_identity")?.args).toEqual([{ type: "address", value: ACCOUNT }])
  })

  it("sep57 identity: a contract revert is not verified, a transport failure is unavailable", async () => {
    const mk = (err: Error) => {
      const table = healthy()
      table[`${sac}.is_frozen`] = false
      table[`${sac}.identity_verifier`] = "CVERIFIER"
      table["CVERIFIER.verify_identity"] = err
      return fetchAccountState(fakeReader(table), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT, "sep57")
    }
    expect((await mk(new Error("HostError: Error(Contract, #4)"))).sep57?.identityVerified).toMatchObject({ status: "live", value: false })
    expect((await mk(new Error("timeout of 20000ms exceeded"))).sep57?.identityVerified.status).toBe("unavailable")
  })

  it("sac kind has no sep57 reads", async () => {
    const s = await fetchAccountState(fakeReader(healthy()), horizonWith(trusted(true)), manifest, market.marketId, ACCOUNT)
    expect(s.sep57).toBeNull()
  })
})
