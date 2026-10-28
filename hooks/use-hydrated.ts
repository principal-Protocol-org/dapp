"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

/**
 * False on the server and during hydration, true from the first client render after it. A view
 * whose content depends on client-only data renders what the server rendered until this is true,
 * so hydration never sees a mismatch, however early the data arrived.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
