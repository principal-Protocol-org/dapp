"use client"

import { useId, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UNAVAILABLE } from "@/components/app/live"
import { useManifest } from "@/components/app/manifest-provider"
import { ManagerSignFlow, type ManagerStep } from "@/components/app/manage/manager-sign-flow"
import type { ChainStepProps } from "@/components/app/manage/wizard"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { useSettings } from "@/hooks/use-settings"
import { useWallet } from "@/hooks/use-wallet"
import { useSeedState } from "@/hooks/use-wizard"
import { knownUnderlyings } from "@/lib/protocol/factory"
import { formatPercent, formatRate, formatTokenAmount, parseDecimalToRaw } from "@/lib/protocol/format"
import type { Blocker } from "@/lib/protocol/gates"
import type { ManagerCall, NewMarket } from "@/lib/protocol/manager-calls"
import { evaluateManagerGates } from "@/lib/protocol/manager-gates"
import { aprToApy } from "@/lib/protocol/math"
import { createRpcReader, liveValue, unavailable } from "@/lib/protocol/reader"
import type { Role } from "@/lib/protocol/roles"
import {
  firstDepositGate,
  readSeedState,
  SEED_NOT_WORKED_OUT,
  seedAmounts,
  seedPair,
  seedResume,
  simulatedSeedCall,
  type SeedAmounts,
  type SeedPairResult,
  type SeedRefusal,
  type SeedSimulate,
} from "@/lib/protocol/seed"
import { createRpcServer, getLedgerClock, simulateInvocation } from "@/lib/protocol/stellar"
import type { Live } from "@/lib/protocol/types"

/** PT, SY and LP have 7 decimals. */
const TOKEN_DECIMALS = 7

/**
 * A fresh seed mints and deposits the amount typed; a resumed one (the wallet already holds this
 * market's PT: a seed was started and not finished) finishes with that PT and deposits only the SY
 * missing, so a retried seed never mints twice.
 */
type Plan =
  | { mode: "fresh"; amounts: SeedAmounts }
  | { mode: "resume"; amounts: SeedPairResult & { depositUnderlying: bigint }; heldPt: bigint; heldSy: bigint }

const liveOf = <T,>(value: Live<T> | undefined): T | undefined => (value?.status === "live" ? value.value : undefined)

/**
 * Step 6 (spec 0002 §5, R5-10): seed the pool from a starting fixed APY and an amount of the
 * underlying. The PT and SY are worked out from the APY with the pool's own curve (`seed.ts`), within
 * its first-deposit rules, and an APY of 0 or less is refused (PT would be priced at or above par,
 * and YT could never be bought). The three calls, Router `wrap_and_mint`, SY `deposit` and Router
 * `add_liquidity`, run in that order through the manager-call path, each reviewed and signed on its
 * own; each is built just before its review, with its floor from its own simulation then. The
 * first-deposit gate stands in for `poolGate`, which refuses an unseeded pool to clients. Signed by
 * the asset's issuer, whom step 5 granted this market's PT and YT. Stays mounted under its flow.
 */
