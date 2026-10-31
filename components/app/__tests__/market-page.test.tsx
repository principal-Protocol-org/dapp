import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountState, down, live, LEDGER_TIME, marketState } from "./fixtures"

const MARKET = {
  marketId: "m1",
  displayName: "STA · test",
  underlying: { code: "STA", decimals: 7 },
}
const mocks = vi.hoisted(() => ({
  ms: undefined as unknown,
  stale: false,
  accountStale: false,
  compliance: undefined as unknown,
  account: undefined as AccountState | undefined,
  wallet: { status: "disconnected" } as WalletState,
  findings: [] as { severity: string; message: string }[],
  network: "testnet" as "testnet" | "local" | "mainnet",
  pending: false,
  clock: { ledgerTime: null as number | null, isError: false },
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object per network, as the provider gives: hooks depend on its identity.
  const byNetwork = new Map<string, unknown>()
  const make = (network: string) => ({ network, markets: [MARKET] })
  return {
    useManifest: () => {
      if (!byNetwork.has(mocks.network)) byNetwork.set(mocks.network, make(mocks.network))
      return byNetwork.get(mocks.network)
    },
  }
})
// Server side: generateStaticParams reads the static seeds, MarketRoute the resolved markets.
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => ({ network: mocks.network, markets: [MARKET] }) }))
vi.mock("@/lib/server/manifest", () => ({
  resolvedManifest: async () => ({ network: mocks.network, markets: [MARKET, { ...MARKET, marketId: "testnet-sta-registry" }] }),
}))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("@/hooks/use-market-state", () => ({
  useMarketState: () => ({ data: mocks.ms, isPending: mocks.pending, stale: mocks.stale }),
}))
vi.mock("@/hooks/use-market-compliance", () => ({
  useMarketCompliance: () => ({ data: mocks.compliance, isPending: false }),
}))
vi.mock("@/hooks/use-account-state", () => ({
  useAccountState: () => ({ data: mocks.account, isPending: false, stale: mocks.accountStale }),
}))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ...mocks.clock, sequence: 1 }),
}))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => mocks.findings }))
// The action panels have their own tests (mint-tab, trade-tab, …); here only their mounting matters.
vi.mock("@/components/app/actions/action-tabs", () => ({
  ActionTabs: ({ marketId }: { marketId: string }) => <section aria-label={`Actions for ${marketId}`} />,
}))
// The dialog has its own tests (onboarding.test.tsx); here only its wiring matters.
vi.mock("@/components/app/onboarding/onboarding-dialog", () => ({
  OnboardingDialog: ({ open, marketId }: { open: boolean; marketId?: string }) =>
    open ? <div role="dialog" aria-label={`Get test tokens for ${marketId}`} /> : null,
}))

import { isValidElement, Suspense } from "react"
import MarketPage, { generateStaticParams } from "../../../app/app/markets/[marketId]/page"
import { MarketRoute } from "../../../app/app/markets/[marketId]/market-route"
import { ComplianceCard } from "../market/compliance-card"
import { MarketHeader } from "../market/market-header"
import { MarketView } from "../market/market-view"
import { SafetyCard } from "../market/safety-card"

const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)
const sac = live({
  kind: "sac" as const,
  authRequired: true,
  authRevocable: true,
  clawbackEnabled: false,
  administrator: "GADMINISTRATORADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
})

beforeEach(() => {
  mocks.ms = marketState()
  mocks.stale = false
  mocks.accountStale = false
  mocks.compliance = sac
  mocks.account = undefined
  mocks.wallet = { status: "disconnected" }
  mocks.findings = []
  mocks.network = "testnet"
  mocks.notFound.mockClear()
  mocks.pending = false
  mocks.clock = { ledgerTime: LEDGER_TIME, isError: false }
})

