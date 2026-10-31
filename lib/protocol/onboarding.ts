/**
 * Testnet onboarding ("Get test tokens", spec §9): what a fresh wallet still needs, and the two
 * client-side steps it takes itself — Friendbot, and a `changeTrust` the user signs in Freighter.
 * The third step (authorize the trustline, grant Permissioning, pay test tokens) is the server
 * route `POST /api/faucet` (`lib/server/faucet.ts`), which holds the Testnet keys. Nothing here
 * is secret: this module is shared by the browser and the server.
 */
import { Account, Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk"
import type { AccountState } from "./account-state"
import { readLive, toBool, type ContractReader } from "./reader"
import {
  assertSignedTransactionMatchesReview,
  createRpcServer,
  pollTransactionStatus,
  submitSignedTransaction,
  transactionEnvelopeHash,
} from "./stellar"
import type { Live, Manifest, Market, Network } from "./types"

/** Whole tokens of the test asset the faucet pays (spec 0002: 100 000 units). */
export const TEST_TOKEN_AMOUNT = 100_000n
/** The faucet pays only while the balance is below this many whole tokens (spec 0002: 10 000). */
export const TEST_TOKEN_TOP_UP_BELOW = 10_000n

/** Every token this app knows has 7 decimals (shared context). */
const DEFAULT_DECIMALS = 7

/** Whole tokens to raw base units at `decimals`. */
export function wholeTokens(amount: bigint, decimals: number): bigint {
  return amount * 10n ** BigInt(decimals)
}

/** Onboarding exists only where the test asset and the faucet keys do: Testnet and a local network. */
export function onboardingAvailable(m: { network: Network }): boolean {
  return m.network === "testnet" || m.network === "local"
}

/** The test asset: the first market's underlying (a classic asset behind its SAC). */
export function testAsset(m: Pick<Manifest, "markets">): Market["underlying"] {
  return m.markets[0].underlying
}

/**
 * The one test asset every market shares (same code, issuer and SAC), or null when the markets use
 * different underlyings (R44). Onboarding authorizes, trusts and pays a single asset, so it is only
 * offered when there is one; the manifest schema itself is left open.
 */
export function sharedTestAsset(m: Pick<Manifest, "markets">): Market["underlying"] | null {
  const [first, ...rest] = m.markets
  if (!first) return null
  const same = rest.every(
    (x) => x.underlying.code === first.underlying.code && x.underlying.issuer === first.underlying.issuer && x.underlying.sac === first.underlying.sac,
  )
  return same ? first.underlying : null
}

/** Whether the account may hold one market's PT and YT (`Permissioning.is_allowed_for_asset`). */
export type MarketPermission = { marketId: string; permPt: Live<boolean>; permYt: Live<boolean> }

/** PT and YT permissions for every market: the faucet grants them all, so onboarding checks them all (R44). */
export async function fetchMarketPermissions(reader: ContractReader, m: Manifest, account: string): Promise<MarketPermission[]> {
  const allowed = (asset: string) =>
    readLive<unknown, boolean>(
      reader,
      {
        contractId: m.shared.permissioning,
        functionName: "is_allowed_for_asset",
        args: [
          { type: "address", value: account },
          { type: "address", value: asset },
        ],
      },
      toBool,
    )
  return Promise.all(
    m.markets.map(async (market) => {
      const [permPt, permYt] = await Promise.all([allowed(market.contracts.pt), allowed(market.contracts.yt)])
      return { marketId: market.marketId, permPt, permYt }
    }),
  )
}

export type OnboardingStepId = "fund" | "trustline" | "grant"

const isTrue = (v: Live<boolean>) => v.status === "live" && v.value

/**
 * The checklist, in order. A step is done only on positive live evidence: an unavailable read is
 * not done (running it again is harmless — Friendbot aside, which the dialog only offers when the
 * account is known to be missing). `grant` covers the whole faucet call, so it stays open while the
 * balance is below the top-up threshold, and while any market's PT or YT is not allowed: pass every
 * market's permissions in `markets` (R44); without it only `acc`'s own market is judged.
 */
export function onboardingSteps(
  acc: AccountState,
  opts: { decimals?: number; markets?: { permPt: Live<boolean>; permYt: Live<boolean> }[] } = {},
): { id: OnboardingStepId; done: boolean }[] {
  const decimals = opts.decimals ?? DEFAULT_DECIMALS
  const markets = opts.markets ?? [{ permPt: acc.permPt, permYt: acc.permYt }]
  const fund = isTrue(acc.accountExists)
  const trustline = acc.trustline.status === "live" && acc.trustline.value !== "none"
  const authorized = (acc.trustline.status === "live" && acc.trustline.value === "authorized") || isTrue(acc.sacAuthorized)
  const funded = acc.underlying.status === "live" && acc.underlying.value >= wholeTokens(TEST_TOKEN_TOP_UP_BELOW, decimals)
  const everyMarket = markets.length > 0 && markets.every((x) => isTrue(x.permPt) && isTrue(x.permYt))
  const grant = authorized && isTrue(acc.permAllowed) && isTrue(acc.permPt) && isTrue(acc.permYt) && everyMarket && funded
  return [
    { id: "fund", done: fund },
    { id: "trustline", done: trustline },
    { id: "grant", done: grant },
  ]
}

/** Validity window of the `changeTrust`, as for every other transaction the user signs. */
const TX_TIMEOUT_SECONDS = 300

/** The unsigned `changeTrust` (default limit: the maximum) the user signs to hold the test asset. */
export function buildChangeTrustXdr(p: {
  account: string
  asset: { code: string; issuer: string }
  manifest: Pick<Manifest, "networkPassphrase">
  /** The account's current sequence number; the transaction uses the next one. */
  sequence: string
}): string {
  return new TransactionBuilder(new Account(p.account, p.sequence), {
    fee: BASE_FEE,
    networkPassphrase: p.manifest.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(p.asset.code, p.asset.issuer) }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()
    .toXDR()
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Step 1: Friendbot funds a new account with Testnet XLM. */
export async function fundWithFriendbot(p: {
  manifest: Pick<Manifest, "friendbotUrl">
  account: string
  fetchImpl?: FetchLike
}): Promise<void> {
  if (!p.manifest.friendbotUrl) {
    throw new Error("This network has no Friendbot. Send XLM to your account from another account first.")
  }
  const url = new URL(p.manifest.friendbotUrl)
  url.searchParams.set("addr", p.account)
  const fetchImpl = p.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url.toString())
  } catch {
    throw new Error("Friendbot could not be reached. Check your connection, then try again.")
  }
  if (!response.ok) {
    throw new Error(`Friendbot could not fund your account (it answered ${response.status}). Try again in a minute.`)
  }
}

type TrustlineServer = NonNullable<Parameters<typeof submitSignedTransaction>[0]["server"]> &
  NonNullable<Parameters<typeof pollTransactionStatus>[0]["server"]> & {
    getAccount(address: string): Promise<{ sequenceNumber(): string }>
  }

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A just-funded account can take a ledger to show on RPC: a few short waits before giving up. */
async function sequenceOf(server: TrustlineServer, account: string, wait: (ms: number) => Promise<unknown>): Promise<string> {
  const attempts = 5
  for (let attempt = 1; ; attempt += 1) {
    try {
      return (await server.getAccount(account)).sequenceNumber()
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(
          `Your account could not be read from the network (${error instanceof Error ? error.message : String(error)}). Fund it first, then try again.`,
        )
      }
      await wait(2_000)
    }
  }
}

