/**
 * The MarketFactory (spec 0002 §5 steps 1–3, R5-10): the creation wizard's parameters, the seven
 * addresses one salt gives, and the three `create_*` calls, encoded exactly as the contract declares
 * them (`principal` `contracts/market_factory/src/lib.rs` at 665bb67).
 *
 * Trust: nothing that decides where code runs comes from the caller. The factory, the shared
 * contracts (Permissioning, oracle, RiskControl) and the Wasm hash of every market contract come from
 * the manifest, read-only; `tokens` and `engine` are derived from the salt here, as the factory derives
 * them (it checks them again on chain, `TopologyMismatch`). The caller chooses the asset, among those
 * the manifest knows, the maturity, the names, the fees, the treasury, the protocol admin and the time
 * stretch, each checked as the contracts check it.
 *
 * Pure and reader-injected, like the rest of `lib/protocol`.
 */
import { Address, StrKey, xdr } from "@stellar/stellar-sdk"
import { sha256 } from "js-sha256"
import { bytesToHex } from "./bytes"
import { shorten } from "./format"
import { readLive, toAddress, toBigint, type ContractReader } from "./reader"
import type { ContractInvocation, ScArg } from "./stellar"
import type { Live, Manifest, Market, MarketContractName, MarketContracts } from "./types"

// ---------------------------------------------------------------- constants (market_factory, market_config, market_pool)

/** The tag each contract's sub-salt mixes in (`TAG_SY` … `TAG_ESCROW`). */
const TAG: Record<MarketContractName, number> = { sy: 1, pt: 2, yt: 3, config: 4, manager: 5, pool: 6, recoveryEscrow: 7 }

/** The factory's field name for each market contract (`MarketContracts`, `MarketTokens`, ...). */
const FIELD: Record<MarketContractName, string> = {
  sy: "sy_wrapper",
  pt: "pt_token",
  yt: "yt_token",
  config: "market_config",
  manager: "principal_manager",
  pool: "market_pool",
  recoveryEscrow: "recovery_escrow",
}

/** How copy names each market contract. */
const NAME: Record<MarketContractName, string> = {
  sy: "SY wrapper",
  pt: "PT",
  yt: "YT",
  config: "market config",
  manager: "PrincipalManager",
  pool: "pool",
  recoveryEscrow: "recovery escrow",
}

/** MarketConfig's caps (`MAX_TOKENIZATION_FEE_BPS`, `MAX_YT_FEE_BPS`, `MAX_SWAP_FEE_TIER_BPS`, `BPS`). */
export const FEE_CAPS = { tokenizationFeeBps: 100, ytFeeBps: 5_000, swapFeeTierBps: 500, protocolShareBps: 10_000 } as const
/** MarketPool: `time_stretch_years` in 1..=20 (`InvalidStretch`). */
export const STRETCH_YEARS = { min: 1, max: 20 } as const
/** MarketPool's `SECONDS_PER_YEAR`. */
export const SECONDS_PER_YEAR = 31_536_000
const WAD = 10n ** 18n
const U32_MAX = 4_294_967_295
const MAX_NAME = 64
const MAX_SYMBOL = 32

// ---------------------------------------------------------------- types

/** What the wizard's first step chooses (spec 0002 §5 step 1). */
export type MarketParams = {
  /** The underlying's SAC: one the manifest knows. */
  underlying: string
  /** Unix seconds (u64). */
  maturity: bigint
  ptName: string
  ptSymbol: string
  ytName: string
  ytSymbol: string
  protocolAdmin: string
  treasury: string
  tokenizationFeeBps: number
  ytFeeBps: number
  swapFeeTierBps: number
  protocolShareBps: number
  timeStretchYears: number
}

/** What each phase signs: `create_tokens`, `create_engine`, `create_pool_and_escrow`. */
export type TokenParamsInput = Pick<MarketParams, "underlying" | "maturity" | "ptName" | "ptSymbol" | "ytName" | "ytSymbol">
export type EngineParamsInput = Pick<
  MarketParams,
  "underlying" | "maturity" | "protocolAdmin" | "treasury" | "tokenizationFeeBps" | "ytFeeBps" | "swapFeeTierBps" | "protocolShareBps"
>
export type PoolParamsInput = Pick<MarketParams, "underlying" | "timeStretchYears">

/** Which factory phases have run (step 3 resumes at the first that has not). */
export type FactoryPhases = { tokens: boolean; engine: boolean }

const struct = (value: Record<string, ScArg>): ScArg => ({ type: "struct", value })
const address = (value: string): ScArg => ({ type: "address", value })
const bytes = (value: string): ScArg => ({ type: "bytes", value })
const u32 = (value: number): ScArg => ({ type: "u32", value })
const u64 = (value: bigint): ScArg => ({ type: "u64", value })
const text = (value: string): ScArg => ({ type: "string", value })

// ---------------------------------------------------------------- salt and addresses

const SALT_RE = /^[0-9a-f]{64}$/

/** A salt from the URL: exactly 32 bytes of hex, lower-cased; anything else is not a salt. */
export function parseSalt(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const lower = value.toLowerCase()
  return SALT_RE.test(lower) ? lower : undefined
}

