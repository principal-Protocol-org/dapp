// @vitest-environment node
import { Address, Asset, Contract, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PASSPHRASES, V1_ROUTER_FUNCTIONS } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market, MarketContractName } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

// ---------------------------------------------------------------- a fake chain

const cid = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n))
const hash = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
const SAC = new Asset("USDY", ISSUER).contractId(PASSPHRASES.local)
const KINDS: MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]
const PINS = { sy: hash(1), pt: hash(2), yt: hash(3), config: hash(4), manager: hash(5), pool: hash(6), recoveryEscrow: hash(7) }
const SHARED = { router: cid(1), oracle: cid(2), permissioning: cid(3), riskControl: cid(4), factory: cid(5) }
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
    this.views.set(`${SAC}.name`, `USDY:${ISSUER}`)
    this.views.set(`${SAC}.decimals`, 7)
    this.views.set(`${SHARED.router}.is_registered`, (args: { value: unknown }[]) => this.registered.has(String(args[0].value)))
    this.views.set(`${SHARED.router}.market`, (args: { value: unknown }[]) => {
      const pool = String(args[0].value)
      if (!this.registered.has(pool)) throw new Error("HostError: Error(Contract, #2)")
      return this.info.get(pool)
    })
  }

  /** Deploys a fully wired market running the pinned code, registered with the Router. */
  deploy(n: number, opts: { register?: boolean; maturity?: number } = {}): Contracts {
    const c = contractsOf(n)
    const maturity = BigInt(opts.maturity ?? MATURITY)
    const set = (id: string, fn: string, v: Answer) => this.views.set(`${id}.${fn}`, v)
    set(c.pool, "config_address", c.config)
    set(c.pool, "recovery_escrow", c.recoveryEscrow)
    set(c.pool, "sy_address", c.sy)
    set(c.pool, "pt_address", c.pt)
    set(c.pool, "yt_address", c.yt)
    set(c.pool, "manager_address", c.manager)
    set(c.pool, "maturity", maturity)
    set(c.pool, "underlying_address", SAC)
    set(c.manager, "oracle_address", SHARED.oracle)
    set(c.manager, "permissioning_address", SHARED.permissioning)
    set(c.manager, "config_address", c.config)
    set(c.manager, "risk_control", SHARED.riskControl)
    set(c.manager, "maturity", maturity)
    set(c.sy, "underlying_address", SAC)
    set(c.sy, "permissioning_address", SHARED.permissioning)
    set(c.sy, "risk_control", SHARED.riskControl)
    set(c.sy, "recovery_escrow", c.recoveryEscrow)
    set(c.pt, "permissioning_address", SHARED.permissioning)
    set(c.pt, "recovery_escrow", c.recoveryEscrow)
    set(c.pt, "minter", c.manager)
    set(c.yt, "minter", c.manager)
    set(c.yt, "permissioning_address", SHARED.permissioning)
    set(c.yt, "oracle_address", SHARED.oracle)
    set(c.yt, "recovery_escrow", c.recoveryEscrow)
    set(c.config, "underlying", SAC)
    set(c.config, "maturity", maturity)
    set(c.recoveryEscrow, "underlying_address", SAC)
    for (const kind of KINDS) this.wasm.set(c[kind], PINS[kind])
    this.info.set(c.pool, { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: SAC })
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
const mktNew = (pool: string, escrow: string, ledger: number) =>
  ev(SHARED.factory, "mkt_new", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(32, 9)), addr(pool), addr(escrow)]), ledger)

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

