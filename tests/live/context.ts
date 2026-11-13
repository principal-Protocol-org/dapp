/**
 * The live harness, selectable by network (plan 0007, Task 1). `liveContext` resolves a manifest and
 * one of two ways to onboard a fresh keypair:
 *
 * - `keys`: the server faucet run in-process (`runFaucet`) with keys the caller supplies. For the
 *   local stack (the dev stack's key, read when onboarding) and for a run that deployed its own market.
 * - `endpoint`: a POST to `<origin>/api/faucet` of a deployed app, with a bounded wait on `busy` and
 *   `rate_limited`, one retry of a transient failure, a timeout per request, and the requests of one
 *   context paced a faucet minute apart. Needs no secret; it tests the deployed faucet itself.
 *
 * It never reads a keystore: a secret comes from the caller or, on local only, from `.env.local`.
 * Nothing here deploys anything or writes a manifest.
 */
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { parseManifest } from "@/lib/protocol/manifest"
import { addTrustline, fundWithFriendbot, requestTestTokens, type FaucetResponse, type FaucetStep } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { keypairSigner, type KeypairSigner } from "../integration/keypair-signer"
import { isExternalFailure, retryOnce } from "./retry"
import { eventually, json, redact, sleep } from "./util"

export type LiveNetwork = "local" | "testnet"

/** The public origin of the official Testnet deployment. */
export const TESTNET_ORIGIN = "https://testnet.principalmarket.fi"

/** The faucet takes one request per address and per IP a minute (`FAUCET_RATE_LIMIT_MS`): a second more. */
export const FAUCET_PACE_MS = 61_000
/** Per request: just past the faucet route's `maxDuration` (120 s), so the platform's own timeout answers first. */
export const FAUCET_TIMEOUT_MS = 130_000
/** A server's `retryAfterSeconds` is waited at most this long. */
export const MAX_RETRY_AFTER_SECONDS = 120
/** The faucet route's `failed` (502) and a platform gateway timeout (504): worth one more request. */
const TRANSIENT_STATUSES = new Set([502, 504])

/** When the last faucet request of a context was sent; shared by its onboardings (`requestFaucetWithRetry`). */
export type FaucetPacer = { lastAt?: number }

/** What onboarding through the faucet endpoint did, for the run's record (public data only). */
export type Onboarding = { trustlineHash: string; faucet: FaucetStep[] }

/** An onboarded keypair; `onboarding` is set in `endpoint` mode. */
export type OnboardedSigner = KeypairSigner & { onboarding?: Onboarding }

export type FaucetMode =
  | { mode: "keys"; issuerSecret?: string; permissioningAdminSecret?: string }
  | {
      mode: "endpoint"
      origin?: string
      fetchImpl?: typeof fetch
      attempts?: number
      /** Per faucet request; `FAUCET_TIMEOUT_MS` by default. */
      timeoutMs?: number
    }

/** What a resolved context records about its faucet; secrets are never kept here. */
export type ResolvedFaucet = { mode: "keys" } | { mode: "endpoint"; origin: string }

export type LiveContextOptions = {
  network: LiveNetwork
  /** Relative to the dApp root, or absolute. Defaults to `config/manifests/<network>.json`. */
  manifestPath?: string
  /** Defaults: `keys` on local (the dev stack's key), `endpoint` on testnet. */
  faucet?: FaucetMode
}

export type LiveContext = {
  network: LiveNetwork
  manifest: Manifest
  rpcUrl: string
  horizonUrl: string
  friendbotUrl: string | undefined
  faucet: ResolvedFaucet
  /**
   * A fresh keypair onboarded as a user would be: Friendbot, the trustline to the test asset, then
   * the faucet (authorize, grant account, PT, YT, pay). Resolves with a signer once the trustline
   * reads as authorized. `markets` is the registry's list (`keys` mode only).
   */
  onboard(market: Market, kind: ComplianceKind, markets?: () => Promise<Market[]>): Promise<OnboardedSigner>
  /** Why this network cannot be reached now, or null. A caller on testnet fails with it; it never skips. */
  unreachableReason(): Promise<string | null>
  redact: (text: unknown) => string
  eventually: typeof eventually
  sleep: typeof sleep
}

const DAPP = join(__dirname, "..", "..")
const isSecret = (value: string | undefined): value is string => !!value && StrKey.isValidEd25519SecretSeed(value.trim())

