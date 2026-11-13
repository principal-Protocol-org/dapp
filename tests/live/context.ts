/**
 * The live harness, selectable by network (plan 0007, Task 1). `liveContext` resolves a manifest and
 * one of two ways to onboard a fresh keypair:
 *
 * - `keys`: the server faucet run in-process (`runFaucet`) with keys the caller supplies. For the
 *   local stack (the dev stack's key, read when onboarding) and for a run that deployed its own market.
 * - `endpoint`: a POST to `<origin>/api/faucet` of a deployed app, with a bounded wait on `busy` and
 *   `rate_limited`. Needs no secret; it tests the deployed faucet itself.
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
import { addTrustline, fundWithFriendbot, requestTestTokens, type FaucetResponse } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { keypairSigner, type KeypairSigner } from "../integration/keypair-signer"
import { eventually, json, redact, sleep } from "./util"

export type LiveNetwork = "local" | "testnet"

/** The public origin of the official Testnet deployment. */
export const TESTNET_ORIGIN = "https://testnet.principalmarket.fi"

export type FaucetMode =
  | { mode: "keys"; issuerSecret?: string; permissioningAdminSecret?: string }
  | {
      mode: "endpoint"
      origin?: string
      fetchImpl?: typeof fetch
      attempts?: number
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
  onboard(market: Market, kind: ComplianceKind, markets?: () => Promise<Market[]>): Promise<KeypairSigner>
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
    onboardImpl = (market, kind) =>
      onboardViaEndpoint({
        manifest,
        market,
        kind,
        origin,
        ...(faucet.fetchImpl ? { fetchImpl: faucet.fetchImpl } : {}),
        ...(faucet.attempts ? { attempts: faucet.attempts } : {}),
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

/** `busy` and `rate_limited` mean "later", not "no": everything else is final. */
const WAIT_ERRORS = new Set(["busy", "rate_limited"])

/**
 * `POST <origin>/api/faucet` for `account`. On `busy` or `rate_limited` (503 / 429) it waits the
 * answer's `retryAfterSeconds` (60 s when absent, plus a second) and asks again, up to `attempts`
 * times, then returns the last refusal. Never throws on a refusal; the answer is typed.
 */
export async function requestFaucetWithRetry(p: {
  origin: string
  account: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
  attempts?: number
}): Promise<FaucetResponse> {
  const fetchImpl = p.fetchImpl ?? fetch
  const wait = p.sleep ?? sleep
  const attempts = p.attempts ?? 4
  const base = p.origin.replace(/\/+$/, "")
  // `requestTestTokens` posts the same JSON the app's button does and parses success and refusals.
  const viaOrigin = ((input: string, init?: RequestInit) => fetchImpl(`${base}${input}`, init)) as typeof fetch
  let answer: FaucetResponse = {
    error: "failed",
    message: "no attempt was made",
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    answer = await requestTestTokens({
      account: p.account,
      fetchImpl: viaOrigin,
    })
    if (!("error" in answer) || !WAIT_ERRORS.has(answer.error) || attempt === attempts) return answer
    await wait((answer.retryAfterSeconds ?? 60) * 1_000 + 1_000)
  }
  return answer
}

async function onboardViaEndpoint(p: {
  manifest: Manifest
  market: Market
  kind: ComplianceKind
  origin: string
  fetchImpl?: typeof fetch
  attempts?: number
}): Promise<KeypairSigner> {
  const { manifest, market, kind } = p
  const keypair = Keypair.random()
  const signer = keypairSigner(keypair, manifest.networkPassphrase)
  const account = signer.publicKey
  await fundWithFriendbot({ manifest, account })
  const read = () =>
    fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account on Horizon")
  await addTrustline({
    manifest,
    account,
    asset: { code: market.underlying.code, issuer: market.underlying.issuer },
    sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
  })
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline on Horizon")
  const outcome = await requestFaucetWithRetry({
    origin: p.origin,
    account,
    ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
    ...(p.attempts ? { attempts: p.attempts } : {}),
  })
  if (!("performed" in outcome)) throw new Error(`faucet refused: ${redact(json(outcome))}`)
  await eventually(
    read,
    (a) => a.trustline.status === "live" && a.trustline.value === "authorized",
    "the authorized trustline on Horizon",
    60_000,
  )
  return signer
}
