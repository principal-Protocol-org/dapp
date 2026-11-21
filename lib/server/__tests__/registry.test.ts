// @vitest-environment node
import { Address, Asset, Contract, Keypair, StrKey, nativeToScVal, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PASSPHRASES, V1_ROUTER_FUNCTIONS } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"
import { RPC_CONCURRENCY } from "@/lib/protocol/rpc-limiter"
import type { Manifest, Market, MarketContractName } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

// ---------------------------------------------------------------- a fake chain

const cid = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n))
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
const SAC = new Asset("USDY", ISSUER).contractId(PASSPHRASES.local)
/** The same asset's contract on Mainnet: the asset contract id depends on the network. */
const MAINNET_SAC = new Asset("USDY", ISSUER).contractId(PASSPHRASES.mainnet)
const KINDS: MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]
const PINS = { sy: hash(1), pt: hash(2), yt: hash(3), config: hash(4), manager: hash(5), pool: hash(6), recoveryEscrow: hash(7) }
const SHARED = { router: cid(1), oracle: cid(2), permissioning: cid(3), riskControl: cid(4), factory: cid(5) }
/** A second oracle a manifest market may use (Mainnet has one per market), and one no manifest names. */
const ORACLE_B = cid(200)
const STRANGER_ORACLE = cid(210)
const MATURITY = 1_900_000_000

type Contracts = Record<MarketContractName, string>
/** A market's seven contracts, ids 10n..10n+6. */
const contractsOf = (n: number): Contracts => ({
  sy: cid(n),
  pt: cid(n + 1),
  yt: cid(n + 2),
  config: cid(n + 3),
  manager: cid(n + 4),
  pool: cid(n + 5),
  recoveryEscrow: cid(n + 6),
})

type Answer = unknown | ((args: { type: string; value: unknown }[]) => unknown)

class Chain {
  views = new Map<string, Answer>()
  wasm = new Map<string, string>()
  registered = new Set<string>()
  info = new Map<string, unknown>()
  /** Contract ids whose reads fail with a transport error (not an answer). */
  down = new Set<string>()

  constructor() {
    for (const sac of [SAC, MAINNET_SAC]) {
      this.views.set(`${sac}.name`, `USDY:${ISSUER}`)
      this.views.set(`${sac}.decimals`, 7)
    }
    this.views.set(`${SHARED.router}.is_registered`, (args: { value: unknown }[]) => this.registered.has(String(args[0].value)))
    this.views.set(`${SHARED.router}.market`, (args: { value: unknown }[]) => {
      const pool = String(args[0].value)
      if (!this.registered.has(pool)) throw new Error("HostError: Error(Contract, #2)")
      return this.info.get(pool)
    })
  }

  /**
   * Deploys a fully wired market running the pinned code, registered with the Router (at `contracts`
   * when given), its manager and YT on `oracle` (the shared one by default), on the asset contract
   * `sac` (the local USDY's by default).
   */
  deploy(n: number, opts: { register?: boolean; maturity?: number; contracts?: Contracts; oracle?: string; sac?: string } = {}): Contracts {
    const c = opts.contracts ?? contractsOf(n)
    const maturity = BigInt(opts.maturity ?? MATURITY)
    const oracle = opts.oracle ?? SHARED.oracle
    const sac = opts.sac ?? SAC
    const set = (id: string, fn: string, v: Answer) => this.views.set(`${id}.${fn}`, v)
    set(c.pool, "config_address", c.config)
    set(c.pool, "recovery_escrow", c.recoveryEscrow)
    set(c.pool, "sy_address", c.sy)
    set(c.pool, "pt_address", c.pt)
    set(c.pool, "yt_address", c.yt)
    set(c.pool, "manager_address", c.manager)
    set(c.pool, "maturity", maturity)
    set(c.pool, "underlying_address", sac)
    set(c.manager, "oracle_address", oracle)
    set(c.manager, "permissioning_address", SHARED.permissioning)
    set(c.manager, "config_address", c.config)
    set(c.manager, "risk_control", SHARED.riskControl)
    set(c.manager, "maturity", maturity)
    set(c.sy, "underlying_address", sac)
    set(c.sy, "permissioning_address", SHARED.permissioning)
    set(c.sy, "risk_control", SHARED.riskControl)
    set(c.sy, "recovery_escrow", c.recoveryEscrow)
    set(c.pt, "permissioning_address", SHARED.permissioning)
    set(c.pt, "recovery_escrow", c.recoveryEscrow)
    set(c.pt, "minter", c.manager)
    set(c.yt, "minter", c.manager)
    set(c.yt, "permissioning_address", SHARED.permissioning)
    set(c.yt, "oracle_address", oracle)
    set(c.yt, "recovery_escrow", c.recoveryEscrow)
    set(c.config, "underlying", sac)
    set(c.config, "maturity", maturity)
    set(c.recoveryEscrow, "underlying_address", sac)
    for (const kind of KINDS) this.wasm.set(c[kind], PINS[kind])
    this.info.set(c.pool, { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: sac })
    if (opts.register ?? true) this.registered.add(c.pool)
    return c
  }

  /** Every view call, as `id.fn`. */
  reads: string[] = []

  reader: ContractReader = (async <T,>(call: { contractId: string; functionName: string; args?: { type: string; value: unknown }[] }) => {
    this.reads.push(`${call.contractId}.${call.functionName}`)
    if (this.down.has(call.contractId)) throw new Error("fetch failed: ECONNRESET")
    const key = `${call.contractId}.${call.functionName}`
    if (!this.views.has(key)) throw new Error(`HostError: Error(WasmVm, MissingValue) ${key}`)
    const h = this.views.get(key)
    const value = typeof h === "function" ? (h as (a: unknown) => unknown)(call.args ?? []) : h
    return { value: value as T, latestLedger: 900, minResourceFee: "0" }
  }) as ContractReader

  events: RawEvent[] = []
  oldestLedger = 100
  latestLedger = 1_000
  getEventsCalls: Record<string, unknown>[] = []

  rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      const entries = keys.flatMap((key) => {
        if (key.type !== "contractData") return []
        const id = Address.fromScAddress(key.contractData.contract).toString()
        if (this.down.has(id)) throw new Error("fetch failed: ECONNRESET")
        const hex = this.wasm.get(id)
        return hex ? [instanceEntry(id, hex)] : []
      })
      return { entries, latestLedger: 900 }
    },
    getHealth: async () => ({ status: "healthy", oldestLedger: this.oldestLedger, latestLedger: this.latestLedger }),
    getEvents: async (req: { startLedger?: number; cursor?: string; filters: unknown; limit: number }) => {
      this.getEventsCalls.push(req)
      const after = req.cursor
      const from = req.startLedger
      if (from !== undefined && from < this.oldestLedger) throw new Error(`startLedger must be between the oldest ledger: ${this.oldestLedger} and the latest ledger`)
      const events = this.events.filter((e) => (after !== undefined ? e.id > after : e.ledger >= (from ?? 0)))
      return {
        events,
        cursor: tipCursor(this.latestLedger),
        latestLedger: this.latestLedger,
        oldestLedger: this.oldestLedger,
        latestLedgerCloseTime: "0",
        oldestLedgerCloseTime: "0",
      }
    },
  }
}