/**
 * Step 2: the user adds a trustline to the test asset. The wallet signs the exact `changeTrust`
 * built here; the signed envelope is checked (same body, signed by `account`) before it is
 * submitted, then polled by its locally computed hash until the network confirms it.
 */
export async function addTrustline(p: {
  manifest: Pick<Manifest, "rpcUrl" | "networkPassphrase">
  account: string
  asset: { code: string; issuer: string }
  /** Signs for `account` on the manifest network: `useWallet().sign(xdr, account)`. */
  sign: (unsignedXdr: string) => Promise<string>
  server?: TrustlineServer
  wait?: (ms: number) => Promise<unknown>
}): Promise<{ hash: string }> {
  const { manifest, account } = p
  const server = p.server ?? createRpcServer(manifest.rpcUrl)
  const sequence = await sequenceOf(server, account, p.wait ?? delay)
  const unsignedXdr = buildChangeTrustXdr({ account, asset: p.asset, manifest, sequence })
  const signedXdr = await p.sign(unsignedXdr)
  assertSignedTransactionMatchesReview({
    unsignedXdr,
    signedXdr,
    networkPassphrase: manifest.networkPassphrase,
    expectedSigner: account,
  })
  const hash = transactionEnvelopeHash(signedXdr, manifest.networkPassphrase)
  const submitted = await submitSignedTransaction({
    rpcUrl: manifest.rpcUrl,
    networkPassphrase: manifest.networkPassphrase,
    signedXdr,
    server,
  })
  if (submitted.status === "TRY_AGAIN_LATER") {
    throw new Error("The network is busy and did not accept the trustline transaction. Try again in a moment.")
  }
  const polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash, server, attempts: 15, wait: p.wait })
  if (polled.status === "FAILED") throw new Error("The trustline transaction failed on the network. Nothing changed; try again.")
  if (polled.status !== "SUCCESS") {
    throw new Error(`The trustline transaction was sent but is not confirmed yet (hash ${hash}). Wait a moment, then try again.`)
  }
  return { hash }
}

