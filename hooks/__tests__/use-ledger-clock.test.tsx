import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getLedgerClock: vi.fn() }))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => ({ rpcUrl: "https://rpc.test" }) }))
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({}), getLedgerClock: mocks.getLedgerClock }))

import { LEDGER_CLOCK_REFETCH_MS, useLedgerClock } from "../use-ledger-clock"

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.getLedgerClock.mockReset()
})

describe("useLedgerClock: how long since the clock was last read", () => {
  it("refetches every 6 s", () => {
    expect(LEDGER_CLOCK_REFETCH_MS).toBe(6_000)
  })

  it("is null before the first read", () => {
    mocks.getLedgerClock.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useLedgerClock(), { wrapper })
    expect(result.current.sinceReadSeconds).toBeNull()
    expect(result.current.ledgerTime).toBeNull()
  })

  it("counts the seconds since the last successful read, on the browser's clock as elapsed time only", async () => {
    mocks.getLedgerClock.mockResolvedValue({ sequence: 7, closeTime: 1_800_000_000, readAtMs: Date.now() - 20_000 })
    const { result } = renderHook(() => useLedgerClock(), { wrapper })
    await waitFor(() => expect(result.current.sinceReadSeconds).toBeGreaterThan(19), { timeout: 3_000 })
    // The ledger time moved on by the same elapsed seconds.
    expect(result.current.ledgerTime).toBeCloseTo(1_800_000_000 + (result.current.sinceReadSeconds as number), 5)
  })
})