const tipCursor = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`
const eventId = (ledger: number, i = 0) => `${((BigInt(ledger) << 32n) + BigInt(i)).toString().padStart(19, "0")}-0000000000`

type RawEvent = { id: string; ledger: number; ledgerClosedAt: string; txHash: string; contractId: string; topic: xdr.ScVal[]; value: xdr.ScVal }

function ev(contractId: string, topic: string, value: xdr.ScVal, ledger: number, i = 0): RawEvent {
  return { id: eventId(ledger, i), ledger, ledgerClosedAt: "", txHash: "ab".repeat(32), contractId, topic: [xdr.ScVal.scvSymbol(topic)], value }
}
const addr = (id: string) => nativeToScVal(id, { type: "address" })
const reg = (pool: string, ledger: number, i = 0) => ev(SHARED.router, "mkt_reg", addr(pool), ledger, i)
const unreg = (pool: string, ledger: number, i = 0) => ev(SHARED.router, "mkt_unreg", addr(pool), ledger, i)
const mktNew = (pool: string, escrow: string, ledger: number, salt = Buffer.alloc(32, 9)) =>
  ev(SHARED.factory, "mkt_new", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(salt), addr(pool), addr(escrow)]), ledger)
/** The factory's `mkt_tok (salt, sy_wrapper)` and `mkt_eng (salt, principal_manager)`: a market part way created. */
const mktTok = (salt: Buffer, sy: string, ledger: number, i = 0, factory = SHARED.factory) =>
  ev(factory, "mkt_tok", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(salt), addr(sy)]), ledger, i)
const mktEng = (salt: Buffer, manager: string, ledger: number, i = 0) =>
  ev(SHARED.factory, "mkt_eng", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(salt), addr(manager)]), ledger, i)
const saltOf = (n: number) => Buffer.alloc(32, n)
const hex = (b: Buffer) => b.toString("hex")

function instanceEntry(contractId: string, hex: string) {
  const executable = xdr.ContractExecutable.contractExecutableWasm(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))))
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  )
  return { key: new Contract(contractId).getFootprint(), val }
}

// ---------------------------------------------------------------- manifest, store

function seedMarket(c: Contracts, oracle: string = SHARED.oracle): Market {
  return {
    marketId: `local-usdy-${MATURITY}`,
    displayName: "USDY (test)",
    underlying: { code: "USDY", issuer: ISSUER, sac: SAC, decimals: 7 },
    maturity: MATURITY,
    contracts: { router: SHARED.router, oracle, ...c },
  }
}

function manifestWith(markets: Market[], overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 2,
    network: "local",
    networkPassphrase: PASSPHRASES.local,
    rpcUrl: "http://localhost:8000/rpc",
    horizonUrl: "http://localhost:8000",
    generatedAt: "2026-10-31T00:00:00Z",
    sourceCommit: "be2a1a5",
    shared: SHARED,
    wasmHashes: { ...PINS, router: hash(8) },
    routerFunctions: [...V1_ROUTER_FUNCTIONS],
    testAsset: { code: "USDY", issuer: ISSUER, sac: SAC, decimals: 7, displayName: "USDY (test)" },
    markets,
    ...overrides,
  }
}

import {
  allowedOracles,
  discover,
  invalidMarkets,
  listedMarkets,
  marketFromPool,
  publishMarket,
  resolvedMarkets,
  revalidate,
  validateMarket,
  MAX_RESUMABLE,
  resumableSalts,
  sqlRegistryStore,
  type RegistryRow,
  type RegistryStore,
  type SaltRow,
} from "@/lib/server/registry"
import { deriveMarketContracts } from "@/lib/protocol/factory"

/** In-memory `market_registry`, `ingest_cursor` and `market_salts`, with the SQL store's upsert rules. */
function memoryStore() {
  const rows = new Map<string, RegistryRow>()
  const cursors = new Map<string, { ledger: number; cursor: string | null }>()
  const salts = new Map<string, SaltRow>()
  const phaseRank = { tokens: 0, engine: 1, pool: 2 } as const
  let clock = 0
  const stamp = () => new Date(Date.UTC(2026, 9, 1) + ++clock * 1000).toISOString()
  const rank = { discovered: 0, published: 1, seed: 2 } as const
  const store: RegistryStore & { rowsMap: typeof rows; cursors: typeof cursors; saltsMap: typeof salts; writes: number; fail?: Error; failSalts?: Error } = {
    rowsMap: rows,
    cursors,
    saltsMap: salts,
    writes: 0,
    async salts(factory) {
      if (store.fail) throw store.fail
      return [...salts.values()].filter((r) => r.factory === factory).sort((a, b) => b.ledger - a.ledger).map((r) => ({ ...r }))
    },
    async recordSalt(row) {
      if (store.failSalts) throw store.failSalts
      store.writes++
      const prev = salts.get(`${row.factory}:${row.salt}`)
      const phase = prev && phaseRank[prev.phase] > phaseRank[row.phase] ? prev.phase : row.phase
      salts.set(`${row.factory}:${row.salt}`, { ...row, phase, ledger: Math.max(row.ledger, prev?.ledger ?? 0) })
    },
    async rows(opts) {
      if (store.fail) throw store.fail
      const all = [...rows.values()].map((r) => structuredClone(r))
      // As the SQL store's bounded read: `valid is true`, plus the named pools' own rows.
      return opts ? all.filter((r) => r.valid === true || opts.listed.includes(r.pool)) : all
    },
    async record(row) {
      store.writes++
      const prev = rows.get(row.pool)
      const source = prev && rank[prev.source] > rank[row.source] ? prev.source : row.source
      if (row.valid === null && prev) {
        rows.set(row.pool, { ...prev, source, reason: row.reason, updatedAt: stamp() })
        return
      }
      rows.set(row.pool, {
        pool: row.pool,
        source,
        valid: row.valid,
        reason: row.reason,
        market: row.market ?? prev?.market ?? null,
        marketId: ((row.market ?? prev?.market) as Market | null | undefined)?.marketId ?? null,
        updatedAt: stamp(),
      })
    },
    async cursor(name) {
      return cursors.get(name) ?? null
    },
    async saveCursor(name, ledger, cursor) {
      store.writes++
      cursors.set(name, { ledger, cursor })
    },
  }
  return store
}

let chain: Chain
let store: ReturnType<typeof memoryStore>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  chain = new Chain()
  store = memoryStore()
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  error = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const depsFor = (manifest: Manifest) => ({ store, reader: chain.reader, rpc: chain.rpc, manifest })

// ---------------------------------------------------------------- marketFromPool

describe("marketFromPool", () => {
  it("builds the market from the pool and the manager (R2-37 id, name and underlying; R2-12 pins)", async () => {
    const c = chain.deploy(10)
    const market = await marketFromPool(chain.reader, chain.rpc, manifestWith([]), c.pool)
    expect(market).toEqual({
      marketId: `local-usdy-${MATURITY}`,
      displayName: "USDY (test)",
      underlying: { code: "USDY", issuer: ISSUER, sac: SAC, decimals: 7 },
      maturity: MATURITY,
      contracts: { router: SHARED.router, oracle: SHARED.oracle, ...c },
      // Market contract kinds only: shared pins (router) are not this market's code.
      wasmHashes: PINS,
    })
  })

  it("an id taken by another pool gets the pool's suffix", async () => {
    const seed = seedMarket(chain.deploy(10))
    const c = chain.deploy(20)
    const market = await marketFromPool(chain.reader, chain.rpc, manifestWith([seed]), c.pool)
    expect(market.marketId).toBe(`local-usdy-${MATURITY}-${c.pool.slice(1, 7).toLowerCase()}`)
  })

  it("the display name has no (test) suffix when the underlying is not the test asset", async () => {
    const c = chain.deploy(10)
    const market = await marketFromPool(chain.reader, chain.rpc, manifestWith([], { testAsset: undefined }), c.pool)
    expect(market.displayName).toBe("USDY")
  })

  it("a pool without a recovery escrow is not a finished market", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.pool}.recovery_escrow`, null)
    await expect(marketFromPool(chain.reader, chain.rpc, manifestWith([]), c.pool)).rejects.toThrow(/recovery escrow/i)
  })
})

// ---------------------------------------------------------------- validateMarket

