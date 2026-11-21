// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import type { AccountState } from "../account-state"
import { evaluateAccountCompliance, fetchMarketCompliance, type ComplianceItem } from "../compliance"
import type { Horizon } from "../horizon"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import type { Live, Network } from "../types"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const sac = market.underlying.sac
const ADMIN = market.underlying.issuer
const VERIFIER = market.contracts.router
const RESTORE = "Contract read requires restoring archived ledger entries before it can be queried."

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

  it("an unknown kind makes trustline and authorized unavailable with the cause", () => {
    const items = byId(evaluateAccountCompliance(account({ trustline: live("none"), sacAuthorized: down() }), null, "admin read failed: 429"))
    for (const id of ["trustline", "authorized"] as const) {
      expect(items[id].status).toBe("unavailable")
      expect(items[id].fix).toBeUndefined()
      expect(items[id].message).toMatch(/admin read failed: 429/)
    }
    expect(items.account.status).toBe("ok")
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

describe("evaluateAccountCompliance by network", () => {
  /** Every account state whose item is not OK, and the item it is about. */
  const cases = {
    "account missing": [account({ accountExists: live(false) }), "account"],
    "no trustline": [account({ trustline: live("none"), sacAuthorized: live(false) }), "trustline"],
    "no trustline to authorize": [account({ trustline: live("none"), sacAuthorized: live(false) }), "authorized"],
    "trustline not authorized": [account({ trustline: live("unauthorized"), sacAuthorized: live(false) }), "authorized"],
    "blocked by the issuer": [account({ sacAuthorized: live(false) }), "authorized"],
    "account not allowed": [account({ permAllowed: live(false) }), "permissioning"],
    "PT not allowed": [account({ permPt: live(false) }), "perm_pt"],
    "YT not allowed": [account({ permYt: live(false) }), "perm_yt"],
  } as const satisfies Record<string, readonly [AccountState, ComplianceItem["id"]]>
  type Case = keyof typeof cases
  const itemFor = (name: Case, network?: Network) => {
    const [acc, id] = cases[name]
    const items = network === undefined ? evaluateAccountCompliance(acc, "sac") : evaluateAccountCompliance(acc, "sac", undefined, network)
    return byId(items)[id]
  }

  // Pinned by the live Testnet suites (journey, lifecycle): these must never change on Testnet or a local network.
  const TESTNET: Record<Case, { message: string; fix: ComplianceItem["fix"] }> = {
    "account missing": { message: "Your account does not exist on the network yet. Fund it first (on Testnet, use Friendbot).", fix: "friendbot" },
    "no trustline": { message: "You have no trustline to the underlying asset. Add one before you can hold it.", fix: "trustline" },
    "no trustline to authorize": { message: "The issuer cannot authorize you until you add a trustline.", fix: "trustline" },
    "trustline not authorized": {
      message: "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it.",
      fix: "onboarding",
    },
    "blocked by the issuer": { message: "Blocked by the issuer: the underlying asset does not authorize your account. Contact the issuer.", fix: "issuer" },
    "account not allowed": { message: "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet.", fix: "onboarding" },
    "PT not allowed": { message: "PT permissioning: PT is not allowed yet. Get test tokens grants it on Testnet.", fix: "onboarding" },
    "YT not allowed": { message: "YT permissioning: YT is not allowed yet. Get test tokens grants it on Testnet.", fix: "onboarding" },
  }

  const ACCESS = "Access to this market is granted by the protocol team."
  const MAINNET: Record<Case, { message: string; fix: ComplianceItem["fix"] }> = {
    "account missing": { message: "Your account does not exist on the network yet. Send it XLM first.", fix: "fund" },
    "no trustline": TESTNET["no trustline"],
    "no trustline to authorize": TESTNET["no trustline to authorize"],
    "trustline not authorized": { message: `Your trustline is not authorized yet. ${ACCESS}`, fix: "access" },
    "blocked by the issuer": TESTNET["blocked by the issuer"],
    "account not allowed": { message: `Principal permissioning: your account is not allowed yet. ${ACCESS}`, fix: "access" },
    "PT not allowed": { message: `PT permissioning: PT is not allowed yet. ${ACCESS}`, fix: "access" },
    "YT not allowed": { message: `YT permissioning: YT is not allowed yet. ${ACCESS}`, fix: "access" },
  }
  const names = Object.keys(cases) as Case[]

  it.each(names)("%s: the Testnet text is unchanged without a network, on testnet and on a local network", (name) => {
    for (const network of [undefined, "testnet", "local"] as const) {
      const item = itemFor(name, network)
      expect(item.message).toBe(TESTNET[name].message)
      expect(item.fix).toBe(TESTNET[name].fix)
    }
  })

  it.each(names)("%s: the Mainnet text names no faucet", (name) => {
    const item = itemFor(name, "mainnet")
    expect(item.message).toBe(MAINNET[name].message)
    expect(item.fix).toBe(MAINNET[name].fix)
    expect(item.message).not.toMatch(/Friendbot|Get test tokens|Testnet/)
  })

  it("the SEP-57 issuer items and the status of every item are the same on Mainnet", () => {
    const sep = account({ sacAuthorized: down("n/a"), trustline: live("none"), sep57: { frozen: live(true), identityVerified: live(true) } })
    expect(byId(evaluateAccountCompliance(sep, "sep57", undefined, "mainnet")).authorized).toEqual(byId(evaluateAccountCompliance(sep, "sep57")).authorized)
    for (const name of names) expect(itemFor(name, "mainnet").status).toBe(itemFor(name).status)
  })

  it("a fully compliant account is OK with no fix on Mainnet too", () => {
    expect(evaluateAccountCompliance(account(), "sac", undefined, "mainnet").every((i) => i.status === "ok" && i.fix === undefined)).toBe(true)
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
      reader({ [`${sac}.admin`]: ADMIN }),
      market,
    )
    expect(r).toMatchObject({
      status: "live",
      value: { kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: ADMIN },
    })
  })

  it("sep57 kind: admin() reverts as a contract error", async () => {
    const r = await fetchMarketCompliance(
      flagsHorizon(down("unused")),
      reader({
        [`${sac}.admin`]: new Error("HostError: Error(WasmVm, MissingValue)\n non-existent contract function"),
        [`${sac}.identity_verifier`]: VERIFIER,
      }),
      market,
    )
    expect(r).toMatchObject({ status: "live", value: { kind: "sep57", administrator: null } })
  })

  it("admin() trap without a valid identity_verifier is unavailable, not sep57", async () => {
    const trap = new Error("HostError: Error(WasmVm, MissingValue)")
    for (const verifier of [new Error("HostError: Error(WasmVm, MissingValue)"), "not-an-address", new Error(RESTORE)]) {
      const r = await fetchMarketCompliance(flagsHorizon(down("unused")), reader({ [`${sac}.admin`]: trap, [`${sac}.identity_verifier`]: verifier }), market)
      expect(r.status).toBe("unavailable")
    }
  })

  it("archival and storage failures on admin() are unavailable, never sep57", async () => {
    for (const msg of [RESTORE, "HostError: Error(Storage, MissingValue)", "HostError: Error(Budget, ExceededLimit)"]) {
      const r = await fetchMarketCompliance(
        flagsHorizon(down("unused")),
        reader({ [`${sac}.admin`]: new Error(msg), [`${sac}.identity_verifier`]: VERIFIER }),
        market,
      )
      expect(r).toMatchObject({ status: "unavailable", error: msg })
    }
  })

  it("an invalid admin() address is unavailable", async () => {
    const r = await fetchMarketCompliance(flagsHorizon(down("unused")), reader({ [`${sac}.admin`]: "GADMIN" }), market)
    expect(r.status).toBe("unavailable")
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
    const r = await fetchMarketCompliance(flagsHorizon(down("horizon 500")), reader({ [`${sac}.admin`]: ADMIN }), market)
    expect(r).toEqual({ status: "unavailable", error: "horizon 500" })
  })
})