/** 32 random bytes, as hex: a fresh market's salt (the factory refuses a salt already used). */
export function randomSalt(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return bytesToHex(random(32)).toLowerCase()
}

// Buffer-free (bytes.ts): browser code never touches the Node Buffer global.
const sha = (data: Uint8Array) => new Uint8Array(sha256.arrayBuffer(data))
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16))

function saltOf(value: string): string {
  const salt = parseSalt(value)
  if (!salt) throw new Error(`"${value}" is not a salt of 32 bytes (64 hex digits).`)
  return salt
}

/** The manifest's MarketFactory; refuses a manifest that names none. */
export function factoryOf(manifest: Manifest): string {
  const factory = manifest.shared.factory
  if (!factory || !StrKey.isValidContract(factory)) {
    throw new Error("This network's manifest names no MarketFactory, so markets cannot be created from the app.")
  }
  return factory
}

/**
 * The seven addresses `salt` gives on this network, as `predict_market` derives them: each is the
 * factory's `deployed_address` for `sha256(salt ‖ tag)` (`sub_salt`), the host's contract id
 * `sha256(HashIdPreimage::ContractId { network_id, FromAddress { factory, sub_salt } })`. Router and
 * oracle are the manifest's, which the market is wired to.
 */
export function deriveMarketContracts(manifest: Manifest, salt: string): MarketContracts {
  const factory = new Address(factoryOf(manifest)).toScAddress()
  const seed = hexToBytes(saltOf(salt))
  const networkId = sha(new TextEncoder().encode(manifest.networkPassphrase))
  const at = (kind: MarketContractName) => {
    const tagged = new Uint8Array(seed.length + 1)
    tagged.set(seed)
    tagged[seed.length] = TAG[kind]
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId,
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({ address: factory, salt: sha(tagged) }),
        ),
      }),
    )
    return StrKey.encodeContract(sha(new Uint8Array(preimage.toXDR())))
  }
  return {
    router: manifest.shared.router,
    oracle: manifest.shared.oracle,
    sy: at("sy"),
    pt: at("pt"),
    yt: at("yt"),
    config: at("config"),
    manager: at("manager"),
    pool: at("pool"),
    recoveryEscrow: at("recoveryEscrow"),
  }
}

/** `MarketFactory.predict_market(salt: BytesN<32>) -> MarketContracts`. */
export function predictMarketInvocation(manifest: Manifest, salt: string): ContractInvocation {
  return { contractId: factoryOf(manifest), functionName: "predict_market", args: [bytes(saltOf(salt))] }
}

const KINDS = Object.keys(TAG) as MarketContractName[]

/**
 * Step 2 (spec 0002 §5): `predict_market` read on chain. Nothing is signed. RPC is untrusted (R29):
 * an answer that is not the derivation above is refused, as is one that cannot be read.
 */
export async function predictMarket(reader: ContractReader, manifest: Manifest, salt: string): Promise<MarketContracts> {
  const { value } = await reader<unknown>(predictMarketInvocation(manifest, salt))
  if (!value || typeof value !== "object") throw new Error("predict_market did not return a struct.")
  const answer = value as Record<string, unknown>
  const derived = deriveMarketContracts(manifest, salt)
  const differs = KINDS.filter((k) => {
    try {
      return toAddress(answer[FIELD[k]]) !== derived[k]
    } catch {
      return true
    }
  })
  if (differs.length > 0) {
    throw new Error(
      `The network's predicted addresses differ from the ones this salt gives on this network (${differs.map((k) => NAME[k]).join(", ")}). Nothing was signed; try again or use another RPC.`,
    )
  }
  return derived
}

// ---------------------------------------------------------------- the assets this network knows

/** The SACs the manifest knows (its markets' underlyings and the test asset), with code and decimals. */
export function knownUnderlyings(manifest: Manifest): Map<string, { code: string; decimals: number }> {
  const known = new Map<string, { code: string; decimals: number }>()
  for (const m of manifest.markets) known.set(m.underlying.sac, { code: m.underlying.code, decimals: m.underlying.decimals })
  if (manifest.testAsset) known.set(manifest.testAsset.sac, { code: manifest.testAsset.code, decimals: manifest.testAsset.decimals })
  return known
}

function underlyingOf(manifest: Manifest, sac: string): { code: string; decimals: number } {
  const found = knownUnderlyings(manifest).get(sac)
  if (!found) throw new Error(`${shorten(sac)} is not the asset contract of an asset on this network.`)
  return found
}

// ---------------------------------------------------------------- checks (as the contracts check)

const isAddress = (v: string) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v)
const isWhole = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max

const FEE_LABEL = {
  tokenizationFeeBps: "Tokenization fee",
  ytFeeBps: "YT fee",
  swapFeeTierBps: "Swap fee tier",
  protocolShareBps: "Protocol share",
} as const
const TEXT_LABEL = { ptName: "PT name", ptSymbol: "PT symbol", ytName: "YT name", ytSymbol: "YT symbol" } as const