describe("validateMarket", () => {
  it("a market wired to this network and running the pinned code is valid", async () => {
    const market = seedMarket(chain.deploy(10))
    expect(await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)).toEqual({ valid: true })
  })

  it("unpinned wasm hash hides market, with the reason naming the contract", async () => {
    const c = chain.deploy(10)
    chain.wasm.set(c.pt, hash(99))
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.unreadable).toBeUndefined()
    expect(v.reason).toContain("pt")
    expect(v.reason).toContain(c.pt)
    expect(v.reason).toContain(hash(99))
  })

  it("a contract kind the manifest pins no hash for is not trusted", async () => {
    const market = seedMarket(chain.deploy(10))
    const pins: Partial<typeof PINS> = { ...PINS }
    delete pins.recoveryEscrow
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market], { wasmHashes: pins }), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/recoveryEscrow/)
  })

  it("wrong wiring hides market: a foreign Permissioning", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.manager}.permissioning_address`, cid(77))
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v).toMatchObject({ valid: false })
    expect(v.reason).toMatch(/permissioning/i)
  })

  it("wrong wiring hides market: an SY outside RiskControl, a YT on another oracle", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.sy}.risk_control`, null)
    chain.views.set(`${c.yt}.oracle_address`, cid(78))
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/sy.*risk/i)
    expect(v.reason).toMatch(/yt.*oracle/i)
  })

  it("a market on its own manifest oracle is valid", async () => {
    const a = seedMarket(chain.deploy(10))
    const b = { ...seedMarket(chain.deploy(20, { oracle: ORACLE_B }), ORACLE_B), marketId: "local-usdy-b" }
    const manifest = manifestWith([a, b])
    expect(await validateMarket(chain.reader, chain.rpc, manifest, a)).toEqual({ valid: true })
    expect(await validateMarket(chain.reader, chain.rpc, manifest, b)).toEqual({ valid: true })
  })

  // The factory is permissionless: anyone can build a market wired, end to end, to an oracle of their own.
  it("a market on an oracle the manifest does not name is refused", async () => {
    const seed = seedMarket(chain.deploy(10))
    const stranger = seedMarket(chain.deploy(20, { oracle: STRANGER_ORACLE }), STRANGER_ORACLE)
    chain.reads = []
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([seed]), stranger)
    expect(v.valid).toBe(false)
    expect(v.reason).toContain(STRANGER_ORACLE)
    expect(v.reason).toMatch(/oracle/i)
    // Refused before any read, like a market on another Router.
    expect(chain.reads).toEqual([])
  })

  it("a manager wired to another manifest oracle than its market's is refused", async () => {
    const a = seedMarket(chain.deploy(10))
    const c = chain.deploy(20, { oracle: ORACLE_B })
    const b = { ...seedMarket(c, ORACLE_B), marketId: "local-usdy-b" }
    const manifest = manifestWith([a, b])
    chain.views.set(`${c.manager}.oracle_address`, SHARED.oracle)
    const manager = await validateMarket(chain.reader, chain.rpc, manifest, b)
    expect(manager.valid).toBe(false)
    expect(manager.reason).toContain(`manager oracle_address is ${SHARED.oracle}, not ${ORACLE_B}`)

    // The YT is held to the market's own oracle too.
    chain.views.set(`${c.manager}.oracle_address`, ORACLE_B)
    chain.views.set(`${c.yt}.oracle_address`, SHARED.oracle)
    const yt = await validateMarket(chain.reader, chain.rpc, manifest, b)
    expect(yt.valid).toBe(false)
    expect(yt.reason).toContain(`yt oracle_address is ${SHARED.oracle}, not ${ORACLE_B}`)
  })

  it("allowedOracles is the manifest markets' oracles and shared.oracle", () => {
    const b = { ...seedMarket(contractsOf(20), ORACLE_B), marketId: "local-usdy-b" }
    expect([...allowedOracles(manifestWith([]))]).toEqual([SHARED.oracle])
    expect([...allowedOracles(manifestWith([seedMarket(contractsOf(10)), b]))].sort()).toEqual([SHARED.oracle, ORACLE_B].sort())
  })

  it("wrong wiring hides market: PT or YT minted by another contract than the manager (R2-40)", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.pt}.minter`, cid(81))
    chain.views.set(`${c.yt}.minter`, cid(82))
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/pt minter/)
    expect(v.reason).toMatch(/yt minter/)
  })

  it("a view answering the wrong type is named as such, not as a refusal (R2-41)", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.pt}.minter`, ISSUER)
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/pt minter is not a contract address/)
    expect(v.reason).not.toMatch(/refused/)
  })

  it("a market on foreign infrastructure is refused without a single read", async () => {
    const market = seedMarket(chain.deploy(10))
    const foreign = { ...market, contracts: { ...market.contracts, router: cid(91) } }
    chain.reads = []
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([foreign]), foreign)
    expect(v.valid).toBe(false)
    expect(chain.reads).toEqual([])
  })

  it("a manager on another Permissioning stops the check before the long reads", async () => {
    const c = chain.deploy(10)
    chain.views.set(`${c.manager}.permissioning_address`, cid(77))
    const market = seedMarket(c)
    chain.reads = []
    await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(chain.reads.length).toBeLessThanOrEqual(4)
    expect(chain.reads).not.toContain(`${c.yt}.oracle_address`)
  })

  it("a refusal never carries RPC text in its reason; the detail is kept apart for logs", async () => {
    const c = chain.deploy(10)
    chain.views.delete(`${c.yt}.recovery_escrow`)
    chain.down.add(c.config)
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/yt recovery_escrow/)
    expect(v.reason).not.toMatch(/HostError|MissingValue|ECONNRESET|fetch failed/)
  })

  it("0001's topology rule: the Router must list the same contracts for the pool", async () => {
    const c = chain.deploy(10)
    chain.info.set(c.pool, { pool: c.pool, manager: c.manager, sy: c.sy, pt: cid(80), yt: c.yt, underlying: SAC })
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/Router.*pt/)
  })

  it("a pool the Router does not list is not valid", async () => {
    const market = seedMarket(chain.deploy(10, { register: false }))
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/not registered with the Router/)
  })

  it("an underlying that is not the asset contract of its code and issuer is refused", async () => {
    const market = seedMarket(chain.deploy(10))
    const fake = { ...market, underlying: { ...market.underlying, code: "USDC" } }
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([fake]), fake)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/USDC/)
  })

  it("a read the RPC could not answer makes the check unreadable, not invalid", async () => {
    const c = chain.deploy(10)
    chain.down.add(c.yt)
    const market = seedMarket(c)
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([market]), market)
    expect(v).toMatchObject({ valid: false, unreadable: true })
    expect(v.reason).toMatch(/could not be checked/i)
  })
})

// ---------------------------------------------------------------- the read cap on a server job (R9-4)

/** A view's answer as the host encodes it: an address as an address, an integer as u32 or u64, a struct as a symbol-keyed map. */
function toScVal(v: unknown): xdr.ScVal {
  if (v === null || v === undefined) return xdr.ScVal.scvVoid()
  if (typeof v === "boolean") return xdr.ScVal.scvBool(v)
  if (typeof v === "number") return nativeToScVal(v, { type: "u32" })
  if (typeof v === "bigint") return nativeToScVal(v, { type: "u64" })
  if (typeof v === "string") return StrKey.isValidContract(v) || StrKey.isValidEd25519PublicKey(v) ? nativeToScVal(v, { type: "address" }) : nativeToScVal(v)
  const fields = v as Record<string, unknown>
  return xdr.ScVal.scvMap(Object.keys(fields).sort().map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: toScVal(fields[k]) })))
}

/**
 * The fake chain as one RPC endpoint: simulations for the app's own reader (`createRpcReader`), each
 * call decoded and answered from the chain's views, and the code reads (`getLedgerEntries`) answered
 * by the chain. It counts every request in flight, of both kinds together. Each one stays open
 * across a timer tick, so requests started together overlap.
 */
function countingEndpoint(chain: Chain) {
  const load = { inFlight: 0, peak: 0, simulations: 0, codeReads: 0 }
  const open = () => {
    load.inFlight++
    load.peak = Math.max(load.peak, load.inFlight)
    return new Promise((resolve) => setTimeout(resolve, 1))
  }
  const rpc = {
    ...chain.rpc,
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      load.codeReads++
      try {
        await open()
        return await chain.rpc.getLedgerEntries(...keys)
      } finally {
        load.inFlight--
      }
    },
  }
  const server = {
    async simulateTransaction(tx: Transaction) {
      load.simulations++
      try {
        await open()
        const [op] = tx.operations
        if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call")
        const invoke = op.func.invokeContract
        const call = {
          contractId: Address.fromScAddress(invoke.contractAddress).toString(),
          functionName: invoke.functionName.toString(),
          // The chain's views take addresses only (the Router's `is_registered` and `market`).
          args: invoke.args.map((a) => ({ type: "address" as const, value: String(scValToNative(a)) })),
        }
        const { value } = await chain.reader(call)
        return { id: "1", _parsed: true, latestLedger: 900, events: [], minResourceFee: "0", transactionData: {}, result: { auth: [], retval: toScVal(value) } } as never
      } finally {
        load.inFlight--
      }
    },
  }
  return { serverFor: () => server, rpc, load }
}

describe("the read cap on a server job (R9-4)", () => {
  it("re-validating five markets through the app's reader never has more than six reads in flight, code reads included", async () => {
    const markets = [10, 20, 30, 40, 50].map((n, i) => ({ ...seedMarket(chain.deploy(n)), marketId: `local-usdy-${i}` }))
    const manifest = manifestWith(markets)
    const endpoint = countingEndpoint(chain)
    // The real reader: this file's route tests mock `createRpcReader`.
    const { createRpcReader } = await vi.importActual<typeof import("@/lib/protocol/reader")>("@/lib/protocol/reader")
    const reader = createRpcReader(manifest, { serverFor: endpoint.serverFor })
    const { checked } = await revalidate({ store, reader, rpc: endpoint.rpc, manifest })
    expect(checked).toEqual(markets.map((m) => m.contracts.pool))
    // Every read was answered: all five are valid, read through the fake endpoint, not around it.
    for (const m of markets) expect(store.rowsMap.get(m.contracts.pool)).toMatchObject({ valid: true })
    expect(endpoint.load.simulations).toBeGreaterThan(5 * 20)
    // One code read per market contract (seven kinds), started beside the wire reads.
    expect(endpoint.load.codeReads).toBe(5 * 7)
    // Reached, never passed: one market alone starts about 20 simulations and 7 code reads at once.
    expect(endpoint.load.peak).toBeLessThanOrEqual(RPC_CONCURRENCY)
    expect(endpoint.load.peak).toBe(RPC_CONCURRENCY)
  })
})

// ---------------------------------------------------------------- discovery

