/**
 * The screenshots of the public "Testnet walkthrough" docs page (plan 0007, Task 6; R7-6). Run by
 * hand, never in CI (it is not a `*.test.ts`, so no Vitest config picks it up):
 *
 *   pnpm walkthrough:shots [--out <dir>] [--base <url>] [--onboard-base <url>] [--claim-wait <minutes>] [--headed]
 *
 * - `--out`: where the PNGs go. Default: `e2e-artifacts/walkthrough/` (gitignored). The docs set
 *   (`../docs/public/images/walkthrough`) is replaced only by hand, or with that path as an explicit `--out`.
 * - `--base`: the app the journey runs on. Default: the live Testnet app, https://testnet.principalmarket.fi.
 *   A local production build of the `testnet` branch on Testnet works too (`http://localhost:3000`): build and
 *   start it with `NEXT_PUBLIC_PRINCIPAL_NETWORK=testnet DATABASE_URL= FAUCET_ISSUER_SECRET=` in front of both
 *   `pnpm build` and `pnpm start`, so `.env.local`'s local-stack settings stay out (the registry then lists the
 *   manifest's market).
 * - `--onboard-base`: the app whose **Get test tokens** dialog onboards the account. Default: the live
 *   Testnet app, whose faucet needs no secret here; a local build has no faucet keys for Testnet.
 * - `--claim-wait`: how long to wait for yield to accrue before Claim yield (an oracle update), 45 by default.
 *
 * It follows Suite A's journey (`journey.test.ts`) in the browser, with Suite A's amounts, on the
 * official market: connect, Get test tokens, Deposit, Split, Buy and Sell PT, Buy and Sell YT, add
 * and withdraw liquidity, Claim yield, Portfolio and History, and what the app shows before maturity.
 *
 * The wallet is a test-only stand-in for the Varial extension, injected into the page and never
 * into the app: freighter-api 4.x talks to the extension with `window.postMessage`
 * (`FREIGHTER_EXTERNAL_MSG_REQUEST`, answered by `FREIGHTER_EXTERNAL_MSG_RESPONSE` with the request's
 * id in `messagedId`), so an init script answers those messages. Every answer, and every signature,
 * comes from Node through one exposed function. The keypair is a throwaway made here for this run:
 * its secret stays in a Node closure and never reaches the page, a log, a file or a screenshot. It
 * signs Testnet transactions from its own account only.
 *
 * A step that fails is reported and the run goes on with the next one; the run ends with a table of
 * what was captured. Nothing is written but the PNGs (and, for a failed step, a debug PNG in the
 * system's temporary folder).
 */
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk"
import { chromium, type BrowserContext, type Locator, type Page } from "playwright"

const LIVE = "https://testnet.principalmarket.fi"
/** The official Testnet market (`config/manifests/testnet.json`). */
const MARKET = "testnet-usdy-1802336344"

// Suite A's amounts (`journey.test.ts`), in whole USDY: small next to the official pool.
const DEPOSIT = "500"
const SPLIT = "300"
const BUY_PT = "200"
const SELL_PT = "100"
/** Suite A's flash budget, 5,000,000 raw units. */
const BUY_YT_BUDGET = "0.5"
const KEEP_YT = "300"

const MINUTE = 60_000

/** As `tests/live/util.ts`: a secret key (S + 55 base32 characters) never reaches a log. */
const redact = (text: unknown) => String(text ?? "").replace(/S[A-Z2-7]{55}/g, "S…[redacted]")
const log = (line: string) => console.log(`[walkthrough] ${redact(line)}`)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

type Args = { out: string; base: string; onboardBase: string; claimWaitMinutes: number; headed: boolean }

function parseArgs(argv: string[]): Args {
  const dapp = resolve(import.meta.dirname, "..", "..")
  const args: Args = {
    // Never the docs set by default: a run replaces only what it shoots, and the docs set mixes sources.
    out: resolve(dapp, "e2e-artifacts", "walkthrough"),
    base: LIVE,
    onboardBase: LIVE,
    claimWaitMinutes: 45,
    headed: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (!v) throw new Error(`${flag} needs a value`)
      return v
    }
    if (flag === "--out") args.out = resolve(value())
    else if (flag === "--base") args.base = value().replace(/\/+$/, "")
    else if (flag === "--onboard-base") args.onboardBase = value().replace(/\/+$/, "")
    else if (flag === "--claim-wait") args.claimWaitMinutes = Number(value())
    else if (flag === "--headed") args.headed = true
    else throw new Error(`unknown argument ${flag}`)
  }
  if (!Number.isFinite(args.claimWaitMinutes) || args.claimWaitMinutes < 0) throw new Error("--claim-wait takes minutes, 0 or more")
  return args
}

