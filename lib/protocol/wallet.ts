import {
  WatchWalletChanges,
  getAddress,
  getNetwork,
  isAllowed,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api"
import { readSession, writeSession } from "@/lib/app/session"
import { assertSignedTransactionMatchesReview } from "./stellar"
import type { Manifest, WalletState } from "./types"

type WalletManifest = Pick<Manifest, "networkPassphrase">

export interface WalletAdapter {
  /** Silent: never opens a Freighter pop-up. */
  restore(m: WalletManifest): Promise<WalletState>
  /** Prompts the user for access. */
  connect(m: WalletManifest): Promise<WalletState>
  disconnect(): void
  sign(xdr: string, passphrase: string, expectedSigner: string): Promise<string>
  watch(onChange: (s: { address: string; networkPassphrase: string }) => void): () => void
}

type FreighterLike = {
  isConnected?: () => Promise<boolean>
  getPublicKey?: () => Promise<string>
  getNetwork?: () => Promise<string>
  signTransaction?: (xdr: string, options: { networkPassphrase: string }) => Promise<string>
}

declare global {
  interface Window {
    freighterApi?: FreighterLike
  }
}

const WATCH_INTERVAL_MS = 3000

function legacy(): FreighterLike | undefined {
  return typeof window === "undefined" ? undefined : window.freighterApi
}

/** Shared tail of restore/connect: resolve the network and compare to the manifest. */
async function resolveState(
  m: WalletManifest,
  api: FreighterLike | undefined,
  address: () => Promise<string>,
): Promise<WalletState> {
  const publicKey = await address()
  if (!publicKey) return { status: "locked" }
  const network = await getNetwork()
  if (network.error && !api?.getNetwork) {
    return {
      status: "unverified_network",
      publicKey,
      expectedPassphrase: m.networkPassphrase,
      reason: network.error.message,
    }
  }
  const networkPassphrase = network.error && api?.getNetwork ? await api.getNetwork() : network.networkPassphrase
  if (networkPassphrase !== m.networkPassphrase) {
    return {
      status: "wrong_network",
      publicKey,
      actualPassphrase: networkPassphrase,
      expectedPassphrase: m.networkPassphrase,
    }
  }
  return { status: "connected", publicKey, networkPassphrase }
}

/** Returns "ok", or the terminal state to report when the wallet is absent or locked. */
async function probe(api: FreighterLike | undefined): Promise<WalletState | "ok"> {
  const pkg = await isConnected()
  if (pkg.error && !api) return { status: "not_installed" }
  // Fail closed: if the package errored and the legacy API cannot confirm, treat as locked.
  const connected = pkg.error ? (api?.isConnected ? await api.isConnected() : false) : pkg.isConnected
  return connected ? "ok" : { status: "locked" }
}

const failure = (error: unknown): WalletState => ({
  status: "rejected",
  reason: error instanceof Error ? error.message : "Wallet request failed",
})

export const freighterAdapter: WalletAdapter = {
  async restore(m) {
    if (!readSession().connected) return { status: "disconnected" }
    try {
      const api = legacy()
      const p = await probe(api)
      if (p !== "ok") return p
      const allowed = await isAllowed()
      if (allowed.error || !allowed.isAllowed) return { status: "disconnected" }
      return await resolveState(m, api, async () => {
        const a = await getAddress()
        return a.error ? (api?.getPublicKey ? await api.getPublicKey() : "") : a.address
      })
    } catch (error) {
      return failure(error)
    }
  },

  async connect(m) {
    try {
      const api = legacy()
      const p = await probe(api)
      if (p !== "ok") return p
      const state = await resolveState(m, api, async () => {
        const access = await requestAccess()
        const a = access.error ? await getAddress() : access
        return a.error ? (api?.getPublicKey ? await api.getPublicKey() : "") : a.address
      })
      if (state.status !== "locked") writeSession({ connected: true })
      return state
    } catch (error) {
      return failure(error)
    }
  },

  disconnect() {
    writeSession({ connected: false })
  },

  async sign(unsignedXdr, passphrase, expectedSigner) {
    const signed = await signTransaction(unsignedXdr, { networkPassphrase: passphrase })
    let signedXdr: string
    if (!signed.error) {
      // Report a wrong-account signature clearly, before the hash/signature-hint checks.
      if (signed.signerAddress !== expectedSigner) {
        throw new Error(
          `Freighter signed with ${signed.signerAddress || "a different account"} instead of the connected wallet (${expectedSigner}). Refusing to submit.`,
        )
      }
      signedXdr = signed.signedTxXdr
    } else {
      const api = legacy()
      if (!api?.signTransaction) throw new Error(signed.error.message)
      signedXdr = await api.signTransaction(unsignedXdr, { networkPassphrase: passphrase })
    }
    // Never trust the wallet's output: the body must be byte-identical to what was reviewed and
    // signed by the account the review was shown for.
    assertSignedTransactionMatchesReview({
      unsignedXdr,
      signedXdr,
      networkPassphrase: passphrase,
      expectedSigner,
    })
    return signedXdr
  },

  watch(onChange) {
    const watcher = new WatchWalletChanges(WATCH_INTERVAL_MS)
    watcher.watch((p) => {
      if (p.error) return
      onChange({ address: p.address, networkPassphrase: p.networkPassphrase })
    })
    return () => watcher.stop()
  },
}