describe("discover and resolvedMarkets", () => {
  it("a valid discovered market appears in resolvedMarkets", async () => {
    const seed = seedMarket(chain.deploy(10))
    const c = chain.deploy(20)
    chain.events = [reg(seed.contracts.pool, 200), reg(c.pool, 300)]
    const manifest = manifestWith([seed])

    const result = await discover(depsFor(manifest))
    expect(result.checked).toEqual([seed.contracts.pool, c.pool])

    const markets = await resolvedMarkets({ store, manifest })
    expect(markets.map((m) => m.contracts.pool)).toEqual([seed.contracts.pool, c.pool])
    expect(markets[1].marketId).toBe(`local-usdy-${MATURITY}-${c.pool.slice(1, 7).toLowerCase()}`)
    expect(store.rowsMap.get(c.pool)).toMatchObject({ source: "discovered", valid: true })
    // The seed's own registration event keeps it a seed.
    expect(store.rowsMap.get(seed.contracts.pool)).toMatchObject({ source: "seed", valid: true })
  })

  it("two new markets with the same code and maturity in one scan get distinct ids and are both listed", async () => {
    const a = chain.deploy(20)
    const b = chain.deploy(30)
    chain.events = [reg(a.pool, 300), reg(b.pool, 301)]
    const manifest = manifestWith([])
    await discover(depsFor(manifest))
    const ids = (await resolvedMarkets({ store, manifest })).map((m) => m.marketId)
    expect(ids).toEqual([`local-usdy-${MATURITY}`, `local-usdy-${MATURITY}-${b.pool.slice(1, 7).toLowerCase()}`])
  })

  it("mkt_unreg removes it", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    chain.events = [reg(c.pool, 300)]
    await discover(depsFor(manifest))
    expect((await resolvedMarkets({ store, manifest })).map((m) => m.contracts.pool)).toEqual([c.pool])

    chain.registered.delete(c.pool)
    chain.latestLedger = 2_000
    chain.events.push(unreg(c.pool, 1_500))
    await discover(depsFor(manifest))
    expect(await resolvedMarkets({ store, manifest })).toEqual([])
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: false, reason: expect.stringMatching(/unregistered/i) })
  })

  it("events are applied in ledger order: register then unregister ends unregistered, whatever order RPC lists them", async () => {
    const a = chain.deploy(20)
    const b = chain.deploy(30)
    chain.registered.delete(a.pool)
    // a: registered at 300, unregistered at 400. b: unregistered at 300, registered again at 400.
    chain.events = [unreg(a.pool, 400), reg(b.pool, 400, 1), reg(a.pool, 300), unreg(b.pool, 300, 1)]
    const manifest = manifestWith([])
    await discover(depsFor(manifest))
    expect(store.rowsMap.get(a.pool)).toMatchObject({ valid: false })
    expect(store.rowsMap.get(b.pool)).toMatchObject({ valid: true })
  })

  it("a factory market not yet registered is flagged, then appears once the Router lists it", async () => {
    const c = chain.deploy(20, { register: false })
    const manifest = manifestWith([])
    chain.events = [mktNew(c.pool, c.recoveryEscrow, 300)]
    await discover(depsFor(manifest))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ source: "discovered", valid: false, reason: expect.stringMatching(/Router/) })
    expect(await resolvedMarkets({ store, manifest })).toEqual([])

    chain.registered.add(c.pool)
    await revalidate(depsFor(manifest))
    expect((await resolvedMarkets({ store, manifest })).map((m) => m.contracts.pool)).toEqual([c.pool])
  })

  it("seed markets are validated the same way", async () => {
    const seedC = chain.deploy(10)
    chain.wasm.set(seedC.manager, hash(98))
    const seed = seedMarket(seedC)
    const manifest = manifestWith([seed])
    // Before any check the seed is listed (the manifest is the trust anchor; R2-36).
    expect(await resolvedMarkets({ store, manifest })).toEqual([seed])

    await revalidate(depsFor(manifest))
    expect(store.rowsMap.get(seedC.pool)).toMatchObject({ source: "seed", valid: false, reason: expect.stringContaining(seedC.manager) })
    expect(await resolvedMarkets({ store, manifest })).toEqual([])

    // With the database down, pages fall back to the manifest seeds.
    store.fail = new Error("connect ECONNREFUSED")
    expect(await resolvedMarkets({ store, manifest })).toEqual([seed])
  })

  it("the RPC detail of a definite refusal is logged server-side, never stored (R2-41)", async () => {
    const c = chain.deploy(10)
    chain.views.delete(`${c.yt}.recovery_escrow`)
    const seed = seedMarket(c)
    await revalidate(depsFor(manifestWith([seed])))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: false, reason: expect.stringMatching(/yt recovery_escrow was refused by the contract/) })
    expect(String(store.rowsMap.get(c.pool)?.reason)).not.toMatch(/MissingValue/)
    expect(JSON.stringify(error.mock.calls)).toMatch(/MissingValue/)
  })

  it("a seed whose check could not finish stays listed (an RPC hiccup is not a verdict)", async () => {
    const seedC = chain.deploy(10)
    const seed = seedMarket(seedC)
    chain.down.add(seedC.config)
    const manifest = manifestWith([seed])
    await revalidate(depsFor(manifest))
    expect(store.rowsMap.get(seedC.pool)).toMatchObject({ valid: null, reason: expect.stringMatching(/could not be checked/) })
    expect(await resolvedMarkets({ store, manifest })).toEqual([seed])
  })

  it("an unreadable re-check keeps a valid market listed", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    chain.events = [reg(c.pool, 300)]
    await discover(depsFor(manifest))
    chain.down.add(c.sy)
    await revalidate(depsFor(manifest))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true, reason: expect.stringMatching(/could not be checked/) })
    expect(await resolvedMarkets({ store, manifest })).toHaveLength(1)
  })

  it("resumes from the stored cursor: an event is processed once", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    chain.events = [reg(c.pool, 300)]
    const first = await discover(depsFor(manifest))
    expect(first.checked).toEqual([c.pool])
    const second = await discover(depsFor(manifest))
    expect(second.checked).toEqual([])
    expect(chain.getEventsCalls.at(-1)).toMatchObject({ cursor: tipCursor(1_000) })
    expect(second.gap).toBe(false)
  })

  it("a cursor older than the RPC's retention restarts from the oldest ledger and reports a gap", async () => {
    const manifest = manifestWith([])
    await discover(depsFor(manifest))
    chain.oldestLedger = 5_000
    chain.latestLedger = 6_000
    const c = chain.deploy(20)
    chain.events = [reg(c.pool, 5_500)]
    const result = await discover(depsFor(manifest))
    expect(result.gap).toBe(true)
    expect(result.checked).toEqual([c.pool])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/gap/i)
    const restart = chain.getEventsCalls.at(-1) as { startLedger?: number }
    expect(restart.startLedger).toBeGreaterThanOrEqual(5_000)
  })

  it("a first scan refused with dRPC's first available state starts again there, and a window read through getLedgers works", async () => {
    const c = chain.deploy(20)
    chain.events = [reg(c.pool, 300)]
    // The window says 100 (a few ledgers older than the events state); getEvents refuses below 110 and names it.
    const getEvents = chain.rpc.getEvents
    chain.rpc.getEvents = async (req) => {
      if (req.startLedger !== undefined && req.startLedger < 110) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: { status: 400, data: { error: { code: 27, message: "Unknown state. First available state is 110" } } },
        })
      }
      return getEvents(req)
    }
    const noHealth = {
      ...chain.rpc,
      getHealth: async () => {
        throw Object.assign(new Error("Request failed with status code 400"), { response: { status: 400 } })
      },
      getLatestLedger: async () => ({ sequence: 1_000 }),
      getLedgers: async () => ({ oldestLedger: 100, latestLedger: 1_000 }),
    }
    const result = await discover({ ...depsFor(manifestWith([])), rpc: noHealth })
    expect(result.checked).toEqual([c.pool])
    expect(chain.getEventsCalls.map((r) => (r as { startLedger?: number }).startLedger)).toEqual([100, 110])
  })

  it("a scan past its deadline stops between pools, saves its place, and the next run resumes there", async () => {
    const a = chain.deploy(20)
    const b = chain.deploy(30)
    const c = chain.deploy(40)
    chain.events = [reg(a.pool, 300), reg(b.pool, 301), reg(c.pool, 302)]
    const manifest = manifestWith([])
    // The clock is read before each getEvents page and before each pool: page, a, b, then c is late.
    const times = [0, 0, 0, 100]
    const first = await discover({ ...depsFor(manifest), now: () => times.shift() ?? 100 }, { deadline: 50 })
    expect(first).toMatchObject({ checked: [a.pool, b.pool], complete: false })
    expect(store.cursors.get(`markets:${SHARED.router}`)).toEqual({ ledger: 301, cursor: eventId(301) })
    expect(await resolvedMarkets({ store, manifest })).toHaveLength(2)

    const second = await discover(depsFor(manifest))
    expect(second).toMatchObject({ checked: [c.pool], complete: true })
    expect(chain.getEventsCalls.at(-1)).toMatchObject({ cursor: eventId(301) })
    expect(await resolvedMarkets({ store, manifest })).toHaveLength(3)
  })

  it("a factory pool the Router does not list costs one read, not a full check", async () => {
    const c = chain.deploy(20, { register: false })
    chain.events = [mktNew(c.pool, c.recoveryEscrow, 300)]
    chain.reads = []
    await discover(depsFor(manifestWith([])))
    expect(chain.reads).toEqual([`${SHARED.router}.is_registered`])
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: false, reason: expect.stringMatching(/not registered with the Router/) })
  })

  it("invalid rows are not re-validated every run: a small batch, oldest first, after the listed ones", async () => {
    const manifest = manifestWith([])
    const good = chain.deploy(20)
    chain.events = [reg(good.pool, 300)]
    await discover(depsFor(manifest))
    const junk = [50, 60, 70, 80, 90].map((n) => chain.deploy(n, { register: false }).pool)
    for (const pool of junk) await store.record({ pool, source: "discovered", valid: false, reason: "the pool is not registered with the Router", market: null })

    const run1 = await revalidate(depsFor(manifest))
    expect(run1.checked).toEqual([good.pool, junk[0], junk[1]])
    const run2 = await revalidate(depsFor(manifest))
    expect(run2.checked).toEqual([good.pool, junk[2], junk[3]])
  })

  it("rows left by another Router, or on an oracle the manifest does not name, are never re-checked", async () => {
    const manifest = manifestWith([])
    const old = { ...seedMarket(contractsOf(30)), marketId: "local-usdy-old", contracts: { ...seedMarket(contractsOf(30)).contracts, router: cid(90) } }
    const stranger = { ...seedMarket(contractsOf(40), STRANGER_ORACLE), marketId: "local-usdy-stranger" }
    for (const m of [old, stranger]) {
      store.rowsMap.set(m.contracts.pool, { pool: m.contracts.pool, source: "discovered", valid: true, reason: null, market: m, marketId: m.marketId, updatedAt: null })
    }
    expect((await revalidate(depsFor(manifest))).checked).toEqual([])
  })

  it("a database that does not answer falls back to the seeds within the timeout", async () => {
    const seed = seedMarket(chain.deploy(10))
    const hanging: RegistryStore = { ...store, rows: () => new Promise(() => {}) }
    const started = Date.now()
    expect(await resolvedMarkets({ store: hanging, manifest: manifestWith([seed]), timeoutMs: 30 })).toEqual([seed])
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/timed out/)
  })

  it("a listed market carries the manifest's current pins, never the stored ones (R2-40, R29b)", async () => {
    const manifest = manifestWith([])
    const stored = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-x", wasmHashes: { ...PINS, pool: hash(55), router: hash(56) } }
    store.rowsMap.set(stored.contracts.pool, { pool: stored.contracts.pool, source: "discovered", valid: true, reason: null, market: stored, marketId: stored.marketId, updatedAt: null })
    const [listed] = await resolvedMarkets({ store, manifest })
    expect(listed.wasmHashes).toEqual(PINS)
  })

  it("resolvedMarkets drops rows from another Router or an oracle the manifest does not name, and rows whose market does not parse", async () => {
    const seedB = { ...seedMarket(contractsOf(80), ORACLE_B), marketId: "local-usdy-seed-b" }
    const manifest = manifestWith([seedB])
    const good = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-good" }
    const stale = { ...seedMarket(contractsOf(30)), marketId: "local-usdy-stale", contracts: { ...seedMarket(contractsOf(30)).contracts, router: cid(90) } }
    const broken = { ...seedMarket(contractsOf(40)), marketId: "" }
    const stranger = { ...seedMarket(contractsOf(50), STRANGER_ORACLE), marketId: "local-usdy-stranger" }
    // On an oracle the manifest names, though not shared.oracle: kept.
    const onB = { ...seedMarket(contractsOf(60), ORACLE_B), marketId: "local-usdy-on-b" }
    for (const m of [good, stale, broken, stranger, onB]) {
      store.rowsMap.set(m.contracts.pool, { pool: m.contracts.pool, source: "discovered", valid: true, reason: null, market: m, marketId: m.marketId, updatedAt: null })
    }
    expect((await resolvedMarkets({ store, manifest })).map((m) => m.marketId)).toEqual(["local-usdy-seed-b", "local-usdy-good", "local-usdy-on-b"])
  })

  describe("seeds only on Mainnet", () => {
    const seed = seedMarket(contractsOf(10))
    const discovered = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-discovered" }
    const on = (network: "mainnet" | "testnet") => manifestWith([seed], { network, networkPassphrase: PASSPHRASES[network] })
    beforeEach(() => {
      store.rowsMap.set(discovered.contracts.pool, { pool: discovered.contracts.pool, source: "discovered", valid: true, reason: null, market: discovered, marketId: discovered.marketId, updatedAt: null })
    })

    it("on mainnet a valid discovered market is not listed", async () => {
      const listed = await listedMarkets({ store, manifest: on("mainnet") })
      expect(listed.markets.map((m) => m.marketId)).toEqual([seed.marketId])
      // The registry did answer (the seeds' verdicts): the indexer's market groups still run.
      expect(listed.fromRegistry).toBe(true)
    })

    it("on mainnet a seed the registry marked invalid stays hidden", async () => {
      await store.record({ pool: seed.contracts.pool, source: "seed", valid: false, reason: "its PT is not wired to the manager", market: seed })
      expect((await listedMarkets({ store, manifest: on("mainnet") })).markets).toEqual([])
    })

    it("on testnet it is", async () => {
      const listed = await listedMarkets({ store, manifest: on("testnet") })
      expect(listed.markets.map((m) => m.marketId)).toEqual([seed.marketId, discovered.marketId])
    })
  })

  it("on a Mainnet-shaped manifest, discovery stores a market on a stranger's oracle as invalid with the oracle reason, and nothing shows it", async () => {
    const onMainnet = (c: Contracts, oracle: string, marketId: string): Market => {
      const m = seedMarket(c, oracle)
      return { ...m, marketId, displayName: "USDY", underlying: { ...m.underlying, sac: MAINNET_SAC } }
    }
    // Two markets, each on its own oracle, as on Mainnet.
    const a = onMainnet(chain.deploy(10, { sac: MAINNET_SAC }), SHARED.oracle, "mainnet-a")
    const b = onMainnet(chain.deploy(20, { oracle: ORACLE_B, sac: MAINNET_SAC }), ORACLE_B, "mainnet-b")
    const manifest = manifestWith([a, b], { network: "mainnet", networkPassphrase: PASSPHRASES.mainnet, testAsset: undefined })
    // Built with the permissionless factory, wired end to end to its own oracle; even registered with the Router.
    const stranger = chain.deploy(30, { oracle: STRANGER_ORACLE, sac: MAINNET_SAC })
    chain.events = [reg(stranger.pool, 300)]

    expect((await discover(depsFor(manifest))).checked).toEqual([stranger.pool])
    const row = store.rowsMap.get(stranger.pool)
    expect(row).toMatchObject({ source: "discovered", valid: false })
    // The oracle is the only problem: the rest of the market checks out on Mainnet.
    expect(row?.reason).toBe(`its oracle (${STRANGER_ORACLE}) is not one of this network's oracles`)
    expect((row?.market as Market).contracts.oracle).toBe(STRANGER_ORACLE)

    expect((await listedMarkets({ store, manifest })).markets.map((m) => m.marketId)).toEqual(["mainnet-a", "mainnet-b"])
    expect(await invalidMarkets({ store, manifest })).toEqual({ status: "ok", rows: [] })
    // The seeds themselves pass under the same manifest.
    expect(await validateMarket(chain.reader, chain.rpc, manifest, b)).toEqual({ valid: true })
  })
})