export type ParamErrors = Partial<Record<keyof MarketParams, string>>

function textError(value: string, max: number): string | undefined {
  if (value.trim() === "") return "Enter a value."
  if (value !== value.trim()) return "Remove the spaces at the start or end."
  if (value.length > max) return `Use at most ${max} characters.`
  return undefined
}

/**
 * The UTC date and time the form shows and reads: `YYYY-MM-DDTHH:mm`, with `:ss` when the seconds
 * are not zero (a maturity the chain fixed is kept to the second).
 */
function utcMinute(seconds: bigint | number): string {
  const iso = new Date(Number(seconds) * 1000).toISOString()
  return iso.slice(17, 19) === "00" ? iso.slice(0, 16) : iso.slice(0, 19)
}

/**
 * Every field the contracts would refuse, in plain words; `{}` is the only "yes". `ledgerTime` (unix
 * seconds) checks the maturity: after now, and within three quarters of the time stretch, or the
 * pool refuses it (`MaturityTooFar`: its curve exponent must stay at least a quarter). Without a
 * ledger time the maturity cannot be checked, which blocks.
 */
export function paramErrors(manifest: Manifest, p: Partial<MarketParams>, ledgerTime?: number | null): ParamErrors {
  const errors: ParamErrors = {}
  if (p.underlying === undefined || !knownUnderlyings(manifest).has(p.underlying)) errors.underlying = "Choose an asset this network knows."
  for (const key of Object.keys(TEXT_LABEL) as (keyof typeof TEXT_LABEL)[]) {
    const error = p[key] === undefined ? "Enter a value." : textError(p[key], key.endsWith("Name") ? MAX_NAME : MAX_SYMBOL)
    if (error) errors[key] = error
  }
  for (const key of Object.keys(FEE_LABEL) as (keyof typeof FEE_LABEL)[]) {
    const v = p[key]
    if (v === undefined || !isWhole(v, 0, FEE_CAPS[key])) {
      errors[key] =
        key === "protocolShareBps"
          ? "Enter a whole number of basis points from 0 to 10000 (100%)."
          : `Enter a whole number of basis points from 0 to ${FEE_CAPS[key]}, the contract's cap.`
    }
  }
  if (p.treasury === undefined || !isAddress(p.treasury)) errors.treasury = "Enter a Stellar account (G…) or contract (C…) address."
  if (p.protocolAdmin === undefined || !isAddress(p.protocolAdmin)) errors.protocolAdmin = "Enter a Stellar account (G…) or contract (C…) address."
  const stretch = p.timeStretchYears
  const stretchOk = stretch !== undefined && isWhole(stretch, STRETCH_YEARS.min, STRETCH_YEARS.max)
  if (!stretchOk) errors.timeStretchYears = `Enter a whole number of years from ${STRETCH_YEARS.min} to ${STRETCH_YEARS.max}.`

  if (p.maturity === undefined || p.maturity <= 0n) errors.maturity = "Enter a maturity."
  else if (typeof ledgerTime !== "number" || !Number.isFinite(ledgerTime) || ledgerTime <= 0) {
    errors.maturity = "Waiting for the ledger time to check the maturity."
  } else {
    const now = BigInt(Math.floor(ledgerTime))
    if (p.maturity <= now) errors.maturity = "The maturity must be after the current ledger time."
    else if (stretchOk) {
      // remaining·4 ≤ stretch·3 keeps the exponent at or above a quarter (market_pool initialize).
      const latest = now + (BigInt(stretch) * BigInt(SECONDS_PER_YEAR) * 3n) / 4n
      if (p.maturity > latest) {
        errors.maturity = `With a time stretch of ${stretch} year${stretch === 1 ? "" : "s"}, the maturity must be on or before ${utcMinute(latest).replace("T", " ")} UTC (three quarters of the stretch from now). Choose an earlier maturity or a longer time stretch.`
      }
    }
  }
  return errors
}

/** The checks a builder makes on the fields it signs: everything but the time (that needs the ledger). */
function assertSigned<K extends keyof MarketParams>(manifest: Manifest, p: Pick<MarketParams, K>, keys: readonly K[]): void {
  underlyingOf(manifest, (p as Partial<MarketParams>).underlying ?? "")
  const errors = paramErrors(manifest, p as Partial<MarketParams>, null)
  for (const key of keys) {
    if (key === "maturity") {
      const maturity = (p as Partial<MarketParams>).maturity
      if (maturity === undefined || maturity <= 0n || maturity > 18_446_744_073_709_551_615n) throw new Error("Maturity must be a time in unix seconds.")
      continue
    }
    const error = errors[key]
    if (error) throw new Error(`${PARAM_LABEL[key]}: ${error}`)
  }
}

/** How the form and refusals name each parameter. */
export const PARAM_LABEL: Record<keyof MarketParams, string> = {
  underlying: "Asset",
  maturity: "Maturity",
  ...TEXT_LABEL,
  protocolAdmin: "Protocol admin",
  treasury: "Treasury",
  ...FEE_LABEL,
  timeStretchYears: "Time stretch",
}

