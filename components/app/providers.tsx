"use client"

import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WalletContext, useWalletController } from "@/hooks/use-wallet"

function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletController()
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

/**
 * Client providers for `/app/**`: React Query, the wallet, tooltips and toasts. Settings need no
 * provider: `useSettings` reads one shared `localStorage` store.
 */
export function Providers({ children }: { children?: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }))
  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </WalletProvider>
    </QueryClientProvider>
  )
}
