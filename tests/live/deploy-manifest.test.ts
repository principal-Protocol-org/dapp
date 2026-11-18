// @vitest-environment node
/**
 * `scripts/dev-stack/deploy.sh` writes the manifest every deploy reads back: the CI's ephemeral
 * Testnet suite parses it with `parseManifest`, which refuses a testnet or mainnet manifest without
 * `deployLedger` (the event indexer starts there). These checks read the script itself: the ledger is
 * taken from the RPC before the deploy's first transaction, and the manifest's jq object carries it.
 * The local deploy proves the output end to end (task 11, fix round 1).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const DIR = join(process.cwd(), "scripts", "dev-stack")
const deploy = readFileSync(join(DIR, "deploy.sh"), "utf8")
const common = readFileSync(join(DIR, "common.sh"), "utf8")

describe("deploy.sh records deployLedger", () => {
  it("reads the latest ledger from RPC getLatestLedger", () => {
    expect(common).toMatch(/latest_ledger\(\) \{[^}]*rpc_call getLatestLedger/)
    expect(deploy).toMatch(/DEPLOY_LEDGER="\$\(latest_ledger\)"/)
  })

  it("before its first transaction: no upload, deploy or set-options comes earlier", () => {
    const at = deploy.indexOf('DEPLOY_LEDGER="$(latest_ledger)"')
    expect(at).toBeGreaterThan(0)
    for (const first of ["stellar contract upload", "stellar contract deploy", "stellar contract asset deploy", "stellar tx new"]) {
      expect(deploy.indexOf(first)).toBeGreaterThan(at)
    }
  })

  it("writes it into the manifest on every network", () => {
    expect(deploy).toContain('--argjson deployLedger "$DEPLOY_LEDGER"')
    expect(deploy).toMatch(/generatedAt: \$generatedAt, sourceCommit: \$commit, deployLedger: \$deployLedger,/)
  })
})
