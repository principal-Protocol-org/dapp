/**
 * The dashboard's 375 px layout check (plan 0008, Task 5 fix round; reused by Tasks 7 and 8). Run by
 * hand against a running app, never in CI (it is not a `*.test.ts`, so no Vitest config picks it up).
 * It only reads: no wallet, nothing signed.
 *
 *   pnpm dashboard:layout [--base <url>] [--paths /dashboard,/dashboard/risk] [--shots <dir>] [--headed]
 *
 * - `--base`: the app. Default http://localhost:3000. For Testnet data, build and start it with
 *   `NEXT_PUBLIC_PRINCIPAL_NETWORK=testnet` in front of both `pnpm build` and `pnpm start`.
 * - `--paths`: the pages to check. Default: every `/dashboard` view.
 * - `--shots`: also write, per page, a desktop and a 375 px screenshot (light), and one at 375 px
 *   with the first How-to-verify drawer open. Use a gitignored folder, e.g. `e2e-artifacts/dashboard`.
 *
 * At 375 px, for each page, once its skeletons are gone:
 * - the page does not scroll sideways (`documentElement.scrollWidth <= innerWidth`);
 * - every table container (`[data-slot=table-container]`) shows its whole table
 *   (`scrollWidth === clientWidth`): a table that scrolls inside its card hides columns;
 * - the first How-to-verify drawer, opened, does not scroll sideways either.
 *
 * It prints one line per check and exits 1 when any fails.
 */
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, type Browser, type Page } from "playwright"

const VIEWS = ["/dashboard", "/dashboard/markets", "/dashboard/oracle", "/dashboard/risk", "/dashboard/compliance", "/dashboard/activity"]

type Args = { base: string; paths: string[]; shots: string | null; headed: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { base: "http://localhost:3000", paths: VIEWS, shots: null, headed: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    if (flag === "--base") args.base = value().replace(/\/+$/, "")
    else if (flag === "--paths") args.paths = value().split(",").map((p) => p.trim()).filter(Boolean)
    else if (flag === "--shots") args.shots = resolve(value())
    else if (flag === "--headed") args.headed = true
    else throw new Error(`Unknown flag ${flag}`)
  }
  return args
}

type Check = { page: string; check: string; ok: boolean; detail: string }

const slug = (path: string) => path.replace(/^\/+/, "").replace(/\//g, "-") || "root"

/** The page, loaded, with its first reads in: no skeleton left in `<main>` (a minute at most). */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" })
  await page.locator("main").waitFor()
  await page.waitForFunction(() => document.querySelectorAll("main [data-slot=skeleton]").length === 0, undefined, { timeout: 60_000 })
  // Let the last rows render and the fade-ins finish.
  await page.waitForTimeout(1000)
}

async function checkPage(browser: Browser, args: Args, path: string, checks: Check[]): Promise<void> {
  const url = `${args.base}${path}`
  const add = (check: string, ok: boolean, detail: string) => checks.push({ page: path, check, ok, detail })

  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: "light", deviceScaleFactor: 2 })
  const page = await phone.newPage()
  try {
    await open(page, url)
    const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
    add("page fits 375 px", doc.scroll <= doc.inner, `scrollWidth ${doc.scroll}, innerWidth ${doc.inner}`)

    const tables = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-slot=table-container]")].map((el) => ({
        region: el.closest("section")?.querySelector("h2")?.textContent ?? "(no panel)",
        scroll: el.scrollWidth,
        client: el.clientWidth,
      })),
    )
    if (tables.length === 0) add("tables show every column", true, "no table on this page")
    for (const t of tables) add(`table "${t.region}" shows every column`, t.scroll === t.client, `scrollWidth ${t.scroll}, clientWidth ${t.client}`)

    if (args.shots) await page.screenshot({ path: join(args.shots, `${slug(path)}-375-light.png`), fullPage: true })

    const verify = page.getByRole("button", { name: /^(How to verify |Why .* is unavailable, and how to verify it$)/ }).first()
    if ((await verify.count()) === 0) add("drawer fits 375 px", true, "no figure on this page")
    else {
      await verify.click()
      const dialog = page.getByRole("dialog")
      await dialog.waitFor()
      await page.waitForTimeout(600)
      const d = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("[role=dialog]")
        return { scroll: el?.scrollWidth ?? 0, client: el?.clientWidth ?? 0, doc: document.documentElement.scrollWidth, inner: window.innerWidth }
      })
      add("drawer fits 375 px", d.scroll <= d.client && d.doc <= d.inner, `drawer ${d.scroll}/${d.client}, page ${d.doc}/${d.inner}`)
      if (args.shots) await page.screenshot({ path: join(args.shots, `${slug(path)}-375-drawer-light.png`) })
      await page.keyboard.press("Escape")
    }
  } catch (error) {
    add("page loads", false, error instanceof Error ? error.message.split("\n")[0] : String(error))
  } finally {
    await phone.close()
  }

  if (args.shots) {
    const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" })
    const p = await desk.newPage()
    try {
      await open(p, url)
      await p.screenshot({ path: join(args.shots, `${slug(path)}-desktop-light.png`), fullPage: true })
    } finally {
      await desk.close()
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.shots) mkdirSync(args.shots, { recursive: true })
  const browser = await chromium.launch({ headless: !args.headed })
  const checks: Check[] = []
  try {
    for (const path of args.paths) await checkPage(browser, args, path, checks)
  } finally {
    await browser.close()
  }
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.page}  ${c.check}  (${c.detail})`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? `\nAll ${checks.length} checks passed.` : `\n${failed} of ${checks.length} checks failed.`)
  if (args.shots) console.log(`Screenshots: ${args.shots}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error("dashboard layout check failed:", error)
  process.exit(1)
})
