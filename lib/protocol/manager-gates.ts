/**
 * The gates of a manager call (spec 0002 §5): whether the connected wallet may sign it, decided
 * from already-fetched state. Pure, like `evaluateGates`: the wallet and network refusals of an
 * action (`walletGate`), then the role the call needs, from `ctx.roles` (Task 21 reads the roles on
 * chain). An unavailable roles read blocks a call that needs a role (R23); a permissionless call
 * never looks at it. Every refusal is a plain-words `Blocker`; an empty list is the only "yes".
 *
 * The contract checks the role again, in the simulation `prepareManagerReview` runs, which must
 * succeed before anything is signed: these gates say early, and in plain words, who must sign.
 */
import { shorten } from "./format"
import { Gates, walletGate, type Blocker } from "./gates"
import type { ManagerCall, ManagerCallKind } from "./manager-calls"
import type { Live, WalletState } from "./types"

/**
 * The roles an account can hold (spec 0002 §5, "My markets"): `issuer` is the underlying SAC's
 * `admin()`, `creator` `MarketConfig.creator()`, `protocolAdmin` `MarketConfig.protocol_admin()`
 * (and the admin of the Router and RiskControl it wires markets on), `contractAdmin` `get_admin()`
 * on the pool, SY wrapper or manager, `permissioningAdmin` `Permissioning.get_admin()`.
 */
export type Role = "issuer" | "creator" | "protocolAdmin" | "contractAdmin" | "permissioningAdmin"

export type ManagerGateContext = {
  wallet: WalletState
  /** The connected account's roles where the call acts; `unavailable` blocks a call that needs one. */
  roles: Live<Role[]>
}

/** The role a call needs, who holds it, and what it lets them do, in plain words. */
export type RoleRequirement = { role: Role; who: string; can: string }

/**
 * The role each call needs, as the contract enforces it: the SAC's admin for `set_authorized`;
 * Permissioning's `assert_admin` for the grants (permissioning:50,96); the contract's own
 * `assert_admin` for `set_paused` (market_pool:734, sy_wrapper:421, principal_manager:662); the
 * Router's and RiskControl's for wiring a market (router:187, risk_control:190), the protocol
 * admin's (spec §5 step 4). The fee claims are permissionless (market_pool:606-613,
 * principal_manager:557-565): anyone may trigger them, the fees go to the payee the config fixes.
 */
export const REQUIRED_ROLE: Record<ManagerCallKind, RoleRequirement | null> = {
  set_authorized: { role: "issuer", who: "the asset's issuer", can: "change who is authorized to hold it" },
  grant_account: { role: "permissioningAdmin", who: "the Permissioning admin", can: "grant this" },
  grant_asset: { role: "permissioningAdmin", who: "the Permissioning admin", can: "grant this" },
  set_paused: { role: "contractAdmin", who: "this contract's admin", can: "pause or unpause it" },
  register_market: { role: "protocolAdmin", who: "the protocol admin", can: "register a market on the Router" },
  add_consumer: { role: "protocolAdmin", who: "the protocol admin", can: "add a risk control consumer" },
  claim_protocol_fees: null,
  claim_creator_fees: null,
}

/**
 * Every reason the connected wallet may not sign `call` now: wallet and network first, as for an
 * action, then the role. The role is checked only for the account the call was prepared for, once
 * it is the connected one; a missing role is a `wallet` refusal (connect another wallet) naming the
 * role and the connected account.
 */
export function evaluateManagerGates(call: ManagerCall, ctx: ManagerGateContext): Blocker[] {
  const g = new Gates()
  walletGate(call.source, ctx.wallet, g)
  const need = REQUIRED_ROLE[call.kind]
  const signer = ctx.wallet.status === "connected" && ctx.wallet.publicKey === call.source
  if (need && signer) {
    const roles = g.need(ctx.roles, "your roles")
    if (roles !== undefined && !roles.includes(need.role)) {
      g.block(
        "wallet",
        `Only ${need.who} can ${need.can}. You are connected as ${shorten(call.source)}, which is not ${need.who}. Connect ${need.who}'s wallet to sign this.`,
      )
    }
  }
  return g.result()
}
