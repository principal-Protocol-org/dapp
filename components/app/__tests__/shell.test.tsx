import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WalletState } from "@/lib/protocol/types"

const mocks = vi.hoisted(() => ({
  manifest: {
    network: "testnet" as "testnet" | "local" | "mainnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.example",
  },
  adapter: {
    restore: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sign: vi.fn(),
    watch: vi.fn(),
  },
  getLedgerClock: vi.fn(),
}))

vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest }))  // TestnetBanner (a server component)
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/lib/protocol/wallet", () => ({ freighterAdapter: mocks.adapter }))
vi.mock("@/lib/protocol/stellar", () => ({
  createRpcServer: () => ({}),
  getLedgerClock: mocks.getLedgerClock,
}))
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }))

import { AppHeader } from "../shell/app-header"
import { SettingsPopover } from "../shell/settings-popover"
import { TestnetBanner } from "../shell/testnet-banner"
import { WalletButton } from "../shell/wallet-button"
import { Providers } from "../providers"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { resetSettingsStoreForTests, useSettings } from "@/hooks/use-settings"
import { useWallet } from "@/hooks/use-wallet"

const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const PASSPHRASE = "Test SDF Network ; September 2015"
const connected: WalletState = { status: "connected", publicKey: ADDRESS, networkPassphrase: PASSPHRASE }

let watcher: ((s: { address: string; networkPassphrase: string }) => void) | undefined

beforeEach(() => {
  // jsdom has no matchMedia; sonner's Toaster reads it.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  localStorage.clear()
  resetSettingsStoreForTests()
  mocks.manifest.network = "testnet"
  mocks.adapter.restore.mockResolvedValue({ status: "disconnected" } satisfies WalletState)
  mocks.adapter.connect.mockResolvedValue(connected)
  mocks.adapter.watch.mockImplementation((cb) => {
    watcher = cb
    return () => {}
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  watcher = undefined
})

describe("testnet banner", () => {
  it("shows the testnet banner when network is testnet", () => {
    render(<TestnetBanner />)
    expect(screen.getByRole("status").textContent).toContain("Stellar Testnet")
    expect(screen.getByRole("status").textContent).toContain("no real value")
  })

  it("also shows for a local network and hides for mainnet", () => {
    mocks.manifest.network = "local"
    const { unmount } = render(<TestnetBanner />)
    expect(screen.getByRole("status").textContent).toContain("test assets only")
    unmount()
    mocks.manifest.network = "mainnet"
    render(<TestnetBanner />)
    expect(screen.queryByRole("status")).toBeNull()
  })
})

describe("wallet button", () => {
  it("links to Varial when it is not installed", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "not_installed" })
    render(<Providers><WalletButton /></Providers>)
    const link = await screen.findByRole("link", { name: /install varial/i })
    expect(link.getAttribute("href")).toBe("https://varialwallet.com")
  })

  it("without Varial, Connect says to install it and turns into the install link (I1)", async () => {
    mocks.adapter.connect.mockResolvedValue({ status: "not_installed" } satisfies WalletState)
    const user = userEvent.setup()
    render(<Providers><WalletButton /></Providers>)
    await user.click(await screen.findByRole("button", { name: /connect wallet/i }))
    expect(await screen.findByText("Varial is not installed. Install Varial, then connect again.")).toBeTruthy()
    expect((await screen.findByRole("link", { name: /install varial/i })).getAttribute("href")).toBe("https://varialwallet.com")
    expect(screen.queryByText(/locked/i)).toBeNull()
  })

  it("shows Connect, then the short address once connected", async () => {
    const user = userEvent.setup()
    render(<Providers><WalletButton /></Providers>)
    const button = await screen.findByRole("button", { name: /connect wallet/i })
    await user.click(button)
    expect(mocks.adapter.connect).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("button", { name: /GBZX.*MADI/ })).toBeTruthy()
  })

  it("restores a remembered session and offers Disconnect in the menu", async () => {
    mocks.adapter.restore.mockResolvedValue(connected)
    const user = userEvent.setup()
    render(<Providers><WalletButton /></Providers>)
    await user.click(await screen.findByRole("button", { name: /GBZX.*MADI/ }))
    await user.click(await screen.findByRole("menuitem", { name: /disconnect/i }))
    expect(mocks.adapter.disconnect).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("button", { name: /connect wallet/i })).toBeTruthy()
  })

  it("shows a warning naming the expected network when Freighter is on another one", async () => {
    mocks.adapter.restore.mockResolvedValue({
      status: "wrong_network",
      publicKey: ADDRESS,
      actualPassphrase: "Public Global Stellar Network ; September 2015",
      expectedPassphrase: PASSPHRASE,
    })
    render(<Providers><WalletButton /></Providers>)
    const trigger = await screen.findByRole("button", { name: /wrong network/i })
    expect(trigger.textContent).toContain("Testnet")
  })
})

