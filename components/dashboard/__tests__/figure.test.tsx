import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { nativeToScVal } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { evidenceRows, verifyCommand, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatAmountFixed } from "@/lib/protocol/format"
import type { Live, ReadSource } from "@/lib/protocol/types"

const mocks = vi.hoisted(() => ({
  manifest: { network: "testnet" as "testnet" | "local" | "mainnet", rpcUrl: "https://rpc.test", rpcFallbackUrls: undefined as string[] | undefined },
}))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))

import { CopyEvidence } from "../copy-evidence"
import { Figure } from "../figure"

const SY = "CA62ARXF2HOK3IJOSRRYFFDA2P3WCYGHN5F7NBBYB6I7NNEUYE367F2I"
const SAC = "CAZIZBKBJ6WCXYQ2K6EOAAQ5BVOQBUUW5U7NRYGWQW6FFHAMNBRMUSDY"
const ESCROW = "CAMOWUWOWTIR6MJDNDCI6DQV4UNEZM6JLAMNNBHT2ONW6RVUTOUGN24Q"
const RPC = "https://rpc.test"

const xdrOf = (value: bigint) => nativeToScVal(value, { type: "i128" }).toXDR("base64")

const totalUnderlying: ReadSource = { contractId: SY, fn: "total_underlying", args: [], rawXdr: xdrOf(2_230_113_029_038n), ledger: 5_720_087, rpcUrl: RPC }
const escrowBalance: ReadSource = {
  contractId: SAC,
  fn: "balance",
  args: [{ type: "address", value: ESCROW, name: "id" }],
  rawXdr: xdrOf(0n),
  ledger: 5_720_086,
  rpcUrl: RPC,
}
const tvl: Live<bigint> = {
  status: "live",
  value: 2_230_113_029_038n,
  ledger: 5_720_087,
  sources: [totalUnderlying, escrowBalance],
  ledgerSpread: { min: 5_720_086, max: 5_720_087 },
}
const usdy = (v: bigint) => `${formatAmountFixed(v, 7)} USDY`
const SCALE_TEXT = "7 decimals: 10,000,000 = 1 USDY"

let writeText: ReturnType<typeof vi.fn>

/** The command block whose text is exactly `command` (its words are separate spans, so flags never split). */
const commandMatcher = (command: string) => (_: string, el: Element | null) => el?.tagName === "CODE" && el.textContent === command

/** user-event installs its own clipboard on setup, so the spy goes in after it. */
function setup() {
  const user = userEvent.setup()
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  return user
}

beforeEach(() => {
  mocks.manifest = { network: "testnet", rpcUrl: RPC, rpcFallbackUrls: undefined }
  writeText = vi.fn(async () => {})
})

afterEach(() => vi.clearAllMocks())

describe("Figure", () => {
  it("shows the formatted value and an info button named for the figure", () => {
    render(<Figure label="TVL" live={tvl} format={usdy} scale={SCALE_TEXT} />)
    expect(screen.getByText("223,011.30 USDY")).toBeTruthy()
    expect(screen.getByRole("button", { name: "How to verify TVL" })).toBeTruthy()
  })

  it("shows Unavailable, never a number, when the read failed; its button opens the reason", async () => {
    const down: Live<bigint> = { status: "unavailable", error: "rpc down", source: { contractId: SY, fn: "total_underlying", args: [], rpcUrl: RPC } }
    const user = setup()
    render(<Figure label="TVL" live={down} format={usdy} />)
    expect(screen.getByText("Unavailable")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Why TVL is unavailable, and how to verify it" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Unavailable: rpc down")).toBeTruthy()
    // The attempted call can still be re-run.
    expect(within(dialog).getByText(commandMatcher(verifyCommand("testnet", down.source!)))).toBeTruthy()
  })
})

