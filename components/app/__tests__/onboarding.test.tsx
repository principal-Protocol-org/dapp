import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { Live, WalletState } from "@/lib/protocol/types"
import { accountState } from "./fixtures"

const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const ISSUER = "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB"
const FRIENDBOT = "https://friendbot.example"

const mocks = vi.hoisted(() => ({
  manifest: {
    network: "testnet" as "testnet" | "local" | "mainnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.example",
    horizonUrl: "https://horizon.example",
    friendbotUrl: "https://friendbot.example" as string | undefined,
    markets: [
      {
        marketId: "m1",
        displayName: "STA · test",
        underlying: { code: "STA", issuer: "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB", sac: "CSAC", decimals: 7 },
        contracts: {},
      },
    ],
  },
  wallet: { status: "connected" } as WalletState,
  account: undefined as AccountState | undefined,
  accountPending: false,
  sign: vi.fn(),
  addTrustline: vi.fn(),
  fetch: vi.fn(),
  order: [] as string[],
}))

vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => ({ state: mocks.wallet, sign: mocks.sign, connect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock("@/hooks/use-account-state", () => ({
  useAccountState: () => ({ data: mocks.account, isPending: mocks.accountPending, stale: false }),
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

function respond(url: string, init?: RequestInit): Response {
  if (url.startsWith(FRIENDBOT)) {
    mocks.order.push("friendbot")
    return new Response("{}", { status: 200 })
  }
  if (url === "/api/faucet") {
    mocks.order.push(`faucet ${String(init?.body)}`)
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

beforeEach(() => {
  mocks.manifest.network = "testnet"
  mocks.manifest.friendbotUrl = FRIENDBOT
  mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: mocks.manifest.networkPassphrase }
  mocks.account = fresh()
  mocks.accountPending = false
  mocks.order = []
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
    expect(mocks.order).toEqual(["friendbot", "trustline", `faucet ${JSON.stringify({ account: ADDRESS })}`])
    expect(mocks.fetch).toHaveBeenCalledWith(`${FRIENDBOT}/?addr=${ADDRESS}`)
    expect(mocks.fetch).toHaveBeenCalledWith("/api/faucet", { method: "POST", body: JSON.stringify({ account: ADDRESS }) })
    // The changeTrust is signed in Freighter, for the connected account.
    expect(mocks.sign).toHaveBeenCalledWith("unsigned-change-trust", ADDRESS)
    expect(mocks.addTrustline).toHaveBeenCalledWith(
      expect.objectContaining({ account: ADDRESS, asset: expect.objectContaining({ code: "STA", issuer: ISSUER }) }),
    )
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "testnet"] })
  })

  it("skips completed steps", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("Done")).toHaveLength(2)
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    await within(dialog).findByText(/your account is ready/i)
    expect(mocks.order).toEqual([`faucet ${JSON.stringify({ account: ADDRESS })}`])
    expect(mocks.addTrustline).not.toHaveBeenCalled()
  })

  it("has nothing to run for an onboarded, funded account", () => {
    mocks.account = ready()
    renderDialog()
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("Done")).toHaveLength(3)
    expect(within(dialog).getByText(/nothing left to do/i)).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Start" })).toBeNull()
    expect(mocks.fetch).not.toHaveBeenCalled()
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
    expect(mocks.order).toEqual(["trustline", `faucet ${JSON.stringify({ account: ADDRESS })}`])
    expect(first.onOpenChange).not.toHaveBeenCalled()

    cleanup()
    mocks.order = []
    mocks.account = fresh()
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

  it("explains a faucet refusal in plain words", async () => {
    const user = userEvent.setup()
    mocks.account = accountState({ accountExists: live(true), trustline: live("unauthorized"), permAllowed: live(false) })
    mocks.fetch.mockImplementation(async () =>
      Response.json({ error: "rate_limited", message: "x", retryAfterSeconds: 60 }, { status: 429 }),
    )
    renderDialog()
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Start" }))
    expect(await within(dialog).findByText(/less than a minute ago/i)).toBeTruthy()
  })

  it("asks for a connected wallet, and waits for the account read", () => {
    mocks.wallet = { status: "disconnected" }
    renderDialog()
    expect(within(screen.getByRole("dialog")).getByText(/connect freighter/i)).toBeTruthy()
    cleanup()
    mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: mocks.manifest.networkPassphrase }
    mocks.account = undefined
    mocks.accountPending = true
    renderDialog()
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Start" })).toBeNull()
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
    mocks.account = ready()
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