// ---------------------------------------------------------------------------------------------
// The wallet stand-in
// ---------------------------------------------------------------------------------------------

/** A freighter-api request as the page posts it, without its envelope (`source`, `messageId`). */
type WalletRequest = { type: string; transactionXdr?: string; networkPassphrase?: string }
type WalletAnswer = Record<string, unknown>

/** What the wallet hands out: the public key, and a signer. The keypair itself never leaves this closure. */
type ThrowawayWallet = { publicKey: string; answer(request: WalletRequest): WalletAnswer; signed(): number }

const DECLINED = { code: -4, message: "The user rejected this request." }

function throwawayWallet(): ThrowawayWallet {
  const keypair = Keypair.random()
  const publicKey = keypair.publicKey()
  // As the extension: the site is allowed once the user approved the connection.
  let allowed = false
  let count = 0

  function sign(xdr: string | undefined, passphrase: string | undefined): WalletAnswer {
    // Testnet only, and only a transaction from this account: anything else is refused, as a user would.
    if (passphrase !== Networks.TESTNET || !xdr) return { apiError: DECLINED }
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET)
    if (!(tx instanceof Transaction) || tx.source !== publicKey) return { apiError: DECLINED }
    tx.sign(keypair)
    count += 1
    log(`signed transaction ${count}: ${Buffer.from(tx.hash()).toString("hex")}`)
    return { signedTransaction: tx.toXDR(), signerAddress: publicKey }
  }

  return {
    publicKey,
    signed: () => count,
    answer(request) {
      switch (request.type) {
        case "REQUEST_CONNECTION_STATUS":
          return { isConnected: true }
        case "REQUEST_ALLOWED_STATUS":
          return { isAllowed: allowed }
        case "SET_ALLOWED_STATUS":
        case "REQUEST_ACCESS":
          allowed = true
          return { isAllowed: true, publicKey }
        case "REQUEST_PUBLIC_KEY":
          return { publicKey: allowed ? publicKey : "" }
        case "REQUEST_NETWORK_DETAILS":
          // `getNetwork` and `WatchWalletChanges` both read these: Varial switched to Testnet.
          return {
            networkDetails: {
              network: "TESTNET",
              networkName: "Testnet",
              networkUrl: "https://horizon-testnet.stellar.org",
              networkPassphrase: Networks.TESTNET,
              sorobanRpcUrl: "https://soroban-testnet.stellar.org",
            },
          }
        case "SUBMIT_TRANSACTION":
          try {
            return sign(request.transactionXdr, request.networkPassphrase)
          } catch (error) {
            // A malformed envelope: answered as an error, as freighter-api expects, so the app never waits on the wallet.
            log(`refused to sign: ${error instanceof Error ? error.message : String(error)}`)
            return { apiError: { code: -1, message: "The wallet could not read this transaction." } }
          }
        default:
          return { apiError: { code: -1, message: `${request.type} is not supported by this test wallet` } }
      }
    },
  }
}

