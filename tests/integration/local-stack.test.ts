/**
 * The local stack's second market (plan 0009, Task 5). Mainnet runs five markets, each on its own
 * asset and its own oracle; nothing may be signed there by a test, so the multi-oracle paths are
 * proven here. `scripts/dev-stack/deploy.sh` (local, `SECOND_MARKET` not 0) deploys a second market
 * on its own asset (`ASSET_CODE_2`, GILT) and its own OracleAdapter; `oracle-tick.sh` keeps every
 * oracle of the manifest fresh; `onboardWithIssuer` onboards an account on either market with the
 * issuer's own steps (the faucet pays only the manifest's `testAsset`).
 *
 * Needs `config/manifests/local.json` from a two-market deploy: a one-market manifest fails here
 * (it does not skip). It ticks both oracles and onboards one throwaway account on the second market.
 */
import { Keypair } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"

// `server-only` throws outside a react-server bundle; `local-stack.ts` imports the faucet, a server module.
vi.mock("server-only", () => ({}))

import { fetchAccountState } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { manifestOracles } from "@/lib/protocol/manifest"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { createLog, DAPP, DEV_STACK, eventually, MINUTE, oracleTick, onboardWithIssuer, readManifest, run, secondMarket, skipReason } from "./local-stack"

const skip = await skipReason()
if (skip) console.warn(`[local-stack] skipped: ${skip}`)

const { log } = createLog("local-stack")

/** A view on one contract, as the app reads it. */
async function view(manifest: Manifest, contractId: string, functionName: string): Promise<unknown> {
  const result = await createRpcReader(manifest)({ contractId, functionName })
  return result.value
}

const timestampOf = async (manifest: Manifest, oracle: string) => BigInt(String(await view(manifest, oracle, "get_reference_timestamp")))

/** Waits until the ledger clock is past every given oracle timestamp: a tick stamped at the same second is refused (stale_ts). */
async function ledgerPast(manifest: Manifest, timestamps: bigint[]): Promise<void> {
  const last = timestamps.reduce((a, b) => (a > b ? a : b))
  await eventually(
    () => getLedgerClock(createRpcServer(manifest.rpcUrl)),
    (clock) => BigInt(clock.closeTime) > last,
    "the ledger clock past the oracles' last timestamps",
  )
}

function tickScript(env: Record<string, string>, args: string[] = []) {
  const base = { ...process.env }
  delete base.ORACLE_TICK_ORACLE
  return run(`${DEV_STACK}/oracle-tick.sh`, args, { cwd: DAPP, env: { ...base, ...env } })
}

