// @vitest-environment node
/**
 * `scripts/dev-stack/drill.sh` on Testnet is the developer's run only (spec 0004 D-31, plan 0008
 * Task 12): it signs with the official keys, so it refuses CI, any key name but the official ones, and
 * a run without a terminal to confirm on. These checks run the script with `stellar` and `curl`
 * replaced by stubs that record any call: each refusal must come before the keystore or the network
 * is touched. The only call allowed before the terminal check is `stellar network ls --long` (the CLI's
 * network list: no key, no network), which the stub answers from a fixture, so the check of the CLI's
 * own `testnet` is tested here too. Nothing here reaches Testnet; the local run is
 * `tests/integration/drill.test.ts`.
 */
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const DRILL = join(process.cwd(), "scripts", "dev-stack", "drill.sh")

let dir: string
let marker: string
let cwdLog: string
let stubs: string
let netls: Record<string, string>

/** `stellar network ls --long` as Stellar CLI 30.0.1 prints it on a default config. */
const TESTNET_BLOCK = "Name: testnet\nRPC url: https://soroban-testnet.stellar.org/\nRPC headers: not set\nNetwork passphrase: Test SDF Network ; September 2015\n"
const OTHERS =
  "Name: local\nRPC url: http://localhost:8000/rpc\nRPC headers: not set\nNetwork passphrase: Standalone Network ; February 2017\n\n" +
  "Name: futurenet\nRPC url: https://rpc-futurenet.stellar.org/\nRPC headers: not set\nNetwork passphrase: Test SDF Future Network ; October 2022\n\n"
const NETLS: Record<string, string> = {
  good: `${OTHERS}${TESTNET_BLOCK}`,
  // A config file's own `testnet`, listed before the built-in one.
  shadow: `${TESTNET_BLOCK.replace("https://soroban-testnet.stellar.org/", "https://rpc.attacker.example/")}\n${OTHERS}${TESTNET_BLOCK}`,
  // Partial or unknown output: the check fails closed.
  noRpcLine: `${OTHERS}${TESTNET_BLOCK.replace(/^RPC url: .*\n/m, "")}`,
  rpcLabelRenamed: `${OTHERS}${TESTNET_BLOCK.replace("RPC url:", "RPC URL:")}`,
  noPassLine: `${OTHERS}${TESTNET_BLOCK.replace(/^Network passphrase: .*\n/m, "")}`,
  passLabelRenamed: `${OTHERS}${TESTNET_BLOCK.replace("Network passphrase:", "Passphrase:")}`,
  noTestnet: OTHERS,
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "drill-guards-"))
  marker = join(dir, "calls.log")
  cwdLog = join(dir, "cwds.log")
  stubs = join(dir, "bin")
  mkdirSync(stubs)
  netls = {}
  for (const [name, text] of Object.entries(NETLS)) {
    netls[name] = join(dir, `netls-${name}.txt`)
    writeFileSync(netls[name], text)
  }
  // `stellar network ls` answers from $STUB_NETLS (stderr and exit code on demand); any other call fails.
  // Each call also logs its physical working directory and the size of the `.env` there (or `none`).
  writeFileSync(
    join(stubs, "stellar"),
    `#!/bin/sh\necho "stellar $*" >> "${marker}"\n` +
      `if [ -f .env ]; then size="$(wc -c < .env | tr -d ' ')"; else size=none; fi\n` +
      `echo "$(pwd -P) $size" >> "${cwdLog}"\n` +
      `if [ "$1" = network ] && [ "$2" = ls ]; then\n` +
      `  [ -z "$STUB_NETLS_STDERR" ] || echo "$STUB_NETLS_STDERR" >&2\n` +
      `  [ -z "$STUB_NETLS" ] || cat "$STUB_NETLS"\n` +
      `  exit "\${STUB_NETLS_EXIT:-0}"\n` +
      `fi\nexit 97\n`,
  )
  writeFileSync(join(stubs, "curl"), `#!/bin/sh\necho "curl $*" >> "${marker}"\nexit 97\n`)
  for (const tool of ["stellar", "curl"]) chmodSync(join(stubs, tool), 0o755)
})

