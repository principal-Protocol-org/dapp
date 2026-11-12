import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { StrKey } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const salt = (fill: string) => fill.repeat(32)
const PUBLISHED = salt("a1")
const HALFWAY = salt("a2")
const NOTHING = salt("a3")

const mocks = vi.hoisted(() => ({
  progress: {} as Record<string, unknown>,
  calls: [] as string[],
  listedPool: "",
  /** Who may resume a registry salt, read on chain: each asset's SAC admin, each market's protocol admin. */
  sacAdmins: {} as Record<string, string>,
  protocolAdmins: {} as Record<string, string>,
  adminReads: [] as string[],
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = {
    network: "testnet",
    rpcUrl: "http://rpc",
    markets: [
      {
        get contracts() {
          return { pool: mocks.listedPool }
        },
      },
    ],
  }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({}) }))
const answer = (value: string | undefined) =>
  value === undefined ? { status: "unavailable", error: "no contract at this address" } : { status: "live", value, ledger: 1 }
vi.mock("@/lib/protocol/factory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/factory")>()),
  // The new market's config is derived from its salt, locally.
  deriveMarketContracts: (_manifest: unknown, s: string) => ({ config: `config-${s}`, pool: `pool-${s}` }),
  readSacAdmin: async (_reader: unknown, sac: string) => (mocks.adminReads.push(`admin ${sac}`), answer(mocks.sacAdmins[sac])),
  readProtocolAdmin: async (_reader: unknown, config: string) => (mocks.adminReads.push(`protocol_admin ${config}`), answer(mocks.protocolAdmins[config])),
}))
vi.mock("@/lib/protocol/market-progress", () => ({
  marketProgress: async (_reader: unknown, _rpc: unknown, _manifest: unknown, s: string) => {
    mocks.calls.push(s)
    return mocks.progress[s]
  },
}))

import { useMarketsInProgress } from "@/hooks/use-wizard"
import { readWizardSalts } from "@/lib/app/wizard-salts"

const LISTED_POOL = contractAt(50)
mocks.listedPool = LISTED_POOL

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  localStorage.clear()
  mocks.calls = []
  mocks.progress = {
    [PUBLISHED]: { step: 7, predicted: { pool: LISTED_POOL } },
    [HALFWAY]: { step: 4, predicted: { pool: contractAt(51) } },
    [NOTHING]: { step: 1, predicted: { pool: contractAt(52) } },
  }
  localStorage.setItem("pp-wizard-salts:testnet", JSON.stringify([PUBLISHED, HALFWAY, NOTHING]))
})

describe("useMarketsInProgress (the manager view's Resume list)", () => {
  it("drops a salt whose pool is listed (published) or that has nothing on chain, and keeps the half-finished one", async () => {
    const { result } = renderHook(() => useMarketsInProgress(), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    expect(readWizardSalts("testnet")).toEqual([HALFWAY])
  })

  it("reads each progress once, on mount: no polling of the list", async () => {
    const { result } = renderHook(() => useMarketsInProgress(), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    const query = client.getQueryCache().find({ queryKey: ["manage", "testnet", "wizard-progress", HALFWAY] })
    expect(query).toBeDefined()
    for (const observer of query!.observers) expect((observer.options as { refetchInterval?: unknown }).refetchInterval).toBeFalsy()
  })
})

describe("useMarketsInProgress with the registry's salts (spec 0002 §5: resume from any browser)", () => {
  const ISSUER = "GISSUER"
  const ADMIN = "GADMIN"
  const SAC_A = contractAt(70)
  const SAC_B = contractAt(71)
  const mine = salt("b2")
  const mineToo = salt("b4")
  const protocol = salt("b3")
  const theirs = salt("b1")
  /** What the server hands over: each salt with the asset its SY wraps (checked on chain when indexed). */
  const registry = [
    { salt: theirs, underlying: SAC_B },
    { salt: mine, underlying: SAC_A },
    { salt: protocol, underlying: SAC_B },
    { salt: mineToo, underlying: SAC_A },
    { salt: HALFWAY, underlying: SAC_A },
  ]
  const progressRead = (s: string) => mocks.calls.includes(s)

  beforeEach(() => {
    mocks.adminReads = []
    for (const [s, step, pool] of [[theirs, 3, 61], [mine, 5, 62], [protocol, 6, 63], [mineToo, 4, 64]] as const) {
      mocks.progress[s] = { step, predicted: { pool: contractAt(pool) }, phases: { tokens: true, engine: true, poolAndEscrow: true } }
    }
    mocks.sacAdmins = { [SAC_A]: ISSUER, [SAC_B]: "GSOMEONE" }
    // `theirs` has no engine yet: no config to read, which is "not this wallet's", never a guess.
    mocks.protocolAdmins = { [`config-${protocol}`]: ADMIN }
  })

  it("no wallet: not a single read for the registry's salts", async () => {
    const { result } = renderHook(() => useMarketsInProgress(registry, null), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    expect(mocks.adminReads).toEqual([])
    expect(mocks.calls).toEqual([PUBLISHED, HALFWAY, NOTHING])
  })

  it("the asset's issuer: one admin() read per asset, and progress read only for the salts it owns", async () => {
    const { result } = renderHook(() => useMarketsInProgress(registry, ISSUER), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY, mine, mineToo]))
    expect(mocks.adminReads.filter((r) => r.startsWith("admin")).sort()).toEqual([`admin ${SAC_A}`, `admin ${SAC_B}`])
    // The asset it issues needs no protocol_admin read; the other asset's markets do, one each.
    expect(mocks.adminReads.filter((r) => r.startsWith("protocol_admin")).sort()).toEqual([`protocol_admin config-${protocol}`, `protocol_admin config-${theirs}`].sort())
    expect([mine, mineToo].every(progressRead)).toBe(true)
    expect(progressRead(theirs) || progressRead(protocol)).toBe(false)
    // A registry salt is never written to this browser's list.
    expect(readWizardSalts("testnet")).toEqual([HALFWAY])
  })

  it("the market's protocol admin: progress read for that market only", async () => {
    const { result } = renderHook(() => useMarketsInProgress(registry, ADMIN), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY, protocol]))
    expect(progressRead(protocol)).toBe(true)
    expect([theirs, mine, mineToo].some(progressRead)).toBe(false)
  })

  it("the list is not polled, and stays fresh for about a minute (refetched on mount and focus after that)", async () => {
    const { result } = renderHook(() => useMarketsInProgress(registry, ISSUER), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY, mine, mineToo]))
    for (const s of [HALFWAY, mine]) {
      const query = client.getQueryCache().find({ queryKey: ["manage", "testnet", "wizard-progress", s] })
      for (const observer of query!.observers) {
        const options = observer.options as { refetchInterval?: unknown; staleTime?: unknown }
        expect(options.refetchInterval).toBeFalsy()
        expect(options.staleTime).toBe(60_000)
      }
    }
  })
})
