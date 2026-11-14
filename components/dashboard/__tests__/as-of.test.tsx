import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"
import { AsOf, readsOf } from "../as-of"

const NOW = Date.UTC(2026, 10, 14, 4, 0, 0)

const read = (ledger: number, fn = "f"): ReadSource => ({ contractId: "C", fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: "https://rpc.test" })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout", "clearInterval", "clearTimeout"] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

async function renderAt(props: Parameters<typeof AsOf>[0]) {
  const view = render(<AsOf {...props} />)
  // The elapsed time is read on the client after mount, never during render.
  await act(async () => {
    vi.advanceTimersByTime(1)
  })
  return view
}

describe("AsOf", () => {
  it("says the newest ledger, how long ago it was read and the cadence", async () => {
    await renderAt({ sources: [read(5_720_087)], updatedAt: NOW - 12_000, cadenceMs: 15_000 })
    const line = screen.getByTestId("as-of")
    expect(line.textContent).toContain("As of ledger 5720087 · 12s ago")
    expect(line.textContent).toContain("Refreshes every 15 s")
    expect(line.textContent).not.toContain("Stale")
    expect(line.getAttribute("data-stale")).toBe("false")
  })

  it("is not stale at exactly 2 × the cadence, and stale after it", async () => {
    const at = await renderAt({ sources: [read(1)], updatedAt: NOW - 30_000, cadenceMs: 15_000 })
    expect(screen.getByTestId("as-of").getAttribute("data-stale")).toBe("false")
    at.unmount()
    await renderAt({ sources: [read(1)], updatedAt: NOW - 30_001, cadenceMs: 15_000 })
    const line = screen.getByTestId("as-of")
    expect(line.getAttribute("data-stale")).toBe("true")
    expect(line.textContent).toContain("Stale: no new read for over 30 s")
  })

  it("turns stale as time passes without a new read", async () => {
    await renderAt({ sources: [read(1)], updatedAt: NOW, cadenceMs: 60_000 })
    expect(screen.getByTestId("as-of").getAttribute("data-stale")).toBe("false")
    await act(async () => {
      vi.advanceTimersByTime(121_000)
    })
    expect(screen.getByTestId("as-of").getAttribute("data-stale")).toBe("true")
    expect(screen.getByTestId("as-of").textContent).toContain("2m 1s ago")
  })

  it("labels reads from different ledgers (D-5) and dates the newest", async () => {
    await renderAt({ sources: [read(5_720_080), read(5_720_087), read(5_720_084)], updatedAt: NOW, cadenceMs: 15_000 })
    const line = screen.getByTestId("as-of")
    expect(line.textContent).toContain("As of ledger 5720087")
    expect(line.textContent).toContain("Read across ledgers 5720080–5720087")
  })

  it("says so when no figure could be read, rather than show a ledger", async () => {
    await renderAt({ sources: [], updatedAt: NOW, cadenceMs: 15_000 })
    expect(screen.getByTestId("as-of").textContent).toContain("No figure could be read")
  })
})

describe("readsOf", () => {
  it("lists every read behind the figures, composite or single, and skips the unread", () => {
    const a = read(1, "a")
    const b = read(2, "b")
    const c = read(3, "c")
    const lives: (Live<unknown> | undefined)[] = [
      { status: "live", value: 1, ledger: 2, sources: [a, b] },
      { status: "live", value: 2, ledger: 3, source: c },
      { status: "unavailable", error: "x" },
      undefined,
    ]
    expect(readsOf(lives)).toEqual([a, b, c])
  })
})
