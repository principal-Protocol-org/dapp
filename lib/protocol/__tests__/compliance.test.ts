// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import type { AccountState } from "../account-state"
import { evaluateAccountCompliance, fetchMarketCompliance } from "../compliance"
import type { Horizon } from "../horizon"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import type { Live } from "../types"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const sac = market.underlying.sac

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 1 })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    underlying: live(1n), sy: live(1n), pt: live(1n), yt: live(1n), lp: live(1n),
    ytLastClaimedIndex: live(1n), ytPendingClaim: live(0n),
    depositCap: live(0n), netDeposited: live(0n),
    sacAuthorized: live(true), permAllowed: live(true), permPt: live(true), permYt: live(true),
    sep57: null,
    trustline: live("authorized"), accountExists: live(true),
    ...over,
  }
}

const byId = (items: ReturnType<typeof evaluateAccountCompliance>) => Object.fromEntries(items.map((i) => [i.id, i]))

describe("evaluateAccountCompliance", () => {
  it("returns the six items in order, all ok for a fully compliant SAC account", () => {
    const items = evaluateAccountCompliance(account(), "sac")
    expect(items.map((i) => i.id)).toEqual(["account", "trustline", "authorized", "permissioning", "perm_pt", "perm_yt"])
    expect(items.every((i) => i.status === "ok" && i.fix === undefined && i.message.length > 0)).toBe(true)
  })

  it("trustline none vs unauthorized give two distinct items and fixes", () => {
    const none = byId(evaluateAccountCompliance(account({ trustline: live("none"), sacAuthorized: live(false) }), "sac"))
    expect(none.trustline).toMatchObject({ status: "missing", fix: "trustline" })
    expect(none.authorized).toMatchObject({ status: "missing", fix: "trustline" })

    const unauth = byId(evaluateAccountCompliance(account({ trustline: live("unauthorized"), sacAuthorized: live(false) }), "sac"))
    expect(unauth.trustline.status).toBe("ok")
    expect(unauth.authorized).toMatchObject({ status: "blocked", fix: "onboarding" })
    expect(unauth.authorized.message).not.toBe(none.authorized.message)
  })

  it("a missing account points to the funding fix", () => {
    const items = byId(evaluateAccountCompliance(account({ accountExists: live(false), trustline: live("none"), sacAuthorized: live(false) }), "sac"))
    expect(items.account).toMatchObject({ status: "missing", fix: "friendbot" })
  })

  it("not authorized although the trustline is authorized is blocked by the issuer", () => {
    const items = byId(evaluateAccountCompliance(account({ sacAuthorized: live(false) }), "sac"))
    expect(items.authorized).toMatchObject({ status: "blocked", fix: "issuer" })
  })

  it("permissioning gaps are missing with the onboarding fix", () => {
    const items = byId(
      evaluateAccountCompliance(account({ permAllowed: live(false), permPt: live(false), permYt: live(false) }), "sac"),
    )
    for (const id of ["permissioning", "perm_pt", "perm_yt"] as const) {
      expect(items[id]).toMatchObject({ status: "missing", fix: "onboarding" })
    }
    expect(items.perm_pt.message).toMatch(/PT/)
    expect(items.perm_yt.message).toMatch(/YT/)
  })

  it("an unavailable input yields an unavailable item, never ok", () => {
    const items = byId(
      evaluateAccountCompliance(
        account({ accountExists: down(), trustline: down(), sacAuthorized: down(), permAllowed: down(), permPt: down(), permYt: down() }),
        "sac",
      ),
    )
    for (const item of Object.values(items)) {
      expect(item.status).toBe("unavailable")
      expect(item.message).toMatch(/rpc down/)
    }
  })

  it("an authorized read that is live but a trustline read that is unavailable stays honest", () => {
    const items = byId(evaluateAccountCompliance(account({ trustline: down("horizon 503"), sacAuthorized: live(false) }), "sac"))
    expect(items.trustline.status).toBe("unavailable")
    expect(items.authorized.status).not.toBe("ok")
  })

  describe("sep57", () => {
    const sep = (frozen: Live<boolean>, identityVerified: Live<boolean>) =>
      account({ sacAuthorized: down("not applicable"), trustline: live("none"), sep57: { frozen, identityVerified } })

    it("uses frozen and identity, and needs no trustline", () => {
      const items = byId(evaluateAccountCompliance(sep(live(false), live(true)), "sep57"))
      expect(items.trustline.status).toBe("ok")
      expect(items.authorized).toMatchObject({ status: "ok" })
    })

    it("a frozen account or an unverified identity is blocked by the issuer", () => {
      expect(byId(evaluateAccountCompliance(sep(live(true), live(true)), "sep57")).authorized).toMatchObject({ status: "blocked", fix: "issuer" })
      expect(byId(evaluateAccountCompliance(sep(live(false), live(false)), "sep57")).authorized).toMatchObject({ status: "blocked", fix: "issuer" })
    })

    it("unavailable frozen or identity, or no sep57 reads at all, is unavailable", () => {
      expect(byId(evaluateAccountCompliance(sep(down(), live(true)), "sep57")).authorized.status).toBe("unavailable")
      expect(byId(evaluateAccountCompliance(sep(live(false), down()), "sep57")).authorized.status).toBe("unavailable")
      expect(byId(evaluateAccountCompliance(account({ sep57: null }), "sep57")).authorized.status).toBe("unavailable")
    })
  })
})

function reader(table: Record<string, unknown>): ContractReader {
  return (async <T,>({ contractId, functionName }: { contractId: string; functionName: string }) => {
    const key = `${contractId}.${functionName}`
    if (!(key in table)) throw new Error(`no fixture for ${key}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return { value: value as T, latestLedger: 4, minResourceFee: "1" }
  }) as ContractReader
}
const flagsHorizon = (r: Live<{ authRequired: boolean; authRevocable: boolean; clawbackEnabled: boolean }>): Horizon => ({
  fetchAccount: async () => down(),
  fetchIssuerFlags: async () => r,
})

describe("fetchMarketCompliance", () => {
  it("a SAC (admin() answers) reports issuer flags and the administrator", async () => {
    const r = await fetchMarketCompliance(
      flagsHorizon(live({ authRequired: true, authRevocable: true, clawbackEnabled: false })),
      reader({ [`${sac}.admin`]: "GADMIN" }),
      market,
    )
    expect(r).toMatchObject({
      status: "live",
      value: { kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: "GADMIN" },
    })
  })

  it("sep57 kind: admin() reverts as a contract error", async () => {
    const r = await fetchMarketCompliance(
      flagsHorizon(down("unused")),
      reader({ [`${sac}.admin`]: new Error("HostError: Error(WasmVm, MissingValue)\n non-existent contract function") }),
      market,
    )
    expect(r).toMatchObject({ status: "live", value: { kind: "sep57", administrator: null } })
  })

  it("admin() failing for a transport reason is unavailable, never guessed as sep57", async () => {
    const r = await fetchMarketCompliance(
      flagsHorizon(live({ authRequired: false, authRevocable: false, clawbackEnabled: false })),
      reader({ [`${sac}.admin`]: new Error("Request failed with status code 429") }),
      market,
    )
    expect(r.status).toBe("unavailable")
  })

  it("a SAC whose issuer flags cannot be read is unavailable", async () => {
    const r = await fetchMarketCompliance(flagsHorizon(down("horizon 500")), reader({ [`${sac}.admin`]: "GADMIN" }), market)
    expect(r).toEqual({ status: "unavailable", error: "horizon 500" })
  })
})
