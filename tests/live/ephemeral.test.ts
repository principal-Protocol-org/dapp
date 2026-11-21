import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { parseRecoveryRecord } from "./admin"
import { assertRunKey, ephemeralDeployEnv, isDeployStep, keyNamesFor, runIdFrom } from "./ephemeral"

// Mainnet's commit (`config/manifests/mainnet.json`), the one Suite B builds.
const COMMIT = "3af938853e5818aa8d56bd35670b9a19cfa55a78"

describe("run-unique key names (S1)", () => {
  it("takes the CI run and attempt when there is one, then the process id", () => {
    expect(runIdFrom({ GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2" }, 0, 42)).toBe("123456-2-42")
    expect(runIdFrom({}, 1_800_000_000_000, 7)).toBe("1800000000000-0-7")
  })

  it("keeps only letters and digits of each part, so a name stays a plain keystore name", () => {
    expect(runIdFrom({ GITHUB_RUN_ID: "1 2;3", GITHUB_RUN_ATTEMPT: "$(x)" }, 0, 1)).toBe("123-x-1")
  })

  it("names the four roles e2e-<runId>-<role>, distinct, and none starts with principal-", () => {
    const names = keyNamesFor("123-1-9")
    expect(names).toEqual({ admin: "e2e-123-1-9-admin", treasury: "e2e-123-1-9-treasury", issuer: "e2e-123-1-9-issuer", oracle: "e2e-123-1-9-oracle" })
    expect(new Set(Object.values(names)).size).toBe(4)
    for (const name of Object.values(names)) expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  })

  it("refuses a run id that is not letters, digits and -", () => {
    expect(() => keyNamesFor("a b")).toThrow(/run id/)
    expect(() => keyNamesFor("-x")).toThrow(/run id/)
  })

  it("lets the suite touch only its own names, never an official one", () => {
    const names = keyNamesFor("1-0-1")
    expect(() => assertRunKey("e2e-1-0-1-issuer", names)).not.toThrow()
    expect(() => assertRunKey("principal-testnet-issuer", names)).toThrow(/official key name/)
    expect(() => assertRunKey("PRINCIPAL_testnet_admin", names)).toThrow(/official key name/)
    expect(() => assertRunKey("e2e-2-0-1-issuer", names)).toThrow(/not one of this run's keys/)
    expect(() => assertRunKey(Keypair.random().secret(), names)).toThrow(/not one of this run's keys/)
    expect(() => assertRunKey("--force", names)).toThrow(/plain keystore name/)
  })
})

describe("the ephemeral deploy's environment", () => {
  const names = keyNamesFor("1-0-1")
  const base = {
    PATH: "/usr/bin",
    PRINCIPAL_REPO: "/src/principal",
    ADMIN_KEY: "principal-testnet-admin",
    ORACLE_KEY: "principal-testnet-oracle",
    MANIFEST_OUT: "/repo/config/manifests/testnet.json",
    PRINCIPAL_REF: "origin/feat/tranche-1-mvp",
    ALLOW_TESTNET_OVERRIDES: "1",
    ASSET_CODE: "OTHER",
    RPC_URL: "http://localhost:8000/rpc",
  }

  it("sets every deploy variable itself: a leftover one never reaches the script", () => {
    const env = ephemeralDeployEnv({ base, names, manifestOut: "/tmp/x/manifest.json", sourceCommit: COMMIT, maturitySeconds: 1500, oracleMaxStaleSeconds: 3600 })
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      PRINCIPAL_REPO: "/src/principal",
      EPHEMERAL: "1",
      PRINCIPAL_NETWORK: "testnet",
      MANIFEST_OUT: "/tmp/x/manifest.json",
      PRINCIPAL_REF: COMMIT,
      MATURITY_SECONDS: "1500",
      ORACLE_MAX_STALE_SECONDS: "3600",
      ADMIN_KEY: names.admin,
      TREASURY_KEY: names.treasury,
      ISSUER_KEY: names.issuer,
      ORACLE_KEY: names.oracle,
    })
    for (const k of ["ALLOW_TESTNET_OVERRIDES", "ASSET_CODE", "RPC_URL"]) expect(env[k], k).toBeUndefined()
    // The caller's environment is not changed.
    expect(base.ADMIN_KEY).toBe("principal-testnet-admin")
  })

  it("pins the contracts to a full commit, never a branch", () => {
    expect(() =>
      ephemeralDeployEnv({ base, names, manifestOut: "/tmp/m.json", sourceCommit: "origin/feat/tranche-1-mvp", maturitySeconds: 1500, oracleMaxStaleSeconds: 3600 }),
    ).toThrow(/full commit hash/)
  })

  it("refuses an official key name among the roles", () => {
    expect(() =>
      ephemeralDeployEnv({ base, names: { ...names, oracle: "principal-testnet-oracle" }, manifestOut: "/tmp/m.json", sourceCommit: COMMIT, maturitySeconds: 1500, oracleMaxStaleSeconds: 3600 }),
    ).toThrow(/official key name/)
  })

  it("shows the deploy's own steps and errors, not the CLI's chatter", () => {
    expect(isDeployStep("==> 9. RecoveryEscrow (+ set_recovery_escrow on SY, PT, YT, pool)")).toBe(true)
    expect(isDeployStep("error: the testnet RPC is not answering")).toBe(true)
    expect(isDeployStep("ℹ️ Simulating install transaction…")).toBe(false)
  })
})

/**
 * Plan 0009, Task 4: Suite B's throwaway Testnet market runs Mainnet's contracts. The suite and the
 * workflow that builds them for it read the commit from `config/manifests/mainnet.json`; Testnet's
 * manifest gives the suite only its RPC.
 */
describe("Suite B builds the Mainnet deployment's commit", () => {
  const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8")
  const suite = read("tests", "e2e-testnet", "lifecycle.test.ts")
  const workflow = read(".github", "workflows", "e2e-testnet.yml")
  const lifecycleJob = workflow.slice(workflow.indexOf("\n  lifecycle:"))

  it("the suite takes sourceCommit from mainnet.json, not from the Testnet manifest", () => {
    expect(suite).toMatch(/readFileSync\(join\(DAPP, "config", "manifests", "mainnet\.json"\), "utf8"\)/)
    expect(suite).not.toContain("official.manifest.sourceCommit")
    // Testnet still answers for the run: its reachability is still checked.
    expect(suite).toContain('liveContext({ network: "testnet" })')
  })

  it("the workflow's source-commit step and wasm comparison read mainnet.json", () => {
    expect(lifecycleJob).toContain("jq -er '.sourceCommit' config/manifests/mainnet.json")
    expect(lifecycleJob).toContain("jq -r '.wasmHashes[]' config/manifests/mainnet.json")
    expect(lifecycleJob).not.toContain("config/manifests/testnet.json")
  })

  it("the comparison stays informational and says why a difference is expected", () => {
    expect(lifecycleJob).toMatch(/- name: Compare the wasm with the Mainnet deployment's \(informational\)/)
    expect(lifecycleJob).toContain("rustc 1.94.1")
    expect(lifecycleJob).toContain("RUST_VERSION: 1.95.0")
  })
})

describe("parseRecoveryRecord", () => {
  const raw = {
    id: 0n,
    account: Keypair.random().publicKey(),
    ledger: 5_712_345,
    timestamp: 1_794_600_000n,
    sy_shares: 1n,
    underlying_from_sy: 2n,
    lp_amount: 3n,
    lp_pt: 4n,
    lp_sy_shares: 5n,
    underlying_from_lp: 6n,
    pt_amount: 7n,
    yt_amount: 8n,
    yt_yield_at_seize: 9n,
    finalized: false,
    underlying_from_pt: 0n,
    underlying_from_yt: 0n,
  }

  it("reads the struct scValToNative gives, field by field", () => {
    expect(parseRecoveryRecord(raw)).toEqual(raw)
  })

  it("refuses a missing or extra field, and a field of the wrong type", () => {
    const missing: Record<string, unknown> = { ...raw }
    delete missing.lp_pt
    expect(() => parseRecoveryRecord(missing)).toThrow(/unexpected recovery record fields/)
    expect(() => parseRecoveryRecord({ ...raw, extra: 1n })).toThrow(/unexpected recovery record fields/)
    expect(() => parseRecoveryRecord({ ...raw, pt_amount: 7 })).toThrow(/pt_amount is not an integer/)
    expect(() => parseRecoveryRecord({ ...raw, finalized: "yes" })).toThrow(/finalized/)
    expect(() => parseRecoveryRecord([raw])).toThrow(/struct/)
  })
})
