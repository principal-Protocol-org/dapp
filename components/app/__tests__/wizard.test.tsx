import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Address, Contract, Keypair, StrKey, xdr } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { deriveMarketContracts } from "@/lib/protocol/factory"
import { minAfterSlippage } from "@/lib/protocol/guards"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import { seedAmounts } from "@/lib/protocol/seed"
import type { ContractInvocation, SimulationOutcome } from "@/lib/protocol/stellar"
import { parseManifest } from "@/lib/protocol/manifest"
import type { ManagerReview } from "@/lib/protocol/review"
import type { Manifest, Market, MarketContractName, WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * The market-creation wizard, steps 1–3 (spec 0002 §5, R5-10): parameters from the current market,
 * the predicted addresses, and the three factory calls, each reviewed and signed by the asset's
 * issuer. Progress is read from the chain: the reads and the ledger entries below stand in for it.
 */

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const pin = (fill: string) => fill.repeat(32)
const SAC = contractAt(7)
const FACTORY = contractAt(40)
const WASM: Record<MarketContractName, string> = {
  sy: pin("a1"),
  pt: pin("a2"),
  yt: pin("a3"),
  config: pin("a4"),
  manager: pin("a5"),
  pool: pin("a6"),
  recoveryEscrow: pin("a7"),
}
const base = parseManifest(structuredClone(testnetJson))
const CURRENT: Market = {
  ...base.markets[0],
  marketId: "usdy-dec",
  displayName: "USDY Dec 2026",
  underlying: { code: "USDY", issuer: Keypair.random().publicKey(), sac: SAC, decimals: 7 },
}
const manifest: Manifest = {
  ...base,
  shared: { ...base.shared, factory: FACTORY },
  wasmHashes: { ...WASM },
  testAsset: { code: "USDY", issuer: CURRENT.underlying.issuer, sac: SAC, decimals: 7, displayName: "USDY (test)" },
  markets: [CURRENT],
}
const SALT = "11".repeat(32)
const predicted = deriveMarketContracts(manifest, SALT)
const ISSUER = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()
const TREASURY = Keypair.random().publicKey()
const PROTOCOL_ADMIN = Keypair.random().publicKey()
const LEDGER = 1_800_000_000
const WAD = 10n ** 18n
const c = CURRENT.contracts

/** The current market's config, read for the defaults: values no code path would invent. */
const CURRENT_READS: Record<string, unknown> = {
  [`${c.config}.tokenization_fee_bps`]: 7,
  [`${c.config}.yt_fee_bps`]: 1500,
  [`${c.config}.swap_fee_tier_bps`]: 20,
  [`${c.config}.protocol_share_bps`]: 2500,
  [`${c.config}.treasury`]: TREASURY,
  [`${c.config}.protocol_admin`]: PROTOCOL_ADMIN,
  [`${c.pt}.name`]: "Principal Token USDY",
  [`${c.pt}.symbol`]: "PT-USDY",
  [`${c.yt}.name`]: "Yield Token USDY",
  [`${c.yt}.symbol`]: "YT-USDY",
  [`${c.pool}.pool_state`]: {
    pt_reserve: 1n,
    sy_reserve: 1n,
    total_lp: 1n,
    rate: 10_000_000n,
    exponent: WAD - (7_776_000n * WAD) / (3n * 31_536_000n),
    fee_rate: 0n,
    seconds_to_maturity: 7_776_000n,
  },
  [`${SAC}.admin`]: ISSUER,
  [`${FACTORY}.predict_market`]: {
    sy_wrapper: predicted.sy,
    pt_token: predicted.pt,
    yt_token: predicted.yt,
    market_config: predicted.config,
    principal_manager: predicted.manager,
    market_pool: predicted.pool,
    recovery_escrow: predicted.recoveryEscrow,
  },
}

const mocks = vi.hoisted(() => ({
  wallet: { status: "disconnected" } as WalletState,
  search: new URLSearchParams(),
  reads: {} as Record<string, unknown>,
  readCalls: [] as string[],
  deployed: [] as string[],
  /** Set: the ledger-entries read fails, like a rate-limited RPC. */
  rpcError: null as string | null,
  prepareManager: vi.fn(),
  execute: vi.fn(),
  toast: vi.fn(),
  /** The seed's simulations (step 6): each call simulated as the signer, with a zero floor. */
  simulate: vi.fn(),
  refresh: vi.fn(),
  /** Set: what the manifest provider hands out instead (the market list after a refresh). */
  manifest: null as Manifest | null,
}))

vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest ?? manifest }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => ({ ledgerTime: LEDGER, sequence: 1, isError: false }) }))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => [] }))
vi.mock("@/hooks/use-execute", () => ({
  useExecute: () => ({ prepareManager: mocks.prepareManager, execute: mocks.execute, pending: false }),
}))
vi.mock("@/components/app/actions/tx-feedback", () => ({ showTxToast: mocks.toast }))
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.search, useRouter: () => ({ refresh: mocks.refresh }) }))
// The chain: contract reads by `contract.function(args)` (or `contract.function`), and the ledger
// entries of the contracts deployed so far.
vi.mock("@/lib/protocol/reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/reader")>()),
  createRpcReader: () => async (call: { contractId: string; functionName: string; args?: { value: unknown }[] }) => {
    const args = (call.args ?? []).map((a) => String(a.value)).join(",")
    const key = `${call.contractId}.${call.functionName}`
    mocks.readCalls.push(key)
    const value = `${key}(${args})` in mocks.reads ? mocks.reads[`${key}(${args})`] : mocks.reads[key]
    if (value === undefined) throw new Error(`no answer for ${key}(${args})`)
    return { value, latestLedger: 10, minResourceFee: "0" }
  },
}))
vi.mock("@/lib/protocol/stellar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol/stellar")>()),
  simulateInvocation: (p: { source: string; invocation: ContractInvocation }) => mocks.simulate(p),
  createRpcServer: () => ({
    // The seed's deferred calls read the ledger time when their turn comes, for their deadline.
    async getLatestLedger() {
      return { sequence: 10, closeTime: LEDGER }
    },
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      if (mocks.rpcError) throw new Error(mocks.rpcError)
      const entries = mocks.deployed.flatMap((id) => {
        const key = new Contract(id).getFootprint()
        if (!keys.some((k) => k.toXDR("base64") === key.toXDR("base64"))) return []
        const kind = (Object.keys(WASM) as MarketContractName[]).find((k) => predicted[k] === id) as MarketContractName
        const val = xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: xdr.ExtensionPoint.v0(),
            contract: Address.fromString(id).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent,
            val: xdr.ScVal.scvContractInstance(
              new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Uint8Array.from(WASM[kind].match(/../g) ?? [], (b) => parseInt(b, 16))), storage: null }),
            ),
          }),
        )
        return [{ key, val }]
      })
      return { entries }
    },
  }),
}))
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })

