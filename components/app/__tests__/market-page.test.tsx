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
  compliance: undefined as unknown,
  account: undefined as AccountState | undefined,
  wallet: { status: "disconnected" } as WalletState,
  findings: [] as { severity: string; message: string }[],
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => ({ network: "testnet", markets: [MARKET] }),
}))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("@/hooks/use-market-state", () => ({
  useMarketState: () => ({ data: mocks.ms, isPending: false }),
}))
vi.mock("@/hooks/use-market-compliance", () => ({
  useMarketCompliance: () => ({ data: mocks.compliance, isPending: false }),
}))
vi.mock("@/hooks/use-account-state", () => ({
  useAccountState: () => ({ data: mocks.account, isPending: false }),
}))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ledgerTime: LEDGER_TIME, sequence: 1, isError: false }),
}))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => mocks.findings }))

import MarketPage, { generateStaticParams } from "../../../app/app/markets/[marketId]/page"
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
  mocks.compliance = sac
  mocks.account = undefined
  mocks.wallet = { status: "disconnected" }
  mocks.findings = []
  mocks.notFound.mockClear()
})

describe("market page route", () => {
  it("prerenders every manifest market", () => {
    expect(generateStaticParams()).toEqual([{ marketId: "m1" }])
  })
  it("calls notFound for an unknown market id", async () => {
    await expect(MarketPage({ params: Promise.resolve({ marketId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.notFound).toHaveBeenCalled()
  })
  it("renders the market for a known id", async () => {
    const el = await MarketPage({ params: Promise.resolve({ marketId: "m1" }) })
    expect(el.props.marketId).toBe("m1")
  })
})

describe("MarketHeader", () => {
  it("shows the oracle rate, its age, the totals and the reserves", () => {
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByRole("heading", { name: "STA · test" })).toBeTruthy()
    expect(screen.getByText("1.0500")).toBeTruthy()
    expect(screen.getByText("10m 0s ago")).toBeTruthy()
    expect(screen.getByText("PT total supply").nextSibling?.textContent).toBe("500")
    expect(screen.getByText("YT total supply").nextSibling?.textContent).toBe("500")
    expect(screen.getByText("Pool PT reserve").nextSibling?.textContent).toBe("1200")
    expect(screen.getByText("Pool SY reserve").nextSibling?.textContent).toBe("3400")
    expect(screen.getByText("PT price (pool spot)").nextSibling?.textContent).toBe("0.9800")
    expect(screen.getByText("Matures in 10d 0h 0m")).toBeTruthy()
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
})
