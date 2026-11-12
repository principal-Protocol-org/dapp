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
  /** Who may resume each registry salt: the asset's issuer and the protocol admin, read on chain. */
  creators: {} as Record<string, unknown>,
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
vi.mock("@/lib/protocol/factory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/factory")>()),
  readCreatorRoles: async (_reader: unknown, predicted: { pool: string }) => mocks.creators[predicted.pool],
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
  const theirs = salt("b1")
  const mine = salt("b2")
  const protocol = salt("b3")
  const live = (value: string) => ({ status: "live", value, ledger: 1 })

  beforeEach(() => {
    Object.assign(mocks.progress, {
      [theirs]: { step: 3, predicted: { pool: contractAt(61) }, phases: { tokens: true, engine: false, poolAndEscrow: false } },
      [mine]: { step: 5, predicted: { pool: contractAt(62) }, phases: { tokens: true, engine: true, poolAndEscrow: true } },
      [protocol]: { step: 6, predicted: { pool: contractAt(63) }, phases: { tokens: true, engine: true, poolAndEscrow: true } },
    })
    mocks.creators = {
      [contractAt(61)]: { sacAdmin: live("GSOMEONE") },
      [contractAt(62)]: { sacAdmin: live(ISSUER), protocolAdmin: live("GSOMEONE") },
      [contractAt(63)]: { sacAdmin: live("GSOMEONE"), protocolAdmin: live(ADMIN) },
      [contractAt(51)]: { sacAdmin: live(ISSUER) },
    }
  })

  it("lists a registry salt to the asset's issuer or the market's protocol admin, deduplicated with this browser's, and to no one else", async () => {
    const registry = [theirs, mine, protocol, HALFWAY]
    const asIssuer = renderHook(() => useMarketsInProgress(registry, ISSUER), { wrapper })
    await waitFor(() => expect(asIssuer.result.current.map((m) => m.salt)).toEqual([HALFWAY, mine]))
    const asAdmin = renderHook(() => useMarketsInProgress(registry, ADMIN), { wrapper })
    await waitFor(() => expect(asAdmin.result.current.map((m) => m.salt)).toEqual([HALFWAY, protocol]))
    const noWallet = renderHook(() => useMarketsInProgress(registry, null), { wrapper })
    await waitFor(() => expect(noWallet.result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    // A registry salt is never written to this browser's list.
    expect(readWizardSalts("testnet")).toEqual([HALFWAY])
  })

  it("the list is not polled, and stays fresh for about a minute (refetched on mount and focus after that)", async () => {
    const { result } = renderHook(() => useMarketsInProgress([mine], ISSUER), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY, mine]))
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
