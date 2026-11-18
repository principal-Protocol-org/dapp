// @vitest-environment node
/**
 * `scripts/dev-stack/deploy.sh` writes the manifest every deploy reads back: the CI's ephemeral
 * Testnet suite parses it with `parseManifest`, which refuses a testnet or mainnet manifest without
 * `deployLedger` (the event indexer starts there). These checks read the script itself: the ledger is
 * taken from the RPC before the deploy's first transaction, and the manifest's jq object carries it.
 * The local deploy proves the output end to end (task 11, fix round 1).
 */
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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
    // 2 when wrap_and_mint has an input named sy_in, 1 when it has none, 0 when there is no wrap_and_mint.
    const jq = deploy.slice(at, deploy.indexOf("die ", at))
    expect(jq).toMatch(/wrap_and_mint/)
    expect(jq).toMatch(/sy_in/)
    expect(jq).toMatch(/then 2\s+elif any\(\.\[\]; \.name == "wrap_and_mint"\) then 1 else 0 end/)
    expect(deploy).toMatch(/^PROTOCOL_ABI=/m)
    expect(deploy).toMatch(/^ROUTER_FUNCTIONS=/m)
    expect(deploy).toMatch(/\[\[ "\$PROTOCOL_ABI" =~ \^\[12\]\$ \]\] \|\| die/)
  })

  // Task 4's review: a Router with functions but no wrap_and_mint must not read as version 1.
  it("stops on a Router with functions but no wrap_and_mint, before the version check", () => {
    const at = deploy.indexOf('stellar contract info interface --wasm "$WASM_DIR/principal_router.wasm" --output json')
    const program = /jq -r '([^']*)'\)"/.exec(deploy.slice(at))?.[1]
    expect(program).toBeDefined()
    const fn = (name: string, inputs: string[] = []) => ({
      function_v0: { doc: "", name, inputs: inputs.map((n) => ({ doc: "", name: n, type: "i128" })), outputs: [] },
    })
    const read = (iface: unknown[]) => execFileSync("jq", ["-r", program as string], { input: JSON.stringify(iface) }).toString().trim()
    const common = [fn("initialize", ["admin"]), fn("bump"), fn("unwrap", ["from", "pool", "amount"]), fn("quote_unwrap", ["pool"])]
    expect(read([...common, fn("wrap_and_mint", ["from", "pool", "amount", "sy_in", "min_pt_out", "deadline"])])).toBe('2 ["unwrap","wrap_and_mint"]')
    expect(read([...common, fn("wrap_and_mint", ["from", "pool", "amount", "min_pt_out", "deadline"])])).toBe('1 ["unwrap","wrap_and_mint"]')
    expect(read([...common, { udt_struct_v0: { name: "MarketInfo" } }])).toBe('0 ["unwrap"]')
    const stop = deploy.search(/^\[ "\$PROTOCOL_ABI" != 0 \] \|\| die "[^"\n]*wrap_and_mint[^"\n]*"$/m)
    expect(stop).toBeGreaterThan(at)
    expect(stop).toBeLessThan(deploy.search(/\[\[ "\$PROTOCOL_ABI" =~ \^\[12\]\$ \]\] \|\| die/))
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
    // The oracle step is a function (one per market since Task 5): its body is indented.
    expect(deploy).toMatch(/^\s+invoke "\$ORACLE_KEY" "\$ORACLE" initialize --admin "\$ORACLE_ADMIN" /m)
    expect(deploy).toMatch(/^iss "\$PERMISSIONING" initialize --admin "\$ISSUER"$/m)
    expect(deploy).not.toMatch(/adm "\$ORACLE" initialize/)
    expect(deploy).not.toMatch(/adm "\$PERMISSIONING" initialize/)
  })

  it("passes the escrow's --caller only inside an if on PROTOCOL_ABI 2", () => {
    // Inside the market function since Task 5: the if, its else and its fi share one indentation.
    const branch = deploy.match(/^( *)if \[ "\$PROTOCOL_ABI" = 2 \]; then\n([\s\S]*?)^\1else\n([\s\S]*?)^\1fi$/m)
    expect(branch).not.toBeNull()
    const [, , v2, v1] = branch ?? []
    expect(v2).toMatch(/^\s+adm "\$ESCROW" initialize --caller "\$ADMIN" --underlying "\$SAC" /m)
    expect(v1).toMatch(/^\s+adm "\$ESCROW" initialize --underlying "\$SAC" /m)
    expect(v1).not.toContain("--caller")
    // Both escrow initialize calls are the two branches of that if: there is no other.
    expect(deploy.match(/"\$ESCROW" initialize/g)).toHaveLength(2)
    expect(escrowInit).toBeGreaterThan(deploy.indexOf(branch?.[0] ?? "\0"))
  })
})