beforeEach(() => {
  rmSync(marker, { force: true })
  rmSync(cwdLog, { force: true })
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/**
 * Runs drill.sh with stdin, stdout and stderr on pipes (no terminal) and the stubs first on PATH, from
 * `cwd` (default: this repository). The stub's `network ls` answers the good list unless `STUB_NETLS` says.
 * A run still going after `timeout` ms is killed with its whole process group (a subshell left spinning
 * would hold the pipes open), and says so (`killed`).
 */
function drill(
  env: Record<string, string | undefined>,
  script: string = DRILL,
  cwd: string = process.cwd(),
  timeout = 4_000, // under vitest's 5 s test timeout, so the group kill fires first
): Promise<{ code: number; stderr: string; stdout: string; killed: boolean }> {
  const base: Record<string, string> = { PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? dir, STUB_NETLS: netls.good }
  const full: Record<string, string | undefined> = { ...base, ...env }
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k]
  return new Promise((resolve) => {
    // Only these variables: CI, GITHUB_ACTIONS and key names of the test run never leak in. Its own
    // process group (detached), so the timeout reaches every subshell it started.
    const child = spawn("bash", [script], { cwd, env: full as NodeJS.ProcessEnv, detached: true })
    let stdout = ""
    let stderr = ""
    let killed = false
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      killed = true
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        // the group already exited
      }
    }, timeout)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}${err.message}`, killed })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, killed })
    })
  })
}

const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8") : "")
/** Each CLI call's physical working directory and the size of its `.env` (`none` without one). */
const cliCwds = () => (existsSync(cwdLog) ? readFileSync(cwdLog, "utf8").trim().split("\n").filter(Boolean) : [])
/** The only call allowed before the terminal check: the CLI's network list. */
const NETWORK_LIST_ONLY = "stellar network ls --long\n"

describe("drill.sh on testnet refuses before touching the keystore or the network", () => {
  it("refuses to run from CI", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", CI: "true" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/never runs? (from|in) CI/i)
    expect(r.stdout).toBe("")
    expect(calls()).toBe("")
  })

  it("refuses GitHub Actions even without CI set", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", GITHUB_ACTIONS: "true" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/never runs? (from|in) CI/i)
    expect(calls()).toBe("")
  })

  it("refuses an agent session (CLAUDECODE)", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", CLAUDECODE: "1" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("The Testnet drill is run by the developer, not by an agent.")
    expect(calls()).toBe("")
  })

  it("refuses Stellar CLI variables that would change the network, source, signer or sending", async () => {
    for (const name of [
      "STELLAR_RPC_URL",
      "STELLAR_NETWORK_PASSPHRASE",
      "STELLAR_NETWORK",
      "STELLAR_ACCOUNT",
      "STELLAR_RPC_HEADERS",
      "STELLAR_SIGN_WITH_KEY",
      "STELLAR_SIGN_WITH_LEDGER",
      "STELLAR_SIGN_WITH_LAB",
      "STELLAR_SEND",
      "STELLAR_INVOKE_VIEW",
      // Another config directory: another `testnet`, another keystore.
      "STELLAR_CONFIG_HOME",
      // The CLI reads every SOROBAN_* name as its STELLAR_* twin: any of them is refused, known or not.
      "SOROBAN_RPC_URL",
      "SOROBAN_NETWORK_PASSPHRASE",
      "SOROBAN_SOMETHING_NEW",
    ]) {
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", [name]: "x" })
      expect(r.code, name).not.toBe(0)
      expect(r.stderr, name).toContain(`${name} is set`)
      expect(calls()).toBe("")
    }
  })

  it("refuses another manifest on testnet, in the drill and in oracle-tick.sh", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", DRILL_MANIFEST: join(dir, "m.json") })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/DRILL_MANIFEST and ORACLE_TICK_MANIFEST are for the local network only/)
    const tick = await drill({ PRINCIPAL_NETWORK: "testnet", ORACLE_TICK_MANIFEST: join(dir, "m.json") }, join(process.cwd(), "scripts", "dev-stack", "oracle-tick.sh"))
    expect(tick.code).not.toBe(0)
    expect(tick.stderr).toMatch(/ORACLE_TICK_MANIFEST is for the local network only/)
    expect(calls()).toBe("")
  })

  it("refuses key names other than the official ones", async () => {
    for (const name of ["ADMIN_KEY", "ORACLE_KEY", "ISSUER_KEY"]) {
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", [name]: "e2e-123-admin" })
      expect(r.code, name).not.toBe(0)
      expect(r.stderr).toContain(name)
      expect(calls()).toBe("")
    }
  })

  it("refuses to run without a terminal (after the CLI's testnet passed its check)", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/needs a terminal/i)
    expect(r.stdout).toBe("")
    expect(calls()).toBe(NETWORK_LIST_ONLY)
  })

  it("refuses a .env in the working directory or any parent, naming it, before any call", async () => {
    // The Stellar CLI loads it (dotenvy): its STELLAR_* / SOROBAN_* lines would never reach this check.
    const root = mkdtempSync(join(dir, "withenv-"))
    writeFileSync(join(root, ".env"), "STELLAR_RPC_URL=x\n")
    const deeper = join(root, "sub", "deeper")
    mkdirSync(deeper, { recursive: true })
    for (const cwd of [root, deeper]) {
      rmSync(marker, { force: true })
      const r = await drill({ PRINCIPAL_NETWORK: "testnet" }, DRILL, cwd)
      expect(r.code, cwd).not.toBe(0)
      expect(r.stderr).toMatch(/\.env exists: the Stellar CLI loads a \.env from the working directory or any parent/)
      expect(r.stderr).toContain(`${root.split("/").pop()}/.env`)
      expect(r.stderr).not.toContain("STELLAR_RPC_URL=x")
      expect(calls()).toBe("")
    }
  })

  it("refuses a .env above its work directory (TMPDIR's parents), before any call", async () => {
    const tmpRoot = mkdtempSync(join(dir, "tmproot-"))
    writeFileSync(join(tmpRoot, ".env"), "SOROBAN_RPC_URL=x\n")
    const tmp = join(tmpRoot, "T")
    mkdirSync(tmp)
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", TMPDIR: `${tmp}/` })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/\.env exists above the drill's work directory/)
    expect(r.stderr).toContain(`${tmpRoot.split("/").pop()}/.env`)
    expect(calls()).toBe("")
    // The early exit trap removed the work directory.
    expect(readdirSync(tmp)).toEqual([])
  })

  it("refuses a .env above a symlinked TMPDIR's physical directory, before any call", async () => {
    // dotenvy walks the physical parents: TMPDIR=…/link/ with link -> real/x/y and real/.env present.
    const base = mkdtempSync(join(dir, "symtmp-"))
    const real = join(base, "real")
    const target = join(real, "x", "y")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(real, ".env"), "STELLAR_RPC_URL=x\n")
    const link = join(base, "link")
    symlinkSync(target, link)
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", TMPDIR: `${link}/` })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/\.env exists above the drill's work directory/)
    expect(r.stderr).toContain(join(realpathSync(real), ".env"))
    expect(r.stderr).not.toContain("STELLAR_RPC_URL=x")
    expect(calls()).toBe("")
    expect(readdirSync(target)).toEqual([])
  })

  it(
    "takes a relative TMPDIR to an absolute work directory: no hang, the CLI runs from it with an empty .env",
    async () => {
      // Before, the walk above a relative work directory never reached `/` (dirname stops at `.`).
      const cwd = mkdtempSync(join(dir, "reltmp-"))
      const rt = join(cwd, "rt")
      mkdirSync(rt)
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", TMPDIR: "rt/" }, DRILL, cwd, 8_000)
      expect(r.killed, "the drill hung").toBe(false)
      expect(r.stderr).toMatch(/needs a terminal/)
      expect(calls()).toBe(NETWORK_LIST_ONLY)
      // The CLI ran from the work directory, by its absolute physical path, next to an empty `.env` of its
      // own (dotenvy loads the first `.env` it finds, so no parent's), and the exit trap removed it.
      const [only, ...rest] = cliCwds()
      expect(rest).toEqual([])
      const [workDir, envSize] = (only ?? "").split(" ")
      expect(workDir.startsWith(`${realpathSync(rt)}/drill.`), workDir).toBe(true)
      expect(envSize).toBe("0")
      expect(readdirSync(rt)).toEqual([])

      // On the local network too: the exit trap removes the work directory, which a relative path missed
      // once the drill had moved into it.
      rmSync(marker, { force: true })
      const local = await drill({ PRINCIPAL_NETWORK: "local", TMPDIR: "rt/", DRILL_MANIFEST: join(cwd, "absent.json") }, DRILL, cwd, 8_000)
      expect(local.killed, "the drill hung").toBe(false)
      expect(local.code).not.toBe(0)
      expect(local.stderr).toContain(`${join(cwd, "absent.json")} not found.`)
      expect(calls()).not.toMatch(/^stellar /m)
      expect(readdirSync(rt)).toEqual([])
    },
    15_000,
  )
})

describe("drill.sh on testnet checks the Stellar CLI's own testnet, and fails closed", () => {
  it("passes the SDF testnet (then stops at the terminal check)", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", STUB_NETLS: netls.good })
    expect(r.stderr).toMatch(/needs a terminal/)
    expect(calls()).toBe(NETWORK_LIST_ONLY)
  })

  it("refuses a config file's own testnet with another RPC", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", STUB_NETLS: netls.shadow })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("the Stellar CLI's testnet uses the RPC 'https://rpc.attacker.example/'")
    expect(r.stderr).not.toMatch(/needs a terminal/)
    expect(calls()).toBe(NETWORK_LIST_ONLY)
  })

  it("refuses a list it cannot read in full (a missing or renamed line, no testnet)", async () => {
    for (const name of ["noRpcLine", "rpcLabelRenamed", "noPassLine", "passLabelRenamed", "noTestnet"]) {
      rmSync(marker, { force: true })
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", STUB_NETLS: netls[name] })
      expect(r.code, name).not.toBe(0)
      expect(r.stderr, name).toMatch(/does not show testnet's RPC and passphrase \(\d+ testnet blocks, \d+ RPC lines, \d+ passphrase lines\)/)
      expect(r.stderr, name).not.toMatch(/needs a terminal/)
      expect(calls()).toBe(NETWORK_LIST_ONLY)
    }
  })

  it("shows why `network ls` failed, with a secret-shaped string redacted", async () => {
    const secret = `S${"A".repeat(55)}`
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", STUB_NETLS: "", STUB_NETLS_EXIT: "2", STUB_NETLS_STDERR: `error: bad config near ${secret}` })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("error: bad config near S…[redacted]")
    expect(r.stderr).not.toContain(secret)
    expect(r.stderr).toMatch(/could not list the Stellar CLI's networks/)
  })

  it("refuses mainnet and any other network", async () => {
    for (const network of ["mainnet", "futurenet"]) {
      const r = await drill({ PRINCIPAL_NETWORK: network })
      expect(r.code, network).not.toBe(0)
      expect(r.stderr).toMatch(/local or testnet/)
      expect(calls()).toBe("")
    }
  })

  it("refuses an unknown step or a pause of a minute or more, on any network", async () => {
    const steps = await drill({ PRINCIPAL_NETWORK: "local", DRILL_STEPS: "recovery,finalize" })
    expect(steps.code).not.toBe(0)
    expect(steps.stderr).toMatch(/DRILL_STEPS/)
    const pause = await drill({ PRINCIPAL_NETWORK: "local", DRILL_PAUSE_SECONDS: "60" })
    expect(pause.code).not.toBe(0)
    expect(pause.stderr).toMatch(/DRILL_PAUSE_SECONDS/)
    expect(calls()).toBe("")
  })

  it("names DRILL_MANIFEST when its directory does not exist (local)", async () => {
    const given = join(dir, "no-such-dir", "m.json")
    const r = await drill({ PRINCIPAL_NETWORK: "local", DRILL_MANIFEST: given })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`DRILL_MANIFEST=${given}: its directory does not exist`)
    expect(calls()).toBe("")
  })
})
