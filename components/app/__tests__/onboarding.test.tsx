import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { MarketPermission } from "@/lib/protocol/onboarding"
import type { Live, WalletState } from "@/lib/protocol/types"
import { accountState } from "./fixtures"

const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const ISSUER = "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB"
const FRIENDBOT = "https://friendbot.example"
const FAUCET_CALL = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: ADDRESS }) }

type TestMarket = { marketId: string; displayName: string; underlying: { code: string; issuer: string; sac: string; decimals: number }; contracts: object }
const market = (marketId: string, code = "STA"): TestMarket => ({
  marketId,
  displayName: `${code} · ${marketId}`,
  underlying: { code, issuer: ISSUER, sac: "CSAC", decimals: 7 },
  contracts: {},
})

const mocks = vi.hoisted(() => ({
  manifest: {
    network: "testnet" as "testnet" | "local" | "mainnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.example",
    horizonUrl: "https://horizon.example",
    friendbotUrl: "https://friendbot.example" as string | undefined,
    markets: [] as unknown[],
  },
  wallet: { status: "connected" } as WalletState,
  account: undefined as AccountState | undefined,
  accountPending: false,
  perms: [] as MarketPermission[] | undefined,
  permsStale: false,
  sign: vi.fn(),
  addTrustline: vi.fn(),
  fetch: vi.fn(),
  order: [] as string[],
  /** What the chain shows after the faucet ran (the refetched state). */
  afterFaucet: undefined as (() => void) | undefined,
}))

vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => ({ state: mocks.wallet, sign: mocks.sign, connect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock("@/hooks/use-account-state", () => ({
  useAccountState: () => ({ data: mocks.account, isPending: mocks.accountPending, stale: false }),
}))
vi.mock("@/hooks/use-market-permissions", () => ({
  useMarketPermissions: () => ({ data: mocks.perms, isPending: false, stale: mocks.permsStale }),
}))
// No real transaction is built under jsdom (R13): the trustline step is mocked; it still signs through the wallet.
vi.mock("@/lib/protocol/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/onboarding")>()),
  addTrustline: mocks.addTrustline,
}))

import { OnboardingDialog } from "../onboarding/onboarding-dialog"
import { WalletButton } from "../shell/wallet-button"

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 1 })
const fresh = () =>
  accountState({
    accountExists: live(false),
    trustline: live("none"),
    sacAuthorized: live(false),
    permAllowed: live(false),
    permPt: live(false),
    permYt: live(false),
    underlying: live(0n),
  })
const ready = () =>
  accountState({
    accountExists: live(true),
    trustline: live("authorized"),
    sacAuthorized: live(true),
    permAllowed: live(true),
    permPt: live(true),
    permYt: live(true),
    underlying: live(5_000n * 10n ** 7n),
  })
const perms = (granted: boolean, marketIds = (mocks.manifest.markets as TestMarket[]).map((m) => m.marketId)): MarketPermission[] =>
  marketIds.map((marketId) => ({ marketId, permPt: live(granted), permYt: live(granted) }))
/** The chain after a successful faucet run: everything granted and funded. */
const onboarded = () => {
  mocks.account = ready()
  mocks.perms = perms(true)
}

function respond(url: string, init?: RequestInit): Response {
  if (url.startsWith(FRIENDBOT)) {
    mocks.order.push("friendbot")
    return new Response("{}", { status: 200 })
  }
  if (url === "/api/faucet") {
    mocks.order.push(`faucet ${String(init?.body)}`)
    mocks.afterFaucet?.()
    return Response.json({ performed: ["authorize", "grant_account", "grant_pt", "grant_yt", "pay"] })
  }
  throw new Error(`unexpected fetch ${url}`)
}