import { readWizardSalts } from "@/lib/app/wizard-salts"
import { Wizard } from "../manage/wizard"

function managerReview(call: ManagerCall): ManagerReview {
  const now = Date.now()
  return {
    origin: { type: "manager", call },
    invocation: call.invocation,
    unsignedXdr: "AAAA",
    unsignedXdrHash: `sha256:${call.kind}`,
    fee: "100",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: { give: [], getAtLeast: [], fees: ["Network fee: up to 0.00001 XLM"], validUntil: Math.floor(now / 1000) + 300 },
    callTree: [`MarketFactory.${call.invocation.functionName}`],
  }
}

let client: QueryClient
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Wizard />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

const connect = (publicKey: string) => {
  mocks.wallet = { status: "connected", publicKey, networkPassphrase: manifest.networkPassphrase }
}
const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement
const kinds = () => mocks.prepareManager.mock.calls.map(([call]) => (call as ManagerCall).kind)

/** Signs every review the flow opens, one after the other. */
async function signAll(user: ReturnType<typeof userEvent.setup>, count: number) {
  for (let i = 0; i < count; i++) {
    const dialog = await screen.findByRole("dialog")
    if (count > 1) await within(dialog).findByText(`Step ${i + 1} of ${count}`)
    const sign = await within(dialog).findByRole("button", { name: "Sign transaction" })
    await waitFor(() => expect((sign as HTMLButtonElement).disabled).toBe(false))
    await user.click(sign)
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(i + 1))
  }
}

beforeEach(() => {
  mocks.wallet = { status: "disconnected" }
  mocks.search = new URLSearchParams({ salt: SALT })
  mocks.reads = { ...CURRENT_READS }
  mocks.readCalls = []
  mocks.deployed = []
  mocks.rpcError = null
  localStorage.clear()
  mocks.prepareManager.mockReset().mockImplementation(async (call: ManagerCall) => managerReview(call))
  mocks.execute.mockReset().mockResolvedValue({ status: "SUCCESS", hash: "abc" })
  mocks.toast.mockReset()
  mocks.simulate.mockReset()
  mocks.refresh.mockReset()
  mocks.manifest = null
})