/** What the faucet does, in order. `grant_pt`/`grant_yt` repeat once per market. */
export type FaucetStep = "authorize" | "grant_account" | "grant_pt" | "grant_yt" | "pay"

export type FaucetErrorCode =
  | "network"
  | "rate_limited"
  | "no_trustline"
  | "invalid_account"
  | "invalid_content_type"
  | "cross_site"
  | "request_too_large"
  | "busy"
  | "not_configured"
  | "failed"

export type FaucetResponse =
  | { performed: FaucetStep[] }
  | { error: FaucetErrorCode; message?: string; step?: FaucetStep; retryAfterSeconds?: number }

const ERROR_CODES: readonly string[] = [
  "network",
  "rate_limited",
  "no_trustline",
  "invalid_account",
  "invalid_content_type",
  "cross_site",
  "request_too_large",
  "busy",
  "not_configured",
  "failed",
]
const STEPS: readonly string[] = ["authorize", "grant_account", "grant_pt", "grant_yt", "pay"]

/** Step 3: asks the server route to authorize, grant and pay. Never throws on a refusal: it is typed. */
export async function requestTestTokens(p: { account: string; fetchImpl?: FetchLike }): Promise<FaucetResponse> {
  const fetchImpl = p.fetchImpl ?? fetch
  let response: Response
  try {
    // A JSON content type: the route refuses anything else, so a cross-site form cannot post (minor 5).
    response = await fetchImpl("/api/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: p.account }),
    })
  } catch {
    return { error: "failed", message: "The faucet could not be reached." }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { error: "failed", message: `The faucet answered ${response.status} without a readable result.` }
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>
    if (response.ok && Array.isArray(record.performed) && record.performed.every((s) => STEPS.includes(String(s)))) {
      return { performed: record.performed as FaucetStep[] }
    }
    if (typeof record.error === "string" && ERROR_CODES.includes(record.error)) {
      return {
        error: record.error as FaucetErrorCode,
        ...(typeof record.message === "string" ? { message: record.message } : {}),
        ...(typeof record.step === "string" && STEPS.includes(record.step) ? { step: record.step as FaucetStep } : {}),
        ...(typeof record.retryAfterSeconds === "number" ? { retryAfterSeconds: record.retryAfterSeconds } : {}),
      }
    }
  }
  return { error: "failed", message: `The faucet answered ${response.status} without a readable result.` }
}