// ---------------------------------------------------------------- the form's draft

/** The form's text for each parameter. */
export type ParamDraft = Record<keyof MarketParams, string>

const MINUTE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** A parameter's text in the form; maturity as a UTC date and time. */
export function draftFromParams(p: Partial<MarketParams>): Partial<ParamDraft> {
  const out: Partial<ParamDraft> = {}
  for (const [key, value] of Object.entries(p) as [keyof MarketParams, MarketParams[keyof MarketParams]][]) {
    if (value === undefined) continue
    out[key] = key === "maturity" ? utcMinute(value as bigint) : String(value)
  }
  return out
}

function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return Number.NaN
  const n = Number(value.trim())
  return n <= U32_MAX ? n : Number.NaN
}

function maturityOf(value: string | undefined): bigint | undefined {
  const m = value === undefined ? null : MINUTE_RE.exec(value.trim())
  if (!m) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  // A date that does not exist (2027-02-30) rolls over in Date.UTC: refuse it rather than move it.
  const exact = m[6] === undefined ? `${value?.trim()}:00` : value?.trim()
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === exact ? BigInt(ms / 1000) : undefined
}

/** The parameters a draft states, with every refusal; `params` only when there is none. */
export function paramsFromDraft(
  manifest: Manifest,
  draft: Partial<ParamDraft>,
  ledgerTime: number | null | undefined,
): { params?: MarketParams; errors: ParamErrors } {
  const read: Partial<MarketParams> = {
    underlying: draft.underlying,
    maturity: maturityOf(draft.maturity),
    ptName: draft.ptName,
    ptSymbol: draft.ptSymbol,
    ytName: draft.ytName,
    ytSymbol: draft.ytSymbol,
    protocolAdmin: draft.protocolAdmin?.trim(),
    treasury: draft.treasury?.trim(),
    tokenizationFeeBps: wholeNumber(draft.tokenizationFeeBps),
    ytFeeBps: wholeNumber(draft.ytFeeBps),
    swapFeeTierBps: wholeNumber(draft.swapFeeTierBps),
    protocolShareBps: wholeNumber(draft.protocolShareBps),
    timeStretchYears: wholeNumber(draft.timeStretchYears),
  }
  const errors = paramErrors(manifest, read, ledgerTime)
  if (read.maturity === undefined && draft.maturity !== undefined && draft.maturity.trim() !== "") {
    errors.maturity = "Enter a date and time (UTC)."
  }
  return Object.keys(errors).length > 0 ? { errors } : { params: read as MarketParams, errors }
}

// ---------------------------------------------------------------- struct encoders (contracttype, field by field)

function pinOf(manifest: Manifest, kind: MarketContractName): string {
  const pin = manifest.wasmHashes[kind]
  if (!pin || !/^[0-9a-f]{64}$/i.test(pin)) {
    throw new Error(`This network's manifest pins no code for the ${NAME[kind]}, so markets cannot be created from the app.`)
  }
  return pin.toLowerCase()
}

const wasmStruct = (manifest: Manifest, kinds: MarketContractName[]) =>
  struct(Object.fromEntries(kinds.map((k) => [FIELD[k], bytes(pinOf(manifest, k))])))
const addressStruct = (c: Partial<Record<MarketContractName, string>>, kinds: MarketContractName[]) =>
  struct(Object.fromEntries(kinds.map((k) => [FIELD[k], address(c[k] as string)])))

/** `TokenWasmHashes { sy_wrapper, pt_token, yt_token }`: the manifest's pins. */
export const tokenWasmHashes = (manifest: Manifest) => wasmStruct(manifest, ["sy", "pt", "yt"])
/** `EngineWasmHashes { market_config, principal_manager }`. */
export const engineWasmHashes = (manifest: Manifest) => wasmStruct(manifest, ["config", "manager"])
/** `PoolEscrowWasmHashes { market_pool, recovery_escrow }`. */
export const poolEscrowWasmHashes = (manifest: Manifest) => wasmStruct(manifest, ["pool", "recoveryEscrow"])
/** `MarketTokens { sy_wrapper, pt_token, yt_token }`. */
export const marketTokens = (c: Pick<MarketContracts, "sy" | "pt" | "yt">) => addressStruct(c, ["sy", "pt", "yt"])
/** `MarketEngine { market_config, principal_manager }`. */
export const marketEngine = (c: Pick<MarketContracts, "config" | "manager">) => addressStruct(c, ["config", "manager"])

/** `TokenParams`: Permissioning and the oracle from the manifest; decimals are the underlying's. */
export function tokenParams(manifest: Manifest, p: TokenParamsInput): ScArg {
  const { decimals } = underlyingOf(manifest, p.underlying)
  return struct({
    underlying: address(p.underlying),
    maturity: u64(p.maturity),
    permissioning: address(manifest.shared.permissioning),
    oracle: address(manifest.shared.oracle),
    pt_name: text(p.ptName),
    pt_symbol: text(p.ptSymbol),
    yt_name: text(p.ytName),
    yt_symbol: text(p.ytSymbol),
    decimals: u32(decimals),
  })
}