describe("step 1: parameters", () => {
  it("defaults come from the current market's config", async () => {
    show()
    await screen.findByRole("heading", { name: /Step 1 of 7: Parameters/ })
    expect(field("Tokenization fee (bps)").value).toBe("7")
    expect(field("YT fee (bps)").value).toBe("1500")
    expect(field("Swap fee tier (bps)").value).toBe("20")
    expect(field("Protocol share (bps)").value).toBe("2500")
    expect(field("Time stretch (years)").value).toBe("3")
    expect(field("PT name").value).toBe("Principal Token USDY")
    expect(field("YT symbol").value).toBe("YT-USDY")
    // The two addresses the issuer signs into the market are plain, editable fields (their defaults come from an RPC read).
    expect(field("Treasury").value).toBe(TREASURY)
    expect(field("Protocol admin").value).toBe(PROTOCOL_ADMIN)
    expect(field("Treasury").readOnly).toBe(false)
    expect(field("Protocol admin").readOnly).toBe(false)
    expect(screen.getByText(/Defaults are those of USDY Dec 2026/)).toBeTruthy()
    // Maturity starts 90 days out, at 00:00 UTC.
    expect(field("Maturity (UTC)").value).toBe("2027-04-16T00:00")
  })

  it("wasm hashes and shared contracts are read-only from the manifest", async () => {
    show()
    await screen.findByRole("heading", { name: /Step 1 of 7: Parameters/ })
    const fromManifest = screen.getByRole("region", { name: /From this network's manifest/ })
    for (const value of [...Object.values(WASM), FACTORY, manifest.shared.permissioning, manifest.shared.oracle, manifest.shared.riskControl]) {
      expect(within(fromManifest).getByText(value)).toBeTruthy()
      expect(screen.queryByDisplayValue(value)).toBeNull()
    }
    expect(within(fromManifest).queryAllByRole("textbox")).toEqual([])
  })

  it("names what the contracts would refuse, and does not go on until it is fixed", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByRole("heading", { name: /Step 1 of 7: Parameters/ })
    await user.clear(field("YT fee (bps)"))
    await user.type(field("YT fee (bps)"), "6000")
    expect(screen.getByText("Enter a whole number of basis points from 0 to 5000, the contract's cap.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Next: preview the addresses" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("step 2: addresses preview", () => {
  it("the preview calls predict_market and signs nothing", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Next: preview the addresses" }))
    await screen.findByRole("heading", { name: /Step 2 of 7: Addresses/ })
    await screen.findByText(predicted.pool)
    for (const k of Object.keys(WASM) as MarketContractName[]) expect(screen.getByText(predicted[k])).toBeTruthy()
    expect(mocks.readCalls).toContain(`${FACTORY}.predict_market`)
    expect(mocks.prepareManager).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /Sign|Deploy/ })).toBeNull()
  })

  it("an answer that differs from the salt's addresses is refused, and the deploy step stays closed", async () => {
    mocks.reads[`${FACTORY}.predict_market`] = { ...(CURRENT_READS[`${FACTORY}.predict_market`] as object), market_pool: contractAt(99) }
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Next: preview the addresses" }))
    expect(await screen.findByText(/differ from the ones this salt gives/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Next: deploy" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("step 3: deploy (R5-10)", () => {
  async function toDeploy(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Next: preview the addresses" }))
    await screen.findByText(predicted.pool)
    await user.click(screen.getByRole("button", { name: "Next: deploy" }))
    await screen.findByRole("heading", { name: /Step 3 of 7: Deploy/ })
  }

  it("deploy runs create_tokens, create_engine and create_pool_and_escrow with one salt, each reviewed", async () => {
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await toDeploy(user)
    const deploy = await screen.findByRole("button", { name: "Deploy the market" })
    await waitFor(() => expect((deploy as HTMLButtonElement).disabled).toBe(false))
    await user.click(deploy)
    await signAll(user, 3)
    expect(kinds()).toEqual(["create_tokens", "create_engine", "create_pool_and_escrow"])
    for (const [call] of mocks.prepareManager.mock.calls as [ManagerCall][]) {
      expect(call.source).toBe(ISSUER)
      expect(call.invocation.contractId).toBe(FACTORY)
      expect(call.invocation.args[0]).toEqual({ type: "address", value: ISSUER })
      expect(call.invocation.args[1]).toEqual({ type: "bytes", value: SALT })
    }
    // The parameters signed are the ones the form showed.
    const engine = (mocks.prepareManager.mock.calls[1][0] as ManagerCall).invocation.args[4] as { value: Record<string, { value: unknown }> }
    expect(engine.value.treasury.value).toBe(TREASURY)
    expect(engine.value.protocol_admin.value).toBe(PROTOCOL_ADMIN)
    expect(engine.value.yt_fee_bps.value).toBe(1500)
  })

  it("the chain moving under the flow (as each signature refreshes the reads) does not interrupt it", async () => {
    connect(ISSUER)
    // Like useExecute: each confirmed call deploys its contracts, and the manager reads are refreshed.
    const deploys: Record<string, string[]> = {
      create_tokens: [predicted.sy, predicted.pt, predicted.yt],
      create_engine: [predicted.config, predicted.manager],
      create_pool_and_escrow: [predicted.pool, predicted.recoveryEscrow],
    }
    mocks.execute.mockImplementation(async (review: ManagerReview) => {
      if (review.origin.type !== "manager") throw new Error("not a manager call")
      const call = review.origin.call
      mocks.deployed.push(...deploys[call.kind])
      const params = call.invocation.args[call.invocation.args.length - 1] as { value: Record<string, { value: unknown }> }
      if (call.kind === "create_tokens") {
        Object.assign(mocks.reads, {
          [`${predicted.pt}.underlying_address`]: SAC,
          [`${predicted.pt}.maturity`]: BigInt(params.value.maturity.value as bigint),
          [`${predicted.pt}.name`]: params.value.pt_name.value,
          [`${predicted.pt}.symbol`]: params.value.pt_symbol.value,
          [`${predicted.yt}.name`]: params.value.yt_name.value,
          [`${predicted.yt}.symbol`]: params.value.yt_symbol.value,
        })
      }
      if (call.kind === "create_engine") {
        Object.assign(mocks.reads, {
          [`${predicted.config}.protocol_admin`]: params.value.protocol_admin.value,
          [`${predicted.config}.treasury`]: params.value.treasury.value,
          [`${predicted.config}.tokenization_fee_bps`]: params.value.tokenization_fee_bps.value,
          [`${predicted.config}.yt_fee_bps`]: params.value.yt_fee_bps.value,
          [`${predicted.config}.swap_fee_tier_bps`]: params.value.swap_fee_tier_bps.value,
          [`${predicted.config}.protocol_share_bps`]: params.value.protocol_share_bps.value,
        })
      }
      await client.invalidateQueries({ queryKey: ["manage", manifest.network] })
      return { status: "SUCCESS", hash: call.kind }
    })
    const user = userEvent.setup()
    show()
    await toDeploy(user)
    const deploy = await screen.findByRole("button", { name: "Deploy the market" })
    await waitFor(() => expect((deploy as HTMLButtonElement).disabled).toBe(false))
    await user.click(deploy)
    await signAll(user, 3)
    expect(kinds()).toEqual(["create_tokens", "create_engine", "create_pool_and_escrow"])
  })

  it("a refresh that fails while the progress is held keeps the step and its review open, and says so", async () => {
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await toDeploy(user)
    const deploy = await screen.findByRole("button", { name: "Deploy the market" })
    await waitFor(() => expect((deploy as HTMLButtonElement).disabled).toBe(false))
    await user.click(deploy)
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("Step 1 of 3")
    // A poll or a post-signature refresh fails (rate-limited RPC): the last read stays, nothing is unmounted.
    mocks.rpcError = "rpc 429"
    await act(async () => {
      await client.refetchQueries({ queryKey: ["manage", manifest.network, "wizard-progress"] })
    })
    expect(await screen.findByText(/Could not refresh where this market stands \(.*rpc 429\)\. What is shown is the last read\./)).toBeTruthy()
    expect(screen.getByRole("dialog")).toBe(dialog)
    // Behind the modal (aria-hidden while it is open), the step is still the deploy step.
    expect(screen.getByRole("heading", { name: /Step 3 of 7: Deploy/, hidden: true })).toBeTruthy()
    // Retrying once the RPC answers clears the note.
    mocks.rpcError = null
    await act(async () => {
      await client.refetchQueries({ queryKey: ["manage", manifest.network, "wizard-progress"] })
    })
    await waitFor(() => expect(screen.queryByText(/Could not refresh/)).toBeNull())
  })

  it("the inline Refresh reads the chain again and clears the note once it answers", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByRole("heading", { name: /Step 1 of 7: Parameters/ })
    mocks.rpcError = "rpc 503"
    await act(async () => {
      await client.refetchQueries({ queryKey: ["manage", manifest.network, "wizard-progress"] })
    })
    expect(await screen.findByText(/Could not refresh where this market stands/)).toBeTruthy()
    expect(screen.getByRole("heading", { name: /Step 1 of 7: Parameters/ })).toBeTruthy()
    mocks.rpcError = null
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.queryByText(/Could not refresh/)).toBeNull())
  })

  it("a salt is remembered only once a phase is deployed, not when step 3 is merely viewed", async () => {
    const user = userEvent.setup()
    const { unmount } = show()
    await toDeploy(user)
    expect(readWizardSalts(manifest.network)).toEqual([])
    unmount()
    mocks.deployed = [predicted.sy, predicted.pt, predicted.yt]
    Object.assign(mocks.reads, {
      [`${predicted.pt}.underlying_address`]: SAC,
      [`${predicted.pt}.maturity`]: 1_810_000_000n,
      [`${predicted.pt}.name`]: "PT chain",
      [`${predicted.pt}.symbol`]: "PT-CHAIN",
      [`${predicted.yt}.name`]: "YT chain",
      [`${predicted.yt}.symbol`]: "YT-CHAIN",
    })
    show()
    await screen.findByRole("heading", { name: /Step 3 of 7: Deploy/ })
    await waitFor(() => expect(readWizardSalts(manifest.network)).toEqual([SALT]))
  })

  it("a wallet that is not the SAC admin is told who must sign", async () => {
    connect(OTHER)
    const user = userEvent.setup()
    show()
    await toDeploy(user)
    const notice = await screen.findByText(/Only the USDY issuer can deploy this market/)
    expect(notice.textContent).toContain(ISSUER)
    expect(notice.textContent).toContain(OTHER)
    expect((screen.getByRole("button", { name: "Deploy the market" }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.prepareManager).not.toHaveBeenCalled()
  })

  it("progress resumes at step 3 when only the tokens exist: what the tokens fixed is read back and locked", async () => {
    connect(ISSUER)
    mocks.deployed = [predicted.sy, predicted.pt, predicted.yt]
    const maturity = 1_810_000_000n
    Object.assign(mocks.reads, {
      [`${predicted.pt}.underlying_address`]: SAC,
      [`${predicted.pt}.maturity`]: maturity,
      [`${predicted.pt}.name`]: "PT chain",
      [`${predicted.pt}.symbol`]: "PT-CHAIN",
      [`${predicted.yt}.name`]: "YT chain",
      [`${predicted.yt}.symbol`]: "YT-CHAIN",
    })
    const user = userEvent.setup()
    show()
    await screen.findByRole("heading", { name: /Step 3 of 7: Deploy/ })
    expect(screen.getByText("SY wrapper, PT and YT").closest("li")?.textContent).toMatch(/Deployed/)
    const go = await screen.findByRole("button", { name: "Continue the deployment" })
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false))
    await user.click(go)
    await signAll(user, 2)
    expect(kinds()).toEqual(["create_engine", "create_pool_and_escrow"])
    const engine = (mocks.prepareManager.mock.calls[0][0] as ManagerCall).invocation.args[4] as { value: Record<string, { value: unknown }> }
    expect(BigInt(engine.value.maturity.value as bigint)).toBe(maturity)

    // Editing the parameters keeps what the chain fixed read-only.
    await user.click(screen.getByRole("button", { name: "Edit the parameters" }))
    expect(field("PT symbol").value).toBe("PT-CHAIN")
    expect(field("PT symbol").readOnly).toBe(true)
    expect(field("YT fee (bps)").readOnly).toBe(false)
  })
})

describe("the salt and the later steps", () => {
  it("without a salt, a fresh one is put in the URL", async () => {
    mocks.search = new URLSearchParams()
    const replace = vi.spyOn(window.history, "replaceState")
    show()
    await waitFor(() => expect(replace).toHaveBeenCalled())
    const url = String(replace.mock.calls[0][2])
    expect(url).toMatch(/\?salt=[0-9a-f]{64}$/)
    replace.mockRestore()
  })

  it("a salt that is not 32 bytes of hex names no market", async () => {
    mocks.search = new URLSearchParams({ salt: "1234" })
    show()
    expect(await screen.findByText(/is not 32 bytes of hex/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "Start a new market" }).getAttribute("href")).toBe("/app/manage/new")
  })

  it("a deployed market opens at the step the chain says, with the next step named", async () => {
    mocks.deployed = Object.values(predicted).filter((id) => id !== manifest.shared.router && id !== manifest.shared.oracle)
    const { riskControl, router } = manifest.shared
    Object.assign(mocks.reads, {
      [`${predicted.config}.underlying`]: SAC,
      [`${predicted.config}.treasury`]: TREASURY,
      [`${riskControl}.is_consumer(${predicted.sy})`]: false,
      [`${riskControl}.is_consumer(${predicted.manager})`]: false,
      [`${router}.is_registered(${predicted.pool})`]: false,
      [`${predicted.pool}.lp_total_supply`]: 0n,
      [`${SAC}.authorized`]: true,
      [`${manifest.shared.permissioning}.is_allowed`]: true,
      [`${manifest.shared.permissioning}.is_allowed_for_asset`]: true,
    })
    show()
    expect(await screen.findByRole("heading", { name: /Step 4 of 7: Wire/ })).toBeTruthy()
    const steps = screen.getByRole("list", { name: "Steps" })
    expect(within(steps).getByText("Deploy").closest("li")?.textContent).toMatch(/Done/)
    expect(within(steps).getByText("Wire").closest("li")?.getAttribute("aria-current")).toBe("step")
  })

  it("progress that cannot be read is unavailable with its reason; no step is guessed", async () => {
    mocks.deployed = [predicted.sy, predicted.pt]
    show()
    expect(await screen.findByText(/only partly deployed/)).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /Step \d of 7/ })).toBeNull()
    await act(async () => {})
  })
})