/**
 * Plan 0009, Task 5: on the local network only, the dev stack adds a second market on its own asset
 * (`ASSET_CODE_2`, default GILT) and its own OracleAdapter, wired to the same Permissioning, RiskControl
 * and Router. The asset, oracle and market blocks are functions called once per market (not copies),
 * and the first market's calls keep their order, so `SECOND_MARKET=0` and Testnet deploy exactly what
 * they did. The local deploy itself is proven by `tests/integration/local-stack.test.ts`.
 */
describe("deploy.sh: a second market on its own asset and oracle, local only", () => {
  const top = (re: RegExp) => deploy.search(re)
  // The gate of the second market's deploy: the last of the two `if`s on the same condition.
  const gate = deploy.lastIndexOf('if [ "$NETWORK" = local ] && [ "$SECOND_MARKET" != 0 ]; then')
  const body = (name: string) => {
    const m = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}$`, "m").exec(deploy)
    expect(m, `function ${name}`).not.toBeNull()
    return m?.[1] ?? ""
  }

  it("defaults SECOND_MARKET on and ASSET_CODE_2 to GILT; checks them only when the second market is made", () => {
    expect(deploy).toContain('SECOND_MARKET="${SECOND_MARKET:-1}"')
    expect(deploy).toContain('ASSET_CODE_2="${ASSET_CODE_2:-GILT}"')
    expect(deploy).toContain('ASSET_DISPLAY_2="$ASSET_CODE_2 (test)"')
    expect(deploy).toMatch(/\[\[ "\$ASSET_CODE_2" =~ \^\[A-Za-z0-9\]\{1,12\}\$ \]\] \|\| die/)
    // Two gates, the same condition: the checks, and the deploy of the second market.
    expect(deploy.match(/^if \[ "\$NETWORK" = local \] && \[ "\$SECOND_MARKET" != 0 \]; then$/gm)).toHaveLength(2)
    expect(top(/\[\[ "\$ASSET_CODE_2" =~/)).toBeGreaterThan(top(/^if \[ "\$NETWORK" = local \] && \[ "\$SECOND_MARKET" != 0 \]; then$/m))
  })

  it("has one asset, one oracle and one market block: functions, never copies", () => {
    for (const fn of ["issue_asset", "deploy_oracle", "deploy_market", "grant_standing", "seed_pool", "record_market", "deploy_second_market"]) {
      expect(deploy.match(new RegExp(`^${fn}\\(\\) \\{$`, "gm")), fn).toHaveLength(1)
    }
    for (const once of [
      "principal_oracle_adapter.wasm", "principal_sy_wrapper.wasm", "principal_pt_token.wasm", "principal_yt_token.wasm",
      "principal_market_config.wasm", "principal_manager.wasm", "principal_market_pool.wasm", "principal_recovery_escrow.wasm",
      "stellar contract asset deploy", "stellar tx new set-options", "set_sources --caller", "add_liquidity --from", "--sy_shares",
    ]) {
      expect(deploy.split(once), once).toHaveLength(2)
    }
  })

  it("keeps the first market's order: asset, maturity, oracle, Permissioning, RiskControl, market, Router, factory, standing, seeding", () => {
    const order = [
      /^issue_asset "\$ASSET_CODE"$/m,
      /^MATURITY=\$\(\(NOW \+ MATURITY_SECONDS\)\)$/m,
      /^deploy_oracle "\$ASSET_CODE" 10000000$/m,
      /^iss "\$PERMISSIONING" initialize --admin "\$ISSUER"$/m,
      /^adm "\$RISK_CONTROL" initialize --admin "\$ADMIN" --cb_limit 0$/m,
      /^deploy_market "\$ASSET_CODE"$/m,
      /^adm "\$ROUTER" initialize --admin "\$ADMIN"$/m,
      /^adm "\$ROUTER" register_market --caller "\$ADMIN" --pool "\$POOL"$/m,
      /^deploy_contract factory principal_market_factory\.wasm$/m,
      /^grant_standing$/m,
      /^seed_pool$/m,
      /^record_market "\$ASSET_CODE" "\$ASSET_DISPLAY"$/m,
    ].map(top)
    for (const at of order) expect(at).toBeGreaterThan(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The second market comes after the first is seeded and recorded, and before the manifest is written.
    expect(gate).toBeGreaterThan(order[order.length - 1])
    expect(deploy.indexOf("jq -n")).toBeGreaterThan(gate)
    expect(deploy.slice(gate)).toMatch(/^if [^\n]*\n {2}deploy_second_market\nfi$/m)
    expect(deploy.match(/^\s*deploy_second_market$/gm)).toHaveLength(1)
  })

  it("makes the second market on its own asset and oracle, with the same Router, and keeps the first market's variables", () => {
    const second = body("deploy_second_market")
    // Local to the function: once it returns, SAC, ORACLE, SY ... and MARKET_ID are the first market's again.
    expect(second).toMatch(/^ {2}local SAC ORACLE SY PT YT CONFIG MANAGER POOL ESCROW MARKET_ID$/m)
    const steps = [
      /^ {2}issue_asset "\$ASSET_CODE_2"$/m,
      /^ {2}deploy_oracle "\$ASSET_CODE_2" 14000000$/m,
      /^ {2}deploy_market "\$ASSET_CODE_2"$/m,
      /^ {2}adm "\$ROUTER" register_market --caller "\$ADMIN" --pool "\$POOL"$/m,
      /^ {2}grant_standing$/m,
      /^ {2}seed_pool$/m,
      /^ {2}record_market "\$ASSET_CODE_2" "\$ASSET_DISPLAY_2"$/m,
    ].map((re) => second.search(re))
    for (const at of steps) expect(at).toBeGreaterThan(0)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    // No new shared contract: the second market uses the first's Permissioning, RiskControl and Router.
    expect(second).not.toMatch(/deploy_contract|initialize/)
  })

  it("derives each oracle's source id from its own asset code", () => {
    const oracle = body("deploy_oracle")
    expect(oracle).toMatch(/^ {2}local code="\$1" genesis="\$2"/m)
    expect(oracle).toContain('"principal-oracle-source:${NETWORK}:${code}:app-team:keeper"')
    expect(oracle).toMatch(/--value "\$genesis" /)
    expect(deploy).not.toContain("principal-oracle-source:${NETWORK}:${ASSET_CODE}")
  })

  it("writes every recorded market; testAsset and shared.oracle stay the first market's", () => {
    const write = deploy.slice(deploy.indexOf("jq -n"))
    expect(write).toContain('--argjson markets "$MARKETS_JSON"')
    expect(write).toMatch(/^\s+markets: \$markets$/m)
    expect(write).toContain('--arg oracle "$ORACLE"')
    expect(write).toContain('--arg sac "$SAC"')
    expect(write).toMatch(/shared: \{ router: \$router, oracle: \$oracle, /)
    expect(write).toMatch(/testAsset: \{ code: \$code, issuer: \$issuer, sac: \$sac, decimals: 7, displayName: \$display \}/)
    // The manifest write is outside every function: it reads the first market's variables.
    expect(deploy.search(/^jq -n \\$/m)).toBeGreaterThan(0)
    expect(body("record_market")).toMatch(/marketId: \$id, displayName: \$display,/)
  })
})

describe("oracle-tick.sh: every oracle of the manifest", () => {
  const tick = readFileSync(join(DIR, "oracle-tick.sh"), "utf8")

  it("ticks each distinct market oracle in manifest order, not shared.oracle alone", () => {
    expect(tick).toContain("[.markets[]?.contracts.oracle] | reduce .[] as $o ([]; if any(.[]; . == $o) then . else . + [$o] end)")
    expect(tick).not.toContain("ORACLE=\"$(jq -er '.shared.oracle // .markets[0].contracts.oracle'")
  })

  it("checks ORACLE_TICK_ORACLE and a rate against the oracle list before any network call", () => {
    const network = tick.indexOf("rpc_healthy")
    expect(tick.indexOf('grep -qxF -- "$ORACLE_TICK_ORACLE"')).toBeGreaterThan(0)
    expect(tick.indexOf('grep -qxF -- "$ORACLE_TICK_ORACLE"')).toBeLessThan(network)
    expect(tick.search(/\[ -z "\$RATE_ARG" \] \|\| \[ "\$COUNT" -eq 1 \] \|\| die "a rate is one oracle's value/)).toBeLessThan(network)
    expect(tick.search(/\[ -z "\$RATE_ARG" \] \|\| \[ "\$COUNT" -eq 1 \]/)).toBeGreaterThan(0)
  })

  // Fix round 1: grep -F reads each line of a multi-line value as a pattern of its own, so the list check
  // alone let `<listed oracle>\n<anything>` through, to be ticked as given.
  it("checks that ORACLE_TICK_ORACLE is one contract id before the list check and before any network call", () => {
    const id = tick.indexOf('[[ "$ORACLE_TICK_ORACLE" =~ ^C[A-Z2-7]{55}$ ]] || die "ORACLE_TICK_ORACLE is not a contract id')
    expect(id).toBeGreaterThan(0)
    expect(id).toBeLessThan(tick.indexOf('grep -qxF -- "$ORACLE_TICK_ORACLE"'))
    expect(id).toBeLessThan(tick.indexOf("rpc_healthy"))
    expect(id).toBeLessThan(tick.indexOf("stellar keys address"))
  })

  it("drill.sh ticks its own oracle only, so the hash it records as oracle_tick is that oracle's", () => {
    const drill = readFileSync(join(DIR, "drill.sh"), "utf8")
    const call = drill.match(/^\s+if PRINCIPAL_NETWORK=[^\n]*\\\n\s+"\$DEV_STACK_DIR\/oracle-tick\.sh"/m)?.[0] ?? ""
    expect(call).toContain('ORACLE_TICK_ORACLE="$ORACLE"')
    expect(drill).toMatch(/^ORACLE="\$\(m '\.shared\.oracle'\)"$/m)
  })

  it("prints the single-oracle line unchanged, and names the oracle when there are several", () => {
    expect(tick).toContain('echo "$label rate $current -> $new at ledger time $ts"')
    expect(tick).toMatch(/label="oracle"/)
    expect(tick).toMatch(/label="oracle \$id"/)
  })
})

/**
 * Fix round 1, run for real: oracle-tick.sh with `stellar` and `curl` replaced by stubs that record any
 * call and fail, against a two-oracle manifest in a temporary directory (ORACLE_TICK_MANIFEST, local).
 * A bad ORACLE_TICK_ORACLE must stop it before either stub is called; a listed id goes on to the
 * network check (the curl stub), which shows the harness reaches that far.
 */
describe("oracle-tick.sh refuses an ORACLE_TICK_ORACLE that is not exactly one listed contract id", () => {
  const A = `C${"A".repeat(55)}`
  const B = `C${"B".repeat(55)}`
  let dir: string
  let calls: string
  let manifest: string
  let stubs: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oracle-tick-guards-"))
    calls = join(dir, "calls.log")
    stubs = join(dir, "bin")
    mkdirSync(stubs)
    for (const tool of ["stellar", "curl"]) {
      writeFileSync(join(stubs, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 97\n`)
      chmodSync(join(stubs, tool), 0o755)
    }
    manifest = join(dir, "local.json")
    writeFileSync(manifest, JSON.stringify({ shared: { oracle: A }, markets: [{ contracts: { oracle: A } }, { contracts: { oracle: B } }] }))
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const tickWith = (oracle: string) => {
    rmSync(calls, { force: true })
    // Only these variables: no Stellar CLI override, key name or ORACLE_TICK_* of the test run leaks in.
    const env: Record<string, string> = { PATH: `${stubs}:${process.env.PATH ?? ""}`, PRINCIPAL_NETWORK: "local", ORACLE_TICK_MANIFEST: manifest, ORACLE_TICK_ORACLE: oracle }
    const r = spawnSync("bash", [join(DIR, "oracle-tick.sh")], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 4_000,
    })
    return { code: r.status, stderr: r.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" }
  }

  it.each([
    ["two lines, the first a listed oracle", `${A}\n${`C${"Z".repeat(55)}`}`],
    ["two lines, both listed oracles", `${A}\n${B}`],
    ["a listed oracle with a trailing newline", `${A}\n`],
    ["an alias-like word", "my-oracle"],
  ])("%s: exits non-zero before any stellar or curl call", (_, value) => {
    const r = tickWith(value)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("ORACLE_TICK_ORACLE is not a contract id")
    expect(r.calls).toBe("")
  })

  it("an unlisted contract id is refused by the list check, also before any call", () => {
    const r = tickWith(`C${"Z".repeat(55)}`)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("is not an oracle of")
    expect(r.calls).toBe("")
  })

  it("a listed oracle passes both checks and reaches the network check (the curl stub), never stellar", () => {
    const r = tickWith(B)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("is not answering")
    expect(r.calls).toMatch(/^curl /)
    expect(r.calls).not.toMatch(/^stellar /m)
  })
})