// ---------------------------------------------------------------- publish (POST /api/markets)

/** The seven contracts `salt` gives on the manifest's factory. */
function saltContracts(manifest: Manifest, salt: Buffer): Contracts {
  const d = deriveMarketContracts(manifest, hex(salt))
  return { sy: d.sy, pt: d.pt, yt: d.yt, config: d.config, manager: d.manager, pool: d.pool, recoveryEscrow: d.recoveryEscrow }
}

describe("half-finished markets by salt (spec 0002 §5 \"Resuming\"): the factory's mkt_tok, mkt_eng and mkt_new", () => {
  const OTHER_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey()
  const FOREIGN_SAC = new Asset("SPAM", OTHER_ISSUER).contractId(PASSPHRASES.local)
  /**
   * What `create_tokens` leaves at the salt's predicted SY address: a contract running `wasm` (the
   * factory deploys whatever hashes its caller passes) whose `underlying_address` answers `underlying`.
   */
  function tokensAt(manifest: Manifest, salt: Buffer, opts: { underlying?: string; wasm?: string } = {}) {
    const sy = deriveMarketContracts(manifest, hex(salt)).sy
    chain.wasm.set(sy, opts.wasm ?? PINS.sy)
    chain.views.set(`${sy}.underlying_address`, opts.underlying ?? SAC)
    return sy
  }

  it("indexes each salt the factory names, at the furthest phase seen, once its SY runs the pinned code on this network's asset", async () => {
    const manifest = manifestWith([])
    const sy1 = tokensAt(manifest, saltOf(1))
    const sy2 = tokensAt(manifest, saltOf(2))
    chain.events = [mktTok(saltOf(1), sy1, 300), mktEng(saltOf(1), cid(64), 301), mktTok(saltOf(2), sy2, 302), mktTok(saltOf(1), sy1, 299, 1)]
    const result = await discover(depsFor(manifest))
    expect(result.checked).toEqual([])
    // One read per salt, on the SY the salt gives: the event's own addresses are not trusted.
    expect(chain.reads.sort()).toEqual([`${sy1}.underlying_address`, `${sy2}.underlying_address`].sort())
    expect([...store.saltsMap.values()]).toEqual([
      { factory: SHARED.factory, salt: hex(saltOf(1)), underlying: SAC, phase: "engine", ledger: 301 },
      { factory: SHARED.factory, salt: hex(saltOf(2)), underlying: SAC, phase: "tokens", ledger: 302 },
    ])
  })

  it("mkt_new indexes its salt too, and its pool is still checked", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    tokensAt(manifest, saltOf(3))
    chain.events = [mktNew(c.pool, c.recoveryEscrow, 300, saltOf(3))]
    const result = await discover(depsFor(manifest))
    expect(result.checked).toEqual([c.pool])
    expect(store.saltsMap.get(`${SHARED.factory}:${hex(saltOf(3))}`)).toMatchObject({ phase: "pool", ledger: 300, underlying: SAC })
  })

  it("never trusts an event beyond what the chain confirms: another asset, unpinned SY code, no SY at all, another contract or another shape index nothing", async () => {
    const manifest = manifestWith([])
    // Anyone who issues an asset can call create_tokens on it, with Wasm of their own choosing.
    const foreign = tokensAt(manifest, saltOf(10), { underlying: FOREIGN_SAC })
    const lying = tokensAt(manifest, saltOf(11), { wasm: hash(99) }) // claims this network's asset, runs other code
    chain.events = [
      mktTok(saltOf(10), foreign, 300),
      mktTok(saltOf(11), lying, 301),
      mktTok(saltOf(12), cid(60), 302), // nothing deployed at the salt's SY address
      mktTok(saltOf(4), cid(60), 303, 0, cid(99)),
      ev(SHARED.factory, "mkt_tok", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(31, 1)), addr(cid(60))]), 304),
      ev(SHARED.factory, "mkt_eng", addr(cid(60)), 305),
    ]
    await discover(depsFor(manifest))
    expect(store.saltsMap.size).toBe(0)
    // Unpinned code is refused from its ledger entry, before any call into it.
    expect(chain.reads).not.toContain(`${lying}.underlying_address`)
  })

  it("an SY that cannot be read is not indexed, and discovery goes on", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    const sy = tokensAt(manifest, saltOf(13))
    chain.views.set(`${sy}.underlying_address`, () => {
      throw new Error("fetch failed: ECONNRESET")
    })
    chain.events = [mktTok(saltOf(13), sy, 290), reg(c.pool, 300)]
    expect(await discover(depsFor(manifest))).toMatchObject({ checked: [c.pool], complete: true })
    expect(store.saltsMap.size).toBe(0)
  })

  it("a salt that cannot be written never stops discovery: the market is still checked and the cursor moves on", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    const sy = tokensAt(manifest, saltOf(5))
    store.failSalts = Object.assign(new Error('relation "market_salts" does not exist'), { code: "42P01" })
    chain.events = [mktTok(saltOf(5), sy, 290), reg(c.pool, 300)]
    const result = await discover(depsFor(manifest))
    expect(result).toMatchObject({ checked: [c.pool], complete: true })
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(JSON.stringify(error.mock.calls)).toMatch(/42P01/)
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/does not exist/)
  })

  it("many salts on a foreign asset never push this network's market out of the list (the DoS the cap allowed)", async () => {
    const manifest = manifestWith([])
    const legit = saltOf(20)
    chain.events = [mktTok(legit, tokensAt(manifest, legit), 300)]
    for (let i = 0; i < 60; i++) {
      const spam = Buffer.alloc(32, 0)
      spam.writeUInt32BE(i + 1, 0)
      spam[31] = 0xee
      chain.events.push(mktTok(spam, tokensAt(manifest, spam, { underlying: FOREIGN_SAC }), 400 + i))
    }
    await discover(depsFor(manifest))
    expect([...store.saltsMap.values()].map((r) => r.salt)).toEqual([hex(legit)])
    expect(await resumableSalts({ store, manifest })).toEqual({ status: "ok", salts: [{ salt: hex(legit), underlying: SAC }] })
  })

  describe("on Mainnet, only the manifest's markets count (Testnet unchanged)", () => {
    const X_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10)).publicKey()
    const SAC_X = new Asset("EURX", X_ISSUER).contractId(PASSPHRASES.local)
    const seed = seedMarket(contractsOf(10))
    /** A valid registry market that is not in the manifest, on an asset no manifest market uses. */
    const onX: Market = { ...seedMarket(contractsOf(40)), marketId: "local-eurx", underlying: { code: "EURX", issuer: X_ISSUER, sac: SAC_X, decimals: 7 } }
    const on = (network: "mainnet" | "testnet") => manifestWith([seed], { network, networkPassphrase: PASSPHRASES[network], testAsset: undefined })
    const storeRow = (m: Market) =>
      store.rowsMap.set(m.contracts.pool, { pool: m.contracts.pool, source: "discovered", valid: true, reason: null, market: m, marketId: m.marketId, updatedAt: null })

    /** The salts discovery indexes from two mkt_tok: one on the seed's asset, one on the registry market's. */
    async function indexed(network: "mainnet" | "testnet") {
      const manifest = on(network)
      storeRow(onX)
      chain.events = [mktTok(saltOf(30), tokensAt(manifest, saltOf(30), { underlying: SAC_X }), 300), mktTok(saltOf(31), tokensAt(manifest, saltOf(31)), 301)]
      await discover(depsFor(manifest))
      return [...store.saltsMap.values()].map((r) => r.salt)
    }

    it("discovery indexes salts on a registry market's asset on testnet", async () => {
      expect(await indexed("testnet")).toEqual([hex(saltOf(30)), hex(saltOf(31))])
    })

    it("on mainnet it indexes salts on the manifest's assets only", async () => {
      expect(await indexed("mainnet")).toEqual([hex(saltOf(31))])
    })

    /** resumableSalts over three salts: open on the seed's asset, one whose pool is a valid registry market, one on that market's asset. */
    async function resumable(network: "mainnet" | "testnet") {
      const manifest = on(network)
      storeRow(onX)
      const finished = deriveMarketContracts(manifest, hex(saltOf(33))).pool
      storeRow({ ...seedMarket(contractsOf(80)), marketId: "local-usdy-finished", contracts: { ...seedMarket(contractsOf(80)).contracts, pool: finished } })
      const salt = (n: number, underlying: string, ledger: number) =>
        store.recordSalt({ factory: SHARED.factory, salt: hex(saltOf(n)), underlying, phase: "tokens", ledger })
      await salt(32, SAC, 320)
      await salt(33, SAC, 330)
      await salt(34, SAC_X, 340)
      const r = await resumableSalts({ store, manifest })
      if (r.status !== "ok") throw new Error("unavailable")
      return r.salts.map((x) => x.salt)
    }

    it("resumableSalts on testnet leaves out a listed registry market's pool and keeps its asset", async () => {
      expect(await resumable("testnet")).toEqual([hex(saltOf(34)), hex(saltOf(32))])
    })

    it("on mainnet a registry market is not listed, so its salt is not done, and its asset is not this network's", async () => {
      // Only the manifest lists a market on Mainnet: one the factory finished is still to be added there.
      expect(await resumable("mainnet")).toEqual([hex(saltOf(33)), hex(saltOf(32))])
    })
  })

  it("resumableSalts lists this factory's salts newest first, capped per asset, leaving out listed pools and assets this network does not list", async () => {
    const B_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey()
    const SAC_B = new Asset("EURB", B_ISSUER).contractId(PASSPHRASES.local)
    const onB: Market = { ...seedMarket(contractsOf(90)), marketId: "local-eurb", underlying: { code: "EURB", issuer: B_ISSUER, sac: SAC_B, decimals: 7 } }
    const manifest = manifestWith([onB])
    const done = saltOf(6)
    const donePool = deriveMarketContracts(manifest, hex(done)).pool
    const row = (salt: string, underlying: string, ledger: number, factory = SHARED.factory) => store.recordSalt({ factory, salt, underlying, phase: "tokens", ledger })
    await row(hex(saltOf(7)), SAC, 300)
    await row(hex(done), SAC, 310)
    await row(hex(saltOf(8)), SAC_B, 320)
    await row(hex(saltOf(9)), SAC, 330, cid(77))
    // Rows from before a manifest change: an asset this network no longer lists is not shown.
    await row(hex(saltOf(14)), FOREIGN_SAC, 340)
    // One asset's issuer filling the list caps only its own share.
    for (let i = 0; i < 25; i++) await row(`${(i + 1).toString(16).padStart(2, "0")}${"ab".repeat(31)}`, SAC, 500 + i)
    await store.record({ pool: donePool, source: "published", valid: true, reason: null, market: { ...seedMarket(contractsOf(80)), contracts: { ...seedMarket(contractsOf(80)).contracts, pool: donePool } } })

    const r = await resumableSalts({ store, manifest })
    if (r.status !== "ok") throw new Error("unavailable")
    // Each salt comes with its asset, so the manager view reads one admin() per asset.
    expect(r.salts.find((x) => x.salt === hex(saltOf(8)))).toEqual({ salt: hex(saltOf(8)), underlying: SAC_B })
    const salts = r.salts.map((x) => x.salt)
    const onSac = salts.filter((s) => s.endsWith("ab".repeat(31)) || s === hex(saltOf(7)))
    expect(onSac).toHaveLength(MAX_RESUMABLE)
    expect(salts).toContain(hex(saltOf(8)))
    expect(salts).not.toContain(hex(done))
    expect(salts).not.toContain(hex(saltOf(9)))
    expect(salts).not.toContain(hex(saltOf(14)))
    expect(salts[0]).toBe(`19${"ab".repeat(31)}`)
  })

  /** A market the factory builds from `salt`: its seven contracts at the addresses the salt gives, wired and pinned. */
  function builtFrom(manifest: Manifest, salt: Buffer, opts: { register?: boolean } = {}): Contracts {
    return chain.deploy(0, { ...opts, contracts: saltContracts(manifest, salt) })
  }
  /** The factory's three events for `salt`, at `at`, `at + 5` and `at + 10`. */
  const build = (salt: ReturnType<typeof saltOf>, c: Contracts, at: number) => [mktTok(salt, c.sy, at), mktEng(salt, c.manager, at + 5), mktNew(c.pool, c.recoveryEscrow, at + 10, salt)]
  const createdOf = (pool: string) => (store.rowsMap.get(pool)?.market as Market | null | undefined)?.createdLedger

  it("a market built and registered in one page keeps its first factory event's ledger (mkt_tok) as createdLedger (I-1)", async () => {
    const manifest = manifestWith([])
    const c = builtFrom(manifest, saltOf(30))
    chain.events = [...build(saltOf(30), c, 290), reg(c.pool, 305)]
    expect((await discover(depsFor(manifest))).checked).toEqual([c.pool])
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(createdOf(c.pool)).toBe(290)
    // The list carries it to the indexer.
    expect((await resolvedMarkets({ store, manifest })).find((m) => m.contracts.pool === c.pool)?.createdLedger).toBe(290)
  })

  it("a market registered in a later run than its build takes the salt index's ledger (its mkt_new), never mkt_reg's (I-1)", async () => {
    const manifest = manifestWith([])
    const c = builtFrom(manifest, saltOf(31), { register: false })
    chain.events = build(saltOf(31), c, 290)
    await discover(depsFor(manifest))
    // Not registered yet: invalid, no market stored to carry a ledger.
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: false })
    chain.registered.add(c.pool)
    // A later run: the chain has moved on past the first run's cursor.
    chain.latestLedger = 1_100
    chain.events = [...chain.events, reg(c.pool, 1_050)]
    await discover(depsFor(manifest))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(createdOf(c.pool)).toBe(300)
  })

  it("a later event naming the pool keeps the earlier createdLedger; re-validation keeps it too", async () => {
    const manifest = manifestWith([])
    const c = builtFrom(manifest, saltOf(32))
    chain.events = [...build(saltOf(32), c, 290), reg(c.pool, 305)]
    await discover(depsFor(manifest))
    chain.latestLedger = 1_100
    chain.events = [...chain.events, unreg(c.pool, 1_040)]
    await discover(depsFor(manifest))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: false })
    chain.latestLedger = 1_200
    chain.events = [...chain.events, reg(c.pool, 1_150)]
    await discover(depsFor(manifest))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(createdOf(c.pool)).toBe(290)
    await revalidate(depsFor(manifest))
    expect(createdOf(c.pool)).toBe(290)
  })

  it("a seed never takes a createdLedger: the indexer reads the seeds from deployLedger", async () => {
    const probe = manifestWith([])
    const c = builtFrom(probe, saltOf(33))
    const manifest = manifestWith([seedMarket(c)])
    chain.events = [...build(saltOf(33), c, 290), reg(c.pool, 305)]
    await discover(depsFor(manifest))
    expect(createdOf(c.pool)).toBeUndefined()
    expect((await resolvedMarkets({ store, manifest }))[0].createdLedger).toBeUndefined()
  })

  it("a market discovery never saw built (registered only) gets no createdLedger: the indexer keeps its old start", async () => {
    const c = chain.deploy(40)
    chain.events = [reg(c.pool, 305)]
    await discover(depsFor(manifestWith([])))
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(createdOf(c.pool)).toBeUndefined()
  })

  it("a salt index that cannot be read leaves the market without one, logged by its code; discovery goes on", async () => {
    const manifest = manifestWith([])
    const c = builtFrom(manifest, saltOf(34), { register: false })
    chain.events = build(saltOf(34), c, 290)
    await discover(depsFor(manifest))
    chain.registered.add(c.pool)
    // A later run: the chain has moved on past the first run's cursor.
    chain.latestLedger = 1_100
    chain.events = [...chain.events, reg(c.pool, 1_050)]
    const salts = store.salts
    store.salts = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5"), { code: "ECONNREFUSED" })
    }
    await discover(depsFor(manifest))
    store.salts = salts
    expect(store.rowsMap.get(c.pool)).toMatchObject({ valid: true })
    expect(createdOf(c.pool)).toBeUndefined()
    expect(JSON.stringify(error.mock.calls)).toMatch(/ECONNREFUSED/)
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/10\.0\.0\.5/)
  })

  it("resumableSalts says it is unavailable when the registry cannot be read, and lists nothing without a factory", async () => {
    store.fail = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    expect(await resumableSalts({ store, manifest: manifestWith([]) })).toEqual({ status: "unavailable" })
    store.fail = undefined
    expect(await resumableSalts({ store, manifest: manifestWith([], { shared: { ...SHARED, factory: undefined } }) })).toEqual({ status: "ok", salts: [] })
  })
})