let client: QueryClient
function renderDialog(props: { marketId?: string } = {}) {
  client = new QueryClient()
  vi.spyOn(client, "invalidateQueries")
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <OnboardingDialog open onOpenChange={onOpenChange} {...props} />
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const faucetText = `faucet ${JSON.stringify({ account: ADDRESS })}`

beforeEach(() => {
  mocks.manifest.network = "testnet"
  mocks.manifest.friendbotUrl = FRIENDBOT
  mocks.manifest.markets = [market("m1")]
  mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: mocks.manifest.networkPassphrase }
  mocks.account = fresh()
  mocks.perms = perms(false)
  mocks.permsStale = false
  mocks.accountPending = false
  mocks.order = []
  mocks.afterFaucet = onboarded
  mocks.sign.mockImplementation(async () => "signed-xdr")
  mocks.addTrustline.mockImplementation(async (p: { sign: (xdr: string) => Promise<string> }) => {
    mocks.order.push("trustline")
    await p.sign("unsigned-change-trust")
    return { hash: "ab".repeat(32) }
  })
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => respond(url, init))
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe("onboarding dialog", () => {
  it("runs Friendbot, the trustline and the faucet in order for a fresh wallet, then refreshes the account", async () => {
    const user = userEvent.setup()
    renderDialog()
    const dialog = screen.getByRole("dialog", { name: "Get test tokens" })
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    expect(await within(dialog).findByText(/your account is ready/i)).toBeTruthy()
    expect(mocks.order).toEqual(["friendbot", "trustline", faucetText])
    expect(mocks.fetch).toHaveBeenCalledWith(`${FRIENDBOT}/?addr=${ADDRESS}`)
    expect(mocks.fetch).toHaveBeenCalledWith("/api/faucet", FAUCET_CALL)
    // The changeTrust is signed in Freighter, for the connected account.
    expect(mocks.sign).toHaveBeenCalledWith("unsigned-change-trust", ADDRESS)
    expect(mocks.addTrustline).toHaveBeenCalledWith(
      expect.objectContaining({ account: ADDRESS, asset: expect.objectContaining({ code: "STA", issuer: ISSUER }) }),
    )
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "testnet"] })
    expect(within(dialog).getAllByText("Done")).toHaveLength(3)
  })

  it("skips completed steps", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("Done")).toHaveLength(2)
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    await within(dialog).findByText(/your account is ready/i)
    expect(mocks.order).toEqual([faucetText])
    expect(mocks.addTrustline).not.toHaveBeenCalled()
  })

  it("has nothing to run for an onboarded, funded account", () => {
    onboarded()
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("Done")).toHaveLength(3)
    expect(within(dialog).getByText(/nothing left to do/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("judges the grant step from every market, not only the opened one (R44)", async () => {
    const user = userEvent.setup()
    mocks.manifest.markets = [market("m1"), market("m2")]
    // The opened market m1 is fully granted; m2's PT is not.
    mocks.account = ready()
    mocks.perms = [
      { marketId: "m1", permPt: live(true), permYt: live(true) },
      { marketId: "m2", permPt: live(false), permYt: live(true) },
    ]
    renderDialog({ marketId: "m1" })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).queryByText(/nothing left to do/i)).toBeNull()
    expect(within(dialog).getAllByText("Done")).toHaveLength(2)
    // After the run, done-ness comes from the refetched state only: m2 still shows ungranted.
    mocks.afterFaucet = undefined
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    expect(await within(dialog).findByText(/does not show every change yet/i)).toBeTruthy()
    expect(within(dialog).queryByText(/your account is ready/i)).toBeNull()
    expect(within(dialog).getByText("Sent — confirming")).toBeTruthy()
    expect(mocks.order).toEqual([faucetText])
  })

  it("refuses when the markets do not share one test asset (R44)", () => {
    mocks.manifest.markets = [market("m1"), market("m2", "STB")]
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/supports a single test asset/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("starts one run on a double click (minor 4)", async () => {
    renderDialog()
    const dialog = screen.getByRole("dialog")
    const start = within(dialog).getByRole("button", { name: "Start" })
    // Both clicks land before React re-renders (one act): the disabled state cannot stop the second.
    act(() => {
      fireEvent.click(start)
      fireEvent.click(start)
    })
    expect(await within(dialog).findByText(/your account is ready/i)).toBeTruthy()
    expect(mocks.order).toEqual(["friendbot", "trustline", faucetText])
  })

  it("hides Friendbot when the network has none, and names the cause when the account is missing", async () => {
    const user = userEvent.setup()
    mocks.manifest.friendbotUrl = undefined
    mocks.account = accountState({ accountExists: live(true), trustline: live("none"), permAllowed: live(false) })
    const first = renderDialog()
    let dialog = screen.getByRole("dialog")
    expect(within(dialog).queryByText(/friendbot/i)).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    await within(dialog).findByText(/your account is ready/i)
    expect(mocks.order).toEqual(["trustline", faucetText])
    expect(first.onOpenChange).not.toHaveBeenCalled()

    cleanup()
    mocks.order = []
    mocks.account = fresh()
    mocks.perms = perms(false)
    renderDialog()
    dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/does not exist on this network yet/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("stops at a failing step, names its cause, and refreshes what was done", async () => {
    const user = userEvent.setup()
    mocks.addTrustline.mockRejectedValueOnce(new Error("The user declined the request in Freighter."))
    renderDialog()
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    expect(await within(dialog).findByText(/declined the request in Freighter/)).toBeTruthy()
    expect(mocks.order).toEqual(["friendbot"])
    expect(mocks.fetch).not.toHaveBeenCalledWith("/api/faucet", expect.anything())
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy()
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "testnet"] })
  })

  it("explains a faucet refusal in plain words, with its retry delay", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    mocks.fetch.mockImplementation(async () =>
      Response.json({ error: "rate_limited", message: "x", retryAfterSeconds: 60 }, { status: 429 }),
    )
    renderDialog()
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    expect(await within(dialog).findByText(/less than a minute ago.*Try again in 60 seconds/i)).toBeTruthy()
  })

  it("names the step a failed faucet run stopped at, in neutral words, and explains busy (minor 6, R43)", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    mocks.fetch.mockImplementation(async () => Response.json({ error: "failed", step: "grant_pt" }, { status: 502 }))
    renderDialog()
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    const failed = await within(dialog).findByRole("alert")
    expect(failed.textContent).toMatch(/^The faucet could not finish — try again/)
    expect(failed.textContent).toMatch(/allowing your account on PT/)
    expect(failed.textContent).not.toMatch(/transaction/)

    mocks.fetch.mockImplementation(async () => Response.json({ error: "busy", retryAfterSeconds: 60 }, { status: 503 }))
    await user.click(within(dialog).getByRole("button", { name: "Try again" }))
    expect(await within(dialog).findByText(/The faucet is busy — try again in a minute/)).toBeTruthy()
  })

  it("asks for a connected wallet, and waits for the account read", () => {
    mocks.wallet = { status: "disconnected" }
    renderDialog()
    expect(within(screen.getByRole("dialog")).getByText(/connect your wallet/i)).toBeTruthy()
    cleanup()
    mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: mocks.manifest.networkPassphrase }
    mocks.account = undefined
    mocks.accountPending = true
    renderDialog()
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("does not offer Start while the market permissions cannot be read (round 2)", () => {
    const check = () => {
      const dialog = screen.getByRole("dialog")
      expect(within(dialog).getByText(/permissions on the markets could not be read/i)).toBeTruthy()
      expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
      cleanup()
    }
    mocks.permsStale = true
    renderDialog()
    check()
    mocks.permsStale = false
    mocks.perms = undefined
    renderDialog()
    check()
    mocks.perms = [{ marketId: "m1", permPt: { status: "unavailable", error: "rpc down" }, permYt: live(false) }]
    renderDialog()
    check()
  })

  it("asks to wait a minute after a no_trustline refusal, as the faucet's limit does (round 2)", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    mocks.fetch.mockImplementation(async () => Response.json({ error: "no_trustline" }, { status: 409 }))
    renderDialog()
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    const alert = await within(dialog).findByRole("alert")
    expect(alert.textContent).toMatch(/try again in a minute/i)
    expect(alert.textContent).not.toMatch(/few seconds/i)
  })

  it("refuses to start while the account cannot be read", () => {
    mocks.account = accountState({ accountExists: { status: "unavailable", error: "horizon down" } })
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/could not be read/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("is not offered on mainnet", () => {
    mocks.manifest.network = "mainnet"
    renderDialog()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("wallet menu", () => {
  function renderButton() {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WalletButton />
      </QueryClientProvider>,
    )
  }

  it("offers Get test tokens on testnet, which opens the dialog", async () => {
    const user = userEvent.setup()
    onboarded()
    renderButton()
    await user.click(screen.getByRole("button", { name: /GBZX.*MADI/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Get test tokens" }))
    expect(await screen.findByRole("dialog", { name: "Get test tokens" })).toBeTruthy()
  })

  it("does not offer it on mainnet", async () => {
    const user = userEvent.setup()
    mocks.manifest.network = "mainnet"
    renderButton()
    await user.click(screen.getByRole("button", { name: /GBZX.*MADI/ }))
    await screen.findByRole("menuitem", { name: /disconnect/i })
    expect(screen.queryByRole("menuitem", { name: "Get test tokens" })).toBeNull()
  })
})

// The trustline step itself, with its signature checks, is covered in lib/protocol/__tests__/onboarding.test.ts.