describe("the How to verify drawer (D-7)", () => {
  it("shows label, value, raw value with scale, contract links, call, ledger, RPC, staleness and the commands", async () => {
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} scale={SCALE_TEXT} />)
    await user.click(screen.getByRole("button", { name: "How to verify TVL" }))
    const dialog = screen.getByRole("dialog", { name: /TVL/ })
    const d = within(dialog)
    expect(d.getByText("223,011.30 USDY")).toBeTruthy()
    expect(d.getByText("total_underlying=2230113029038; balance=0")).toBeTruthy()
    expect(d.getByText(SCALE_TEXT)).toBeTruthy()
    expect(d.getByRole("link", { name: new RegExp(SY) }).getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/contract/${SY}`)
    expect(d.getByRole("link", { name: new RegExp(SAC) }).getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/contract/${SAC}`)
    expect(d.getByText(`total_underlying(); balance(id=${ESCROW})`)).toBeTruthy()
    expect(d.getByText("5720086–5720087")).toBeTruthy()
    expect(d.getByText(RPC)).toBeTruthy()
    expect(d.getByText("No fallback RPC configured")).toBeTruthy()
    expect(d.getByText("Read across ledgers 5720086–5720087")).toBeTruthy()
    expect(d.getByText(commandMatcher(verifyCommand("testnet", totalUnderlying)))).toBeTruthy()
    expect(d.getByText(commandMatcher(verifyCommand("testnet", escrowBalance)))).toBeTruthy()
    // The raw XDR of each read sits in a collapsed section.
    const xdr = d.getByText("Raw XDR (base64)").closest("details")
    expect(xdr).toBeTruthy()
    expect(xdr?.open).toBe(false)
    expect(within(xdr as HTMLElement).getByText(totalUnderlying.rawXdr)).toBeTruthy()
    expect(within(xdr as HTMLElement).getByText(escrowBalance.rawXdr)).toBeTruthy()
  })

  it("copies a command", async () => {
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} />)
    await user.click(screen.getByRole("button", { name: "How to verify TVL" }))
    await user.click(screen.getByRole("button", { name: "Copy the total_underlying command" }))
    expect(writeText).toHaveBeenCalledWith(verifyCommand("testnet", totalUnderlying))
  })

  it("is a modal dialog: Esc closes it and focus returns to the info button", async () => {
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} />)
    const trigger = screen.getByRole("button", { name: "How to verify TVL" })
    await user.click(trigger)
    expect(screen.getByRole("dialog")).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("names the fallback RPCs when the manifest has some", async () => {
    mocks.manifest.rpcFallbackUrls = ["https://rpc-b.test"]
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} />)
    await user.click(screen.getByRole("button", { name: "How to verify TVL" }))
    expect(within(screen.getByRole("dialog")).getByText("Fallback: https://rpc-b.test")).toBeTruthy()
  })

  it("on a local network the contract is plain text (no explorer)", async () => {
    mocks.manifest.network = "local"
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} />)
    await user.click(screen.getByRole("button", { name: "How to verify TVL" }))
    const d = within(screen.getByRole("dialog"))
    expect(d.queryByRole("link", { name: new RegExp(SY) })).toBeNull()
    // The id as plain text in the Contracts row (the command's --id shows it too).
    expect(d.getAllByText(SY).some((el) => !el.closest("code") && el.tagName !== "A")).toBe(true)
  })

  it("says why there is no command rather than print a guessed one", async () => {
    const odd: Live<bigint> = {
      status: "live",
      value: 1n,
      ledger: 9,
      source: { contractId: SY, fn: "mystery", args: [{ type: "u32", value: 3 }], rawXdr: xdrOf(1n), ledger: 9, rpcUrl: RPC },
    }
    const user = setup()
    render(<Figure label="Odd" live={odd} format={String} />)
    await user.click(screen.getByRole("button", { name: "How to verify Odd" }))
    expect(within(screen.getByRole("dialog")).getByText(/^No command: No argument name is known for mystery/)).toBeTruthy()
  })

  it("long ids and commands wrap, so the drawer never widens a 375 px screen", async () => {
    const user = setup()
    render(<Figure label="TVL" live={tvl} format={usdy} />)
    await user.click(screen.getByRole("button", { name: "How to verify TVL" }))
    const d = within(screen.getByRole("dialog"))
    const code = d.getByText(commandMatcher(verifyCommand("testnet", totalUnderlying)))
    expect(code.className).toContain("wrap-anywhere")
    expect(within(code).getByText("--source-account").className).toContain("whitespace-nowrap")
    expect(d.getByRole("link", { name: new RegExp(SY) }).className).toContain("wrap-anywhere")
  })
})

describe("CopyEvidence", () => {
  const figures: VerifiableFigure[] = [
    { label: "TVL", display: "223,011.30 USDY", live: tvl },
    { label: "Pool liquidity", display: "Unavailable", live: { status: "unavailable", error: "rpc down" } },
  ]

  it("copies the page's figures as the evidence table", async () => {
    const user = setup()
    render(<CopyEvidence figures={figures} />)
    await user.click(screen.getByRole("button", { name: "Copy evidence table" }))
    expect(writeText).toHaveBeenCalledWith(evidenceRows(figures))
  })

  it("is disabled while no figure has been read", () => {
    render(<CopyEvidence figures={[]} />)
    expect((screen.getByRole("button", { name: "Copy evidence table" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