describe("publishMarket", () => {
  it("POST validates before writing: an invalid pool writes nothing", async () => {
    const c = chain.deploy(20)
    chain.wasm.set(c.pool, hash(97))
    const result = await publishMarket(depsFor(manifestWith([])), c.pool)
    expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining(c.pool) })
    expect(store.writes).toBe(0)
  })

  it("an unverifiable pool writes nothing either", async () => {
    const c = chain.deploy(20)
    chain.down.add(c.pt)
    expect(await publishMarket(depsFor(manifestWith([])), c.pool)).toMatchObject({ status: "unreadable" })
    expect(store.writes).toBe(0)
  })

  it("a valid pool is stored as published and resolves at once", async () => {
    const c = chain.deploy(20)
    const manifest = manifestWith([])
    const result = await publishMarket(depsFor(manifest), c.pool)
    expect(result).toMatchObject({ status: "valid", market: { contracts: { pool: c.pool } } })
    expect(store.rowsMap.get(c.pool)).toMatchObject({ source: "published", valid: true })
    expect((await resolvedMarkets({ store, manifest })).map((m) => m.contracts.pool)).toEqual([c.pool])
    // Nothing in the salt index names it: no creation ledger (the indexer keeps its old start).
    expect((store.rowsMap.get(c.pool)?.market as Market).createdLedger).toBeUndefined()
  })

  it("a published market whose build is in the salt index takes that ledger as createdLedger (I-1)", async () => {
    const manifest = manifestWith([])
    const salt = Buffer.alloc(32, 41)
    const c = chain.deploy(0, { contracts: saltContracts(manifest, salt) })
    await store.recordSalt({ factory: SHARED.factory, salt: hex(salt), underlying: SAC, phase: "pool", ledger: 300 })
    const result = await publishMarket(depsFor(manifest), c.pool)
    expect(result).toMatchObject({ status: "valid", market: { createdLedger: 300 } })
    expect((store.rowsMap.get(c.pool)?.market as Market).createdLedger).toBe(300)
    expect((await resolvedMarkets({ store, manifest }))[0].createdLedger).toBe(300)
  })
})

