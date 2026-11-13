#!/usr/bin/env bash
# Build the Principal contracts and deploy one market on the local network, or on testnet with
# PRINCIPAL_NETWORK=testnet. Follows principal docs/DEPLOYMENT.md steps 1-11, then seeds the pool and
# writes config/manifests/<network>.json. Locally it also writes .env.local and migrates the local
# database; on testnet it writes no env file and prints which keys to give the server.
#
# Usage: [PRINCIPAL_NETWORK=local|testnet] [PRINCIPAL_REPO=../principal] \
#        [PRINCIPAL_REF=origin/feat/tranche-1-mvp] [MATURITY_SECONDS=3600 locally, 7776000 on testnet] \
#        [ASSET_CODE=USDY] scripts/dev-stack/deploy.sh
# Options: MANIFEST_OUT=<path> writes the manifest there instead of config/manifests/<network>.json and
#          writes no .env file. ORACLE_MAX_STALE_SECONDS=<n> sets the oracle freshness window (default 3600).
#          EPHEMERAL=1 (testnet, needs MANIFEST_OUT outside the repo and run-unique ADMIN_KEY/TREASURY_KEY/
#          ISSUER_KEY/ORACLE_KEY names) deploys a throwaway market: no database, no env file, no notes.
#          Key names must not start with principal- or principal_ (any letter case) and must not exist in the
#          keystore yet. A deploy that rewrites config/manifests/testnet.json refuses non-default key names and
#          a non-3600 stale window unless ALLOW_TESTNET_OVERRIDES=1.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

need stellar "Install the Stellar CLI."
need cargo "Install Rust with the wasm32v1-none target: rustup target add wasm32v1-none"
need jq "brew install jq"
need node "Install Node.js."
need git ""
need shasum ""

# Ephemeral mode guards: they run before the build and before any network call.
EPHEMERAL="${EPHEMERAL:-}"
MANIFEST_OUT="${MANIFEST_OUT:-}"
ORACLE_MAX_STALE_SECONDS="${ORACLE_MAX_STALE_SECONDS:-3600}"
case "$ORACLE_MAX_STALE_SECONDS" in '' | *[!0-9]*) die "ORACLE_MAX_STALE_SECONDS must be a positive integer" ;; esac
[ "${#ORACLE_MAX_STALE_SECONDS}" -le 9 ] || die "ORACLE_MAX_STALE_SECONDS is too large (at most 9 digits)"
[ "$ORACLE_MAX_STALE_SECONDS" -gt 0 ] || die "ORACLE_MAX_STALE_SECONDS must be positive"

# Key names (testnet): plain keystore names only. A raw secret or address is also accepted by the Stellar CLI
# as a "name", so secret-shaped values are refused. No message below ever prints a name's value.
if [ "$NETWORK" = testnet ]; then
  for var in ADMIN_KEY TREASURY_KEY ISSUER_KEY ORACLE_KEY; do
    name="${!var}"
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "$var is not a plain keystore name (letters, digits, - and _, starting with a letter or digit)"
    [[ "$name" =~ ^[GS][A-Z2-7]{55}$ ]] && die "$var looks like a Stellar address or secret, not a keystore name"
  done
fi

# inside_repo <dir>: true if <dir> or any ancestor is the dApp repository. `-ef` compares inodes, so letter
# case, `..` and symlinks cannot fool it.
inside_repo() {
  local d="$1"
  while :; do
    [ ! "$d" -ef "$DAPP_DIR" ] || return 0
    [ "$d" != / ] || return 1
    d="$(dirname "$d")"
  done
}