/** Installs the wallet in every page of `context`: an init script that forwards freighter-api's messages to Node. */
async function installWallet(context: BrowserContext, wallet: ThrowawayWallet): Promise<void> {
  await context.exposeFunction("__walkthroughWallet", (request: WalletRequest) => wallet.answer(request))
  await context.addInitScript(() => {
    const page = window as unknown as Window & { __walkthroughWallet(request: unknown): Promise<Record<string, unknown>> }
    page.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== page) return
      const data: unknown = event.data
      if (!data || typeof data !== "object") return
      const { source, messageId, ...request } = data as { source?: unknown; messageId?: unknown }
      if (source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return
      const reply = (answer: Record<string, unknown>) =>
        page.postMessage({ ...answer, source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: messageId }, page.location.origin)
      // Any failure still answers the request, so the app never waits on the wallet.
      void page
        .__walkthroughWallet(request)
        .then(reply)
        .catch(() => reply({ apiError: { code: -1, message: "The wallet encountered an internal error." } }))
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

/** Polls `check` until it holds, every second, for at most `timeoutMs`. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if (await check().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(1_000)
  }
}

const enabled = (l: Locator) => async () => (await l.count()) > 0 && (await l.first().isEnabled())
const visible = (l: Locator) => async () => (await l.count()) > 0 && (await l.first().isVisible())

/** Toasts are hidden in every shot: the same result shows under the form. */
const HIDE_TOASTS = "[data-sonner-toaster] { display: none !important; }"

type Shots = { dir: string; taken: { name: string; bytes: number; source: string }[] }

/**
 * A PNG of `target` (an element, padded by `pad` CSS pixels and kept inside the viewport), or of a
 * fixed region of the page.
 */
async function shot(shots: Shots, page: Page, name: string, target: Locator | { x: number; y: number; width: number; height: number }, pad = 16) {
  // Tooltips open on hover and on focus: the pointer stays where the last click was, and a dialog
  // focuses its first button when it opens (the Claim yield dialog, an info tip's button).
  await page.mouse.move(1, 1)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
  })
  await sleep(500)
  let clip: { x: number; y: number; width: number; height: number }
  if ("boundingBox" in target) {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box) throw new Error(`${name}: the element is not visible`)
    const view = page.viewportSize() ?? { width: 1280, height: 1100 }
    const x = Math.max(0, box.x - pad)
    const y = Math.max(0, box.y - pad)
    clip = { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) }
    if (clip.width < box.width + 2 * pad || clip.height < box.height + 2 * pad) {
      log(`warning: ${name}.png is cut to the ${view.width} x ${view.height} viewport (the element is ${Math.round(box.width)} x ${Math.round(box.height)} at ${Math.round(box.x)}, ${Math.round(box.y)})`)
    }
  } else {
    clip = target
  }
  const path = join(shots.dir, `${name}.png`)
  const buffer = await page.screenshot({ path, clip, animations: "disabled", caret: "hide", style: HIDE_TOASTS })
  shots.taken.push({ name: `${name}.png`, bytes: buffer.length, source: new URL(page.url()).origin })
  log(`shot ${name}.png (${Math.round(buffer.length / 1024)} KB) from ${new URL(page.url()).origin}`)
}

/** The number in an amount field's "Balance: 1,234.5 USDY" line. */
async function balanceIn(scope: Locator): Promise<number> {
  const line = scope.getByText(/^Balance: [0-9]/).first()
  await until(visible(line), "a balance", 2 * MINUTE)
  const text = (await line.textContent()) ?? ""
  const value = Number(text.replace(/^Balance: /, "").replace(/[^0-9.]/g, ""))
  if (!Number.isFinite(value)) throw new Error(`cannot read the balance in "${text}"`)
  return value
}

/** Half of `balance`, rounded down to two decimals, as typed in a field. */
const halfOf = (balance: number) => (Math.floor((balance / 2) * 100) / 100).toFixed(2).replace(/\.?0+$/, "")

/** Waits until the figures are simulated as the account ("Exact (simulated)"), briefly: indicative figures are fine too. */
async function waitExact(scope: Locator) {
  await until(visible(scope.getByText(/Exact \(simulated\)/).first()), "simulated figures", MINUTE).catch(() => log("figures stayed indicative"))
}

// ---------------------------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------------------------

type Ctx = { page: Page; args: Args; shots: Shots; wallet: ThrowawayWallet }

const marketUrl = (base: string, query = "") => `${base}/app/markets/${MARKET}${query ? `?${query}` : ""}`

async function openMarket(c: Ctx, query: string): Promise<Locator> {
  await c.page.goto(marketUrl(c.args.base, query), { waitUntil: "load" })
  const trade = c.page.getByRole("region", { name: "Trade" })
  await until(visible(trade.getByRole("tabpanel")), "the Trade panel", 2 * MINUTE)
  return trade
}

/** The panel's amount field, then the figures, then the enabled Review button. */
async function fillTrade(trade: Locator, amount: string): Promise<Locator> {
  const panel = trade.getByRole("tabpanel")
  await balanceIn(panel)
  await panel.getByRole("textbox").first().fill(amount)
  const review = panel.getByRole("button", { name: /^Review / })
  await until(enabled(review), "the Review button", 2 * MINUTE)
  await waitExact(panel)
  return review
}

/** Opens the route review, shoots it when `name` is set, signs it and waits for "Route complete". */
async function signRoute(c: Ctx, trade: Locator, review: Locator, name?: string): Promise<void> {
  await review.click()
  const dialog = c.page.getByRole("dialog", { name: /^Review route:/ })
  const sign = dialog.getByRole("button", { name: /^Sign step 1 of 1$/ })
  await until(enabled(sign), "the route review", 2 * MINUTE)
  if (name) await shot(c.shots, c.page, name, dialog)
  await sign.click()
  const progress = trade.getByRole("region", { name: "Route progress" })
  const stopped = progress.getByRole("alert")
  await until(async () => (await visible(progress.getByText(/^Route complete/))()) || (await visible(stopped)()), "Route complete", 4 * MINUTE)
  if (await visible(stopped)()) throw new Error(`the route stopped: ${(await stopped.first().textContent()) ?? ""}`)
}

