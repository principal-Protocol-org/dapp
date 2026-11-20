import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import { SubmissionRejectedError } from "@/lib/protocol/stellar"
import type { Network, WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountState as fixtureAccount, down, live } from "./fixtures"

const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const ISSUER = "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB"
const HASH = "ab".repeat(32)
const UNDERLYING = { code: "USDY", issuer: ISSUER, sac: "CSAC", decimals: 7 }
const OTHER = { code: "EURC", issuer: "GOTHERISSUER", sac: "COTHERSAC", decimals: 7 }

type Deferred = { resolve: (v: { hash: string }) => void; reject: (e: unknown) => void }

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  wallet: { status: "disconnected" } as WalletState,
  account: undefined as AccountState | undefined,
  sign: vi.fn(),
  addTrustline: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-market-compliance", () => ({
  useMarketCompliance: () => ({
    data: { status: "live", value: { kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: ISSUER }, ledger: 1 },
    isPending: false,
  }),
}))
vi.mock("@/hooks/use-account-state", () => ({ useAccountState: () => ({ data: mocks.account, isPending: false, stale: false }) }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet, sign: mocks.sign }) }))
// No real transaction is built under jsdom: the trustline is mocked; it still signs through the wallet.
vi.mock("@/lib/protocol/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/onboarding")>()),
  addTrustline: mocks.addTrustline,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { ComplianceContent } from "../market/compliance-card"

const manifest = (network: Network, over: Record<string, unknown> = {}) => ({
  network,
  networkPassphrase: network === "mainnet" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
  rpcUrl: "https://rpc.example",
  markets: [
    { marketId: "m0", displayName: "Other", underlying: OTHER, contracts: {} },
    { marketId: "m1", displayName: "USDY · test", underlying: UNDERLYING, contracts: {} },
  ],
  ...over,
})

/** A compliant account unless `over` says otherwise (the shared fixture has no YT grant). */
const accountState = (over: Partial<AccountState> = {}) => fixtureAccount({ permYt: live(true), ...over })

/** A connected wallet whose account has no trustline yet: the issuer cannot authorize it, and Principal does not know it. */
const noTrustline = () =>
  accountState({ trustline: live("none"), sacAuthorized: live(false), permAllowed: live(false), permPt: live(false), permYt: live(false) })

let client: QueryClient
let onGetTestTokens: ReturnType<typeof vi.fn<() => void>>
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(client, "invalidateQueries")
  onGetTestTokens = vi.fn<() => void>()
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ComplianceContent marketId="m1" onGetTestTokens={onGetTestTokens} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}
const account = () => screen.getByRole("region", { name: "Your account" })
const accessBlock = () => screen.queryByRole("region", { name: "Request access" })
/** The fix lines, as shown. */
const fixes = () => within(account()).queryAllByText(/^Fix: /).map((p) => p.textContent)

beforeEach(() => {
  mocks.manifest = manifest("testnet")
  mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: "Test SDF Network ; September 2015" }
  mocks.account = accountState()
  mocks.sign.mockReset().mockImplementation(async () => "signed-xdr")
  mocks.addTrustline.mockReset().mockImplementation(async (p: { sign: (xdr: string) => Promise<string> }) => {
    await p.sign("unsigned-change-trust")
    return { hash: HASH }
  })
  for (const f of Object.values(mocks.toast)) f.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Testnet and a local network: the texts are unchanged", () => {
  it.each(["testnet", "local"] as const)("%s: the Friendbot and Get test tokens fixes, and no access block", (network) => {
    mocks.manifest = manifest(network)
    mocks.account = accountState({
      accountExists: live(false),
      trustline: live("none"),
      sacAuthorized: live(false),
      permAllowed: live(false),
      permPt: live(false),
      permYt: live(false),
    })
    show()
    expect(fixes()).toEqual([
      "Fix: Fund the account with Friendbot, then reload.",
      "Fix: Add a trustline to the underlying asset in your wallet.",
      "Fix: Add a trustline to the underlying asset in your wallet.",
    ])
    expect(within(account()).getByText(/Fund it first \(on Testnet, use Friendbot\)\./)).toBeTruthy()
    // The three Permissioning items keep their Get test tokens button.
    expect(within(account()).getAllByRole("button", { name: "Get test tokens" })).toHaveLength(3)
    expect(accessBlock()).toBeNull()
  })

  it("an unauthorized trustline keeps Get test tokens, which opens the dialog", async () => {
    mocks.account = accountState({ trustline: live("unauthorized"), sacAuthorized: live(false) })
    show()
    expect(within(account()).getByText(/On Testnet, Get test tokens asks the issuer to authorize it\./)).toBeTruthy()
    await userEvent.click(within(account()).getByRole("button", { name: "Get test tokens" }))
    expect(onGetTestTokens).toHaveBeenCalledTimes(1)
    expect(within(account()).queryByRole("button", { name: "Add trustline" })).toBeNull()
  })
})