/** `EngineParams`: Permissioning, the oracle and RiskControl from the manifest. */
export function engineParams(manifest: Manifest, p: EngineParamsInput): ScArg {
  underlyingOf(manifest, p.underlying)
  return struct({
    underlying: address(p.underlying),
    maturity: u64(p.maturity),
    permissioning: address(manifest.shared.permissioning),
    oracle: address(manifest.shared.oracle),
    risk_control: address(manifest.shared.riskControl),
    protocol_admin: address(p.protocolAdmin),
    treasury: address(p.treasury),
    tokenization_fee_bps: u32(p.tokenizationFeeBps),
    yt_fee_bps: u32(p.ytFeeBps),
    swap_fee_tier_bps: u32(p.swapFeeTierBps),
    protocol_share_bps: u32(p.protocolShareBps),
  })
}

/** `PoolEscrowParams { underlying, time_stretch_years }`. */
export function poolEscrowParams(manifest: Manifest, p: PoolParamsInput): ScArg {
  underlyingOf(manifest, p.underlying)
  return struct({ underlying: address(p.underlying), time_stretch_years: u32(p.timeStretchYears) })
}

// ---------------------------------------------------------------- struct decoders (R31: a call is read back, then built again)

type FieldType = "address" | "u32" | "u64" | "string" | "bytes"

/** A struct's fields, exactly `spec`, each of its type; refuses anything else in plain words. */
function fieldsOf(arg: ScArg, what: string, spec: Record<string, FieldType>): Record<string, ScArg> {
  if (arg.type !== "struct") throw new Error(`${what} must be a struct.`)
  for (const name of Object.keys(arg.value)) {
    if (!Object.hasOwn(spec, name)) throw new Error(`${what} has a field ${name} the contract does not declare.`)
  }
  for (const [name, type] of Object.entries(spec)) {
    const field = arg.value[name]
    if (!field) throw new Error(`${what} has no field ${name}.`)
    if (field.type !== type) throw new Error(`${what}.${name} must be a${type === "address" ? "n" : ""} ${type}.`)
  }
  return arg.value
}

const valueOf = {
  address(arg: ScArg, what: string): string {
    if (arg.type !== "address" || typeof arg.value !== "string") throw new Error(`${what} must be an address.`)
    return arg.value
  },
  text(arg: ScArg, what: string): string {
    if (arg.type !== "string" || typeof arg.value !== "string") throw new Error(`${what} must be a string.`)
    return arg.value
  },
  u32(arg: ScArg, what: string): number {
    if (arg.type !== "u32" || !Number.isInteger(arg.value)) throw new Error(`${what} must be a u32.`)
    return arg.value
  },
  u64(arg: ScArg, what: string): bigint {
    if (arg.type !== "u64") throw new Error(`${what} must be a u64.`)
    return BigInt(arg.value)
  },
}

const TOKEN_SPEC = {
  underlying: "address",
  maturity: "u64",
  permissioning: "address",
  oracle: "address",
  pt_name: "string",
  pt_symbol: "string",
  yt_name: "string",
  yt_symbol: "string",
  decimals: "u32",
} as const satisfies Record<string, FieldType>

const ENGINE_SPEC = {
  underlying: "address",
  maturity: "u64",
  permissioning: "address",
  oracle: "address",
  risk_control: "address",
  protocol_admin: "address",
  treasury: "address",
  tokenization_fee_bps: "u32",
  yt_fee_bps: "u32",
  swap_fee_tier_bps: "u32",
  protocol_share_bps: "u32",
} as const satisfies Record<string, FieldType>

/** The caller-chosen fields of a `TokenParams`; the rest is checked when the call is built again. */
export function decodeTokenParams(arg: ScArg): TokenParamsInput {
  const f = fieldsOf(arg, "TokenParams", TOKEN_SPEC)
  return {
    underlying: valueOf.address(f.underlying, "TokenParams.underlying"),
    maturity: valueOf.u64(f.maturity, "TokenParams.maturity"),
    ptName: valueOf.text(f.pt_name, "TokenParams.pt_name"),
    ptSymbol: valueOf.text(f.pt_symbol, "TokenParams.pt_symbol"),
    ytName: valueOf.text(f.yt_name, "TokenParams.yt_name"),
    ytSymbol: valueOf.text(f.yt_symbol, "TokenParams.yt_symbol"),
  }
}

export function decodeEngineParams(arg: ScArg): EngineParamsInput {
  const f = fieldsOf(arg, "EngineParams", ENGINE_SPEC)
  return {
    underlying: valueOf.address(f.underlying, "EngineParams.underlying"),
    maturity: valueOf.u64(f.maturity, "EngineParams.maturity"),
    protocolAdmin: valueOf.address(f.protocol_admin, "EngineParams.protocol_admin"),
    treasury: valueOf.address(f.treasury, "EngineParams.treasury"),
    tokenizationFeeBps: valueOf.u32(f.tokenization_fee_bps, "EngineParams.tokenization_fee_bps"),
    ytFeeBps: valueOf.u32(f.yt_fee_bps, "EngineParams.yt_fee_bps"),
    swapFeeTierBps: valueOf.u32(f.swap_fee_tier_bps, "EngineParams.swap_fee_tier_bps"),
    protocolShareBps: valueOf.u32(f.protocol_share_bps, "EngineParams.protocol_share_bps"),
  }
}

