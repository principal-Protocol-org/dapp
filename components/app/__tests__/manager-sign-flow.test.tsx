import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Keypair } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import type { ManagerReview } from "@/lib/protocol/review"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * `ManagerSignFlow` with deferred steps (plan 0005 Task 8): a step that is built only when its turn
 * comes, after the one before it has confirmed. The seed's calls take their floors from a simulation
 * run then (the pool's first deposit cannot be simulated before the mint and the deposit have landed).
 */

const SIGNER = Keypair.random().publicKey()
const mocks = vi.hoisted(() => ({ prepareManager: vi.fn(), execute: vi.fn(), toast: vi.fn(), order: [] as string[] }))
vi.mock("@/hooks/use-execute", () => ({
  useExecute: () => ({ prepareManager: mocks.prepareManager, execute: mocks.execute, pending: false }),
}))
vi.mock("@/components/app/actions/tx-feedback", () => ({ showTxToast: mocks.toast }))
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })

import { ManagerSignFlow, type ManagerStep } from "../manage/manager-sign-flow"

const call = (label: string): ManagerCall => ({
  kind: "register_market",
  source: SIGNER,
  label,
  invocation: { contractId: "C", functionName: label, args: [] },
})
function review(c: ManagerCall): ManagerReview {
  const now = Date.now()
  return {
    origin: { type: "manager", call: c },
    invocation: c.invocation,
    unsignedXdr: "AAAA",
    unsignedXdrHash: `sha256:${c.label}`,
    fee: "100",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: { give: [], getAtLeast: [], fees: ["Network fee: up to 0.00001 XLM"], validUntil: Math.floor(now / 1000) + 300 },
    callTree: [c.label],
  }
}

function show(steps: ManagerStep[], blockersFor = () => []) {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ManagerSignFlow label="Seed the pool" title="Seed the pool" steps={steps} blockersFor={blockersFor} ledgerTime={1_800_000_000} network="local" />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mocks.order = []
  mocks.prepareManager.mockReset().mockImplementation(async (c: ManagerCall) => {
    mocks.order.push(`prepare ${c.label}`)
    return review(c)
  })
  mocks.execute.mockReset().mockImplementation(async (r: ManagerReview) => {
    mocks.order.push(`sign ${r.origin.call.label}`)
    return { status: "SUCCESS", hash: "abc" }
  })
})

async function signNext(user: ReturnType<typeof userEvent.setup>, n: number, total: number) {
  const dialog = await screen.findByRole("dialog")
  await within(dialog).findByText(`Step ${n} of ${total}`)
  const sign = await within(dialog).findByRole("button", { name: "Sign transaction" })
  await waitFor(() => expect((sign as HTMLButtonElement).disabled).toBe(false))
  await user.click(sign)
  await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(n))
}

describe("ManagerSignFlow: deferred steps", () => {
  it("builds a deferred step only when its turn comes, after the step before it confirmed, and prepares what it built", async () => {
    const steps: ManagerStep[] = [
      call("first"),
      {
        build: async () => {
          mocks.order.push("build second")
          return call("second")
        },
      },
    ]
    const user = userEvent.setup()
    show(steps)
    await user.click(screen.getByRole("button", { name: "Seed the pool" }))
    await signNext(user, 1, 2)
    await signNext(user, 2, 2)
    expect(mocks.order).toEqual(["prepare first", "sign first", "build second", "prepare second", "sign second"])
  })

  it("a build that fails stops the flow with its reason; nothing more is prepared or signed", async () => {
    const steps: ManagerStep[] = [
      {
        build: async () => {
          throw new Error("The pool's first deposit was refused by the simulation: the oracle price is stale. Nothing was signed.")
        },
      },
      call("never"),
    ]
    const user = userEvent.setup()
    show(steps)
    await user.click(screen.getByRole("button", { name: "Seed the pool" }))
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByText(/the oracle price is stale/)).toBeTruthy()
    expect(mocks.prepareManager).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it("the blockers are asked about the call that was built", async () => {
    const blockersFor = vi.fn(() => [])
    const user = userEvent.setup()
    show([{ build: async () => call("built") }], blockersFor)
    await user.click(screen.getByRole("button", { name: "Seed the pool" }))
    await screen.findByRole("dialog")
    await waitFor(() => expect(blockersFor).toHaveBeenCalledWith(expect.objectContaining({ label: "built" })))
  })
})
