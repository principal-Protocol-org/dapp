import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RouteControls, RouteState, UseRouteOptions } from "@/hooks/use-route"
import type { RouteRun } from "@/lib/app/route-log"
import type { Review } from "@/lib/protocol/review"
import type { RouteRequest, StepPlan } from "@/lib/protocol/routes"

let controls: RouteControls
let lastOpts: UseRouteOptions
const exec = { prepareRestore: vi.fn(), executeRestore: vi.fn() }

vi.mock("@/hooks/use-route", () => ({
  useRoute: (opts: UseRouteOptions) => {
    lastOpts = opts
    return controls
  },
}))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => ({ ledgerTime: 1_800_000_000, sequence: 1, isError: false }) }))
vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = { network: "local" }
  return { useManifest: () => manifest }
})
vi.mock("@/hooks/use-execute", () => ({ useExecute: () => exec }))
vi.mock("@/components/app/actions/tx-feedback", () => ({ showTxToast: vi.fn(), TxNoticeView: () => null }))

import { RouteFlow } from "../route/route-flow"

const REQUEST: RouteRequest = { kind: "buy_yt", marketId: "m1", source: "G", amount: 100n, pay: "underlying", receive: "underlying", matured: false }
const PLANS: StepPlan[] = [
  { action: "deposit", amount: { from: "input" }, gives: "100 USDY", takes: "SY" },
  { action: "mint", amount: { from: "input" }, gives: "SY from step 1", takes: "PT and YT" },
  { action: "sell_pt", amount: { from: "input" }, gives: "PT from step 2", takes: "SY" },
]

function review(): Review {
  const input: Review["input"] = { action: "deposit", marketId: "m1", source: "G", amount: 1n, guards: { minOut: 1n }, deadline: 0n }
  return {
    origin: { type: "action", input },
    input,
    invocation: { contractId: "CROUTER", functionName: "deposit", args: [] },
    unsignedXdr: "AAAA",
    unsignedXdrHash: "sha256:00",
    fee: "100",
    preparedAtMs: 0,
    expiresAtMs: 60_000,
    summary: { give: ["100 USDY"], getAtLeast: ["99 SY"], fees: ["Network fee"], validUntil: 1_800_000_300 },
    callTree: [],
  }
}

function run(statuses: RouteRun["steps"][number]["status"][]): RouteRun {
  return {
    id: "r1",
    account: "G",
    marketId: "m1",
    kind: "buy_yt",
    request: REQUEST,
    plans: PLANS,
    outputs: [],
    steps: statuses.map((status) => ({ action: "deposit", status })),
    startedAt: 0,
  } as unknown as RouteRun
}

function setup(state: Partial<RouteState>, over: Partial<RouteControls> = {}) {
  controls = {
    state: { phase: "idle", step: 0, of: 0, canDismiss: false, ...state },
    start: vi.fn(),
    sign: vi.fn(),
    continue: vi.fn(),
    unwind: vi.fn(),
    dismiss: vi.fn(),
    ...over,
  }
}

