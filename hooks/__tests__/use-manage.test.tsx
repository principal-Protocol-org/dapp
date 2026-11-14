import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { Keypair } from "@stellar/stellar-sdk"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "@/lib/protocol/manifest"

const ME = Keypair.random().publicKey()
const manifest = parseManifest(structuredClone(testnetJson))

const mocks = vi.hoisted(() => ({
  pathname: "/app",
  rolesOf: vi.fn(),
  sharedRolesOf: vi.fn(),
  issuerOfAsset: vi.fn(),
}))

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => manifest }))
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => ({ state: { status: "connected", publicKey: ME, networkPassphrase: manifest.networkPassphrase } }),
}))
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/roles", () => ({
  rolesOf: mocks.rolesOf,
  sharedRolesOf: mocks.sharedRolesOf,
  issuerOfAsset: mocks.issuerOfAsset,
  accruedFees: vi.fn(),
}))

import { ROLES_REFETCH_MANAGE_MS, ROLES_REFETCH_MS, rolesRefetchMs, useMyRoles } from "@/hooks/use-manage"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Every role read made so far: the per-market views, the shared admins and the test asset's issuer. */
const reads = () => mocks.rolesOf.mock.calls.length + mocks.sharedRolesOf.mock.calls.length + mocks.issuerOfAsset.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.rolesOf.mockReset().mockResolvedValue({ marketId: manifest.markets[0].marketId })
  mocks.sharedRolesOf.mockReset().mockResolvedValue({})
  mocks.issuerOfAsset.mockReset().mockResolvedValue(false)
})
afterEach(() => {
  vi.useRealTimers()
})

describe("header role polling (D-26 item 3)", () => {
  it("polls every 30 s only on the manage view, every 120 s elsewhere", () => {
    expect(ROLES_REFETCH_MANAGE_MS).toBe(30_000)
    expect(ROLES_REFETCH_MS).toBe(120_000)
    expect(rolesRefetchMs("/app/manage")).toBe(30_000)
    expect(rolesRefetchMs("/app/manage/new")).toBe(30_000)
    expect(rolesRefetchMs("/app")).toBe(120_000)
    expect(rolesRefetchMs("/app/markets/m1")).toBe(120_000)
    expect(rolesRefetchMs("/app/portfolio")).toBe(120_000)
    expect(rolesRefetchMs("/app/manager")).toBe(120_000)
    expect(rolesRefetchMs(null)).toBe(120_000)
  })

  it("off the manage view, the role views are not read again at 30 s, only at 120 s", async () => {
    mocks.pathname = "/app/markets/m1"
    const { result } = renderHook(() => useMyRoles(), { wrapper })
    await waitFor(() => expect(result.current.pending).toBe(false))
    const first = reads()
    // The per-market views and the shared admins (this manifest has no test asset to read the issuer of).
    expect(first).toBe(manifest.markets.length + (manifest.testAsset ? 2 : 1))
    await act(() => vi.advanceTimersByTimeAsync(31_000))
    expect(reads()).toBe(first)
    await act(() => vi.advanceTimersByTimeAsync(90_000))
    await waitFor(() => expect(reads()).toBe(2 * first))
  })

  it("on the manage view, they are read every 30 s", async () => {
    mocks.pathname = "/app/manage"
    const { result } = renderHook(() => useMyRoles(), { wrapper })
    await waitFor(() => expect(result.current.pending).toBe(false))
    const first = reads()
    await act(() => vi.advanceTimersByTimeAsync(31_000))
    await waitFor(() => expect(reads()).toBe(2 * first))
  })
})