/** A Quick action dialog (Deposit, Split): fill, review, sign, wait for its result. */
async function quickAction(c: Ctx, query: string, title: string, amount: string, names: { form?: string; review?: string; done?: string }) {
  await c.page.goto(marketUrl(c.args.base, query), { waitUntil: "load" })
  const dialog = c.page.getByRole("dialog", { name: title })
  await until(visible(dialog), `the ${title} dialog`, 2 * MINUTE)
  await balanceIn(dialog)
  await dialog.getByRole("textbox").first().fill(amount)
  const review = dialog.getByRole("button", { name: /^Review / })
  await until(enabled(review), `${title}: the Review button`, 2 * MINUTE)
  await waitExact(dialog)
  if (names.form) await shot(c.shots, c.page, names.form, dialog)
  await review.click()
  const reviewDialog = c.page.getByRole("dialog", { name: /^Review: / })
  const sign = reviewDialog.getByRole("button", { name: "Sign transaction" })
  await until(enabled(sign), `${title}: the review`, 2 * MINUTE)
  if (names.review) await shot(c.shots, c.page, names.review, reviewDialog)
  await sign.click()
  const result = dialog.getByRole("status").filter({ hasText: "stellar.expert" })
  await until(visible(result), `${title}: the result`, 4 * MINUTE)
  const text = (await result.first().textContent()) ?? ""
  if (!/^You /.test(text.trim())) throw new Error(`${title}: ${text}`)
  if (names.done) await shot(c.shots, c.page, names.done, dialog)
  await c.page.keyboard.press("Escape")
}