describe.skipIf(skip !== null)("two markets on two oracles, on the local stack", () => {
  it("the manifest lists two markets on two oracles and two underlyings; testAsset and shared.oracle are the first's", () => {
    const manifest = readManifest()
    expect(manifest.markets, "run scripts/dev-stack/deploy.sh (SECOND_MARKET not 0) for the two-market stack").toHaveLength(2)
    const [first, second] = manifest.markets
    log(`markets: ${manifest.markets.map((m) => `${m.marketId} (${m.underlying.code}, oracle ${m.contracts.oracle.slice(0, 6)}…)`).join(", ")}`)
    expect(first.contracts.oracle).not.toBe(second.contracts.oracle)
    expect(first.underlying.code).not.toBe(second.underlying.code)
    expect(first.underlying.sac).not.toBe(second.underlying.sac)
    // One issuer locally (every local role is one key), one Router for both.
    expect(second.underlying.issuer).toBe(first.underlying.issuer)
    expect(second.contracts.router).toBe(manifest.shared.router)
    expect(second.maturity).toBe(first.maturity)
    expect(second.marketId).toBe(`local-${second.underlying.code.toLowerCase()}-${second.maturity}`)
    expect(second.displayName).toBe(`${second.underlying.code} (test)`)
    for (const k of ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"] as const) {
      expect(second.contracts[k], k).not.toBe(first.contracts[k])
    }
    expect(manifest.shared.oracle).toBe(first.contracts.oracle)
    expect(manifest.testAsset).toMatchObject({ code: first.underlying.code, issuer: first.underlying.issuer, sac: first.underlying.sac })
    expect(manifestOracles(manifest).map((o) => o.oracle)).toEqual([first.contracts.oracle, second.contracts.oracle])
    expect(secondMarket(manifest)).toBe(second)
  })

  it("secondMarket names the deploy to run when the manifest has one market", () => {
    const manifest = readManifest()
    expect(() => secondMarket({ ...manifest, markets: manifest.markets.slice(0, 1) })).toThrow(/scripts\/dev-stack\/deploy\.sh.*SECOND_MARKET/)
  })

  it("each oracle has its own source and value, and the Router lists both pools", async () => {
    const manifest = readManifest()
    const [first, second] = manifest.markets
    const sources = await Promise.all(manifest.markets.map((m) => view(manifest, m.contracts.oracle, "get_primary_source")))
    expect(sources[0]).not.toEqual(sources[1])
    // The second oracle started at 1.4 (14000000), the first at 1.0: a tick only ever grows a value.
    expect(BigInt(String(await view(manifest, second.contracts.oracle, "get_reference_value")))).toBeGreaterThanOrEqual(14_000_000n)
    expect(BigInt(String(await view(manifest, first.contracts.oracle, "get_reference_value")))).toBeLessThan(14_000_000n)
    for (const m of manifest.markets) {
      const registered = await createRpcReader(manifest)({
        contractId: manifest.shared.router,
        functionName: "is_registered",
        args: [{ type: "address", value: m.contracts.pool }],
      })
      expect(registered.value, `${m.marketId} is registered with the Router`).toBe(true)
    }
  })

  it(
    "oracle-tick.sh ticks every oracle of the manifest: both move, both are available",
    async () => {
      const manifest = readManifest()
      const oracles = manifestOracles(manifest).map((o) => o.oracle)
      const before = await Promise.all(oracles.map((o) => timestampOf(manifest, o)))
      await ledgerPast(manifest, before)
      const out = await oracleTick()
      log(out)
      const lines = out.split("\n")
      expect(lines).toHaveLength(2)
      lines.forEach((line, i) => expect(line).toMatch(new RegExp(`^oracle ${oracles[i]} rate \\d+ -> \\d+ at ledger time \\d+$`)))
      const after = await Promise.all(oracles.map((o) => timestampOf(manifest, o)))
      after.forEach((ts, i) => expect(ts, oracles[i]).toBeGreaterThan(before[i]))
      for (const o of oracles) expect(await view(manifest, o, "is_available"), o).toBe(true)
    },
    2 * MINUTE,
  )

  it(
    "ORACLE_TICK_ORACLE ticks that oracle only, and one the manifest does not name is refused",
    async () => {
      const manifest = readManifest()
      const [first, second] = manifest.markets.map((m) => m.contracts.oracle)
      const before = await Promise.all([first, second].map((o) => timestampOf(manifest, o)))
      await ledgerPast(manifest, before)
      const { stdout } = await tickScript({ ORACLE_TICK_ORACLE: second })
      // One oracle ticked: the line it always printed.
      expect(stdout.trim()).toMatch(/^oracle rate \d+ -> \d+ at ledger time \d+$/)
      expect(await timestampOf(manifest, first)).toBe(before[0])
      expect(await timestampOf(manifest, second)).toBeGreaterThan(before[1])

      const stranger = manifest.shared.permissioning
      await expect(tickScript({ ORACLE_TICK_ORACLE: stranger })).rejects.toMatchObject({
        stderr: expect.stringContaining(`ORACLE_TICK_ORACLE ${stranger} is not an oracle of`),
      })
    },
    2 * MINUTE,
  )

  it("an explicit rate with two oracles is refused before anything is signed", async () => {
    const manifest = readManifest()
    const oracles = manifest.markets.map((m) => m.contracts.oracle)
    const before = await Promise.all(oracles.map((o) => timestampOf(manifest, o)))
    await expect(tickScript({}, ["20000000"])).rejects.toMatchObject({
      stderr: expect.stringContaining("a rate is one oracle's value"),
    })
    expect(await Promise.all(oracles.map((o) => timestampOf(manifest, o)))).toEqual(before)
  })

  it("onboardWithIssuer refuses a manifest that is not the local network's, before any call", async () => {
    const manifest = readManifest()
    const account = Keypair.random()
    await expect(onboardWithIssuer({ ...manifest, network: "testnet" }, secondMarket(manifest), account)).rejects.toThrow(/local network only/)
    const horizon = await createHorizon(manifest.horizonUrl).fetchAccount(account.publicKey())
    expect(horizon).toMatchObject({ status: "live", value: null })
  })

  it(
    "onboardWithIssuer onboards a fresh account on the second market: authorized trustline, allow-listed, 100,000 of its asset",
    async () => {
      const manifest = readManifest()
      const market = secondMarket(manifest)
      const account = Keypair.random()
      await onboardWithIssuer(manifest, market, account)
      const state = await fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account.publicKey(), "sac")
      expect(state.trustline).toMatchObject({ status: "live", value: "authorized" })
      expect(state.sacAuthorized).toMatchObject({ status: "live", value: true })
      expect(state.underlying).toMatchObject({ status: "live", value: 100_000n * 10n ** BigInt(market.underlying.decimals) })
      for (const [what, v] of [["account", state.permAllowed], ["PT", state.permPt], ["YT", state.permYt]] as const) {
        expect(v, what).toMatchObject({ status: "live", value: true })
      }
      log(`onboarded ${account.publicKey()} on ${market.marketId}`)
    },
    3 * MINUTE,
  )
})
