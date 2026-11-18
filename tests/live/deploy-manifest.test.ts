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

/**
 * Plan 0009, Task 4: the dev stack deploys principal 3af9388 (Mainnet's contracts) by default and
 * still deploys 665bb67 (the official Testnet market's) when asked. The interface version is read
 * from the Router it built and written as the manifest's `protocolAbi`; the three `initialize` calls
 * that 3af9388 changed are signed so they work at both versions.
 */
describe("deploy.sh at both contract versions (protocolAbi)", () => {
  const mainnet = JSON.parse(readFileSync(join(process.cwd(), "config", "manifests", "mainnet.json"), "utf8")) as { sourceCommit: string }
  const manifestWrite = deploy.indexOf("jq -n")
  const escrowInit = deploy.indexOf('"$ESCROW" initialize')

  it("defaults PRINCIPAL_REF to the Mainnet deployment's full commit", () => {
    expect(mainnet.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(deploy).toContain(`PRINCIPAL_REF="\${PRINCIPAL_REF:-${mainnet.sourceCommit}}"`)
  })

  it("reads both the Router functions and PROTOCOL_ABI from one interface call on the built Router", () => {
    const call = 'stellar contract info interface --wasm "$WASM_DIR/principal_router.wasm" --output json'
    expect(deploy.split(call)).toHaveLength(2)
    const at = deploy.indexOf(call)
    // 2 when wrap_and_mint has an input named sy_in, else 1.
    const jq = deploy.slice(at, deploy.indexOf("die ", at))
    expect(jq).toMatch(/wrap_and_mint/)
    expect(jq).toMatch(/sy_in/)
    expect(jq).toMatch(/then 2 else 1 end/)
    expect(deploy).toMatch(/^PROTOCOL_ABI=/m)
    expect(deploy).toMatch(/^ROUTER_FUNCTIONS=/m)
    expect(deploy).toMatch(/\[\[ "\$PROTOCOL_ABI" =~ \^\[12\]\$ \]\] \|\| die/)
  })

  it("derives PROTOCOL_ABI before the escrow step and before the manifest is written", () => {
    const derived = deploy.search(/^PROTOCOL_ABI=/m)
    expect(derived).toBeGreaterThan(0)
    expect(escrowInit).toBeGreaterThan(derived)
    expect(manifestWrite).toBeGreaterThan(derived)
    // Read before the first transaction: a Router that cannot be read signs nothing.
    for (const first of ["stellar contract upload", "stellar contract deploy", "stellar contract asset deploy", "stellar tx new"]) {
      expect(deploy.indexOf(first)).toBeGreaterThan(derived)
    }
  })

  it("writes protocolAbi into the manifest as a number", () => {
    expect(deploy).toContain('--argjson protocolAbi "$PROTOCOL_ABI"')
    expect(deploy.slice(manifestWrite)).toMatch(/^\s+protocolAbi: \$protocolAbi,$/m)
  })

  it("signs OracleAdapter.initialize as the oracle admin and Permissioning.initialize as the issuer", () => {
    expect(deploy).toMatch(/^invoke "\$ORACLE_KEY" "\$ORACLE" initialize --admin "\$ORACLE_ADMIN" /m)
    expect(deploy).toMatch(/^iss "\$PERMISSIONING" initialize --admin "\$ISSUER"$/m)
    expect(deploy).not.toMatch(/adm "\$ORACLE" initialize/)
    expect(deploy).not.toMatch(/adm "\$PERMISSIONING" initialize/)
  })

  it("passes the escrow's --caller only inside an if on PROTOCOL_ABI 2", () => {
    const branch = deploy.match(/^if \[ "\$PROTOCOL_ABI" = 2 \]; then\n([\s\S]*?)^else\n([\s\S]*?)^fi$/m)
    expect(branch).not.toBeNull()
    const [, v2, v1] = branch ?? []
    expect(v2).toMatch(/^\s+adm "\$ESCROW" initialize --caller "\$ADMIN" --underlying "\$SAC" /m)
    expect(v1).toMatch(/^\s+adm "\$ESCROW" initialize --underlying "\$SAC" /m)
    expect(v1).not.toContain("--caller")
    // Both escrow initialize calls are the two branches of that if: there is no other.
    expect(deploy.match(/"\$ESCROW" initialize/g)).toHaveLength(2)
    expect(escrowInit).toBeGreaterThan(deploy.indexOf(branch?.[0] ?? "\0"))
  })
})