describe("Mainnet: no faucet, access on request", () => {
  beforeEach(() => {
    mocks.manifest = manifest("mainnet")
    mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: "Public Global Stellar Network ; September 2015" }
  })

  it("a missing account is funded with XLM, the grants are asked for below; nothing names a faucet", () => {
    mocks.account = accountState({
      accountExists: live(false),
      trustline: live("none"),
      sacAuthorized: live(false),
      permAllowed: live(false),
      permPt: live(false),
      permYt: live(false),
    })
    show()
    expect(fixes()).toEqual([
      "Fix: Send XLM to this account from an exchange or another wallet, then reload.",
      "Fix: Add a trustline to the underlying asset in your wallet.",
      "Fix: Add a trustline to the underlying asset in your wallet.",
      "Fix: Request access below.",
      "Fix: Request access below.",
      "Fix: Request access below.",
    ])
    expect(within(account()).getByText(/Your account does not exist on the network yet\. Send it XLM first\./)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Get test tokens" })).toBeNull()
    expect(document.body.textContent).not.toMatch(/Friendbot|Get test tokens|Testnet|test tokens/)
  })

  it("an unauthorized trustline: access is granted by the protocol team", () => {
    mocks.account = accountState({ trustline: live("unauthorized"), sacAuthorized: live(false) })
    show()
    expect(within(account()).getByText(/Your trustline is not authorized yet\. Access to this market is granted by the protocol team\./)).toBeTruthy()
    expect(fixes()).toEqual(["Fix: Request access below."])
    const block = within(accessBlock() as HTMLElement)
    expect(block.getByText("Issuer authorization")).toBeTruthy()
    // The trustline exists: no sentence about adding it.
    expect(block.queryByText(/Add the trustline first/)).toBeNull()
  })

  it("the access block: the full address with a copy button, what is missing, and Ask the protocol team without a contact", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    mocks.account = accountState({ permAllowed: live(false), permYt: live(false) })
    show()
    const block = within(accessBlock() as HTMLElement)
    expect(block.getByRole("heading", { name: "Request access" })).toBeTruthy()
    const address = block.getByText(ADDRESS)
    // 56 characters on a 375 px screen: it wraps.
    expect(address.className).toMatch(/break-all/)
    expect(block.getByText("Still missing for this market:")).toBeTruthy()
    expect(block.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Principal permissioning", "YT permissioning"])
    expect(block.queryByText(/Add the trustline first/)).toBeNull()
    expect(block.getByText("Ask the protocol team.")).toBeTruthy()
    expect(block.queryByRole("link")).toBeNull()
    await userEvent.click(block.getByRole("button", { name: "Copy address" }))
    expect(writeText).toHaveBeenCalledWith(ADDRESS)
  })

  it("a missing trustline: the block says to add it first, beside the Add trustline button", () => {
    mocks.account = noTrustline()
    show()
    const block = within(accessBlock() as HTMLElement)
    expect(block.getByText("Add the trustline first: the issuer cannot authorize an account without one.")).toBeTruthy()
    expect(block.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Trustline",
      "Issuer authorization",
      "Principal permissioning",
      "PT permissioning",
      "YT permissioning",
    ])
    expect(within(account()).getByRole("button", { name: "Add trustline" })).toBeTruthy()
  })

  it("an unread item is not listed as missing: it sits apart, under Could not be checked, with its own reason", () => {
    mocks.account = accountState({ sacAuthorized: down("timeout"), permAllowed: live(false), permPt: down("HTTP 429") })
    show()
    const block = within(accessBlock() as HTMLElement)
    const list = (heading: string) => within(block.getByText(heading).nextElementSibling as HTMLElement).getAllByRole("listitem").map((li) => li.textContent)
    expect(list("Still missing for this market:")).toEqual(["Principal permissioning"])
    expect(list("Could not be checked:")).toEqual([
      "The issuer's authorization could not be checked right now (timeout).",
      "PT permissioning could not be checked right now (HTTP 429).",
    ])
  })

  it("a blocked item is still missing; nothing unread means no Could not be checked list", () => {
    mocks.account = accountState({ trustline: live("unauthorized"), sacAuthorized: live(false), permYt: live(false) })
    show()
    const block = within(accessBlock() as HTMLElement)
    expect(block.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Issuer authorization", "YT permissioning"])
    expect(block.queryByText("Could not be checked:")).toBeNull()
  })

  it("with an https contact: Send your address to, a link that opens in a new tab", () => {
    mocks.manifest = manifest("mainnet", { accessContact: { label: "the Principal access desk", url: "https://principal.example/access" } })
    mocks.account = accountState({ permPt: live(false) })
    show()
    const block = within(accessBlock() as HTMLElement)
    const link = block.getByRole("link", { name: "the Principal access desk" })
    expect(link.getAttribute("href")).toBe("https://principal.example/access")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(link.parentElement?.textContent).toBe("Send your address to the Principal access desk.")
    expect(block.queryByText("Ask the protocol team.")).toBeNull()
  })

  it("with a mailto contact: the link opens normally", () => {
    mocks.manifest = manifest("mainnet", { accessContact: { label: "access@principal.example", url: "mailto:access@principal.example" } })
    mocks.account = accountState({ permPt: live(false) })
    show()
    const link = within(accessBlock() as HTMLElement).getByRole("link", { name: "access@principal.example" })
    expect(link.getAttribute("href")).toBe("mailto:access@principal.example")
    expect(link.getAttribute("target")).toBeNull()
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("no access block when everything is OK, or when only the issuer blocks the account", () => {
    show()
    expect(accessBlock()).toBeNull()
    cleanup()
    mocks.account = accountState({ sacAuthorized: live(false) })
    show()
    expect(fixes()).toEqual(["Fix: Contact the issuer of the underlying asset."])
    expect(accessBlock()).toBeNull()
  })

  it("no wallet: no button and no access block, only the prompt to connect", () => {
    mocks.wallet = { status: "disconnected" }
    mocks.account = noTrustline()
    show()
    expect(within(account()).getByText("Connect a wallet to check whether your account can use this market.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add trustline" })).toBeNull()
    expect(accessBlock()).toBeNull()
  })
})

describe("Add trustline (Mainnet only, spec 0005)", () => {
  beforeEach(() => {
    mocks.manifest = manifest("mainnet")
    mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: "Public Global Stellar Network ; September 2015" }
  })

  it("mainnet: offered on the trustline item while the trustline is missing", () => {
    mocks.account = noTrustline()
    show()
    const buttons = within(account()).getAllByRole("button", { name: "Add trustline" })
    expect(buttons).toHaveLength(1)
    // On the trustline item, beside its fix line.
    expect(buttons[0].closest("li")?.textContent).toMatch(/You have no trustline to the underlying asset/)
    expect(buttons[0].closest("li")?.textContent).toMatch(/Fix: Add a trustline to the underlying asset in your wallet\./)
  })

  it.each(["testnet", "local"] as const)("%s: never offered, where Get test tokens adds the trustline; the item keeps its fix line", (network) => {
    mocks.manifest = manifest(network)
    mocks.wallet = { status: "connected", publicKey: ADDRESS, networkPassphrase: "Test SDF Network ; September 2015" }
    mocks.account = noTrustline()
    show()
    expect(screen.queryByRole("button", { name: "Add trustline" })).toBeNull()
    const item = within(account()).getByText(/You have no trustline to the underlying asset/).closest("li")
    expect(item?.textContent).toBe("Action needed. You have no trustline to the underlying asset. Add one before you can hold it.Fix: Add a trustline to the underlying asset in your wallet.")
  })

  it("not offered once the trustline exists", () => {
    mocks.account = accountState({ trustline: live("unauthorized"), sacAuthorized: live(false) })
    show()
    expect(screen.queryByRole("button", { name: "Add trustline" })).toBeNull()
  })

  it("trusts this market's underlying for the connected address, signing with the wallet, then refreshes the account reads", async () => {
    mocks.manifest = manifest("mainnet")
    mocks.account = noTrustline()
    show()
    await userEvent.click(screen.getByRole("button", { name: "Add trustline" }))
    expect(await screen.findByText("Trustline added. Your account checks update within a few seconds.")).toBeTruthy()
    await waitFor(() => expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "mainnet"] }))
    expect(mocks.addTrustline).toHaveBeenCalledTimes(1)
    const call = mocks.addTrustline.mock.calls[0][0]
    expect(call.manifest).toBe(mocks.manifest)
    expect(call.account).toBe(ADDRESS)
    // This market's underlying, never another market's asset.
    expect(call.asset).toEqual(UNDERLYING)
    expect(mocks.sign).toHaveBeenCalledWith("unsigned-change-trust", ADDRESS)
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "mainnet"] })
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    expect(mocks.toast.success.mock.calls[0][0]).toBe("Trustline added.")
  })

  it("while it runs the button is off and says so; a second press signs nothing more", async () => {
    let pending: Deferred | undefined
    mocks.addTrustline.mockImplementation(() => new Promise((resolve, reject) => (pending = { resolve, reject })))
    mocks.account = noTrustline()
    show()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add trustline" }))
    const busy = screen.getByRole("button", { name: "Adding trustline…" })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    expect(busy.getAttribute("aria-busy")).toBe("true")
    await user.click(busy)
    expect(mocks.addTrustline).toHaveBeenCalledTimes(1)
    pending?.resolve({ hash: HASH })
    expect(await screen.findByText("Trustline added. Your account checks update within a few seconds.")).toBeTruthy()
    // Sent: not offered again until the reads say otherwise.
    expect(screen.queryByRole("button", { name: "Add trustline" })).toBeNull()
    expect(mocks.addTrustline).toHaveBeenCalledTimes(1)
  })

  it("a failure is shown with the transaction notice, and the button is offered again", async () => {
    mocks.addTrustline.mockRejectedValue(new Error("The trustline transaction failed on the network. Nothing changed; try again."))
    mocks.account = noTrustline()
    show()
    await userEvent.click(screen.getByRole("button", { name: "Add trustline" }))
    const notice = await within(account()).findByRole("status")
    expect(notice.textContent).toMatch(/Adding the trustline did not finish\./)
    expect(notice.textContent).toMatch(/The trustline transaction failed on the network\. Nothing changed; try again\./)
    const again = screen.getByRole("button", { name: "Add trustline" })
    expect((again as HTMLButtonElement).disabled).toBe(false)
    // It may have landed: the reads are refreshed either way.
    await waitFor(() => expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["account", "mainnet"] }))
    // Pressed again, it tries again.
    mocks.addTrustline.mockResolvedValue({ hash: HASH })
    await userEvent.click(again)
    expect(await screen.findByText("Trustline added. Your account checks update within a few seconds.")).toBeTruthy()
    expect(mocks.addTrustline).toHaveBeenCalledTimes(2)
  })

  it("a refusal by the network keeps its hash and says it was not accepted", async () => {
    mocks.manifest = manifest("mainnet")
    mocks.addTrustline.mockRejectedValue(new SubmissionRejectedError("The network refused the transaction: the account does not hold enough XLM.", HASH))
    mocks.account = noTrustline()
    show()
    await userEvent.click(screen.getByRole("button", { name: "Add trustline" }))
    const notice = await within(account()).findByRole("status")
    expect(notice.textContent).toMatch(/^The trustline was not accepted by the network\./)
    expect(notice.textContent).toContain(HASH)
    expect(within(notice).getByRole("link").getAttribute("href")).toBe(`https://stellar.expert/explorer/public/tx/${HASH}`)
  })
})
