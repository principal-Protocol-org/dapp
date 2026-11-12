import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Address, Contract, Keypair, StrKey, xdr } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { deriveMarketContracts } from "@/lib/protocol/factory"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
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
  prepareManager: vi.fn(),
  execute: vi.fn(),
  toast: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => manifest }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => ({ ledgerTime: LEDGER, sequence: 1, isError: false }) }))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => [] }))
vi.mock("@/hooks/use-execute", () => ({
  useExecute: () => ({ prepareManager: mocks.prepareManager, execute: mocks.execute, pending: false }),
}))
vi.mock("@/components/app/actions/tx-feedback", () => ({ showTxToast: mocks.toast }))
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.search }))
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
  createRpcServer: () => ({
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
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
    await within(dialog).findByText(`Step ${i + 1} of ${count}`)
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
  mocks.prepareManager.mockReset().mockImplementation(async (call: ManagerCall) => managerReview(call))
  mocks.execute.mockReset().mockResolvedValue({ status: "SUCCESS", hash: "abc" })
  mocks.toast.mockReset()
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