export function liveContext(options: LiveContextOptions): LiveContext {
  const { network } = options
  const path = options.manifestPath
    ? isAbsolute(options.manifestPath)
      ? options.manifestPath
      : join(DAPP, options.manifestPath)
    : join(DAPP, "config", "manifests", `${network}.json`)
  const manifest = parseManifest(JSON.parse(readFileSync(path, "utf8")))
  if (manifest.network !== network) throw new Error(`${path} is for "${manifest.network}", not "${network}"`)

  const faucet: FaucetMode = options.faucet ?? (network === "local" ? { mode: "keys" } : { mode: "endpoint" })
  let resolved: ResolvedFaucet
  let onboardImpl: LiveContext["onboard"]

  if (faucet.mode === "endpoint") {
    if (network === "local") throw new Error("faucet mode endpoint is for a deployed app; the local stack onboards with keys")
    const origin = (faucet.origin ?? TESTNET_ORIGIN).replace(/\/+$/, "")
    resolved = { mode: "endpoint", origin }
    // One pacer per context: its onboardings ask the faucet a minute apart (Review Focus 4).
    const pacer: FaucetPacer = {}
    onboardImpl = (market, kind) =>
      onboardViaEndpoint({
        manifest,
        market,
        kind,
        origin,
        pacer,
        ...(faucet.fetchImpl ? { fetchImpl: faucet.fetchImpl } : {}),
        ...(faucet.attempts ? { attempts: faucet.attempts } : {}),
        ...(faucet.timeoutMs ? { timeoutMs: faucet.timeoutMs } : {}),
      })
  } else {
    // On local the dev stack's key is read when onboarding; anywhere else the caller must hand one over.
    if (network !== "local" && !faucet.issuerSecret)
      throw new Error(`faucet mode keys on ${network} needs the issuer secret from the caller`)
    if (faucet.issuerSecret !== undefined && !isSecret(faucet.issuerSecret))
      throw new Error("the issuer secret is not a Stellar secret key")
    if (faucet.permissioningAdminSecret !== undefined && !isSecret(faucet.permissioningAdminSecret)) {
      throw new Error("the Permissioning admin secret is not a Stellar secret key")
    }
    resolved = { mode: "keys" }
    onboardImpl = async (market, kind, markets) => {
      // Loaded here: the in-process faucet is server code, which unit tests and endpoint runs never need.
      const { onboardFreshAccount } = await import("../integration/local-stack")
      return onboardFreshAccount(manifest, market, kind, markets, faucet.issuerSecret?.trim(), faucet.permissioningAdminSecret?.trim())
    }
  }

  return {
    network,
    manifest,
    rpcUrl: manifest.rpcUrl,
    horizonUrl: manifest.horizonUrl,
    friendbotUrl: manifest.friendbotUrl,
    faucet: resolved,
    onboard: onboardImpl,
    async unreachableReason() {
      try {
        const health = await createRpcServer(manifest.rpcUrl).getHealth()
        return health.status === "healthy" ? null : `the ${network} RPC reports "${health.status}"`
      } catch (error) {
        return `the ${network} RPC does not answer (${redact(error instanceof Error ? error.message : String(error))})`
      }
    },
    redact,
    eventually,
    sleep,
  }
}

/** `busy` and `rate_limited` mean "later", not "no": everything else is final, but for one transient `failed`. */
const WAIT_ERRORS = new Set(["busy", "rate_limited"])

/** The server's `retryAfterSeconds`, 60 s when absent or not a number, within [0, `MAX_RETRY_AFTER_SECONDS`]. */
const retryAfter = (seconds: number | undefined) =>
  Math.min(Math.max(typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 60, 0), MAX_RETRY_AFTER_SECONDS)

/**
 * `POST <origin>/api/faucet` for `account`, each request cut after `timeoutMs`. On `busy` or
 * `rate_limited` (503 / 429) it waits the answer's `retryAfterSeconds` (60 s when absent, at most
 * 120 s, plus a second) and asks again. A transient `failed` (HTTP 502 or 504, or no answer at all:
 * a network error or the timeout) is asked again once, a faucet minute later: a run that failed
 * after a transaction keeps its address slot that long, and the steps it did are kept. At most
 * `attempts` requests, then the last answer. With a `pacer` shared across calls, every request
 * waits until a faucet minute after the one before it. Never throws on a refusal; the answer is typed.
 */