/** The steps, in the page's order. A step that throws is reported; the run goes on. */
const STEPS: { id: string; critical?: boolean; run(c: Ctx): Promise<void> }[] = [
  {
    id: "2 Connect",
    critical: true,
    async run(c) {
      const { page } = c
      await page.goto(`${c.args.onboardBase}/app`, { waitUntil: "load" })
      const connect = page.getByRole("button", { name: "Connect wallet" })
      await until(visible(connect), "Connect wallet", 2 * MINUTE)
      await shot(c.shots, page, "02-connect-wallet", { x: 0, y: 0, width: 1280, height: 104 })
      await connect.click()
      const short = `${c.wallet.publicKey.slice(0, 4)}…${c.wallet.publicKey.slice(-4)}`
      const account = page.getByRole("banner").getByRole("button", { name: short })
      await until(visible(account), "the connected wallet", MINUTE)
      await account.click()
      await until(visible(page.getByRole("menuitem", { name: "Get test tokens" })), "the address menu", MINUTE)
      // Below the Testnet banner (37 px), which this crop would cut mid-sentence.
      await shot(c.shots, page, "02-address-menu", { x: 760, y: 37, width: 520, height: 225 })
    },
  },
  {
    id: "3 Get test tokens",
    critical: true,
    async run(c) {
      const { page } = c
      await page.getByRole("menuitem", { name: "Get test tokens" }).click()
      const dialog = page.getByRole("dialog", { name: "Get test tokens" })
      const start = dialog.getByRole("button", { name: "Start" })
      await until(enabled(start), "the Start button", 2 * MINUTE)
      await shot(c.shots, page, "03-get-test-tokens", dialog)
      await start.click()
      const ready = dialog.getByText(/Your account is ready/)
      const again = dialog.getByRole("button", { name: "Try again" })
      for (let attempt = 1; ; attempt++) {
        await until(async () => (await visible(ready)()) || (await enabled(again)()), "the faucet", 6 * MINUTE)
        if (await visible(ready)()) break
        const reason = (await dialog.getByRole("alert").first().textContent().catch(() => "")) ?? ""
        if (attempt >= 3) throw new Error(`Get test tokens failed: ${reason}`)
        // The faucet serves an account, and a connection, once a minute.
        log(`Get test tokens: ${reason}; trying again in a minute`)
        await sleep(61_000)
        await again.click()
      }
      await shot(c.shots, page, "03-account-ready", dialog)
      await page.keyboard.press("Escape")
    },
  },
  {
    id: "4 Deposit",
    run: (c) => quickAction(c, "quick=deposit", "Deposit USDY → SY", DEPOSIT, { review: "04-deposit-review", done: "04-deposit-done" }),
  },
  {
    id: "5 Mint (Split)",
    run: (c) => quickAction(c, "quick=split", "Split USDY → PT + YT", SPLIT, { form: "05-split", review: "05-split-review" }),
  },
  {
    id: "6 Buy PT",
    async run(c) {
      const trade = await openMarket(c, "tab=pt&side=buy")
      const review = await fillTrade(trade, BUY_PT)
      await shot(c.shots, c.page, "06-buy-pt", trade)
      await signRoute(c, trade, review, "06-buy-pt-review")
    },
  },
  {
    id: "6 Sell PT",
    async run(c) {
      const trade = await openMarket(c, "tab=pt&side=sell")
      const review = await fillTrade(trade, SELL_PT)
      await shot(c.shots, c.page, "06-sell-pt", trade)
      await signRoute(c, trade, review)
    },
  },
  {
    id: "7 Buy YT",
    async run(c) {
      const trade = await openMarket(c, "tab=yt&side=buy")
      const review = await fillTrade(trade, BUY_YT_BUDGET)
      await shot(c.shots, c.page, "07-buy-yt", trade)
      await signRoute(c, trade, review, "07-buy-yt-review")
    },
  },
  {
    id: "7 Sell YT",
    async run(c) {
      const trade = await openMarket(c, "tab=yt&side=sell")
      const half = halfOf(await balanceIn(trade.getByRole("tabpanel")))
      log(`selling ${half} YT, half of the balance`)
      const review = await fillTrade(trade, half)
      await shot(c.shots, c.page, "07-sell-yt", trade)
      await signRoute(c, trade, review)
    },
  },
  {
    id: "8 Add liquidity (Keep YT)",
    async run(c) {
      const trade = await openMarket(c, "tab=lp&side=deposit")
      const review = await fillTrade(trade, KEEP_YT)
      await shot(c.shots, c.page, "08-add-liquidity", trade)
      await signRoute(c, trade, review, "08-add-liquidity-review")
    },
  },
  {
    id: "8 Withdraw liquidity",
    async run(c) {
      const trade = await openMarket(c, "tab=lp&side=withdraw")
      const half = halfOf(await balanceIn(trade.getByRole("tabpanel")))
      log(`withdrawing ${half} LP, half of the balance`)
      const review = await fillTrade(trade, half)
      await shot(c.shots, c.page, "08-withdraw-liquidity", trade)
      await signRoute(c, trade, review)
    },
  },
  {
    id: "9 Claim yield",
    async run(c) {
      const { page } = c
      // Yield accrues when the oracle rate rises, at the keeper's next update: wait for it, bounded.
      const end = Date.now() + c.args.claimWaitMinutes * MINUTE
      let dialog: Locator
      let review: Locator
      for (;;) {
        await page.goto(`${c.args.base}/app/portfolio`, { waitUntil: "load" })
        const claim = page.getByRole("button", { name: "Claim yield" })
        await until(enabled(claim), "the Claim yield shortcut", 2 * MINUTE)
        await claim.first().click()
        dialog = page.getByRole("dialog", { name: "Claim yield" })
        review = dialog.getByRole("button", { name: /^Review Claim yield/ })
        const ready = await until(enabled(review), "yield to claim", 2 * MINUTE).then(
          () => true,
          () => false,
        )
        if (ready) break
        if (Date.now() > end) {
          await shot(c.shots, page, "09-claim-yield", dialog)
          throw new Error(`no yield to claim after ${c.args.claimWaitMinutes} minutes: the dialog is shot as it stands`)
        }
        log("no yield to claim yet; waiting for the next oracle update")
        await sleep(3 * MINUTE)
      }
      await waitExact(dialog)
      // A simulation run just before the oracle update reads no yield yet: wait for the one after it.
      const exact = dialog.getByRole("region", { name: "Preview" }).getByRole("definition").first()
      await until(async () => !/^0\.0000 /.test(((await exact.textContent()) ?? "").trim()), "the simulated claim", 2 * MINUTE).catch(() =>
        log("the simulated claim still reads 0.0000"),
      )
      await shot(c.shots, page, "09-claim-yield", dialog)
      await review.click()
      const reviewDialog = page.getByRole("dialog", { name: /^Review: / })
      const sign = reviewDialog.getByRole("button", { name: "Sign transaction" })
      await until(enabled(sign), "the claim review", 2 * MINUTE)
      await shot(c.shots, page, "09-claim-yield-review", reviewDialog)
      await sign.click()
      const result = dialog.getByRole("status").filter({ hasText: "stellar.expert" })
      await until(visible(result), "the claim's result", 4 * MINUTE)
      const text = (await result.first().textContent()) ?? ""
      if (!/^You claimed/.test(text.trim())) throw new Error(`Claim yield: ${text}`)
      await page.keyboard.press("Escape")
    },
  },
  {
    id: "10 Portfolio",
    async run(c) {
      const { page } = c
      await page.goto(`${c.args.base}/app/portfolio`, { waitUntil: "load" })
      // The market's card is a region named after the market.
      const card = page.getByRole("main").getByRole("region", { name: "USDY (test)" })
      await until(visible(card), "the position card", 2 * MINUTE)
      await until(async () => !(await card.getByText(/loading/i).count()), "the card's figures", 2 * MINUTE).catch(() => log("some figures still loading"))
      await shot(c.shots, page, "10-portfolio", card)
    },
  },
  {
    id: "10 History",
    async run(c) {
      const { page } = c
      const table = page.getByRole("table")
      const failed = page.getByRole("main").getByRole("alert").filter({ hasText: "could not load history" })
      // A failed read says so ("could not load history"); the page reads again on a reload, three times at most.
      for (let attempt = 1; ; attempt++) {
        await page.goto(`${c.args.base}/app/history`, { waitUntil: "load" })
        // The table shows this browser's own records at once; the network's events have loaded once
        // the line that names their ledgers is there.
        const loaded = page.getByText(/^Showing activity from ledger/)
        await until(async () => ((await visible(table)()) && (await visible(loaded)())) || (await visible(failed)()), "the History table", 3 * MINUTE)
        if (await visible(loaded)()) break
        if (attempt >= 3) throw new Error("History could not load the transactions, three times")
        log("History could not load; reloading")
      }
      await until(async () => !(await table.getByText(/^Pending$/).count()), "no pending row", 3 * MINUTE).catch(() => log("rows still pending"))
      await shot(c.shots, page, "10-history", page.getByRole("main").getByRole("region", { name: "History" }))
    },
  },
  {
    id: "11 Before maturity",
    async run(c) {
      const { page } = c
      await page.goto(`${c.args.base}/app/portfolio`, { waitUntil: "load" })
      // The block is the list that starts with this label.
      const block = page.getByText("Fixed return if held to maturity").locator("xpath=ancestor::dl[1]")
      await until(visible(block), "the held-to-maturity block", 2 * MINUTE)
      await shot(c.shots, page, "11-held-to-maturity", block)
    },
  },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.out, { recursive: true })
  const debugDir = join(tmpdir(), "walkthrough-shots-debug")
  mkdirSync(debugDir, { recursive: true })
  const wallet = throwawayWallet()
  log(`account ${wallet.publicKey} (throwaway, Testnet); journey on ${args.base}, onboarding on ${args.onboardBase}; PNGs to ${args.out}`)

  const shots: Shots = { dir: args.out, taken: [] }
  const results: { id: string; ok: boolean; note: string }[] = []
  const browser = await chromium.launch({ headless: !args.headed })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1100 },
      deviceScaleFactor: 2,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
    })
    await installWallet(context, wallet)
    const page = await context.newPage()
    page.on("pageerror", (error) => log(`page error: ${error.message}`))
    const c: Ctx = { page, args, shots, wallet }
    for (const step of STEPS) {
      const started = Date.now()
      log(`step ${step.id}`)
      try {
        await step.run(c)
        results.push({ id: step.id, ok: true, note: `${Math.round((Date.now() - started) / 1_000)} s` })
      } catch (error) {
        const message = redact(error instanceof Error ? error.message.split("\n")[0] : String(error))
        results.push({ id: step.id, ok: false, note: message })
        log(`step ${step.id} failed: ${message}`)
        await page.screenshot({ path: join(debugDir, `${step.id.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => undefined)
        await page.keyboard.press("Escape").catch(() => undefined)
        if (step.critical) break
      }
    }
  } finally {
    await browser.close()
  }
  log(`signed ${wallet.signed()} transactions; debug shots of failed steps in ${debugDir}`)
  for (const r of results) log(`${r.ok ? "ok  " : "FAIL"} ${r.id}: ${r.note}`)
  for (const s of shots.taken) log(`${s.name}: ${Math.round(s.bytes / 1024)} KB, ${s.source}`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

await main()