export function decodePoolEscrowParams(arg: ScArg): PoolParamsInput {
  const f = fieldsOf(arg, "PoolEscrowParams", { underlying: "address", time_stretch_years: "u32" })
  return {
    underlying: valueOf.address(f.underlying, "PoolEscrowParams.underlying"),
    timeStretchYears: valueOf.u32(f.time_stretch_years, "PoolEscrowParams.time_stretch_years"),
  }
}

/** A salt argument read back. */
export function decodeSalt(arg: ScArg | undefined, what: string): string {
  if (!arg || arg.type !== "bytes" || typeof arg.value !== "string" || parseSalt(arg.value) !== arg.value) {
    throw new Error(`${what} must be a salt of 32 bytes.`)
  }
  return arg.value
}

// ---------------------------------------------------------------- the three create_* invocations (one salt)

function issuerOf(value: string): string {
  if (!StrKey.isValidEd25519PublicKey(value)) throw new Error(`The issuer "${value}" is not a Stellar account address (G…).`)
  return value
}

type Create<P> = { issuer: string; salt: string; params: P }

/** `create_tokens(issuer, salt, wasm: TokenWasmHashes, params: TokenParams) -> MarketTokens`. */
export function createTokensInvocation(manifest: Manifest, c: Create<TokenParamsInput>): ContractInvocation {
  assertSigned(manifest, c.params, ["underlying", "maturity", "ptName", "ptSymbol", "ytName", "ytSymbol"])
  return {
    contractId: factoryOf(manifest),
    functionName: "create_tokens",
    args: [address(issuerOf(c.issuer)), bytes(saltOf(c.salt)), tokenWasmHashes(manifest), tokenParams(manifest, c.params)],
  }
}

/** `create_engine(issuer, salt, wasm: EngineWasmHashes, tokens: MarketTokens, params: EngineParams) -> MarketEngine`. */
export function createEngineInvocation(manifest: Manifest, c: Create<EngineParamsInput>): ContractInvocation {
  assertSigned(manifest, c.params, [
    "underlying",
    "maturity",
    "protocolAdmin",
    "treasury",
    "tokenizationFeeBps",
    "ytFeeBps",
    "swapFeeTierBps",
    "protocolShareBps",
  ])
  const predicted = deriveMarketContracts(manifest, c.salt)
  return {
    contractId: factoryOf(manifest),
    functionName: "create_engine",
    args: [
      address(issuerOf(c.issuer)),
      bytes(saltOf(c.salt)),
      engineWasmHashes(manifest),
      marketTokens(predicted),
      engineParams(manifest, c.params),
    ],
  }
}

/** `create_pool_and_escrow(issuer, salt, wasm, tokens, engine, params: PoolEscrowParams) -> MarketPoolAndEscrow`. */
export function createPoolAndEscrowInvocation(manifest: Manifest, c: Create<PoolParamsInput>): ContractInvocation {
  assertSigned(manifest, c.params, ["underlying", "timeStretchYears"])
  const predicted = deriveMarketContracts(manifest, c.salt)
  return {
    contractId: factoryOf(manifest),
    functionName: "create_pool_and_escrow",
    args: [
      address(issuerOf(c.issuer)),
      bytes(saltOf(c.salt)),
      poolEscrowWasmHashes(manifest),
      marketTokens(predicted),
      marketEngine(predicted),
      poolEscrowParams(manifest, c.params),
    ],
  }
}

// ---------------------------------------------------------------- the issuer's authorization tree (R29, R5-10)

/**
 * What the issuer's single authorization of a `create_*` call carries beneath it: exactly the calls
 * the factory makes into the contracts it deploys that call `admin.require_auth()` (each child's
 * `initialize`, then its wiring through `assert_admin`), in the order it makes them, each with the
 * arguments it passes (market_factory `create_tokens`, `create_engine`, `create_pool_and_escrow`).
 * `RecoveryEscrow.initialize` takes no admin and asks no authorization. RPC prepares the
 * authorization entries and is untrusted: the review refuses any tree but this one.
 */
export function tokensAuthTree(manifest: Manifest, c: Create<TokenParamsInput>): ContractInvocation[] {
  const p = deriveMarketContracts(manifest, c.salt)
  const { permissioning, oracle } = manifest.shared
  const { decimals } = underlyingOf(manifest, c.params.underlying)
  const issuer = address(issuerOf(c.issuer))
  const underlying = address(c.params.underlying)
  const maturity = u64(c.params.maturity)
  return [
    { contractId: p.sy, functionName: "initialize", args: [issuer, underlying, address(permissioning)] },
    {
      contractId: p.pt,
      functionName: "initialize",
      args: [issuer, address(permissioning), underlying, maturity, text(c.params.ptName), text(c.params.ptSymbol), u32(decimals)],
    },
    {
      contractId: p.yt,
      functionName: "initialize",
      args: [issuer, address(permissioning), underlying, address(oracle), maturity, text(c.params.ytName), text(c.params.ytSymbol), u32(decimals)],
    },
  ]
}