// ---------------------------------------------------------------- the route

const routeMocks = vi.hoisted(() => ({ sql: vi.fn(), chain: null as unknown as { reader: unknown; rpc: unknown }, manifest: null as unknown }))
vi.mock("@/lib/server/db", () => ({ sql: routeMocks.sql, DatabaseConfigError: class DatabaseConfigError extends Error {} }))
vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => routeMocks.manifest,
  activeNetwork: () => (routeMocks.manifest as Manifest).network,
}))
vi.mock("@/lib/protocol/reader", async (orig) => ({ ...(await orig<object>()), createRpcReader: () => routeMocks.chain.reader }))
vi.mock("@/lib/protocol/stellar", async (orig) => ({ ...(await orig<object>()), createRpcServer: () => routeMocks.chain.rpc }))
vi.mock("next/server", () => ({ connection: async () => {} }))

import { GET, POST } from "@/app/api/markets/route"
import { resetPublishLimitsForTests } from "@/lib/server/registry"
import type { Sql } from "@/lib/server/db"

describe("POST /api/markets", () => {
  const post = (body: unknown, ip = "203.0.113.7") =>
    POST(
      new Request("http://localhost/api/markets", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-vercel-forwarded-for": ip },
      }),
    )

  beforeEach(() => {
    resetPublishLimitsForTests()
    routeMocks.chain = chain
    routeMocks.manifest = manifestWith([])
    routeMocks.sql.mockReset()
    routeMocks.sql.mockResolvedValue([])
  })

  const writes = () => routeMocks.sql.mock.calls.filter(([strings]) => /^\s*(insert|update|delete)\b/i.test((strings as string[]).join("")))

  it("POST validates before writing: an invalid pool is refused (422) and nothing is written", async () => {
    const c = chain.deploy(20)
    chain.views.set(`${c.manager}.oracle_address`, cid(66))
    const res = await post({ pool: c.pool })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: "invalid_market", reason: expect.stringMatching(/oracle/i) })
    expect(writes()).toEqual([])
  })

  it("a 422 logs the RPC detail of a refused view server-side and answers in this app's words (R2-41)", async () => {
    const c = chain.deploy(20)
    chain.views.delete(`${c.yt}.recovery_escrow`)
    const res = await post({ pool: c.pool })
    expect(res.status).toBe(422)
    const text = await res.text()
    expect(text).toMatch(/yt recovery_escrow was refused by the contract/)
    expect(text).not.toMatch(/MissingValue|HostError/)
    expect(JSON.stringify(error.mock.calls)).toMatch(/MissingValue/)
  })

  it("a valid pool is stored as published", async () => {
    const c = chain.deploy(20)
    const res = await post({ pool: c.pool })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ market: { contracts: { pool: c.pool } } })
    const [insert] = writes()
    expect((insert[0] as string[]).join("?")).toMatch(/insert into market_registry/)
    expect(insert.slice(1)).toContain("published")
  })

  it("an unverifiable pool answers 503 with a fixed reason; the RPC detail goes to the server log only (R2-40)", async () => {
    const c = chain.deploy(20)
    chain.down.add(c.yt)
    const res = await post({ pool: c.pool })
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error: "unverified", reason: "The market could not be checked right now; try again later." })
    expect(text).not.toMatch(/ECONNRESET|fetch failed/)
    expect(JSON.stringify(error.mock.calls)).toMatch(/ECONNRESET/)
    expect(writes()).toEqual([])
  })

  it("a body that is not { pool: C… } is refused before any read", async () => {
    const reads = vi.spyOn(chain, "reader")
    expect((await post({ pool: "nope" })).status).toBe(400)
    expect((await post({ account: cid(20) })).status).toBe(400)
    expect(reads).not.toHaveBeenCalled()
  })

  it("POST is rate-limited per IP", async () => {
    const c = chain.deploy(20)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await post({ pool: c.pool })).status)
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    const limited = await post({ pool: c.pool })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
    // Another connection is not limited by this one.
    expect((await post({ pool: c.pool }, "198.51.100.9")).status).toBe(200)
  })

  it("on mainnet it answers 403 not_available before any read or write", async () => {
    routeMocks.manifest = manifestWith([], { network: "mainnet", networkPassphrase: PASSPHRASES.mainnet })
    const c = chain.deploy(20)
    chain.reads = []
    const res = await post({ pool: c.pool })
    expect(res.status).toBe(403)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "not_available", message: "Markets are created by the protocol team on Mainnet." })
    expect(chain.reads).toEqual([])
    expect(routeMocks.sql).not.toHaveBeenCalled()
  })

  it("a cross-site page cannot publish", async () => {
    const res = await POST(
      new Request("http://localhost/api/markets", {
        method: "POST",
        body: JSON.stringify({ pool: cid(25) }),
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe("GET /api/markets", () => {
  it("returns the seeds and the valid registry rows", async () => {
    const seed = seedMarket(chain.deploy(10))
    const extra = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-extra" }
    routeMocks.manifest = manifestWith([seed])
    routeMocks.sql.mockReset()
    routeMocks.sql.mockResolvedValue([
      { pool: extra.contracts.pool, market_id: extra.marketId, source: "discovered", valid: true, reason: null, market: extra },
    ])
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).markets.map((m: Market) => m.marketId)).toEqual([seed.marketId, "local-usdy-extra"])
  })

  it("is cached 60 s at the CDN when the registry answered (D-26 item 1)", async () => {
    routeMocks.manifest = manifestWith([seedMarket(chain.deploy(10))])
    routeMocks.sql.mockReset()
    routeMocks.sql.mockResolvedValue([])
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
  })

  it("falls back to the seeds when the database is down, and that answer is never cached", async () => {
    const seed = seedMarket(chain.deploy(10))
    routeMocks.manifest = manifestWith([seed])
    routeMocks.sql.mockReset()
    routeMocks.sql.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await res.json()).markets).toEqual([seed])
    expect(error).toHaveBeenCalled()
  })

  it("an error is 500 failed and never cached", async () => {
    // A manifest whose markets cannot be read: the route's own failure, not the database's.
    routeMocks.manifest = Object.defineProperty({ ...manifestWith([]) }, "markets", {
      get() {
        throw new Error("boom")
      },
    })
    const res = await GET()
    expect(res.status).toBe(500)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toMatchObject({ error: "failed" })
  })
})

describe("bounded registry reads (D-26 item 1)", () => {
  const sqlOf = () => routeMocks.sql as unknown as Sql
  const queries = () => routeMocks.sql.mock.calls.map(([strings, ...values]) => ({ text: (strings as string[]).join("?"), values }))
  const row = (m: Market, valid: boolean | null, source = "discovered") => ({
    pool: m.contracts.pool,
    market_id: m.marketId,
    source,
    valid,
    reason: valid === false ? "it did not pass" : null,
    market: m,
    updated_at: null,
  })

  beforeEach(() => {
    routeMocks.sql.mockReset()
    routeMocks.sql.mockResolvedValue([])
  })

  it("resolvedMarkets reads where valid is true, plus the seeds' own rows, never every row", async () => {
    const seed = seedMarket(chain.deploy(10))
    await resolvedMarkets({ store: sqlRegistryStore(sqlOf()), manifest: manifestWith([seed]) })
    const [read] = queries()
    expect(read.text).toMatch(/from market_registry\s+where valid is true or pool = any\(\?::text\[\]\)/)
    expect(read.values).toEqual([[seed.contracts.pool]])
  })

  it("a seed whose verdict is valid = false stays hidden under the bounded read", async () => {
    const seed = seedMarket(chain.deploy(10))
    const extra = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-extra" }
    routeMocks.sql.mockResolvedValue([row(seed, false, "seed"), row(extra, true)])
    const markets = await resolvedMarkets({ store: sqlRegistryStore(sqlOf()), manifest: manifestWith([seed]) })
    expect(markets.map((m) => m.marketId)).toEqual(["local-usdy-extra"])
  })

  it("the recorder's re-check, discovery, publishing and the manager view still read every row, invalid ones too", async () => {
    const manifest = manifestWith([seedMarket(chain.deploy(10))])
    const sqlStore = sqlRegistryStore(sqlOf())
    await revalidate({ store: sqlStore, reader: chain.reader, rpc: chain.rpc, manifest })
    await invalidMarkets({ store: sqlStore, manifest })
    const reads = queries().filter((q) => /from market_registry/.test(q.text))
    expect(reads.length).toBeGreaterThanOrEqual(2)
    for (const q of reads) expect(q.text).not.toMatch(/where valid/)
  })
})

describe("invalidMarkets (R2-38: the manager view lists them with their reason)", () => {
  it("lists rows with valid = false and their reason, a hidden seed too, and no listed or unknown row", async () => {
    const seed = seedMarket(chain.deploy(10))
    const manifest = manifestWith([seed])
    const gone = chain.deploy(20)
    const unknown = chain.deploy(30)
    const fine = chain.deploy(40)
    await store.record({ pool: seed.contracts.pool, source: "seed", valid: false, reason: "its PT is not wired to the manager", market: seed })
    await store.record({ pool: gone.pool, source: "discovered", valid: false, reason: "Unregistered from the Router.", market: null })
    await store.record({ pool: unknown.pool, source: "discovered", valid: null, reason: "could not be checked", market: null })
    await store.record({ pool: fine.pool, source: "discovered", valid: true, reason: null, market: null })

    const result = await invalidMarkets({ store, manifest })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.rows).toEqual([
      { pool: seed.contracts.pool, name: seed.displayName, reason: "its PT is not wired to the manager" },
      { pool: gone.pool, name: null, reason: "Unregistered from the Router." },
    ])
  })

  it("leaves out a row from another deployment (its stored market has another Router, or an oracle the manifest does not name)", async () => {
    const seed = seedMarket(chain.deploy(50))
    const seedB = { ...seedMarket(contractsOf(80), ORACLE_B), marketId: "local-usdy-seed-b" }
    const manifest = manifestWith([seed, seedB])
    const old = seedMarket(chain.deploy(60))
    const otherRouter = { ...old, contracts: { ...old.contracts, router: seedMarket(chain.deploy(70)).contracts.pool } }
    await store.record({ pool: old.contracts.pool, source: "seed", valid: false, reason: "matured and unpinned", market: otherRouter })
    const stranger = { ...seedMarket(contractsOf(20), STRANGER_ORACLE), displayName: "stranger" }
    await store.record({ pool: stranger.contracts.pool, source: "discovered", valid: false, reason: "its oracle is not one of this network's oracles", market: stranger })
    // On an oracle the manifest names, though not shared.oracle: this deployment's, so listed.
    const onB = { ...seedMarket(contractsOf(30), ORACLE_B), displayName: "on B" }
    await store.record({ pool: onB.contracts.pool, source: "discovered", valid: false, reason: "the pool is not registered with the Router", market: onB })
    const result = await invalidMarkets({ store, manifest })
    expect(result).toEqual({ status: "ok", rows: [{ pool: onB.contracts.pool, name: "on B", reason: "the pool is not registered with the Router" }] })
  })

  it("on mainnet lists the manifest's markets only: no stranger's row, whatever it stores (testnet unchanged)", async () => {
    const seed = seedMarket(contractsOf(10))
    const seedB = { ...seedMarket(contractsOf(80), ORACLE_B), marketId: "mainnet-b" }
    await store.record({ pool: seed.contracts.pool, source: "seed", valid: false, reason: "its PT is not wired to the manager", market: seed })
    // A factory market on one of the manifest's public oracles passes isForeign: the Router is set by marketFromPool itself.
    const onB = { ...seedMarket(contractsOf(30), ORACLE_B), displayName: "stranger on B" }
    await store.record({ pool: onB.contracts.pool, source: "discovered", valid: false, reason: "the pool is not registered with the Router", market: onB })
    // A pool stored without a market (one the Router never listed).
    const bare = contractsOf(50).pool
    await store.record({ pool: bare, source: "discovered", valid: false, reason: "the pool is not registered with the Router", market: null })
    const on = (network: "mainnet" | "testnet") => manifestWith([seed, seedB], { network, networkPassphrase: PASSPHRASES[network] })

    expect(await invalidMarkets({ store, manifest: on("mainnet") })).toEqual({
      status: "ok",
      rows: [{ pool: seed.contracts.pool, name: seed.displayName, reason: "its PT is not wired to the manager" }],
    })
    const testnet = await invalidMarkets({ store, manifest: on("testnet") })
    expect(testnet.status === "ok" && testnet.rows.map((r) => r.pool)).toEqual([seed.contracts.pool, onB.contracts.pool, bare])
  })

  it("says it is unavailable when the registry cannot be read, instead of an empty list", async () => {
    store.fail = new Error("connection refused at 10.0.0.1")
    vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await invalidMarkets({ store, manifest: manifestWith([]) })
    expect(result).toEqual({ status: "unavailable" })
  })
})