describe("market page route", () => {
  it("prerenders every manifest market", () => {
    expect(generateStaticParams()).toEqual([{ marketId: "m1" }])
  })
  it("keeps the market id out of the shared App Shell: params are read inside Suspense (V3)", () => {
    // A params promise that never settles: the page must not wait for it.
    const params = new Promise<{ marketId: string }>(() => {})
    const el = MarketPage({ params })
    expect(isValidElement(el)).toBe(true)
    if (!isValidElement<{ children: React.ReactElement<{ params: unknown }> }>(el)) return
    expect(el.type).toBe(Suspense)
    expect(el.props.children.type).toBe(MarketRoute)
    expect(el.props.children.props.params).toBe(params)
  })
  it("calls notFound for an unknown market id", async () => {
    await expect(MarketRoute({ params: Promise.resolve({ marketId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.notFound).toHaveBeenCalled()
  })
  it("renders the market for a known id", async () => {
    const el = await MarketRoute({ params: Promise.resolve({ marketId: "m1" }) })
    expect(el.props.marketId).toBe("m1")
  })
  it("renders a registry market too: known ids are the resolved markets, not only the seeds", async () => {
    const el = await MarketRoute({ params: Promise.resolve({ marketId: "testnet-sta-registry" }) })
    expect(el.props.marketId).toBe("testnet-sta-registry")
    expect(mocks.notFound).not.toHaveBeenCalled()
  })
})

describe("MarketHeader", () => {
  const badge = () => document.querySelector('[data-slot="badge"]')?.textContent
  it("says Loading, not Unavailable, in the status badge while the ledger clock loads (V6)", () => {
    mocks.clock = { ledgerTime: null, isError: false }
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Loading")
  })
  it("says Loading in the status badge while the market data loads (V6)", () => {
    mocks.ms = undefined
    mocks.pending = true
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Loading")
  })
  it("says Unavailable once the ledger clock has failed", () => {
    mocks.clock = { ledgerTime: null, isError: true }
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Unavailable")
  })
  it("shows the market's status once both have loaded", () => {
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Live")
  })
  it("defines the oracle rate as the mint panel does: notional per SY share (M4)", async () => {
    // Radix positions the tooltip with a ResizeObserver, which jsdom lacks.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    wrap(<MarketHeader marketId="m1" />)
    await userEvent.hover(screen.getByRole("button", { name: "1.0500" }))
    expect((await screen.findAllByText(/^Notional per SY share, read from the market oracle\./)).length).toBeGreaterThan(0)
  })
  it("shows the oracle rate, its age, the totals and the reserves", () => {
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByRole("heading", { name: "STA · test" })).toBeTruthy()
    expect(screen.getByText("1.0500")).toBeTruthy()
    expect(screen.getByText("10m 0s ago")).toBeTruthy()
    expect(screen.getByText("PT total supply").nextSibling?.textContent).toBe("500")
    expect(screen.getByText("YT total supply").nextSibling?.textContent).toBe("500")
    expect(screen.getByText("Pool PT reserve").nextSibling?.textContent).toBe("1200")
    expect(screen.getByText("Pool SY reserve").nextSibling?.textContent).toBe("3400")
    expect(screen.getByText("PT price (pool spot)").nextSibling?.textContent).toBe("0.9800 notional value per PT")
    expect(screen.getByText("Matures in 10d 0h 0m")).toBeTruthy()
  })
  it("shows the pool value estimate and the three fees", () => {
    mocks.ms = marketState({
      fees: { tokenizationBps: live(5n), ytBps: live(30n), swapTierBps: live(0n), protocolShareBps: live(0n) },
      swapFeeRate: live(3_000_000_000n),
    })
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByText("Pool value (estimate)").nextSibling?.textContent).toBe("≈ 4520 STA, PT at pool price")
    expect(screen.getByText("Tokenization fee").nextSibling?.textContent).toBe("0.05%")
    expect(screen.getByText("YT fee").nextSibling?.textContent).toBe("0.30%")
    expect(screen.getByText("Current swap fee (decreases to 0 at maturity)").nextSibling?.textContent).toBe("0.3000%")
  })
  it("shows Unavailable for the fees and pool value when unreadable", () => {
    mocks.ms = marketState({ fees: { tokenizationBps: down(), ytBps: down(), swapTierBps: live(0n), protocolShareBps: live(0n) }, swapFeeRate: down(), exchangeRate: down() })
    wrap(<MarketHeader marketId="m1" />)
    for (const label of ["Tokenization fee", "YT fee", "Current swap fee (decreases to 0 at maturity)", "Pool value (estimate)"]) {
      expect(screen.getByText(label).nextSibling?.textContent).toBe("Unavailable")
    }
  })
  it("shows an oracle timestamp in the future as 0s ago, not a negative age", () => {
    mocks.ms = marketState({ oracleTimestamp: live(BigInt(LEDGER_TIME + 500)) })
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByText("Oracle updated").nextSibling?.textContent).toBe("0s ago")
  })
  it("hides old values after a failed refresh", () => {
    mocks.stale = true
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByRole("alert").textContent).toMatch(/Unavailable — last update failed/)
    expect(screen.queryByText("1.0500")).toBeNull()
  })
  it("shows Unavailable for an unavailable value", () => {
    mocks.ms = marketState({ oracleRate: down(), totalPt: down(), poolState: down() })
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByText("Oracle rate").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("PT total supply").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("Pool SY reserve").nextSibling?.textContent).toBe("Unavailable")
  })
})