export function engineAuthTree(manifest: Manifest, c: Create<EngineParamsInput>): ContractInvocation[] {
  const p = deriveMarketContracts(manifest, c.salt)
  const { permissioning, oracle, riskControl } = manifest.shared
  const q = c.params
  const issuer = address(issuerOf(c.issuer))
  const maturity = u64(q.maturity)
  return [
    {
      contractId: p.config,
      functionName: "initialize",
      args: [
        issuer,
        address(q.underlying),
        maturity,
        address(q.protocolAdmin),
        address(q.treasury),
        u32(q.tokenizationFeeBps),
        u32(q.ytFeeBps),
        u32(q.swapFeeTierBps),
        u32(q.protocolShareBps),
      ],
    },
    {
      contractId: p.manager,
      functionName: "initialize",
      args: [issuer, address(p.sy), address(p.pt), address(p.yt), address(oracle), address(permissioning), address(q.underlying), maturity, address(p.config)],
    },
    { contractId: p.pt, functionName: "set_minter", args: [issuer, address(p.manager)] },
    { contractId: p.yt, functionName: "set_minter", args: [issuer, address(p.manager)] },
    { contractId: p.sy, functionName: "set_risk_control", args: [issuer, address(riskControl)] },
    { contractId: p.manager, functionName: "set_risk_control", args: [issuer, address(riskControl)] },
  ]
}

export function poolAuthTree(manifest: Manifest, c: Create<PoolParamsInput>): ContractInvocation[] {
  const p = deriveMarketContracts(manifest, c.salt)
  const issuer = address(issuerOf(c.issuer))
  const escrow = address(p.recoveryEscrow)
  return [
    { contractId: p.pool, functionName: "initialize", args: [issuer, address(p.manager), u32(c.params.timeStretchYears)] },
    { contractId: p.sy, functionName: "set_recovery_escrow", args: [issuer, escrow] },
    { contractId: p.pt, functionName: "set_recovery_escrow", args: [issuer, escrow] },
    { contractId: p.yt, functionName: "set_recovery_escrow", args: [issuer, escrow] },
    { contractId: p.pool, functionName: "set_recovery_escrow", args: [issuer, escrow] },
  ]
}

/** The maturity the form starts from: the first 00:00 UTC at least 90 days after `ledgerTime` (deploy.sh's testnet term). */
export function defaultMaturity(ledgerTime: number): bigint {
  const day = 86_400
  const at = Math.floor(ledgerTime) + 90 * day
  return BigInt(Math.ceil(at / day) * day)
}

/** A maturity as copy shows it: `2027-02-10 00:00 UTC`. */
export function maturityText(maturity: bigint): string {
  return `${utcMinute(maturity).replace("T", " ")} UTC`
}

// ---------------------------------------------------------------- defaults: the current market's (spec 0002 §5 step 1)

/**
 * The market whose settings a new market starts from: the latest maturity on `underlying`, else the
 * latest of all; none when the network lists no market.
 */
export function currentMarket(manifest: Manifest, underlying: string | undefined): Market | undefined {
  const latest = (markets: Market[]) => markets.reduce<Market | undefined>((best, m) => (!best || m.maturity > best.maturity ? m : best), undefined)
  return latest(manifest.markets.filter((m) => m.underlying.sac === underlying)) ?? latest(manifest.markets)
}

/** Each default as read, so an unreadable one says why and is never guessed. */
export type ParamDefaults = {
  market: Market
  tokenizationFeeBps: Live<number>
  ytFeeBps: Live<number>
  swapFeeTierBps: Live<number>
  protocolShareBps: Live<number>
  treasury: Live<string>
  protocolAdmin: Live<string>
  ptName: Live<string>
  ptSymbol: Live<string>
  ytName: Live<string>
  ytSymbol: Live<string>
  timeStretchYears: Live<number>
}

export function toU32(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= U32_MAX) return value
  throw new Error(`expected a u32, got ${typeof value}`)
}

export function toText(value: unknown): string {
  if (typeof value === "string") return value
  throw new Error(`expected a string, got ${typeof value}`)
}

/**
 * The time stretch a pool was built with, in whole years, from `pool_state`: its exponent is
 * `WAD − seconds_to_maturity·WAD / stretch` (market_pool `math::exponent`), so `stretch =
 * seconds_to_maturity·WAD / (WAD − exponent)`. A matured pool no longer says.
 */
function stretchYearsOf(raw: unknown): number {
  if (!raw || typeof raw !== "object") throw new Error("pool_state did not return a struct")
  const s = raw as Record<string, unknown>
  const seconds = toBigint(s.seconds_to_maturity)
  const exponent = toBigint(s.exponent)
  if (seconds <= 0n || exponent >= WAD) throw new Error("the current market has matured, so its time stretch can no longer be read")
  const stretch = (seconds * WAD) / (WAD - exponent)
  const years = Number((stretch + BigInt(SECONDS_PER_YEAR) / 2n) / BigInt(SECONDS_PER_YEAR))
  if (!isWhole(years, STRETCH_YEARS.min, STRETCH_YEARS.max)) throw new Error("the current pool's time stretch is out of range")
  return years
}

