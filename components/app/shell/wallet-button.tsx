"use client"

import { ChevronDown, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWallet } from "@/hooks/use-wallet"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { networkLabel } from "./network"

const FREIGHTER_URL = "https://www.freighter.app"

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address
}

function AccountMenu({
  address,
  onDisconnect,
  children,
  triggerClassName,
}: {
  address: string
  onDisconnect: () => void
  children: React.ReactNode
  triggerClassName?: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="toggle" className={triggerClassName}>
          {children}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="break-all font-mono text-[11px]/4">{address}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard?.writeText(address).then(
              () => toast.success("Address copied"),
              () => toast.error("Could not copy the address"),
            )
          }}
        >
          Copy address
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDisconnect}>Disconnect</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WalletButton() {
  const { state, connect, disconnect } = useWallet()
  const { network } = activeManifest()
  const label = networkLabel(network)

  async function onConnect() {
    const next = await connect()
    if (next.status === "rejected") toast.error(`Wallet not connected: ${next.reason}`)
    else if (next.status === "locked") toast.error("Freighter is locked. Unlock it, then connect again.")
    else if (next.status === "not_installed") toast.error("Freighter is not installed.")
  }

  switch (state.status) {
    case "not_installed":
      return (
        <Button asChild variant="secondary" size="toggle">
          <a href={FREIGHTER_URL} target="_blank" rel="noopener noreferrer">
            Install Freighter
          </a>
        </Button>
      )
    case "connecting":
      return (
        <Button type="button" size="toggle" disabled aria-busy="true">
          Connecting…
        </Button>
      )
    case "connected":
      return (
        <AccountMenu address={state.publicKey} onDisconnect={disconnect}>
          <span aria-hidden="true" className="size-1.5 rounded-full bg-positive" />
          <span className="font-mono">{shortAddress(state.publicKey)}</span>
        </AccountMenu>
      )
    case "wrong_network":
    case "unverified_network":
      return (
        <AccountMenu
          address={state.publicKey}
          onDisconnect={disconnect}
          triggerClassName="border-negative text-negative hover:border-negative hover:text-negative"
        >
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          <span>
            {state.status === "wrong_network" ? "Wrong network" : "Network unverified"}
            <span className="max-[520px]:hidden"> · switch Freighter to {label.replace("Stellar ", "")}</span>
          </span>
        </AccountMenu>
      )
    default:
      return (
        <Button type="button" size="toggle" onClick={onConnect}>
          Connect wallet
        </Button>
      )
  }
}