export function StepSeed({ salt, progress, account, ledgerTime }: ChainStepProps) {
  const id = useId()
  const manifest = useManifest()
  const { state: wallet } = useWallet()
  const findings = useManifestFindings()
  const { slippageBps, deadlineSeconds } = useSettings()
  const { predicted, live } = progress
  const seedState = useSeedState(predicted, account)
  const [apyText, setApyText] = useState("")
  const [amountText, setAmountText] = useState("")

  const asset = knownUnderlyings(manifest).get(live.underlying)
  const code = asset?.code ?? "underlying"
  const isIssuer = account !== null && account === live.admin
  const data = seedState.data
  const readError = data === undefined && seedState.isError ? seedState.error.message : null

  const pool = liveOf(data?.poolState)
  const exchangeRate = liveOf(data?.exchangeRate)
  const feeBps = liveOf(data?.feeBps)
  const heldPt = liveOf(data?.balances?.pt)
  const heldSy = liveOf(data?.balances?.sy)
  const resuming = heldPt !== undefined && heldPt > 0n

  // The inputs: a percent with up to 5 decimals is the APY at SCALE (1e7 is 100 %).
  const apy = apyText.trim() === "" ? undefined : parseDecimalToRaw(apyText, 5)
  const amount = amountText.trim() === "" || !asset ? undefined : parseDecimalToRaw(amountText, asset.decimals)
  const apyError = apy === null ? "Enter the APY as a percent, such as 5 or 4.25." : null
  const amountError = amount === null ? `Enter an amount of ${code}, with at most ${asset?.decimals ?? 7} decimals.` : null

  let plan: Plan | SeedRefusal | undefined
  if (!asset) {
    plan = { error: `${live.underlying} is not an asset this network's manifest knows, so the seed cannot be worked out.` }
  } else if (typeof apy === "bigint" && pool && exchangeRate !== undefined && heldPt !== undefined && heldSy !== undefined) {
    const s = { secondsToMaturity: pool.secondsToMaturity, exponent: pool.exponent }
    if (resuming) {
      const r = seedResume({ apy, heldPt, heldSy, s, oracleRate: pool.rate, exchangeRate })
      plan = "error" in r ? r : { mode: "resume", amounts: r, heldPt, heldSy }
    } else if (typeof amount === "bigint" && feeBps !== undefined) {
      const r = seedAmounts({ apy, amountUnderlying: amount, s, oracleRate: pool.rate, exchangeRate, feeBps })
      plan = "error" in r ? r : { mode: "fresh", amounts: r }
    }
  }
  const planError = plan && "error" in plan ? plan.error : null
  const ready = plan && !("error" in plan) ? plan : undefined

  // The first-deposit rule in place of poolGate: unseeded, a fresh oracle, amounts within the rules.
  const gate = firstDepositGate({
    totalLp: liveValue(live.lpTotalSupply, 0),
    oracleFresh: data?.oracleFresh ?? unavailable(readError ?? "still being read"),
    amounts: plan === undefined ? undefined : "error" in plan ? plan : plan.amounts,
  })
  const reads: [Live<unknown> | undefined, string][] = [
    [data?.poolState, "the pool's state"],
    [data?.exchangeRate, "the SY exchange rate"],
    [data?.feeBps, "the tokenization fee"],
    [data?.balances?.pt, "your PT of this market"],
    [data?.balances?.sy, "your SY of this market"],
  ]
  const unread = reads.flatMap(([v, what]) => (v?.status === "unavailable" ? [`${what} (${v.error})`] : []))
  // Shown beside the fields: the amount refusal is the plan's error, and "not worked out" is the empty form.
  const shown = gate.filter((b) => b.code !== "amount" && b.message !== SEED_NOT_WORKED_OUT)

  const market: NewMarket = { salt, underlying: live.underlying }
  const simulate: SeedSimulate = (source, invocation) =>
    simulateInvocation({ rpcUrl: manifest.rpcUrl, networkPassphrase: manifest.networkPassphrase, source, invocation })
  // A deferred call is built after the earlier signatures have landed: its deadline is the ledger's
  // time read then (never the browser clock), plus the deadline setting fixed when the flow started.
  const deadline = async () => {
    try {
      const clock = await getLedgerClock(createRpcServer(manifest.rpcUrl))
      return BigInt(clock.closeTime + deadlineSeconds)
    } catch (error) {
      throw new Error(`The ledger time could not be read (${error instanceof Error ? error.message : String(error)}), so the call's deadline cannot be set. Nothing was signed; try again in a moment.`)
    }
  }
  const built = (source: string, params: Parameters<typeof simulatedSeedCall>[0]["params"]) =>
    simulatedSeedCall({ manifest, source, market, params, simulate, slippageBps, pool: predicted.pool })

  let steps: ManagerStep[] = []
  if (ready && account && typeof apy === "bigint") {
    const source = account
    /** The pool's first deposit, worked out again once the mint and deposit have landed: from what the wallet then holds (at most `cap`), at the oracle rate of that moment. */
    const addLiquidity = (cap?: { pt: bigint; sy: bigint }) => ({
      build: async (): Promise<ManagerCall> => {
        const now = await readSeedState(createRpcReader(manifest), manifest, predicted, source)
        const st = now.poolState
        const pt = liveOf(now.balances?.pt)
        const sy = liveOf(now.balances?.sy)
        if (st.status !== "live" || pt === undefined || sy === undefined) {
          throw new Error("The pool or your PT and SY could not be read, so the first deposit cannot be worked out. Nothing was signed; try again in a moment.")
        }
        // Anyone with the grants can call the pool: had another deposit seeded it meanwhile, this call
        // would land as a proportional deposit at that deposit's ratio, not as the seed this step offers.
        // Its floor guards the moments between this check and inclusion.
        if (st.value.totalLp > 0n) {
          throw new Error("The pool was already seeded by another deposit while this ran, so there is no first deposit left to make. Nothing was signed. Close this; the wizard moves on.")
        }
        const min = (a: bigint, b: bigint | undefined) => (b !== undefined && b < a ? b : a)
        const pair = seedPair({
          apy,
          maxPt: min(pt, cap?.pt),
          maxSy: min(sy, cap?.sy),
          s: { secondsToMaturity: st.value.secondsToMaturity, exponent: st.value.exponent },
          oracleRate: st.value.rate,
        })
        if ("error" in pair) throw new Error(pair.error)
        return built(source, { kind: "seed_add_liquidity", pt: pair.pt, sy: pair.sy, deadline: await deadline() })
      },
    })
    if (ready.mode === "fresh") {
      const a = ready.amounts
      steps = [
        { build: async () => built(source, { kind: "seed_mint", amount: a.mintUnderlying, deadline: await deadline() }) },
        { build: () => built(source, { kind: "seed_deposit", amount: a.depositUnderlying }) },
        // At most the plan's PT and SY: SY the wallet held before stays where it is.
        addLiquidity({ pt: a.pt, sy: a.sy }),
      ]
    } else {
      const deposit = ready.amounts.depositUnderlying
      steps = [...(deposit > 0n ? [{ build: () => built(source, { kind: "seed_deposit", amount: deposit }) }] : []), addLiquidity()]
    }
  }

  // The asset's issuer signs (step 5 granted it this market's PT and YT). Re-checked on every render:
  // a pool someone else seeded meanwhile is not seeded again.
  const roles: Live<Role[]> = { status: "live", value: isIssuer ? ["issuer"] : [], ledger: 0 }
  const blockersFor = (call: ManagerCall): Blocker[] => [
    ...evaluateManagerGates(call, { wallet, roles, findings, listed: true }),
    // The registry lists the market at step 7; until then the wizard's progress checks every contract runs pinned code.
    ...gate,
  ]

  const tok = (raw: bigint) => formatTokenAmount(raw, TOKEN_DECIMALS)
  const und = (raw: bigint) => `${formatTokenAmount(raw, asset?.decimals ?? 7)} ${code}`
  const apyId = `${id}-apy`
  const amountId = `${id}-amount`

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 6 of 7: Seed the pool
        </h2>
        <p className="text-sm text-ink-muted">
          The pool needs its first liquidity before anyone can trade. Enter the fixed APY it starts at and the {code} to put in: part
          is minted into PT and YT, the rest deposited as SY, and the pool takes the PT and SY in the ratio that prices that APY. Three
          transactions, each reviewed and signed in your wallet.
        </p>
      </div>

      {!isIssuer ? (
        <p role="alert" className="rounded-lg border border-line bg-surface p-4 text-sm break-words text-ink">
          Only the {code} issuer seeds this pool: step 5 gave this market&apos;s PT and YT permissions to the asset contract&apos;s admin, which is{" "}
          <span className="font-mono">{live.admin}</span>.{" "}
          {account ? (
            <>
              You are connected as <span className="font-mono">{account}</span>.{" "}
            </>
          ) : null}
          Connect that wallet to seed it. This page&apos;s link keeps your place.
        </p>
      ) : null}

      {resuming && heldPt !== undefined && heldSy !== undefined ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm break-words text-ink">
          Your wallet already holds {tok(heldPt)} PT and {tok(heldSy)} SY of this market: a seed was started and not finished. It
          finishes with that PT, so no more is minted; any SY missing is deposited first.
        </p>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[560px]:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={apyId}>Starting fixed APY (%)</Label>
          <Input
            id={apyId}
            value={apyText}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={apyError ? true : undefined}
            aria-describedby={`${apyId}-note`}
            onChange={(e) => setApyText(e.target.value)}
          />
          <p id={`${apyId}-note`} className="text-xs/5 text-ink-muted">
            The fixed APY the market list shows once the pool is seeded. It must be above 0%.
          </p>
          {apyError ? (
            <p role="alert" className="text-xs/5 text-negative">
              {apyError}
            </p>
          ) : null}
        </div>
        {resuming ? null : (
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={amountId}>Amount ({code})</Label>
            <Input
              id={amountId}
              value={amountText}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={amountError ? true : undefined}
              aria-describedby={`${amountId}-note`}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <p id={`${amountId}-note`} className="text-xs/5 text-ink-muted">
              All of it is used: the YT minted stays in your wallet, the PT and SY go to the pool.
            </p>
            {amountError ? (
              <p role="alert" className="text-xs/5 text-negative">
                {amountError}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {readError ? (
        <p role="alert" className="text-sm text-negative">
          {UNAVAILABLE}: what the seed needs could not be read ({readError}). Seeding stays off until it can.
        </p>
      ) : null}
      {unread.length > 0 ? (
        <p role="alert" className="text-sm text-negative">
          {UNAVAILABLE}: {unread.join("; ")}. Seeding stays off until it can be read.
        </p>
      ) : null}
      {planError ? (
        <p role="alert" className="text-sm text-negative">
          {planError}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="grid gap-1 text-sm text-negative">
          {shown.map((b) => (
            <li key={b.message} role="alert">
              {b.message}
            </li>
          ))}
        </ul>
      ) : null}

      {ready ? (
        <dl className="grid gap-2 rounded-lg border border-line bg-surface p-4 text-sm">
          {ready.mode === "fresh" ? (
            <>
              <Row label="Minted into PT and YT">{und(ready.amounts.mintUnderlying)}</Row>
              <Row label="Deposited as SY">{und(ready.amounts.depositUnderlying)}</Row>
            </>
          ) : ready.amounts.depositUnderlying > 0n ? (
            <Row label="Deposited as SY first">{und(ready.amounts.depositUnderlying)}</Row>
          ) : null}
          <Row label="The pool takes">
            {tok(ready.amounts.pt)} PT and {tok(ready.amounts.sy)} SY
          </Row>
          <Row label="Starting fixed APY">
            The pool&apos;s fixed APY starts at {formatPercent(aprToApy(ready.amounts.impliedRate, pool?.secondsToMaturity ?? 0n))} (implied
            rate {formatPercent(Number(ready.amounts.impliedRate) / 1e7)} a year, simple); one PT is priced at{" "}
            {formatRate(ready.amounts.ptPrice)} of its value at maturity.
          </Row>
          <Row label="Your liquidity">About {tok(ready.amounts.lp)} LP; the pool keeps 1,000 raw units of LP forever.</Row>
        </dl>
      ) : null}
      {ready ? (
        <p className="text-xs/5 text-ink-muted">
          Each amount is final only in its review: the floors come from each call&apos;s simulation, and the pool&apos;s first deposit is
          worked out again from what your wallet holds once the mint and deposit have landed. A few raw units of PT or SY may stay in your
          wallet.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <ManagerSignFlow
          label="Seed the pool"
          title="Seed the pool"
          steps={steps}
          disabled={steps.length === 0 || !isIssuer || gate.length > 0 || unread.length > 0}
          blockersFor={blockersFor}
          ledgerTime={ledgerTime}
          network={manifest.network}
        />
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 min-[560px]:grid-cols-[12rem_minmax(0,1fr)] min-[560px]:gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="break-words text-ink">{children}</dd>
    </div>
  )
}