describe("steps 4 and 5: wire and grants (R5-10, spec 0002 §5)", () => {
  const { riskControl, router, permissioning } = manifest.shared
  const RC_ADMIN = Keypair.random().publicKey()
  const ROUTER_ADMIN = Keypair.random().publicKey()
  const PERM_ADMIN = Keypair.random().publicKey()
  const key = (contract: string, fn: string, ...args: string[]) => `${contract}.${fn}(${args.join(",")})`

  /** A fully deployed market; `over` changes what the chain says of its wiring and grants. */
  function market(over: Record<string, unknown> = {}) {
    mocks.deployed = Object.values(predicted).filter((id) => id !== manifest.shared.router && id !== manifest.shared.oracle)
    Object.assign(mocks.reads, {
      [`${predicted.config}.underlying`]: SAC,
      [`${predicted.config}.treasury`]: TREASURY,
      [`${riskControl}.is_consumer`]: true,
      [`${router}.is_registered`]: true,
      [`${predicted.pool}.lp_total_supply`]: 0n,
      [`${SAC}.authorized`]: true,
      [`${permissioning}.is_allowed`]: true,
      [`${permissioning}.is_allowed_for_asset`]: true,
      [`${riskControl}.get_admin`]: RC_ADMIN,
      [`${router}.get_admin`]: ROUTER_ADMIN,
      [`${permissioning}.get_admin`]: PERM_ADMIN,
      ...over,
    })
  }
  const unwired = () =>
    market({
      [key(riskControl, "is_consumer", predicted.sy)]: false,
      [key(riskControl, "is_consumer", predicted.manager)]: false,
      [key(router, "is_registered", predicted.pool)]: false,
    })
  const signAllNow = async (user: ReturnType<typeof userEvent.setup>, name: string, count: number) => {
    const button = await screen.findByRole("button", { name })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    await user.click(button)
    await signAll(user, count)
  }

  it("names the RiskControl and Router admins when the wallet is neither, and offers nothing to sign", async () => {
    unwired()
    connect(OTHER)
    show()
    await screen.findByRole("heading", { name: /Step 4 of 7: Wire/ })
    expect((await screen.findAllByText(RC_ADMIN, { exact: false })).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(ROUTER_ADMIN, { exact: false })).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Must be signed by/).length).toBe(3)
    const button = screen.queryByRole("button", { name: /Wire the market|Sign the/ }) as HTMLButtonElement | null
    expect(button === null || button.disabled).toBe(true)
    expect(mocks.prepareManager).not.toHaveBeenCalled()
  })

  it("a wallet holding both roles signs add_consumer for the SY wrapper and the manager, then register_market", async () => {
    unwired()
    mocks.reads[`${riskControl}.get_admin`] = ISSUER
    mocks.reads[`${router}.get_admin`] = ISSUER
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await signAllNow(user, "Wire the market", 3)
    expect(kinds()).toEqual(["add_consumer", "add_consumer", "register_market"])
    const calls = mocks.prepareManager.mock.calls.map(([c]) => c as ManagerCall)
    expect(calls[0].invocation.args[1]).toEqual({ type: "address", value: predicted.sy })
    expect(calls[1].invocation.args[1]).toEqual({ type: "address", value: predicted.manager })
    expect(calls[2].invocation.args[1]).toEqual({ type: "address", value: predicted.pool })
  })

  it("offers only what is missing, and only what this wallet's role can sign; the rest names its signer", async () => {
    unwired()
    mocks.reads[key(riskControl, "is_consumer", predicted.sy)] = true
    mocks.reads[`${riskControl}.get_admin`] = RC_ADMIN
    mocks.reads[`${router}.get_admin`] = ISSUER
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await signAllNow(user, "Wire the market", 1)
    expect(kinds()).toEqual(["register_market"])
    expect(screen.getAllByText(RC_ADMIN, { exact: false }).length).toBeGreaterThan(0)
  })

  it("lists the 17 grants with their state, and offers the missing ones signed by each role holder", async () => {
    market({
      [key(SAC, "authorized", predicted.pool)]: false,
      [key(permissioning, "is_allowed_for_asset", predicted.recoveryEscrow, predicted.pt)]: false,
    })
    mocks.reads[`${SAC}.admin`] = ISSUER
    mocks.reads[`${permissioning}.get_admin`] = PERM_ADMIN
    connect(ISSUER)
    show()
    const heading = await screen.findByRole("heading", { name: /Step 5 of 7: Grants/ })
    const list = within(heading.closest("section") as HTMLElement).getByRole("list", { name: "Grants" })
    const rows = within(list).getAllByRole("listitem")
    expect(rows).toHaveLength(17)
    expect(rows.filter((r) => /To do/.test(r.textContent ?? ""))).toHaveLength(2)
    // The issuer holds the SAC admin role only: Permissioning's admin is named for the other grant.
    expect((await screen.findAllByText(PERM_ADMIN, { exact: false })).length).toBeGreaterThan(0)
    const user = userEvent.setup()
    await signAllNow(user, "Sign the grants", 1)
    expect(kinds()).toEqual(["set_authorized"])
    const call = mocks.prepareManager.mock.calls[0][0] as ManagerCall
    expect(call.invocation.contractId).toBe(SAC)
    expect(call.invocation.args).toEqual([{ type: "address", value: predicted.pool }, { type: "bool", value: true }])
  })

  it("the Permissioning admin signs the missing Permissioning grants, account and asset", async () => {
    market({
      [key(permissioning, "is_allowed", predicted.manager)]: false,
      [key(permissioning, "is_allowed_for_asset", predicted.pool, predicted.yt)]: false,
    })
    mocks.reads[`${SAC}.admin`] = ISSUER
    mocks.reads[`${permissioning}.get_admin`] = PERM_ADMIN
    connect(PERM_ADMIN)
    const user = userEvent.setup()
    show()
    await signAllNow(user, "Sign the grants", 2)
    expect(kinds()).toEqual(["grant_account", "grant_asset"])
    const calls = mocks.prepareManager.mock.calls.map(([c]) => c as ManagerCall)
    expect(calls[0].invocation.args[1]).toEqual({ type: "address", value: predicted.manager })
    expect(calls[1].invocation.args.slice(1)).toEqual([
      { type: "address", value: predicted.pool },
      { type: "address", value: predicted.yt },
    ])
  })

  it("a wallet with none of the roles sees who must sign and nothing signable", async () => {
    market({ [key(SAC, "authorized", predicted.sy)]: false })
    mocks.reads[`${SAC}.admin`] = ISSUER
    connect(OTHER)
    show()
    await screen.findByRole("heading", { name: /Step 5 of 7: Grants/ })
    expect((await screen.findAllByText(ISSUER, { exact: false })).length).toBeGreaterThan(0)
    const button = screen.queryByRole("button", { name: "Sign the grants" }) as HTMLButtonElement | null
    expect(button === null || button.disabled).toBe(true)
  })

  describe("the chain moving on while a flow is open (a step never unmounts under its review)", () => {
    /** Everything wired and granted except one grant: the chain reads step 5. */
    const toStep5 = () =>
      Object.assign(mocks.reads, {
        [key(riskControl, "is_consumer", predicted.sy)]: true,
        [key(riskControl, "is_consumer", predicted.manager)]: true,
        [key(router, "is_registered", predicted.pool)]: true,
        [key(SAC, "authorized", predicted.sy)]: false,
      })
    const refresh = () => act(async () => void (await client.invalidateQueries({ queryKey: ["manage"] })))

    it("(a) this wallet's last wire signature lands: the wire step stays until its flow is closed, then the wizard advances", async () => {
      market({ [key(router, "is_registered", predicted.pool)]: false })
      mocks.reads[`${router}.get_admin`] = ISSUER
      connect(ISSUER)
      let wireShownWhileOpen = false
      let settled = false
      mocks.execute.mockImplementation(async () => {
        toStep5()
        await client.invalidateQueries({ queryKey: ["manage"] })
        await new Promise((r) => setTimeout(r, 60)) // let React render the new read
        wireShownWhileOpen = screen.queryByRole("heading", { name: /Step 4 of 7: Wire/, hidden: true }) !== null && screen.queryByRole("dialog") !== null
        settled = true
        return { status: "SUCCESS", hash: "abc" }
      })
      const user = userEvent.setup()
      show()
      await signAllNow(user, "Wire the market", 1)
      await waitFor(() => expect(settled).toBe(true))
      expect(wireShownWhileOpen).toBe(true)
      expect(await screen.findByRole("heading", { name: /Step 5 of 7: Grants/ })).toBeTruthy()
      expect(screen.queryByRole("heading", { name: /Step 4 of 7/ })).toBeNull()
      expect(kinds()).toEqual(["register_market"])
    })

    it("(b) another wallet completed the call under an open review: nothing unmounts, the review says it is done and cannot be signed", async () => {
      unwired()
      mocks.reads[`${riskControl}.get_admin`] = ISSUER
      mocks.reads[`${router}.get_admin`] = ISSUER
      connect(ISSUER)
      const user = userEvent.setup()
      show()
      await user.click(await screen.findByRole("button", { name: "Wire the market" }).then(async (b) => (await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false)), b)))
      const dialog = await screen.findByRole("dialog")
      await within(dialog).findByText("Step 1 of 3")
      toStep5()
      await refresh()
      expect(screen.getByRole("heading", { name: /Step 4 of 7: Wire/, hidden: true })).toBeTruthy()
      expect(screen.getByRole("dialog")).toBe(dialog)
      expect(await within(dialog).findByText(/already done on chain/)).toBeTruthy()
      expect((within(dialog).getByRole("button", { name: "Sign transaction" }) as HTMLButtonElement).disabled).toBe(true)
      expect(mocks.execute).not.toHaveBeenCalled()
      // Closing it lets the wizard move to the chain's step.
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
      expect(await screen.findByRole("heading", { name: /Step 5 of 7: Grants/ })).toBeTruthy()
    })

    it("(c) the last deployment signature moves the chain to step 4: the deploy step stays until its flow is closed", async () => {
      connect(ISSUER)
      let deployShownWhileOpen = false
      let settled = false
      mocks.execute.mockImplementation(async () => {
        if (mocks.execute.mock.calls.length < 3) return { status: "SUCCESS", hash: "abc" }
        market({ [key(riskControl, "is_consumer", predicted.sy)]: false })
        await client.invalidateQueries({ queryKey: ["manage"] })
        await new Promise((r) => setTimeout(r, 60))
        deployShownWhileOpen = screen.queryByRole("heading", { name: /Step 3 of 7: Deploy/, hidden: true }) !== null && screen.queryByRole("dialog") !== null
        settled = true
        return { status: "SUCCESS", hash: "abc" }
      })
      const user = userEvent.setup()
      show()
      await user.click(await screen.findByRole("button", { name: "Next: preview the addresses" }))
      await screen.findByText(predicted.pool)
      await user.click(screen.getByRole("button", { name: "Next: deploy" }))
      await signAllNow(user, "Deploy the market", 3)
      await waitFor(() => expect(settled).toBe(true))
      expect(deployShownWhileOpen).toBe(true)
      expect(await screen.findByRole("heading", { name: /Step 4 of 7: Wire/ })).toBeTruthy()
    })
  })
})