# check_manifest_out: resolve MANIFEST_OUT and refuse every target that could reach the app's files. Sets
# OFFICIAL_MANIFEST=1 when it is exactly the default config/manifests/<network>.json. Run once up front and
# again right before the write.
OFFICIAL_MANIFEST=""
check_manifest_out() {
  local out_dir
  case "$MANIFEST_OUT" in /*) ;; *) MANIFEST_OUT="$PWD/$MANIFEST_OUT" ;; esac
  out_dir="$(cd "$(dirname "$MANIFEST_OUT")" 2>/dev/null && pwd -P)" || die "the directory of MANIFEST_OUT does not exist"
  MANIFEST_OUT="$out_dir/$(basename "$MANIFEST_OUT")"
  [ ! -d "$MANIFEST_OUT" ] || die "MANIFEST_OUT '$MANIFEST_OUT' is a directory: give a file path"
  [ ! -L "$MANIFEST_OUT" ] || die "MANIFEST_OUT '$MANIFEST_OUT' is a symlink"
  OFFICIAL_MANIFEST=""
  if [ -n "$EPHEMERAL" ]; then
    [ ! -s "$MANIFEST_OUT" ] || die "EPHEMERAL=1: MANIFEST_OUT '$MANIFEST_OUT' already exists and is not empty: it would be overwritten"
    ! inside_repo "$out_dir" || die "EPHEMERAL=1: MANIFEST_OUT must be outside the dApp repository (it would point the app at a throwaway market): use a path under a temporary directory"
  elif inside_repo "$out_dir"; then
    if [ "$out_dir" -ef "$DAPP_DIR/config/manifests" ] && [ "$(basename "$MANIFEST_OUT")" = "$NETWORK.json" ]; then
      OFFICIAL_MANIFEST=1
    else
      die "MANIFEST_OUT '$MANIFEST_OUT' is inside the dApp repository and is not config/manifests/$NETWORK.json: use a path outside it"
    fi
  fi
}
[ -z "$MANIFEST_OUT" ] || check_manifest_out
[ -n "$MANIFEST_OUT" ] || OFFICIAL_MANIFEST=1

if [ -n "$EPHEMERAL" ]; then
  [ "$EPHEMERAL" = 1 ] || die "EPHEMERAL must be 1 when set"
  [ -n "$MANIFEST_OUT" ] || die "EPHEMERAL=1 requires MANIFEST_OUT: an ephemeral deploy never writes config/manifests/<network>.json"
  [ "$NETWORK" = testnet ] || die "EPHEMERAL=1 needs PRINCIPAL_NETWORK=testnet"
  seen=""
  for var in ADMIN_KEY TREASURY_KEY ISSUER_KEY ORACLE_KEY; do
    lower="$(tr '[:upper:]' '[:lower:]' <<<"${!var}")"
    role="$(tr '[:upper:]' '[:lower:]' <<<"${var%_KEY}")"
    case "$lower" in
      principal-* | principal_*) die "EPHEMERAL=1 refuses $var: names starting with principal- or principal_ are reserved for the official keys. Set $var to a run-unique name, e.g. e2e-<runid>-$role" ;;
    esac
    case " $seen " in *" $lower "*) die "EPHEMERAL=1 needs four distinct key names (ADMIN_KEY, TREASURY_KEY, ISSUER_KEY, ORACLE_KEY); $var repeats an earlier one (compared in lower case)" ;; esac
    seen="$seen $lower"
  done
  # Last, and the only guard that reads the keystore (local read, no network): the script must generate
  # every key itself, so a cleanup can never delete a key that existed before the run.
  for var in ADMIN_KEY TREASURY_KEY ISSUER_KEY ORACLE_KEY; do
    ! stellar keys address "${!var}" >/dev/null 2>&1 ||
      die "EPHEMERAL=1 refuses $var: that key already exists in the keystore. Use a name that does not exist yet; the script generates and funds it"
  done
elif [ "$NETWORK" = testnet ] && [ -n "$OFFICIAL_MANIFEST" ] && [ "${ALLOW_TESTNET_OVERRIDES:-}" != 1 ]; then
  # The official manifest is the target (by default or by an explicit MANIFEST_OUT pointing at it): leftover
  # variables must not rewrite it with throwaway keys.
  [ "$ADMIN_KEY" = principal-testnet-admin ] && [ "$TREASURY_KEY" = principal-testnet-treasury ] &&
    [ "$ISSUER_KEY" = principal-testnet-issuer ] && [ "$ORACLE_KEY" = principal-testnet-oracle ] ||
    die "this deploy rewrites config/manifests/testnet.json but ADMIN_KEY/TREASURY_KEY/ISSUER_KEY/ORACLE_KEY are not the official names. Unset them, or set ALLOW_TESTNET_OVERRIDES=1 on purpose"
  [ "$ORACLE_MAX_STALE_SECONDS" = 3600 ] ||
    die "this deploy rewrites config/manifests/testnet.json but ORACLE_MAX_STALE_SECONDS is $ORACLE_MAX_STALE_SECONDS, not 3600. Unset it, or set ALLOW_TESTNET_OVERRIDES=1 on purpose"
fi

PRINCIPAL_REPO="${PRINCIPAL_REPO:-../principal}"
PRINCIPAL_REF="${PRINCIPAL_REF:-origin/feat/tranche-1-mvp}"
if [ "$NETWORK" = local ]; then MATURITY_SECONDS="${MATURITY_SECONDS:-3600}"; else MATURITY_SECONDS="${MATURITY_SECONDS:-7776000}"; fi
ASSET_CODE="${ASSET_CODE:-USDY}"
[[ "$ASSET_CODE" =~ ^[A-Za-z0-9]{1,12}$ ]] || die "ASSET_CODE must be 1-12 letters or digits"
ASSET_DISPLAY="$ASSET_CODE (test)"
case "$MATURITY_SECONDS" in '' | *[!0-9]*) die "MATURITY_SECONDS must be a positive integer" ;; esac
[ "$MATURITY_SECONDS" -gt 0 ] || die "MATURITY_SECONDS must be positive"
case "$PRINCIPAL_REPO" in /*) ;; *) PRINCIPAL_REPO="$DAPP_DIR/$PRINCIPAL_REPO" ;; esac
[ -d "$PRINCIPAL_REPO" ] || die "PRINCIPAL_REPO '$PRINCIPAL_REPO' does not exist"

if [ "$NETWORK" = local ]; then
  rpc_healthy || die "the local network is not answering on $RPC_URL. Run scripts/dev-stack/up.sh first."
  stellar keys address "$ADMIN_KEY" >/dev/null 2>&1 || die "key $ADMIN_KEY is missing. Run scripts/dev-stack/up.sh first."
  stellar keys address "$TREASURY_KEY" >/dev/null 2>&1 || die "key $TREASURY_KEY is missing. Run scripts/dev-stack/up.sh first."
else
  rpc_healthy || die "the $NETWORK RPC is not answering on $RPC_URL."
  for key in "$ADMIN_KEY" "$TREASURY_KEY" "$ISSUER_KEY" "$ORACLE_KEY"; do ensure_funded_key "$key"; done
fi
ADMIN="$(stellar keys address "$ADMIN_KEY")"
TREASURY="$(stellar keys address "$TREASURY_KEY")"
ISSUER="$(stellar keys address "$ISSUER_KEY")"
ORACLE_ADMIN="$(stellar keys address "$ORACLE_KEY")"

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------------------------
# Build. Sources are extracted read-only with `git archive` (never a worktree, never a checkout in
# the principal repository) into a cache directory keyed by the commit.
# ---------------------------------------------------------------------------------------------
COMMIT="$(git -C "$PRINCIPAL_REPO" rev-parse --verify "${PRINCIPAL_REF}^{commit}")" ||
  die "cannot resolve PRINCIPAL_REF '$PRINCIPAL_REF' in $PRINCIPAL_REPO"
SRC_DIR="${TMPDIR:-/tmp}/principal-dev-stack/${COMMIT}"
WASM_DIR="$SRC_DIR/target/wasm32v1-none/release"
if [ ! -f "$WASM_DIR/principal_router.wasm" ] || [ ! -f "$WASM_DIR/principal_market_factory.wasm" ]; then
  log "Extracting $PRINCIPAL_REF ($COMMIT) to $SRC_DIR"
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  git -C "$PRINCIPAL_REPO" archive "$COMMIT" | tar -x -C "$SRC_DIR"
  log "Building contracts (cargo build --workspace --release --target wasm32v1-none)"
  (cd "$SRC_DIR" && cargo build --workspace --release --target wasm32v1-none) ||
    die "cargo build failed. Is the target installed? rustup target add wasm32v1-none"
else
  log "Reusing built contracts for $COMMIT"
fi

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
HASHES_JSON="{}"
LAST_ID=""
# deploy_contract <name> <wasm file name>: sets LAST_ID (runs in the current shell, so it records the hash too)
deploy_contract() {
  local name="$1" file="$WASM_DIR/$2" hash id
  [ -f "$file" ] || die "missing build artifact $file"
  hash="$(stellar contract upload --wasm "$file" --source "$ADMIN_KEY" --network "$NETWORK" | tail -n1)"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "uploading $2 returned an unexpected hash: '$hash'"
  HASHES_JSON="$(jq -c --arg k "$name" --arg v "$hash" '. + {($k): $v}' <<<"$HASHES_JSON")"
  id="$(stellar contract deploy --wasm-hash "$hash" --source "$ADMIN_KEY" --network "$NETWORK" | tail -n1)"
  [[ "$id" =~ ^C[A-Z2-7]{55}$ ]] || die "deploying $name returned an unexpected contract id: '$id'"
  LAST_ID="$id"
}

adm() { invoke "$ADMIN_KEY" "$@" >/dev/null; } # adm <contract id> <fn> [args...]
iss() { invoke "$ISSUER_KEY" "$@" >/dev/null; } # iss <contract id> <fn> [args...]: as the issuer (SAC and Permissioning admin)

# Unwrap a JSON scalar printed by `stellar contract invoke`.
scalar() { tr -d '"[:space:]'; }

# ---------------------------------------------------------------------------------------------
# Underlying: classic asset $ASSET_CODE (USDY) issued by the issuer key (AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED)
# and its Stellar Asset Contract. Every Principal contract requires its admin to be the SAC admin
# (compliance::is_authority), so the SAC admin is the protocol admin. The issuer keeps its classic
# powers (trustline flags, payments) and is the Permissioning admin: that is all the faucet needs.
# Locally one dev key is all of these.
# ---------------------------------------------------------------------------------------------
ASSET="$ASSET_CODE:$ISSUER"
log "Issuing $ASSET_CODE with AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED"
stellar tx new set-options --source "$ISSUER_KEY" --network "$NETWORK" \
  --set-required --set-revocable --set-clawback-enabled >/dev/null 2>&1 ||
  die "could not set the issuer flags on $ISSUER_KEY"
SAC="$(stellar contract id asset --asset "$ASSET" --network "$NETWORK")"
if ! stellar contract asset deploy --asset "$ASSET" --source "$ISSUER_KEY" --network "$NETWORK" >/dev/null 2>&1; then
  # Already deployed by an earlier run: fine as long as the contract answers.
  invoke "$ISSUER_KEY" "$SAC" admin >/dev/null 2>&1 || die "could not deploy the $ASSET_CODE Stellar Asset Contract"
fi
SAC_ADMIN="$(invoke "$ISSUER_KEY" "$SAC" admin | scalar)"
if [ "$SAC_ADMIN" != "$ADMIN" ]; then
  [ "$SAC_ADMIN" = "$ISSUER" ] || die "the $ASSET_CODE SAC admin is $SAC_ADMIN, neither the issuer nor the admin key"
  log "Handing the SAC admin to the protocol admin"
  iss "$SAC" set_admin --new_admin "$ADMIN"
fi
log "$ASSET_CODE SAC ${SAC:0:6}..."

# The treasury receives fee shares, so it holds the underlying: open a trustline (issuer authorizes below).
stellar tx new change-trust --source "$TREASURY_KEY" --line "$ASSET" --network "$NETWORK" >/dev/null 2>&1 ||
  die "could not open the $ASSET_CODE trustline for $TREASURY_KEY"
# The admin seeds the pool below. When it is not the issuer it needs a trustline, its authorization
# and the seeding amount, both from the SAC, whose admin it now is.
DEPOSIT=2000000000000 # 200_000 $ASSET_CODE at 7 decimals
if [ "$ADMIN" != "$ISSUER" ]; then
  stellar tx new change-trust --source "$ADMIN_KEY" --line "$ASSET" --network "$NETWORK" >/dev/null 2>&1 ||
    die "could not open the $ASSET_CODE trustline for $ADMIN_KEY"
  adm "$SAC" set_authorized --id "$ADMIN" --authorize true
  adm "$SAC" mint --to "$ADMIN" --amount "$DEPOSIT"
fi

# Maturity is fixed at initialization for PT, YT, MarketConfig and PrincipalManager.
NOW="$(ledger_close_time)"
MATURITY=$((NOW + MATURITY_SECONDS))
log "Maturity $MATURITY (ledger time $NOW + ${MATURITY_SECONDS}s)"

# ---------------------------------------------------------------------------------------------
# DEPLOYMENT.md steps 1-10
# ---------------------------------------------------------------------------------------------
log "1. OracleAdapter"
deploy_contract oracle principal_oracle_adapter.wasm
ORACLE="$LAST_ID"
# The oracle admin is its own key on testnet: it can only push a value (the keeper's job).
# v2 (R4-9): freshness window ORACLE_MAX_STALE_SECONDS (default 1 h), 10 % deviation bound, one primary source, no fallback.
adm "$ORACLE" initialize --admin "$ORACLE_ADMIN" --max_stale_seconds "$ORACLE_MAX_STALE_SECONDS" --max_deviation_bps 1000
ORACLE_SOURCE="$(printf '%s' "principal-oracle-source:${NETWORK}:${ASSET_CODE}:app-team:keeper" | shasum -a 256 | cut -d' ' -f1)"
[[ "$ORACLE_SOURCE" =~ ^[0-9a-f]{64}$ ]] || die "could not derive the oracle source id"
invoke "$ORACLE_KEY" "$ORACLE" set_sources --caller "$ORACLE_ADMIN" --primary_source "$ORACLE_SOURCE" >/dev/null ||
  die "oracle set_sources failed"
# Genesis value 1.0 (1e7). YTToken.initialize needs an available value; the timestamp is ledger time.
GENESIS="$(invoke "$ORACLE_KEY" "$ORACLE" set_reference_value --caller "$ORACLE_ADMIN" --source "$ORACLE_SOURCE" --value 10000000 --timestamp "$(ledger_close_time)" | tr -d '"[:space:]')"
[ "$GENESIS" = "true" ] || die "the oracle rejected the genesis value (returned '$GENESIS'): $(invoke "$ORACLE_KEY" "$ORACLE" last_rejection)"

log "2. Permissioning"
deploy_contract permissioning principal_permissioning.wasm
PERMISSIONING="$LAST_ID"
adm "$PERMISSIONING" initialize --admin "$ISSUER"

log "3. RiskControl (circuit breaker disabled)"
deploy_contract riskControl principal_risk_control.wasm
RISK_CONTROL="$LAST_ID"
adm "$RISK_CONTROL" initialize --admin "$ADMIN" --cb_limit 0

log "4. SYWrapper (+ RiskControl wiring)"
deploy_contract sy principal_sy_wrapper.wasm
SY="$LAST_ID"
adm "$SY" initialize --admin "$ADMIN" --underlying "$SAC" --permissioning "$PERMISSIONING"
adm "$SY" set_risk_control --admin "$ADMIN" --risk_control "$RISK_CONTROL"
adm "$RISK_CONTROL" add_consumer --caller "$ADMIN" --consumer "$SY"

log "5. PTToken and YTToken"
deploy_contract pt principal_pt_token.wasm
PT="$LAST_ID"
adm "$PT" initialize --admin "$ADMIN" --permissioning "$PERMISSIONING" --underlying "$SAC" \
  --maturity "$MATURITY" --name "Principal Token $ASSET_CODE" --symbol "PT-$ASSET_CODE" --decimals 7
deploy_contract yt principal_yt_token.wasm
YT="$LAST_ID"
adm "$YT" initialize --admin "$ADMIN" --permissioning "$PERMISSIONING" --underlying "$SAC" \
  --oracle "$ORACLE" --maturity "$MATURITY" --name "Yield Token $ASSET_CODE" --symbol "YT-$ASSET_CODE" --decimals 7

log "6. MarketConfig (fees 5 / 1000 / 10 bps, protocol share 2000 bps)"
deploy_contract config principal_market_config.wasm
CONFIG="$LAST_ID"
adm "$CONFIG" initialize --admin "$ADMIN" --underlying "$SAC" --maturity "$MATURITY" \
  --protocol_admin "$ADMIN" --treasury "$TREASURY" \
  --tokenization_fee_bps 5 --yt_fee_bps 1000 --swap_fee_tier_bps 10 --protocol_share_bps 2000

log "7. PrincipalManager (+ minter on PT/YT, RiskControl wiring)"
deploy_contract manager principal_manager.wasm
MANAGER="$LAST_ID"
adm "$MANAGER" initialize --admin "$ADMIN" --sy_wrapper "$SY" --pt_token "$PT" --yt_token "$YT" \
  --oracle "$ORACLE" --permissioning "$PERMISSIONING" --underlying "$SAC" --maturity "$MATURITY" \
  --market_config "$CONFIG"
for token in "$PT" "$YT"; do
  adm "$token" set_minter --admin "$ADMIN" --minter "$MANAGER"
done
adm "$MANAGER" set_risk_control --admin "$ADMIN" --risk_control "$RISK_CONTROL"
adm "$RISK_CONTROL" add_consumer --caller "$ADMIN" --consumer "$MANAGER"

log "8. MarketPool (time stretch 4 years)"
deploy_contract pool principal_market_pool.wasm
POOL="$LAST_ID"
adm "$POOL" initialize --admin "$ADMIN" --principal_manager "$MANAGER" --time_stretch_years 4

log "9. RecoveryEscrow (+ set_recovery_escrow on SY, PT, YT, pool)"
deploy_contract recoveryEscrow principal_recovery_escrow.wasm
ESCROW="$LAST_ID"
adm "$ESCROW" initialize --underlying "$SAC" --sy_wrapper "$SY" --pt_token "$PT" --yt_token "$YT" \
  --principal_manager "$MANAGER" --market_pool "$POOL"
for c in "$SY" "$PT" "$YT" "$POOL"; do
  adm "$c" set_recovery_escrow --admin "$ADMIN" --escrow "$ESCROW"
done

log "10. Router (+ register_market)"
deploy_contract router principal_router.wasm
ROUTER="$LAST_ID"
adm "$ROUTER" initialize --admin "$ADMIN"
adm "$ROUTER" register_market --caller "$ADMIN" --pool "$POOL"

log "10b. MarketFactory (stateless: no initialize; its wasm hash is recorded for market creation)"
deploy_contract factory principal_market_factory.wasm
FACTORY="$LAST_ID"
# The factory deploys the market contracts from already-uploaded wasm: they were all uploaded above.
for k in sy pt yt config manager pool recoveryEscrow; do
  jq -e --arg k "$k" 'has($k)' <<<"$HASHES_JSON" >/dev/null || die "wasm hash for $k was not recorded"
done
# Router functions the deployed wasm exposes (user flows only), read from its interface. The `quote_*`
# views are reads, not flows, so they are left out.
ROUTER_FUNCTIONS="$(stellar contract info interface --wasm "$WASM_DIR/principal_router.wasm" --output json 2>/dev/null |
  jq -c '[.[] | select(has("function_v0")) | .function_v0.name | select(startswith("quote_") | not)] - ["bump","initialize","register_market","unregister_market","is_registered","market","get_admin","transfer_admin"]')" ||
  die "could not read the router interface"
[ "$(jq 'length' <<<"$ROUTER_FUNCTIONS")" -gt 0 ] || die "router interface listed no user functions"

# ---------------------------------------------------------------------------------------------
# Step 11: compliance standing. Both layers: SAC authorization and Permissioning grants.
# The Router holds nothing and gets none. The admin key trades too (seeding), so it gets grants as well;
# its SAC authorization was set above (an issuer needs none). The SAC admin authorizes, the
# Permissioning admin (the issuer) grants.
# ---------------------------------------------------------------------------------------------
log "11. Compliance standing"
for holder in "$SY" "$MANAGER" "$POOL" "$ESCROW" "$TREASURY"; do
  adm "$SAC" set_authorized --id "$holder" --authorize true
  iss "$PERMISSIONING" grant_account --caller "$ISSUER" --account "$holder"
done
for holder in "$POOL" "$ESCROW" "$ADMIN"; do
  for asset in "$PT" "$YT"; do
    iss "$PERMISSIONING" grant_asset --caller "$ISSUER" --account "$holder" --asset "$asset"
  done
done
iss "$PERMISSIONING" grant_account --caller "$ISSUER" --account "$ADMIN"

# ---------------------------------------------------------------------------------------------
# Seed the pool from the dev admin key.
#   deposit 200_000 underlying -> 200_000 SY (first deposit is 1:1)
#   mint with 100_000 SY -> notional PT = YT = (SY - 5 bps fee) * oracle rate / 1e7
#   add_liquidity(all PT, 95 % of its SY value)
# First add_liquidity rule (market_pool add_liquidity): sy * rate / 1e7 must not exceed pt
# (InvalidInitialRatio) and isqrt(pt * sy) must exceed MINIMUM_LIQUIDITY = 1000. With
# sy = 0.95 * pt * 1e7 / rate the first holds with 5 % headroom (pool prices PT at a 5 % discount),
# and isqrt(~0.97e12) is far above 1000. 100_000 SY are left over for the sy side (needs ~95_000).
# ---------------------------------------------------------------------------------------------
log "Seeding the pool"
MINT_SY=1000000000000 # 100_000 SY
adm "$SY" deposit --from "$ADMIN" --amount "$DEPOSIT" --min_shares_out 0
MINT_OUT="$(invoke "$ADMIN_KEY" "$MANAGER" mint --from "$ADMIN" --sy_shares "$MINT_SY")"
PT_MINTED="$(echo "$MINT_OUT" | jq -er '.pt_minted' | scalar)"
RATE="$(invoke "$ADMIN_KEY" "$ORACLE" get_reference_value | scalar)"
SY_FOR_POOL="$(node -e 'const [pt,rate]=process.argv.slice(1).map(BigInt); console.log((pt*10000000n/rate*95n/100n).toString())' "$PT_MINTED" "$RATE")"
log "pt=$PT_MINTED sy=$SY_FOR_POOL rate=$RATE"
adm "$POOL" add_liquidity --from "$ADMIN" --pt_desired "$PT_MINTED" --sy_desired "$SY_FOR_POOL" --min_lp_out 0

# ---------------------------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------------------------
MARKET_ID="$NETWORK-$(tr "[:upper:]" "[:lower:]" <<<"$ASSET_CODE")-$MATURITY"
if [ -n "$MANIFEST_OUT" ]; then
  check_manifest_out # again, right before the write: the path may have changed during the deploy
  MANIFEST="$MANIFEST_OUT"
else
  MANIFEST="$DAPP_DIR/config/manifests/$NETWORK.json"
  mkdir -p "$(dirname "$MANIFEST")"
fi
# Write to a sibling temp file, then rename: a symlink or hard link at $MANIFEST is replaced, never followed.
MANIFEST_TMP="$(mktemp "$(dirname "$MANIFEST")/.manifest.XXXXXX")"

jq -n \
  --arg passphrase "$NETWORK_PASSPHRASE" --arg rpc "$RPC_URL" --arg horizon "$HORIZON_URL" \
  --arg friendbot "$FRIENDBOT_URL" --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$COMMIT" --arg risk "$RISK_CONTROL" --arg perm "$PERMISSIONING" --arg factory "$FACTORY" \
  --arg id "$MARKET_ID" --arg issuer "$ISSUER" --arg sac "$SAC" --argjson maturity "$MATURITY" --arg network "$NETWORK" \
  --arg code "$ASSET_CODE" --arg display "$ASSET_DISPLAY" --argjson fns "$ROUTER_FUNCTIONS" \
  --arg router "$ROUTER" --arg oracle "$ORACLE" --arg sy "$SY" --arg pt "$PT" --arg yt "$YT" \
  --arg config "$CONFIG" --arg manager "$MANAGER" --arg pool "$POOL" --arg escrow "$ESCROW" \
  --argjson hashes "$HASHES_JSON" '{
    schemaVersion: 2, network: $network, networkPassphrase: $passphrase,
    rpcUrl: $rpc, horizonUrl: $horizon, friendbotUrl: $friendbot,
    generatedAt: $generatedAt, sourceCommit: $commit,
    shared: { router: $router, oracle: $oracle, permissioning: $perm, riskControl: $risk, factory: $factory },
    wasmHashes: $hashes,
    routerFunctions: $fns,
    testAsset: { code: $code, issuer: $issuer, sac: $sac, decimals: 7, displayName: $display },
    markets: [{
      marketId: $id, displayName: ($display),
      underlying: { code: $code, issuer: $issuer, sac: $sac, decimals: 7 },
      maturity: $maturity,
      contracts: { router: $router, oracle: $oracle, sy: $sy, pt: $pt, yt: $yt, config: $config,
                   manager: $manager, pool: $pool, recoveryEscrow: $escrow }
    }]
  }' >"$MANIFEST_TMP" || { rm -f "$MANIFEST_TMP"; die "could not write the manifest"; }
mv -f "$MANIFEST_TMP" "$MANIFEST" || { rm -f "$MANIFEST_TMP"; die "could not move the manifest into place"; }

if [ -n "$EPHEMERAL" ]; then
  log "Wrote $MANIFEST (ephemeral: no env file, no database, nothing points the app at this market)"
  log "Market $MARKET_ID matures at $MATURITY. Remove the keys afterwards: stellar keys rm <name> --force"
  exit 0
fi

if [ "$NETWORK" != local ]; then
  # No env file and no database migration off the local network: the server's keys are set in the
  # hosting environment by hand, and the network's database is migrated with `pnpm db:migrate`.
  # The secrets are never printed: copy each one from the keystore yourself.
  log "Wrote $MANIFEST"
  log "Market $MARKET_ID matures at $MATURITY."
  log "Set in the $NETWORK environment of the app (secrets: copy them yourself, they are not printed):"
  log "  NEXT_PUBLIC_PRINCIPAL_NETWORK=$NETWORK"
  log "  FAUCET_ISSUER_SECRET        <- stellar keys secret $ISSUER_KEY"
  log "  ORACLE_ADMIN_SECRET         <- stellar keys secret $ORACLE_KEY"
  log "Schedule POST /api/cron/oracle every 30 minutes: the oracle value is fresh for $ORACLE_MAX_STALE_SECONDS s."
  exit 0
fi

if [ -n "$MANIFEST_OUT" ]; then
  log "Wrote $MANIFEST (MANIFEST_OUT: no .env.local, no database migration)"
  exit 0
fi

# .env.local: set (or replace) the three keys, keep anything else already in the file. Local only; git-ignored.
ENV_FILE="$DAPP_DIR/.env.local"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
tmp="$(mktemp)"
grep -v -e '^FAUCET_ISSUER_SECRET=' -e '^NEXT_PUBLIC_PRINCIPAL_NETWORK=' -e '^DATABASE_URL=' "$ENV_FILE" >"$tmp" || true
{
  cat "$tmp"
  echo "NEXT_PUBLIC_PRINCIPAL_NETWORK=local"
  echo "FAUCET_ISSUER_SECRET=$(stellar keys secret "$ISSUER_KEY")"
  echo "DATABASE_URL=postgres://principal:principal@localhost:5432/principal"
} >"$ENV_FILE"
rm -f "$tmp"

if [ -f "$DAPP_DIR/scripts/db-migrate.mjs" ]; then
  log "Migrating the local database"
  (cd "$DAPP_DIR" && DATABASE_URL="postgres://principal:principal@localhost:5432/principal" node scripts/db-migrate.mjs) ||
    die "database migration failed. Is Postgres up? scripts/dev-stack/up.sh"
else
  log "scripts/db-migrate.mjs not present yet: skipping the database migration"
fi

log "Wrote $MANIFEST and $ENV_FILE"
log "Market $MARKET_ID matures at $MATURITY. Keep the oracle fresh: scripts/dev-stack/oracle-tick.sh (every 30 minutes)."