describe("ComplianceCard", () => {
  it("lists the market model", () => {
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText("Authorization required").nextSibling?.textContent).toBe("Yes")
    expect(screen.getByText("Authorization revocable").nextSibling?.textContent).toBe("Yes")
    expect(screen.getByText("Clawback enabled").nextSibling?.textContent).toBe("No")
    expect(screen.getByText("Administrator").nextSibling?.textContent).toContain("GADMINIS")
    expect(screen.getByText(/Connect a wallet/)).toBeTruthy()
  })
  it("says a SEP-57 token has no flags", () => {
    mocks.compliance = live({ kind: "sep57" as const, administrator: null })
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/SEP-57 token. It has no issuer flags/)).toBeTruthy()
  })
  it("says Unavailable when the model cannot be read", () => {
    mocks.compliance = down("horizon 503")
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/compliance model could not be read \(horizon 503\)/)).toBeTruthy()
  })
  it("hides old account items after a failed refresh", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState()
    mocks.accountStale = true
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(screen.queryByText(/Your account exists/)).toBeNull()
  })
  it("lists account items with fixes; onboarding opens Get test tokens", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permPt: live(false), trustline: live("none"), sacAuthorized: live(false) })
    const open = vi.fn()
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={open} />)
    expect(screen.getByText(/You have no trustline/)).toBeTruthy()
    expect(screen.getAllByText(/Fix: Add a trustline/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole("button", { name: "Get test tokens" })[0])
    expect(open).toHaveBeenCalledTimes(1)
  })
  it("offers Get test tokens only on testnet or a local network", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permPt: live(false) })
    mocks.network = "mainnet"
    wrap(<ComplianceCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.queryByRole("button", { name: "Get test tokens" })).toBeNull()
    expect(screen.getAllByText(/Fix: Ask the market's administrator/).length).toBeGreaterThan(0)
  })
})

describe("SafetyCard", () => {
  it("lists pauses, oracle freshness and circuit-breaker room", () => {
    mocks.ms = marketState({ riskPaused: live(true) })
    wrap(<SafetyCard marketId="m1" />)
    expect(screen.getByText("SY wrapper").nextSibling?.textContent).toBe("Not paused")
    expect(screen.getByText("Risk control").nextSibling?.textContent).toMatch(/^Paused/)
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Fresh (updated within the last hour), updated 10m 0s ago")
    expect(screen.getByText("Circuit breaker, protocol-wide").nextSibling?.textContent).toBe("75000 left of 100000")
    expect(screen.getByText("Circuit breaker, STA").nextSibling?.textContent).toBe("No limit (disabled)")
    expect(screen.getByText("Your deposit cap").nextSibling?.textContent).toMatch(/Connect a wallet/)
  })
  it("shows deposit cap left for a connected account", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState()
    wrap(<SafetyCard marketId="m1" />)
    expect(screen.getByText("Your deposit cap").nextSibling?.textContent).toBe("6000 left of 10000")
  })
  it("says a stale oracle is stale", () => {
    mocks.ms = marketState({ oracleFresh: live(false) })
    wrap(<SafetyCard marketId="m1" />)
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Stale (not updated within the last hour), updated 10m 0s ago")
  })
  it("hides old values after a failed refresh", () => {
    mocks.stale = true
    wrap(<SafetyCard marketId="m1" />)
    expect(screen.getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(screen.queryByText("Not paused")).toBeNull()
  })
  it("never reads an unavailable value as zero", () => {
    mocks.ms = marketState({ syPaused: down(), oracleFresh: down(), cb: { limit: down(), volume: live(0n), assetLimit: live(0n), assetVolume: live(0n) } })
    wrap(<SafetyCard marketId="m1" />)
    expect(screen.getByText("SY wrapper").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("Circuit breaker, protocol-wide").nextSibling?.textContent).toBe("Unavailable")
  })
})

describe("MarketView", () => {
  it("shows a banner for manifest errors only", () => {
    mocks.findings = [
      { severity: "error", message: "rpcUrl must use https://" },
      { severity: "warning", message: "minor" },
    ]
    wrap(<MarketView marketId="m1" />)
    const alert = screen.getAllByRole("alert")[0]
    expect(within(alert).getByText(/rpcUrl must use/)).toBeTruthy()
    expect(within(alert).queryByText("minor")).toBeNull()
  })
  it("has no banner for a clean manifest", () => {
    wrap(<MarketView marketId="m1" />)
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("mounts the action tabs for this market (R8)", () => {
    wrap(<MarketView marketId="m1" />)
    expect(screen.getByRole("region", { name: "Actions for m1" })).toBeTruthy()
  })
  it("opens the Get test tokens dialog for this market from the compliance card", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permYt: live(false) })
    wrap(<MarketView marketId="m1" />)
    expect(screen.queryByRole("dialog")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Get test tokens" }))
    expect(screen.getByRole("dialog", { name: "Get test tokens for m1" })).toBeTruthy()
  })
})