describe("steps 6 and 7: seed and publish (spec 0002 §5, R5-10)", () => {
  const { riskControl, router, permissioning, oracle } = manifest.shared
  const key = (contract: string, fn: string, ...args: string[]) => `${contract}.${fn}(${args.join(",")})`
  const TAU = 7_776_000n
  const EXPONENT = WAD - (TAU * WAD) / (3n * 31_536_000n)
  const RATE = 10_500_000n
  const XR = 10_200_000n

  /** Deployed, wired and granted: the chain reads step 6 until the pool holds liquidity. */
  function granted(over: Record<string, unknown> = {}) {
    mocks.deployed = Object.values(predicted).filter((id) => id !== manifest.shared.router && id !== manifest.shared.oracle)
    Object.assign(mocks.reads, {
      [`${predicted.config}.underlying`]: SAC,
      [`${predicted.config}.treasury`]: TREASURY,
      [`${riskControl}.is_consumer`]: true,
      [`${router}.is_registered`]: true,
      [`${predicted.pool}.lp_total_supply`]: 0n,
      [`${SAC}.authorized`]: true,
      [`${permissioning}.is_allowed`]: true,
      [`${permissioning}.is_allowed_for_asset`]: true,
      [`${SAC}.admin`]: ISSUER,
      // What the seed reads: the unseeded pool, the oracle, the SY wrapper and the config.
      [`${predicted.pool}.pool_state`]: { pt_reserve: 0n, sy_reserve: 0n, total_lp: 0n, rate: RATE, exponent: EXPONENT, fee_rate: 0n, seconds_to_maturity: TAU },
      [`${oracle}.is_available`]: true,
      [`${predicted.sy}.exchange_rate`]: XR,
      [`${predicted.config}.tokenization_fee_bps`]: 7n,
      [key(predicted.pt, "balance", ISSUER)]: 0n,
      [key(predicted.sy, "balance_of", ISSUER)]: 0n,
      ...over,
    })
  }

  /** The simulations answer what the calls would make; the signatures land them on the fake chain. */
  function chainAnswers() {
    const v = (i: ContractInvocation, n: number) => i.args[n].value as bigint
    mocks.simulate.mockImplementation(async ({ invocation: i }: { invocation: ContractInvocation }): Promise<SimulationOutcome> => {
      const retval =
        i.functionName === "wrap_and_mint"
          ? { pt_minted: ((((v(i, 2) * 10_000_000n) / XR) * 9_993n) / 10_000n * RATE) / 10_000_000n, yt_minted: 0n, fee_shares: 0n }
          : i.functionName === "deposit"
            ? (v(i, 1) * 10_000_000n) / XR
            : [v(i, 2), v(i, 3), 1_000_000n]
      return { ok: true, retval, latestLedger: 10, minResourceFee: "0" }
    })
    mocks.execute.mockImplementation(async (review: ManagerReview) => {
      const call = review.origin.type === "manager" ? review.origin.call : undefined
      const sim = mocks.simulate.mock.results[mocks.simulate.mock.results.length - 1]
      const out = (await sim.value) as { retval: unknown }
      const add = (k: string, v: bigint) => (mocks.reads[k] = (mocks.reads[k] as bigint) + v)
      if (call?.kind === "seed_mint") add(key(predicted.pt, "balance", ISSUER), (out.retval as { pt_minted: bigint }).pt_minted)
      if (call?.kind === "seed_deposit") add(key(predicted.sy, "balance_of", ISSUER), out.retval as bigint)
      return { status: "SUCCESS", hash: "abc" }
    })
  }

  async function typeSeed(user: ReturnType<typeof userEvent.setup>, apy: string, amount: string) {
    await screen.findByRole("heading", { name: /Step 6 of 7: Seed the pool/ })
    await user.type(await screen.findByLabelText("Starting fixed APY (%)"), apy)
    await user.type(screen.getByLabelText("Amount (USDY)"), amount)
  }

  it("the seed runs wrap_and_mint, deposit and add_liquidity in that order through the manager-call path, floors from each simulation", async () => {
    granted()
    chainAnswers()
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await typeSeed(user, "5", "1000")
    const plan = seedAmounts({ apy: 500_000n, amountUnderlying: 10_000_000_000n, s: { secondsToMaturity: TAU, exponent: EXPONENT }, oracleRate: RATE, exchangeRate: XR, feeBps: 7n })
    if ("error" in plan) throw new Error(plan.error)
    // The plan is shown before anything is signed: the starting APY the pool will show.
    expect(await screen.findByText(/starts at 5\.00%/)).toBeTruthy()
    const seed = screen.getByRole("button", { name: "Seed the pool" })
    await waitFor(() => expect((seed as HTMLButtonElement).disabled).toBe(false))
    await user.click(seed)
    await signAll(user, 3)

    expect(kinds()).toEqual(["seed_mint", "seed_deposit", "seed_add_liquidity"])
    const calls = mocks.prepareManager.mock.calls.map(([c]) => c as ManagerCall)
    expect(calls.map((c) => c.invocation.functionName)).toEqual(["wrap_and_mint", "deposit", "add_liquidity"])
    expect(calls.map((c) => c.invocation.contractId)).toEqual([router, predicted.sy, router])
    for (const c of calls) expect(c.source).toBe(ISSUER)
    // The amounts are the plan's; the whole amount is used.
    const [mint, deposit, add] = calls.map((c) => c.invocation.args.map((a) => a.value))
    expect(mint[1]).toBe(predicted.pool)
    expect(mint[2]).toBe(plan.mintUnderlying)
    expect(deposit[1]).toBe(plan.depositUnderlying)
    expect(add[2]).toBe(plan.pt)
    expect(add[3]).toBe(plan.sy)
    // The deadlines are the ledger's time when each call was built, plus the 300 s setting.
    expect([mint[4], add[5]]).toEqual([BigInt(LEDGER + 300), BigInt(LEDGER + 300)])
    // Each was simulated with a zero floor, then signed with the simulated output less 0.5 % (never zero).
    const sims = mocks.simulate.mock.calls.map(([p]) => (p as { invocation: ContractInvocation }).invocation)
    expect(sims.map((i) => i.functionName)).toEqual(["wrap_and_mint", "deposit", "add_liquidity"])
    expect([sims[0].args[3].value, sims[1].args[2].value, sims[2].args[4].value]).toEqual([0n, 0n, 0n])
    const outs = await Promise.all(mocks.simulate.mock.results.map((r) => r.value as Promise<{ retval: unknown }>))
    expect(mint[3]).toBe(minAfterSlippage((outs[0].retval as { pt_minted: bigint }).pt_minted, 50n))
    expect(deposit[2]).toBe(minAfterSlippage(outs[1].retval as bigint, 50n))
    expect(add[4]).toBe(minAfterSlippage(1_000_000n, 50n))
    // The pool's first deposit is simulated only once the mint and the deposit have landed.
    expect(mocks.simulate.mock.invocationCallOrder[2]).toBeGreaterThan(mocks.execute.mock.invocationCallOrder[1])
  })

  it("a starting APY of 0 or less is refused before anything is signed (R5-10)", async () => {
    granted()
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await typeSeed(user, "0", "1000")
    expect(await screen.findByText(/Enter a starting APY above 0%/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Seed the pool" }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.simulate).not.toHaveBeenCalled()
    expect(mocks.prepareManager).not.toHaveBeenCalled()
  })

  it("a stale oracle is said, and nothing is offered to sign", async () => {
    granted({ [`${oracle}.is_available`]: false })
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await typeSeed(user, "5", "1000")
    expect(await screen.findByText(/oracle price is stale/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Seed the pool" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a wallet that is not the issuer is told who seeds the pool", async () => {
    granted()
    connect(OTHER)
    show()
    await screen.findByRole("heading", { name: /Step 6 of 7: Seed the pool/ })
    expect((await screen.findAllByText(ISSUER, { exact: false })).length).toBeGreaterThan(0)
    expect((screen.getByRole("button", { name: "Seed the pool" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a seed started before finishes with the PT the wallet holds: no second mint", async () => {
    granted({ [key(predicted.pt, "balance", ISSUER)]: 5_000_000_000n, [key(predicted.sy, "balance_of", ISSUER)]: 1_000_000_000n })
    chainAnswers()
    connect(ISSUER)
    const user = userEvent.setup()
    show()
    await screen.findByRole("heading", { name: /Step 6 of 7: Seed the pool/ })
    expect(await screen.findByText(/already holds/)).toBeTruthy()
    expect(screen.queryByLabelText("Amount (USDY)")).toBeNull()
    await user.type(screen.getByLabelText("Starting fixed APY (%)"), "5")
    const seed = screen.getByRole("button", { name: "Seed the pool" })
    await waitFor(() => expect((seed as HTMLButtonElement).disabled).toBe(false))
    await user.click(seed)
    await signAll(user, 2)
    expect(kinds()).toEqual(["seed_deposit", "seed_add_liquidity"])
    const add = (mocks.prepareManager.mock.calls[1][0] as ManagerCall).invocation.args
    expect(add[2].value).toBe(5_000_000_000n)
  })

  it("an already seeded pool sends the wizard on to step 7", async () => {
    granted({ [`${predicted.pool}.lp_total_supply`]: 2_000n })
    show()
    expect(await screen.findByRole("heading", { name: /Step 7 of 7: Publish/ })).toBeTruthy()
    const steps = screen.getByRole("list", { name: "Steps" })
    expect(within(steps).getByText("Seed the pool").closest("li")?.textContent).toMatch(/Done/)
  })

  describe("publish", () => {
    const listed: Market = {
      ...CURRENT,
      marketId: "testnet-usdy-1807776000",
      displayName: "USDY (test)",
      maturity: 1_807_776_000,
      contracts: { ...predicted },
    }
    let fetchMock: ReturnType<typeof vi.fn>
    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
    })

    it("posts the pool to the registry, and the market appears after one refresh (spec §1)", async () => {
      granted({ [`${predicted.pool}.lp_total_supply`]: 2_000n })
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ market: listed }), { status: 200, headers: { "content-type": "application/json" } }))
      // The refresh re-renders the server layout, which lists the registry's valid markets.
      mocks.refresh.mockImplementation(() => {
        mocks.manifest = { ...manifest, markets: [...manifest.markets, listed] }
      })
      const user = userEvent.setup()
      show()
      await user.click(await screen.findByRole("button", { name: "Publish the market" }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("/api/markets")
      expect(init.method).toBe("POST")
      expect(new Headers(init.headers).get("content-type")).toBe("application/json")
      expect(JSON.parse(String(init.body))).toEqual({ pool: predicted.pool })
      expect(mocks.refresh).toHaveBeenCalledTimes(1)
      expect(await screen.findByText(/is in the market list/)).toBeTruthy()
      expect(screen.getByRole("link", { name: "Open the market" }).getAttribute("href")).toBe(`/app/markets/${listed.marketId}`)
    })

    it("a market the registry refuses is not listed, and the reason is shown", async () => {
      granted({ [`${predicted.pool}.lp_total_supply`]: 2_000n })
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_market", message: "This pool is not a market this app can list. The reason says what to fix.", reason: "pool (C…) runs Wasm 00…, which the manifest does not pin for pool" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      )
      const user = userEvent.setup()
      show()
      await user.click(await screen.findByRole("button", { name: "Publish the market" }))
      expect(await screen.findByText(/which the manifest does not pin for pool/)).toBeTruthy()
      expect(mocks.refresh).not.toHaveBeenCalled()
    })

    it("a market already in the list says so, and offers nothing to publish", async () => {
      granted({ [`${predicted.pool}.lp_total_supply`]: 2_000n })
      mocks.manifest = { ...manifest, markets: [...manifest.markets, listed] }
      show()
      expect(await screen.findByText(/is in the market list/)).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Publish the market" })).toBeNull()
    })
  })
})
