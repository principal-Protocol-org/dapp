// @vitest-environment node
/**
 * The OracleAdapter v2 on the local stack (plan 0004: R4-2, R4-8, R4-9, Task 7):
 * - market state reads the oracle's policy through the real RPC reader (the oracle is ticked first
 *   when it was last set more than half its freshness window ago): `get_primary_source()` (a
 *   `BytesN<32>`) decodes to the hex the Stellar CLI prints, which is R4-9's source id
 *   `sha256("principal-oracle-source:local:<ASSET_CODE>:app-team:keeper")`; no fallback source, no
 *   rejection ever (`last_rejection()` is `None`), `is_available()`, 3,600 s and 1,000 bps;
 * - the keeper behind `/api/cron/oracle` (`tickOracle`) pushes one value with the local oracle
 *   admin's key and reports `updated`.
 *
 * The keeper's key is the dev stack's throwaway `principal-localdev-admin`, read inside this process
 * from the Stellar CLI's keystore; it is never printed or written. One tick moves the oracle forward
 * by the default growth for the seconds elapsed, as `scripts/dev-stack/oracle-tick.sh` does.
 * Skipped unless `config/manifests/local.json` is a local manifest whose RPC answers.
 */
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

// The keeper and the faucet (through local-stack) are `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { fetchMarketState } from "@/lib/protocol/market-state"
import { createRpcReader } from "@/lib/protocol/reader"
import { tickOracle } from "@/lib/server/oracle-keeper"
import { createLog, eventually, ledgerClock, oracleTick, readManifest, redact, run, skipReason } from "./local-stack"

const skip = await skipReason()
if (skip) console.info(`[oracle] skipped: ${skip}. Start it with scripts/dev-stack/up.sh.`)

const ADMIN_KEY = "principal-localdev-admin"
/** The oracle is stale after 3,600 s; older than this, it is ticked before its freshness is asserted (as the routes suite does). */
const TICK_AFTER_SECONDS = 1_800
/** How long the keeper test waits for a ledger after the oracle's last reference timestamp. */
const NEXT_LEDGER_TIMEOUT_MS = 30_000
const out = createLog("oracle")

/** A read-only call of the oracle through the Stellar CLI, as the developer would type it. */
async function cli(oracle: string, fn: string): Promise<string> {
  const { stdout } = await run("stellar", ["contract", "invoke", "--id", oracle, "--source", ADMIN_KEY, "--network", "local", "--send=no", "--", fn])
  return stdout.trim()
}

describe.skipIf(skip !== null)("the OracleAdapter v2 on the local stack", () => {
  it("market state decodes the oracle's policy as the CLI prints it (Task 7, R4-9)", async () => {
    const manifest = readManifest()
    const market = manifest.markets[0]
    const oracle = manifest.shared.oracle
    // A stack left idle past the freshness window has a stale oracle: tick it first, as the routes suite does.
    const lastSet = Number(JSON.parse(await cli(oracle, "get_reference_timestamp")))
    const age = (await ledgerClock(manifest)).closeTime - lastSet
    out.log(`oracle last set ${age} s ago: ${age > TICK_AFTER_SECONDS ? await oracleTick() : "not ticked"}`)
    const ms = await fetchMarketState(createRpcReader(manifest), manifest, market.marketId)

    // `Option<BytesN<32>>`: the CLI prints the bytes as a JSON hex string.
    const printed = JSON.parse(await cli(oracle, "get_primary_source")) as unknown
    expect(typeof printed === "string" && /^[0-9a-f]{64}$/.test(printed), `CLI printed ${String(printed)}`).toBe(true)
    expect(ms.oraclePrimarySource).toMatchObject({ status: "live", value: printed })
    const convention = createHash("sha256").update(`principal-oracle-source:local:${market.underlying.code}:app-team:keeper`).digest("hex")
    expect(printed).toBe(convention)
    expect(ms.oracleFallbackSource).toMatchObject({ status: "live", value: null })

    expect(await cli(oracle, "last_rejection")).toBe("null")
    expect(ms.oracleLastRejection).toMatchObject({ status: "live", value: null })
    expect(ms.oracleFresh).toMatchObject({ status: "live", value: true })
    expect(ms.oracleMaxStaleSeconds).toMatchObject({ status: "live", value: 3_600n })
    expect(ms.oracleMaxDeviationBps).toMatchObject({ status: "live", value: 1_000n })
    out.log(`primary source ${printed} (CLI) = market state = sha256 of R4-9's id; fallback none; last_rejection None; is_available true; 3600 s, 1000 bps`)
  }, 60_000)

  it("one keeper tick (tickOracle, the cron's function) with the local oracle admin's key returns updated", async () => {
    const manifest = readManifest()
    const oracle = manifest.shared.oracle
    // The key, from the CLI's keystore, kept in this process only.
    const secret = (await run("stellar", ["keys", "secret", ADMIN_KEY])).stdout.trim()
    // The oracle refuses a timestamp that does not move forward: wait for a ledger past the last value.
    const last = Number(JSON.parse(await cli(oracle, "get_reference_timestamp")))
    await eventually(
      () => ledgerClock(manifest),
      (clock) => clock.closeTime > last,
      `a ledger closed after the oracle's last reference timestamp ${last} (is the local network closing ledgers?)`,
      NEXT_LEDGER_TIMEOUT_MS,
    )
    const before = BigInt(JSON.parse(await cli(oracle, "get_reference_value")) as string)

    const tick = await tickOracle({ manifest, secret })
    out.log(redact(`keeper tick: ${JSON.stringify(tick)} (value before ${before}, timestamp before ${last})`))
    expect(tick.status).toBe("updated")
    if (tick.status !== "updated") return
    expect(BigInt(tick.value) >= before).toBe(true)
    expect(tick.timestamp > last).toBe(true)
    expect(BigInt(JSON.parse(await cli(oracle, "get_reference_value")) as string)).toBe(BigInt(tick.value))
    expect(Number(JSON.parse(await cli(oracle, "get_reference_timestamp")))).toBe(tick.timestamp)
    expect(await cli(oracle, "last_rejection")).toBe("null")
  }, 2 * 60_000)

  it("prints the log", () => {
    out.summary()
  })
})
