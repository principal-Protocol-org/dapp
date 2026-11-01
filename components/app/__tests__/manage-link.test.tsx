import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountRoles, MarketRoles } from "@/lib/protocol/roles"
import type { Live } from "@/lib/protocol/types"

const mocks = vi.hoisted(() => ({ roles: { markets: new Map() } as AccountRoles, pending: false }))
vi.mock("@/hooks/use-manage", () => ({ useMyRoles: () => ({ account: "G", roles: mocks.roles, pending: mocks.pending }) }))
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }))
vi.mock("../shell/wallet-button", () => ({ WalletButton: () => null }))
vi.mock("../shell/settings-popover", () => ({ SettingsPopover: () => null }))
vi.mock("@/components/landing/theme-toggle", () => ({ ThemeToggle: () => null }))

import { AppHeader } from "../shell/app-header"

const yes: Live<boolean> = { status: "live", value: true, ledger: 1 }
const no: Live<boolean> = { status: "live", value: false, ledger: 1 }
const down: Live<boolean> = { status: "unavailable", error: "rpc" }
const market = (over: Partial<MarketRoles> = {}): MarketRoles => ({
  sac: "CS",
  contracts: { pool: "CP", sy: "CY", manager: "CM" },
  issuer: no,
  creator: no,
  protocolAdmin: no,
  contractAdmin: { pool: no, sy: no, manager: no },
  ...over,
})
const link = () => screen.queryByRole("link", { name: "Manage" })

beforeEach(() => {
  mocks.roles = { markets: new Map() }
})

describe("Manage link", () => {
  it("is hidden without a role", () => {
    mocks.roles = { markets: new Map([["m", market()]]), testAssetIssuer: no }
    render(<AppHeader />)
    expect(link()).toBeNull()
    expect(screen.getByRole("link", { name: "Portfolio" })).toBeTruthy()
  })

  it("is hidden while roles are unread or unreadable: never shown on a guess", () => {
    mocks.roles = { markets: new Map([["m", market({ issuer: down, contractAdmin: { pool: down, sy: no, manager: no } })]]), testAssetIssuer: down }
    render(<AppHeader />)
    expect(link()).toBeNull()
  })

  it("shows for a role on a listed market", () => {
    mocks.roles = { markets: new Map([["m", market({ contractAdmin: { pool: yes, sy: no, manager: no } })]]) }
    render(<AppHeader />)
    expect(link()?.getAttribute("href")).toBe("/app/manage")
  })

  it("shows for the issuer of the test asset", () => {
    mocks.roles = { markets: new Map(), testAssetIssuer: yes }
    render(<AppHeader />)
    expect(link()).toBeTruthy()
  })
})