const base = {
  account: "G",
  marketId: "m1",
  gate: () => [],
  request: REQUEST,
  plans: PLANS,
  canStart: true,
  blockers: [],
  onNotice: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe("RouteFlow", () => {
  it("review lists every step with gives, takes and floors before any signature", () => {
    setup({ phase: "reviewing", step: 1, of: 3, run: run(["pending", "pending", "pending"]), review: review() })
    render(<RouteFlow {...base} />)
    const list = screen.getByRole("list", { name: "Route steps" })
    for (const text of ["100 USDY", "PT from step 2", "PT and YT", "At least: 99 SY"]) expect(list.textContent).toContain(text)
    expect(list.textContent).toContain("Its minimum is set from a fresh quote once step 1 is confirmed")
    expect(list.textContent).toContain("once step 2 is confirmed")
    expect(controls.sign).not.toHaveBeenCalled()
  })

  it("the step review shows 0001's technical details and time limit", () => {
    setup({ phase: "reviewing", step: 1, of: 3, run: run(["pending", "pending", "pending"]), review: review() })
    render(<RouteFlow {...base} />)
    const dialog = screen.getByRole("dialog").textContent ?? ""
    expect(dialog).toContain("Technical details")
    expect(dialog).toContain("sha256:00")
    expect(dialog).toContain("by ledger time")
    expect(dialog).toContain("Valid until")
  })

  it("blockers disable Sign, and an unprepared step shows Preparing", () => {
    setup({ phase: "reviewing", step: 2, of: 3, run: run(["confirmed", "pending", "pending"]), blockers: [{ code: "x", message: "Nope" } as never] })
    render(<RouteFlow {...base} />)
    expect(screen.getByText("Preparing step 2 with the network…")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Sign step 2 of 3" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("idle: Review starts the route", () => {
    setup({})
    render(<RouteFlow {...base} />)
    fireEvent.click(screen.getByRole("button", { name: "Review Buy YT" }))
    expect(controls.start).toHaveBeenCalledWith(REQUEST, PLANS)
  })

  it('sign button reads "Sign step 1 of 3" and signs', () => {
    setup({ phase: "reviewing", step: 1, of: 3, run: run(["pending", "pending", "pending"]), review: review() })
    render(<RouteFlow {...base} />)
    fireEvent.click(screen.getByRole("button", { name: "Sign step 1 of 3" }))
    expect(controls.sign).toHaveBeenCalled()
  })

  it("progress shows Step 2 of 3", () => {
    setup({
      phase: "waiting",
      step: 2,
      of: 3,
      run: run(["confirmed", "unknown", "pending"]),
      holdings: "You held 100 SY before step 2. Its result is not known yet.",
      error: "Step 2 was sent.",
      canDismiss: false,
    })
    render(<RouteFlow {...base} />)
    expect(screen.getByRole("heading", { name: "Step 2 of 3" })).toBeTruthy()
    expect(screen.getByText(/You held 100 SY before step 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Check again" }))
    expect(controls.continue).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull()
  })

  it("interrupted panel offers Continue and Back to USDY", () => {
    setup({
      phase: "interrupted",
      step: 2,
      of: 3,
      run: run(["confirmed", "pending", "pending"]),
      holdings: "You hold 100 SY.",
      error: "Step 2 stopped.",
      unwind: { available: true, amount: 100n },
      canDismiss: true,
    })
    render(<RouteFlow {...base} />)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(controls.continue).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Back to USDY" }))
    expect(controls.unwind).toHaveBeenCalled()
  })

  it("interrupted without an unwind says why", () => {
    setup({ phase: "interrupted", step: 1, of: 3, run: run(["pending", "pending", "pending"]), unwind: { available: false, reason: "Nothing to return." } })
    render(<RouteFlow {...base} />)
    expect(screen.queryByRole("button", { name: "Back to USDY" })).toBeNull()
    expect(screen.getByText("Nothing to return.")).toBeTruthy()
  })

  it("Dismiss with funds held needs an explicit confirm and shows holdings first", () => {
    setup({
      phase: "interrupted",
      step: 2,
      of: 3,
      run: run(["confirmed", "pending", "pending"]),
      holdings: "You hold 100 SY.",
      unwind: { available: true, amount: 100n },
      canDismiss: true,
    })
    render(<RouteFlow {...base} />)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(controls.dismiss).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog").textContent).toContain("Close anyway? You hold 100 SY. The route stays in History")
    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }))
    expect(controls.dismiss).toHaveBeenCalledTimes(1)
  })

  it("an interrupted route with the holdings not shown offers no Dismiss", () => {
    setup({ phase: "interrupted", step: 2, of: 3, run: run(["confirmed", "pending", "pending"]), canDismiss: true })
    render(<RouteFlow {...base} />)
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull()
  })

  it("an archived entry shows the restore banner", () => {
    setup({
      phase: "interrupted",
      step: 1,
      of: 3,
      run: run(["pending", "pending", "pending"]),
      error: "expired",
      restore: { source: "G", invocation: { contractId: "C", functionName: "f", args: [] } },
    })
    render(<RouteFlow {...base} />)
    expect(screen.getByRole("button", { name: "Restore contract data" })).toBeTruthy()
  })

  it("the form resets once a step reaches the network", () => {
    setup({})
    function Host() {
      const [amount, setAmount] = useState("100")
      return (
        <>
          <input aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <RouteFlow {...base} onReachedNetwork={() => setAmount("")} />
        </>
      )
    }
    render(<Host />)
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("100")
    act(() => lastOpts.onReachedNetwork?.({ step: 1, status: "SUCCESS", hash: "h" }))
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("")
  })
})