export async function requestFaucetWithRetry(p: {
  origin: string
  account: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
  attempts?: number
  timeoutMs?: number
  pacer?: FaucetPacer
  now?: () => number
}): Promise<FaucetResponse> {
  const fetchImpl = p.fetchImpl ?? fetch
  const wait = p.sleep ?? sleep
  const now = p.now ?? Date.now
  const attempts = p.attempts ?? 4
  const timeoutMs = p.timeoutMs ?? FAUCET_TIMEOUT_MS
  const base = p.origin.replace(/\/+$/, "")
  // How the last request ended at the transport: its HTTP status, or "none" when no answer came.
  let transport: number | "none" = "none"
  // `requestTestTokens` posts the same JSON the app's button does and parses success and refusals.
  const viaOrigin = (async (input: string, init?: RequestInit) => {
    transport = "none"
    const response = await fetchImpl(`${base}${input}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    transport = response.status
    return response
  }) as typeof fetch
  let answer: FaucetResponse = {
    error: "failed",
    message: "no attempt was made",
  }
  let retriedFailure = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (p.pacer?.lastAt !== undefined) {
      const due = p.pacer.lastAt + FAUCET_PACE_MS - now()
      if (due > 0) await wait(due)
    }
    if (p.pacer) p.pacer.lastAt = now()
    answer = await requestTestTokens({
      account: p.account,
      fetchImpl: viaOrigin,
    })
    if (!("error" in answer) || attempt === attempts) return answer
    if (WAIT_ERRORS.has(answer.error)) {
      await wait(retryAfter(answer.retryAfterSeconds) * 1_000 + 1_000)
      continue
    }
    const transient = answer.error === "failed" && (transport === "none" || TRANSIENT_STATUSES.has(transport))
    if (!transient || retriedFailure) return answer
    retriedFailure = true
    await wait(FAUCET_PACE_MS)
  }
  return answer
}

/**
 * Friendbot for `account` (external, at times slow or failing). After an external failure the
 * account is read: if Friendbot funded it anyway, that is done; otherwise Friendbot is asked once
 * more. `exists` reads the account.
 */
export async function fundOnce(p: {
  manifest: Pick<Manifest, "friendbotUrl">
  account: string
  exists: () => Promise<boolean>
  fetchImpl?: typeof fetch
  wait?: (ms: number) => Promise<unknown>
}): Promise<void> {
  const fund = () => fundWithFriendbot({ manifest: p.manifest, account: p.account, ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}) })
  try {
    await fund()
  } catch (error) {
    if (!isExternalFailure(error)) throw error
    await (p.wait ?? sleep)(10_000)
    const what = `Friendbot for ${p.account}: ${redact(error instanceof Error ? error.message : String(error))}`
    if (await p.exists().catch(() => false)) {
      console.info(`[live] ${what}; the account exists, so it was funded anyway`)
      return
    }
    console.info(`[live] ${what}; asking once more`)
    await fund()
  }
}

async function onboardViaEndpoint(p: {
  manifest: Manifest
  market: Market
  kind: ComplianceKind
  origin: string
  pacer: FaucetPacer
  fetchImpl?: typeof fetch
  attempts?: number
  timeoutMs?: number
}): Promise<OnboardedSigner> {
  const { manifest, market, kind } = p
  const keypair = Keypair.random()
  const signer = keypairSigner(keypair, manifest.networkPassphrase)
  const account = signer.publicKey
  const read = () =>
    fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  const exists = async () => {
    const a = await read()
    return a.accountExists.status === "live" && a.accountExists.value
  }
  await fundOnce({ manifest, account, exists })
  await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account on Horizon")
  const { hash: trustlineHash } = await retryOnce({
    what: `the trustline of ${account}`,
    run: () =>
      addTrustline({
        manifest,
        account,
        asset: { code: market.underlying.code, issuer: market.underlying.issuer },
        sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
      }),
    nothingLanded: async () => {
      const a = await read()
      return a.trustline.status === "live" && a.trustline.value === "none"
    },
    log: (line) => console.info(`[live] ${line}`),
  })
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline on Horizon")
  const outcome = await requestFaucetWithRetry({
    origin: p.origin,
    account,
    pacer: p.pacer,
    ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
    ...(p.attempts ? { attempts: p.attempts } : {}),
    ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
  })
  if (!("performed" in outcome)) throw new Error(`faucet refused: ${redact(json(outcome))}`)
  await eventually(
    read,
    (a) => a.trustline.status === "live" && a.trustline.value === "authorized",
    "the authorized trustline on Horizon",
    60_000,
  )
  return { ...signer, onboarding: { trustlineHash, faucet: outcome.performed } }
}
