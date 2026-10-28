"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { WalletState } from "@/lib/protocol/types"
import { freighterAdapter } from "@/lib/protocol/wallet"

export type WalletApi = {
  state: WalletState
  /** Prompts for access; resolves with the resulting state. */
  connect(): Promise<WalletState>
  disconnect(): void
  /** Signs for the connected account on the manifest network; rejects when not connected. */
  sign(xdr: string): Promise<string>
}

export const WalletContext = createContext<WalletApi | null>(null)

export function useWallet(): WalletApi {
  const api = useContext(WalletContext)
  if (!api) throw new Error("useWallet must be used inside <Providers>.")
  return api
}

/** The network the wallet is actually on, when known. */
function observed(state: WalletState): { address: string; passphrase: string } | null {
  if (state.status === "connected") return { address: state.publicKey, passphrase: state.networkPassphrase }
  if (state.status === "wrong_network") return { address: state.publicKey, passphrase: state.actualPassphrase }
  return null
}

/** Owns the wallet state. Mounted once by `<Providers>`. */
export function useWalletController(): WalletApi {
  const [state, setState] = useState<WalletState>({ status: "disconnected" })
  const stateRef = useRef(state)
  // Only the latest request may write: a slow restore must not overwrite a newer connect.
  const requestId = useRef(0)

  const apply = useCallback((next: WalletState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const run = useCallback(
    async (call: () => Promise<WalletState>): Promise<WalletState> => {
      const id = ++requestId.current
      const next = await call()
      if (id === requestId.current) apply(next)
      return next
    },
    [apply],
  )

  const restore = useCallback(() => run(() => freighterAdapter.restore(activeManifest())), [run])

  useEffect(() => {
    void restore()
    const stop = freighterAdapter.watch(({ address, networkPassphrase }) => {
      // connect() owns the state until it settles; a restore now would race the session flag.
      if (stateRef.current.status === "connecting") return
      if (!address) {
        void restore()
        return
      }
      const seen = observed(stateRef.current)
      if (seen && seen.address === address && seen.passphrase === networkPassphrase) return
      void restore()
    })
    return stop
  }, [restore])

  const connect = useCallback(async () => {
    const id = ++requestId.current
    apply({ status: "connecting" })
    let next: WalletState
    try {
      next = await freighterAdapter.connect(activeManifest())
    } catch (error) {
      next = { status: "rejected", reason: error instanceof Error ? error.message : "Wallet request failed" }
    }
    if (id === requestId.current) apply(next)
    return next
  }, [apply])

  const disconnect = useCallback(() => {
    requestId.current++
    freighterAdapter.disconnect()
    apply({ status: "disconnected" })
  }, [apply])

  const sign = useCallback(async (xdr: string) => {
    const current = stateRef.current
    if (current.status !== "connected") throw new Error("Wallet is not connected on the right network.")
    return freighterAdapter.sign(xdr, activeManifest().networkPassphrase, current.publicKey)
  }, [])

  return useMemo(() => ({ state, connect, disconnect, sign }), [state, connect, disconnect, sign])
}