function seedMarket(c: Contracts): Market {
  return {
    marketId: `local-usdy-${MATURITY}`,
    displayName: "USDY (test)",
    underlying: { code: "USDY", issuer: ISSUER, sac: SAC, decimals: 7 },
    maturity: MATURITY,
    contracts: { router: SHARED.router, oracle: SHARED.oracle, ...c },
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
  discover,
  invalidMarkets,
  marketFromPool,
  publishMarket,
  resolvedMarkets,
  revalidate,
  validateMarket,
  type RegistryRow,
  type RegistryStore,
} from "@/lib/server/registry"

/** In-memory `market_registry` and `ingest_cursor`, with the SQL store's upsert rules. */
function memoryStore() {
  const rows = new Map<string, RegistryRow>()
  const cursors = new Map<string, { ledger: number; cursor: string | null }>()
  let clock = 0
  const stamp = () => new Date(Date.UTC(2026, 9, 1) + ++clock * 1000).toISOString()
  const rank = { discovered: 0, published: 1, seed: 2 } as const
  const store: RegistryStore & { rowsMap: typeof rows; cursors: typeof cursors; writes: number; fail?: Error } = {
    rowsMap: rows,
    cursors,
    writes: 0,
    async rows() {
      if (store.fail) throw store.fail
      return [...rows.values()].map((r) => structuredClone(r))
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

  it("wrong wiring hides market: a market on another Router or oracle", async () => {
    const market = seedMarket(chain.deploy(10))
    const foreign = { ...market, contracts: { ...market.contracts, oracle: cid(79) } }
    const v = await validateMarket(chain.reader, chain.rpc, manifestWith([foreign]), foreign)
    expect(v.valid).toBe(false)
    expect(v.reason).toMatch(/oracle/i)
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

  it("rows left by another Router are never re-checked", async () => {
    const manifest = manifestWith([])
    const old = { ...seedMarket(contractsOf(30)), marketId: "local-usdy-old", contracts: { ...seedMarket(contractsOf(30)).contracts, router: cid(90) } }
    store.rowsMap.set(old.contracts.pool, { pool: old.contracts.pool, source: "discovered", valid: true, reason: null, market: old, marketId: old.marketId, updatedAt: null })
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

  it("resolvedMarkets drops rows from another Router or oracle, and rows whose market does not parse", async () => {
    const manifest = manifestWith([])
    const good = { ...seedMarket(contractsOf(20)), marketId: "local-usdy-good" }
    const stale = { ...seedMarket(contractsOf(30)), marketId: "local-usdy-stale", contracts: { ...seedMarket(contractsOf(30)).contracts, router: cid(90) } }
    const broken = { ...seedMarket(contractsOf(40)), marketId: "" }
    for (const m of [good, stale, broken]) {
      store.rowsMap.set(m.contracts.pool, { pool: m.contracts.pool, source: "discovered", valid: true, reason: null, market: m, marketId: m.marketId, updatedAt: null })
    }
    expect((await resolvedMarkets({ store, manifest })).map((m) => m.marketId)).toEqual(["local-usdy-good"])
  })
})

// ---------------------------------------------------------------- publish (POST /api/markets)

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
  })
})

// ---------------------------------------------------------------- the route

const routeMocks = vi.hoisted(() => ({ sql: vi.fn(), chain: null as unknown as { reader: unknown; rpc: unknown }, manifest: null as unknown }))
vi.mock("@/lib/server/db", () => ({ sql: routeMocks.sql, DatabaseConfigError: class DatabaseConfigError extends Error {} }))
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => routeMocks.manifest }))
vi.mock("@/lib/protocol/reader", async (orig) => ({ ...(await orig<object>()), createRpcReader: () => routeMocks.chain.reader }))
vi.mock("@/lib/protocol/stellar", async (orig) => ({ ...(await orig<object>()), createRpcServer: () => routeMocks.chain.rpc }))
vi.mock("next/server", () => ({ connection: async () => {} }))

import { GET, POST } from "@/app/api/markets/route"
import { resetPublishLimitsForTests } from "@/lib/server/registry"

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
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await res.json()).markets.map((m: Market) => m.marketId)).toEqual([seed.marketId, "local-usdy-extra"])
  })

  it("falls back to the seeds when the database is down", async () => {
    const seed = seedMarket(chain.deploy(10))
    routeMocks.manifest = manifestWith([seed])
    routeMocks.sql.mockReset()
    routeMocks.sql.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).markets).toEqual([seed])
    expect(error).toHaveBeenCalled()
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

  it("says it is unavailable when the registry cannot be read, instead of an empty list", async () => {
    store.fail = new Error("connection refused at 10.0.0.1")
    vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await invalidMarkets({ store, manifest: manifestWith([]) })
    expect(result).toEqual({ status: "unavailable" })
  })
})