describe("useWallet", () => {
  it("re-runs restore when watch reports an empty address, and on a passphrase change", async () => {
    mocks.adapter.restore.mockResolvedValue(connected)
    const { result } = renderHook(() => useWallet(), { wrapper: Providers })
    await waitFor(() => expect(result.current.state.status).toBe("connected"))
    expect(mocks.adapter.restore).toHaveBeenCalledTimes(1)

    // Same account and network: nothing to re-evaluate.
    act(() => watcher?.({ address: ADDRESS, networkPassphrase: PASSPHRASE }))
    expect(mocks.adapter.restore).toHaveBeenCalledTimes(1)

    mocks.adapter.restore.mockResolvedValue({ status: "locked" })
    act(() => watcher?.({ address: "", networkPassphrase: "" }))
    await waitFor(() => expect(result.current.state.status).toBe("locked"))
    expect(mocks.adapter.restore).toHaveBeenCalledTimes(2)

    mocks.adapter.restore.mockResolvedValue({
      status: "wrong_network",
      publicKey: ADDRESS,
      actualPassphrase: "Other",
      expectedPassphrase: PASSPHRASE,
    })
    act(() => watcher?.({ address: ADDRESS, networkPassphrase: "Other" }))
    await waitFor(() => expect(result.current.state.status).toBe("wrong_network"))
  })

  it("ignores watcher events while connecting, so approval is not dropped", async () => {
    let release!: (s: WalletState) => void
    mocks.adapter.connect.mockReturnValue(new Promise<WalletState>((r) => (release = r)))
    const { result } = renderHook(() => useWallet(), { wrapper: Providers })
    await waitFor(() => expect(mocks.adapter.restore).toHaveBeenCalledTimes(1))
    let pending!: Promise<WalletState>
    act(() => {
      pending = result.current.connect()
    })
    expect(result.current.state.status).toBe("connecting")
    act(() => watcher?.({ address: ADDRESS, networkPassphrase: PASSPHRASE }))
    expect(mocks.adapter.restore).toHaveBeenCalledTimes(1)
    await act(async () => {
      release(connected)
      await pending
    })
    expect(result.current.state).toEqual(connected)
  })

  it("turns a throwing connect into a rejected state", async () => {
    mocks.adapter.connect.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useWallet(), { wrapper: Providers })
    await act(async () => {
      await result.current.connect()
    })
    expect(result.current.state).toEqual({ status: "rejected", reason: "boom" })
  })

  it("refuses to sign unless connected, and signs for the connected account", async () => {
    mocks.adapter.sign.mockResolvedValue("signed-xdr")
    const { result } = renderHook(() => useWallet(), { wrapper: Providers })
    await expect(result.current.sign("xdr", ADDRESS)).rejects.toThrow(/not connected/i)
    mocks.adapter.restore.mockResolvedValue(connected)
    const second = renderHook(() => useWallet(), { wrapper: Providers })
    await waitFor(() => expect(second.result.current.state.status).toBe("connected"))
    await expect(second.result.current.sign("xdr", ADDRESS)).resolves.toBe("signed-xdr")
    expect(mocks.adapter.sign).toHaveBeenCalledWith("xdr", PASSPHRASE, ADDRESS)
  })

  it("passes the expected signer to Freighter, and refuses another one before it opens", async () => {
    mocks.adapter.sign.mockResolvedValue("signed-xdr")
    mocks.adapter.restore.mockResolvedValue(connected)
    const { result } = renderHook(() => useWallet(), { wrapper: Providers })
    await waitFor(() => expect(result.current.state.status).toBe("connected"))
    const other = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
    await expect(result.current.sign("xdr", other)).rejects.toThrow(/not the one this was prepared for/)
    expect(mocks.adapter.sign).not.toHaveBeenCalled()
  })
})