/** The current market's settings, read on its contracts: config fees, treasury, protocol admin, names, stretch. */
export async function readDefaults(reader: ContractReader, market: Market): Promise<ParamDefaults> {
  const c = market.contracts
  const read = <T>(contractId: string, functionName: string, map: (v: unknown) => T) => readLive<unknown, T>(reader, { contractId, functionName }, map)
  const [tokenizationFeeBps, ytFeeBps, swapFeeTierBps, protocolShareBps, treasury, protocolAdmin, ptName, ptSymbol, ytName, ytSymbol, timeStretchYears] =
    await Promise.all([
      read(c.config, "tokenization_fee_bps", toU32),
      read(c.config, "yt_fee_bps", toU32),
      read(c.config, "swap_fee_tier_bps", toU32),
      read(c.config, "protocol_share_bps", toU32),
      read(c.config, "treasury", toAddress),
      read(c.config, "protocol_admin", toAddress),
      read(c.pt, "name", toText),
      read(c.pt, "symbol", toText),
      read(c.yt, "name", toText),
      read(c.yt, "symbol", toText),
      read(c.pool, "pool_state", stretchYearsOf),
    ])
  return { market, tokenizationFeeBps, ytFeeBps, swapFeeTierBps, protocolShareBps, treasury, protocolAdmin, ptName, ptSymbol, ytName, ytSymbol, timeStretchYears }
}

/** The defaults that were read, as parameters (an unavailable one is left out, so its field starts empty). */
export function paramsFromDefaults(d: ParamDefaults): Partial<MarketParams> {
  const out: Partial<MarketParams> = { underlying: d.market.underlying.sac }
  const keys = ["tokenizationFeeBps", "ytFeeBps", "swapFeeTierBps", "protocolShareBps", "treasury", "protocolAdmin", "ptName", "ptSymbol", "ytName", "ytSymbol", "timeStretchYears"] as const
  for (const key of keys) {
    const v = d[key]
    if (v.status === "live") (out as Record<string, unknown>)[key] = v.value
  }
  return out
}

/**
 * What a half-deployed market already fixed on chain (resuming step 3): the tokens fix the asset,
 * the maturity and the names; the engine also fixes the fees, the treasury and the protocol admin.
 * Any read that fails refuses: a resumed deployment never guesses what is on chain.
 */
export async function readFixedParams(reader: ContractReader, predicted: MarketContracts, phases: FactoryPhases): Promise<Partial<MarketParams>> {
  const get = async <T>(contractId: string, functionName: string, map: (v: unknown) => T): Promise<T> => {
    const r = await readLive<unknown, T>(reader, { contractId, functionName }, map)
    if (r.status === "unavailable") throw new Error(`Could not read ${functionName} on the new market's contract ${shorten(contractId)}: ${r.error}`)
    return r.value
  }
  const out: Partial<MarketParams> = {}
  if (phases.tokens) {
    const [underlying, maturity, ptName, ptSymbol, ytName, ytSymbol] = await Promise.all([
      get(predicted.pt, "underlying_address", toAddress),
      get(predicted.pt, "maturity", toBigint),
      get(predicted.pt, "name", toText),
      get(predicted.pt, "symbol", toText),
      get(predicted.yt, "name", toText),
      get(predicted.yt, "symbol", toText),
    ])
    Object.assign(out, { underlying, maturity, ptName, ptSymbol, ytName, ytSymbol })
  }
  if (phases.engine) {
    const c = predicted.config
    const [protocolAdmin, treasury, tokenizationFeeBps, ytFeeBps, swapFeeTierBps, protocolShareBps] = await Promise.all([
      get(c, "protocol_admin", toAddress),
      get(c, "treasury", toAddress),
      get(c, "tokenization_fee_bps", toU32),
      get(c, "yt_fee_bps", toU32),
      get(c, "swap_fee_tier_bps", toU32),
      get(c, "protocol_share_bps", toU32),
    ])
    Object.assign(out, { protocolAdmin, treasury, tokenizationFeeBps, ytFeeBps, swapFeeTierBps, protocolShareBps })
  }
  return out
}

/** `get_admin()` of RiskControl, the Router or Permissioning, read live: who must sign a call on it (R5-10, spec §5 step 4). */
export function readContractAdmin(reader: ContractReader, contractId: string): Promise<Live<string>> {
  return readLive<unknown, string>(reader, { contractId, functionName: "get_admin" }, toAddress)
}

/** The admin of an asset's SAC, read live: who must sign a deployment on it (R5-10). */
export function readSacAdmin(reader: ContractReader, sac: string): Promise<Live<string>> {
  return readLive<unknown, string>(reader, { contractId: sac, functionName: "admin" }, toAddress)
}