describe("settings", () => {
  it("settings persist slippage", () => {
    const first = renderHook(() => useSettings())
    expect(first.result.current.slippageBps).toBe(50n)
    expect(first.result.current.deadlineSeconds).toBe(300)

    let outcome: ReturnType<typeof first.result.current.set> | undefined
    act(() => {
      outcome = first.result.current.set({ slippageBps: 120 })
    })
    expect(outcome).toEqual({ ok: true })
    expect(first.result.current.slippageBps).toBe(120n)
    expect(JSON.parse(localStorage.getItem("pp-settings") ?? "{}").slippageBps).toBe(120)

    first.unmount()
    const second = renderHook(() => useSettings())
    expect(second.result.current.slippageBps).toBe(120n)
    expect(second.result.current.deadlineSeconds).toBe(300)
  })

  it("rejects values outside the allowed ranges and keeps the stored value", () => {
    const { result } = renderHook(() => useSettings())
    for (const patch of [
      { slippageBps: 0 },
      { slippageBps: 501 },
      { slippageBps: 1.5 },
      { deadlineSeconds: 59 },
      { deadlineSeconds: 1801 },
    ]) {
      let outcome: ReturnType<typeof result.current.set> | undefined
      act(() => {
        outcome = result.current.set(patch)
      })
      expect(outcome?.ok).toBe(false)
    }
    expect(result.current.slippageBps).toBe(50n)
    expect(result.current.deadlineSeconds).toBe(300)
    expect(localStorage.getItem("pp-settings")).toBeNull()
  })

  it("falls back to defaults on corrupt storage and survives a throwing storage", () => {
    localStorage.setItem("pp-settings", JSON.stringify({ slippageBps: 9999, deadlineSeconds: "x" }))
    const { result } = renderHook(() => useSettings())
    expect(result.current.slippageBps).toBe(50n)
    expect(result.current.deadlineSeconds).toBe(300)

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    let outcome: ReturnType<typeof result.current.set> | undefined
    act(() => {
      outcome = result.current.set({ deadlineSeconds: 600 })
    })
    expect(outcome).toEqual({ ok: true })
    expect(result.current.deadlineSeconds).toBe(600)
    spy.mockRestore()
  })

  it("commits a valid draft on blur and never stores an invalid one", async () => {
    const user = userEvent.setup()
    render(<SettingsPopover />)
    await user.click(screen.getByRole("button", { name: /settings/i }))
    const input = await screen.findByLabelText(/slippage/i)
    expect((input as HTMLInputElement).value).toBe("50")
    await user.clear(input)
    await user.type(input, "300")
    // Nothing is stored while typing ("3" is never saved).
    expect(localStorage.getItem("pp-settings")).toBeNull()
    await user.tab()
    expect(JSON.parse(localStorage.getItem("pp-settings") ?? "{}").slippageBps).toBe(300)

    await user.clear(input)
    await user.type(input, "900")
    await user.tab()
    expect((await screen.findByRole("alert")).textContent).toMatch(/1 and 500/)
    expect(JSON.parse(localStorage.getItem("pp-settings") ?? "{}").slippageBps).toBe(300)
  })

  it("commits on Enter, and on close discards an invalid draft", async () => {
    const user = userEvent.setup()
    render(<SettingsPopover />)
    await user.click(screen.getByRole("button", { name: /settings/i }))
    const input = await screen.findByLabelText(/slippage/i)
    await user.clear(input)
    await user.type(input, "75{Enter}")
    expect(JSON.parse(localStorage.getItem("pp-settings") ?? "{}").slippageBps).toBe(75)

    await user.clear(input)
    await user.type(input, "900")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByLabelText(/slippage/i)).toBeNull())
    expect(JSON.parse(localStorage.getItem("pp-settings") ?? "{}").slippageBps).toBe(75)
    await user.click(screen.getByRole("button", { name: /settings/i }))
    expect(((await screen.findByLabelText(/slippage/i)) as HTMLInputElement).value).toBe("75")
  })
})

describe("useLedgerClock", () => {
  it("reads the ledger every 6 s and ticks locally in between", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    vi.setSystemTime(5_000_000)
    mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 10, closeTime: 1000, readAtMs: Date.now() }))
    const { result } = renderHook(() => useLedgerClock(), { wrapper: Providers })
    expect(result.current.ledgerTime).toBeNull()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(result.current.ledgerTime).toBe(1000)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.ledgerTime).toBe(1003)
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(mocks.getLedgerClock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe("app header", () => {
  it("has the logo link and the three nav links", () => {
    render(<Providers><AppHeader /></Providers>)
    expect(screen.getByRole("link", { name: /principal home/i }).getAttribute("href")).toBe("/")
    expect(screen.getByRole("link", { name: "Markets" }).getAttribute("href")).toBe("/app")
    expect(screen.getByRole("link", { name: "Portfolio" }).getAttribute("href")).toBe("/app/portfolio")
    expect(screen.getByRole("link", { name: "History" }).getAttribute("href")).toBe("/app/history")
    expect(screen.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBe("page")
  })
})
