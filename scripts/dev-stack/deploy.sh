#!/usr/bin/env bash
# Build the Principal contracts and deploy one market on the local network, or on testnet with
# PRINCIPAL_NETWORK=testnet. Follows principal docs/DEPLOYMENT.md steps 1-11, then seeds the pool and
# writes config/manifests/<network>.json. Locally it also writes .env.local and migrates the local
# database; on testnet it writes no env file and prints which keys to give the server.
# Locally it then adds a second market on its own asset (ASSET_CODE_2) and its own OracleAdapter, on the
# same Permissioning, RiskControl and Router, so the app's multi-oracle paths can be tried without Mainnet.
#
# Usage: [PRINCIPAL_NETWORK=local|testnet] [PRINCIPAL_REPO=../principal] \
#        [PRINCIPAL_REF=3af938853e5818aa8d56bd35670b9a19cfa55a78] [MATURITY_SECONDS=86400 locally, 7776000 on testnet] \
#        [ASSET_CODE=USDY] [ASSET_CODE_2=GILT] [SECOND_MARKET=1] scripts/dev-stack/deploy.sh
# SECOND_MARKET=0 deploys one market locally too. On testnet there is always one market (both are ignored).
# PRINCIPAL_REF defaults to the Mainnet deployment's commit (config/manifests/mainnet.json sourceCommit).
# PRINCIPAL_REF=665bb6760372d30307a1a035da24e51776f727e8 deploys the official Testnet market's contracts,
# the older interface. The manifest's protocolAbi (1 or 2) is read from the Router that was built.
# Options: MANIFEST_OUT=<path> writes the manifest there instead of config/manifests/<network>.json and
#          writes no .env file. ORACLE_MAX_STALE_SECONDS=<n> sets the oracle freshness window (default 3600).
#          The window must outlast the deploy itself (genesis value at step 1, seeding mints 5 to 10 minutes
#          later on Testnet); to test a stale oracle, shorten it afterwards with set_safety_params.
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
PRINCIPAL_REF="${PRINCIPAL_REF:-3af938853e5818aa8d56bd35670b9a19cfa55a78}"
if [ "$NETWORK" = local ]; then MATURITY_SECONDS="${MATURITY_SECONDS:-86400}"; else MATURITY_SECONDS="${MATURITY_SECONDS:-7776000}"; fi
ASSET_CODE="${ASSET_CODE:-USDY}"
[[ "$ASSET_CODE" =~ ^[A-Za-z0-9]{1,12}$ ]] || die "ASSET_CODE must be 1-12 letters or digits"
ASSET_DISPLAY="$ASSET_CODE (test)"
# The second market (local only): its own asset, checked like the first, and a market id of its own.
SECOND_MARKET="${SECOND_MARKET:-1}"
if [ "$NETWORK" = local ] && [ "$SECOND_MARKET" != 0 ]; then
  [ "$SECOND_MARKET" = 1 ] || die "SECOND_MARKET must be 0 (one market) or 1 (the default: a second market, local only)"
  ASSET_CODE_2="${ASSET_CODE_2:-GILT}"
  [[ "$ASSET_CODE_2" =~ ^[A-Za-z0-9]{1,12}$ ]] || die "ASSET_CODE_2 must be 1-12 letters or digits"
  [ "$(tr '[:upper:]' '[:lower:]' <<<"$ASSET_CODE_2")" != "$(tr '[:upper:]' '[:lower:]' <<<"$ASSET_CODE")" ] ||
    die "ASSET_CODE_2 must differ from ASSET_CODE (in lower case too: the market id is built from it)"
  ASSET_DISPLAY_2="$ASSET_CODE_2 (test)"
fi
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

# The Router's interface, read from the wasm just built with one CLI call and one jq program: the user
# flows it exposes (the `quote_*` views are reads, not flows, so they are left out) and its interface
# version, the manifest's protocolAbi: 2 when wrap_and_mint takes `sy_in` (principal 3af9388, Mainnet),
# 1 when it does not (665bb67, the official Testnet market), 0 when the Router has no wrap_and_mint at all
# (not a version this script knows: it stops). Read before any transaction, so a Router that cannot be
# read signs nothing; step 9 (RecoveryEscrow) depends on the version.
ROUTER_INTERFACE="$(stellar contract info interface --wasm "$WASM_DIR/principal_router.wasm" --output json 2>/dev/null |
  jq -r '[.[] | select(has("function_v0")) | .function_v0] |
    ([.[].name | select(startswith("quote_") | not)] - ["bump","initialize","register_market","unregister_market","is_registered","market","get_admin","transfer_admin"]) as $fns |
    (if any(.[]; .name == "wrap_and_mint" and any(.inputs[]?; .name == "sy_in")) then 2
     elif any(.[]; .name == "wrap_and_mint") then 1 else 0 end) as $abi |
    "\($abi) \($fns | tojson)"')" ||
  die "could not read the router interface"
PROTOCOL_ABI="${ROUTER_INTERFACE%% *}"
ROUTER_FUNCTIONS="${ROUTER_INTERFACE#* }"
[ "$PROTOCOL_ABI" != 0 ] || die "the Router at $PRINCIPAL_REF has no wrap_and_mint: its interface version (protocolAbi 1 or 2) cannot be told. Deploy a Principal commit whose Router has it (the default, or 665bb67)"
[[ "$PROTOCOL_ABI" =~ ^[12]$ ]] || die "could not tell the router's interface version from its interface"
[ "$(jq 'length' <<<"$ROUTER_FUNCTIONS")" -gt 0 ] || die "router interface listed no user functions"
log "Router interface version $PROTOCOL_ABI (the manifest's protocolAbi)"

# The manifest's deployLedger, where the event indexer starts: the latest ledger before this deploy's
# first transaction (set-options, the SAC, every upload and contract), so no event of it comes before.
# Written on every network; the schema requires it off the local one.
DEPLOY_LEDGER="$(latest_ledger)" || die "could not read the latest ledger from $RPC_URL"
[[ "$DEPLOY_LEDGER" =~ ^[1-9][0-9]{0,9}$ ]] || die "the RPC answered an unexpected latest ledger: '$DEPLOY_LEDGER'"
log "Deploy ledger: $DEPLOY_LEDGER"

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

# Each market is the same few steps, so they are functions, called once per market: issue_asset,
# deploy_oracle, deploy_market, grant_standing, seed_pool and record_market. They take the asset code
# (and the oracle's genesis value) as arguments and work on plain variables, one market at a time: SAC
# and ORACLE, then SY, PT, YT, CONFIG, MANAGER, POOL and ESCROW. The first market sets them at the top
# level; deploy_second_market declares them local, so the first market's are untouched once it returns.
DEPOSIT=2000000000000 # 200_000 of the underlying at 7 decimals: the admin's seeding deposit, each market
MARKETS_JSON="[]"     # the manifest's markets, appended by record_market

# ---------------------------------------------------------------------------------------------
# Underlying: a classic asset ($ASSET_CODE, USDY; locally also $ASSET_CODE_2, GILT) issued by the issuer
# key (AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED) and its Stellar Asset Contract. Every
# Principal contract requires its admin to be the SAC admin (compliance::is_authority), so the SAC
# admin is the protocol admin. The issuer keeps its classic powers (trustline flags, payments) and is
# the Permissioning admin: that is all the faucet needs. Locally one dev key is all of these.
# ---------------------------------------------------------------------------------------------
# issue_asset <code>: sets SAC.
issue_asset() {
  local code="$1" asset="$1:$ISSUER" sac_admin
  log "Issuing $code with AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED"
  # The flags are the issuer account's: a second asset finds them set (the call changes nothing then).
  stellar tx new set-options --source "$ISSUER_KEY" --network "$NETWORK" \
    --set-required --set-revocable --set-clawback-enabled >/dev/null 2>&1 ||
    die "could not set the issuer flags on $ISSUER_KEY"
  SAC="$(stellar contract id asset --asset "$asset" --network "$NETWORK")"
  if ! stellar contract asset deploy --asset "$asset" --source "$ISSUER_KEY" --network "$NETWORK" >/dev/null 2>&1; then
    # Already deployed by an earlier run: fine as long as the contract answers.
    invoke "$ISSUER_KEY" "$SAC" admin >/dev/null 2>&1 || die "could not deploy the $code Stellar Asset Contract"
  fi
  sac_admin="$(invoke "$ISSUER_KEY" "$SAC" admin | scalar)"
  if [ "$sac_admin" != "$ADMIN" ]; then
    [ "$sac_admin" = "$ISSUER" ] || die "the $code SAC admin is $sac_admin, neither the issuer nor the admin key"
    log "Handing the SAC admin to the protocol admin"
    iss "$SAC" set_admin --new_admin "$ADMIN"
  fi
  log "$code SAC ${SAC:0:6}..."

  # The treasury receives fee shares, so it holds the underlying: open a trustline (issuer authorizes below).
  stellar tx new change-trust --source "$TREASURY_KEY" --line "$asset" --network "$NETWORK" >/dev/null 2>&1 ||
    die "could not open the $code trustline for $TREASURY_KEY"
  # The admin seeds the pool below. When it is not the issuer it needs a trustline, its authorization
  # and the seeding amount, both from the SAC, whose admin it now is.
  if [ "$ADMIN" != "$ISSUER" ]; then
    stellar tx new change-trust --source "$ADMIN_KEY" --line "$asset" --network "$NETWORK" >/dev/null 2>&1 ||
      die "could not open the $code trustline for $ADMIN_KEY"
    adm "$SAC" set_authorized --id "$ADMIN" --authorize true
    adm "$SAC" mint --to "$ADMIN" --amount "$DEPOSIT"
  fi
}
issue_asset "$ASSET_CODE"

# Maturity is fixed at initialization for PT, YT, MarketConfig and PrincipalManager. The local second
# market has the same one.
NOW="$(ledger_close_time)"
MATURITY=$((NOW + MATURITY_SECONDS))
log "Maturity $MATURITY (ledger time $NOW + ${MATURITY_SECONDS}s)"

# ---------------------------------------------------------------------------------------------
# DEPLOYMENT.md steps 1-10
# ---------------------------------------------------------------------------------------------
# deploy_oracle <asset code> <genesis value>: step 1, the OracleAdapter of that asset's market. Sets ORACLE.
deploy_oracle() {
  local code="$1" genesis="$2" oracle_source accepted
  log "1. OracleAdapter ($code)"
  deploy_contract oracle principal_oracle_adapter.wasm
  ORACLE="$LAST_ID"
  # The oracle admin is its own key on testnet: it can only push a value (the keeper's job).
  # v2 (R4-9): freshness window ORACLE_MAX_STALE_SECONDS (default 1 h), 10 % deviation bound, one primary source, no fallback.
  # Signed by the oracle admin: at 3af9388 initialize requires the admin's authorization (665bb67 requires none).
  invoke "$ORACLE_KEY" "$ORACLE" initialize --admin "$ORACLE_ADMIN" --max_stale_seconds "$ORACLE_MAX_STALE_SECONDS" --max_deviation_bps 1000 >/dev/null ||
    die "oracle initialize failed"
  # Each oracle's own source id: the asset code is part of the preimage.
  oracle_source="$(printf '%s' "principal-oracle-source:${NETWORK}:${code}:app-team:keeper" | shasum -a 256 | cut -d' ' -f1)"
  [[ "$oracle_source" =~ ^[0-9a-f]{64}$ ]] || die "could not derive the oracle source id"
  invoke "$ORACLE_KEY" "$ORACLE" set_sources --caller "$ORACLE_ADMIN" --primary_source "$oracle_source" >/dev/null ||
    die "oracle set_sources failed"
  # The genesis value (7 decimals: 10000000 is 1.0). YTToken.initialize needs an available value; the timestamp is ledger time.
  accepted="$(invoke "$ORACLE_KEY" "$ORACLE" set_reference_value --caller "$ORACLE_ADMIN" --source "$oracle_source" --value "$genesis" --timestamp "$(ledger_close_time)" | tr -d '"[:space:]')"
  [ "$accepted" = "true" ] || die "the oracle rejected the genesis value (returned '$accepted'): $(invoke "$ORACLE_KEY" "$ORACLE" last_rejection)"
}
deploy_oracle "$ASSET_CODE" 10000000

log "2. Permissioning"
deploy_contract permissioning principal_permissioning.wasm
PERMISSIONING="$LAST_ID"
# Signed by its admin, the issuer: at 3af9388 initialize requires the admin's authorization (665bb67 requires none).
iss "$PERMISSIONING" initialize --admin "$ISSUER"

log "3. RiskControl (circuit breaker disabled)"
deploy_contract riskControl principal_risk_control.wasm
RISK_CONTROL="$LAST_ID"
adm "$RISK_CONTROL" initialize --admin "$ADMIN" --cb_limit 0

# deploy_market <asset code>: steps 4-9, the market's own contracts on the underlying SAC, its oracle
# ORACLE and MATURITY, wired to the shared Permissioning and RiskControl. Sets SY, PT, YT, CONFIG,
# MANAGER, POOL and ESCROW.
deploy_market() {
  local code="$1" token c
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
    --maturity "$MATURITY" --name "Principal Token $code" --symbol "PT-$code" --decimals 7
  deploy_contract yt principal_yt_token.wasm
  YT="$LAST_ID"
  adm "$YT" initialize --admin "$ADMIN" --permissioning "$PERMISSIONING" --underlying "$SAC" \
    --oracle "$ORACLE" --maturity "$MATURITY" --name "Yield Token $code" --symbol "YT-$code" --decimals 7

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
  # At 3af9388 (protocolAbi 2) initialize takes a first argument, caller, who signs and must be the underlying's
  # authority: the SAC admin, which is $ADMIN since issue_asset's set_admin. 665bb67 has no such parameter.
  if [ "$PROTOCOL_ABI" = 2 ]; then
    adm "$ESCROW" initialize --caller "$ADMIN" --underlying "$SAC" --sy_wrapper "$SY" --pt_token "$PT" --yt_token "$YT" \
      --principal_manager "$MANAGER" --market_pool "$POOL"
  else
    adm "$ESCROW" initialize --underlying "$SAC" --sy_wrapper "$SY" --pt_token "$PT" --yt_token "$YT" \
      --principal_manager "$MANAGER" --market_pool "$POOL"
  fi
  for c in "$SY" "$PT" "$YT" "$POOL"; do
    adm "$c" set_recovery_escrow --admin "$ADMIN" --escrow "$ESCROW"
  done
}
deploy_market "$ASSET_CODE"

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

# ---------------------------------------------------------------------------------------------
# Step 11: compliance standing. Both layers: SAC authorization and Permissioning grants.
# The Router holds nothing and gets none. The admin key trades too (seeding), so it gets grants as well;
# its SAC authorization was set above (an issuer needs none). The SAC admin authorizes, the
# Permissioning admin (the issuer) grants.
# ---------------------------------------------------------------------------------------------
# grant_standing: step 11 for the market of SAC, SY, PT, YT, MANAGER, POOL and ESCROW. Granting an account
# twice (the treasury and the admin, once per market) is a plain storage write: no error.
grant_standing() {
  local holder asset
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
}
grant_standing

# ---------------------------------------------------------------------------------------------
# Seed the pool from the dev admin key.
#   deposit 200_000 underlying -> 200_000 SY (first deposit is 1:1)
#   mint with 100_000 SY -> notional PT = YT = (SY - 5 bps fee) * oracle rate / 1e7
#   add_liquidity(all PT, 95 % of its SY value)
# First add_liquidity rule (market_pool add_liquidity): sy * rate / 1e7 must not exceed pt
# (InvalidInitialRatio) and isqrt(pt * sy) must exceed MINIMUM_LIQUIDITY = 1000. With
# sy = 0.95 * pt * 1e7 / rate the first holds with 5 % headroom (pool prices PT at a 5 % discount),
# and isqrt(~0.97e12) is far above 1000. 100_000 SY are left over for the sy side (needs ~95_000).
# At any oracle rate: the local second market's (1.4) mints ~140_000 PT and pools ~95_000 SY the same way.
# ---------------------------------------------------------------------------------------------
# seed_pool: seeds POOL through SY and MANAGER at the rate of ORACLE (no Router call).
seed_pool() {
  local mint_sy=1000000000000 mint_out pt_minted rate sy_for_pool # mint_sy: 100_000 SY
  log "Seeding the pool"
  adm "$SY" deposit --from "$ADMIN" --amount "$DEPOSIT" --min_shares_out 0
  mint_out="$(invoke "$ADMIN_KEY" "$MANAGER" mint --from "$ADMIN" --sy_shares "$mint_sy")"
  pt_minted="$(echo "$mint_out" | jq -er '.pt_minted' | scalar)"
  rate="$(invoke "$ADMIN_KEY" "$ORACLE" get_reference_value | scalar)"
  sy_for_pool="$(node -e 'const [pt,rate]=process.argv.slice(1).map(BigInt); console.log((pt*10000000n/rate*95n/100n).toString())' "$pt_minted" "$rate")"
  log "pt=$pt_minted sy=$sy_for_pool rate=$rate"
  adm "$POOL" add_liquidity --from "$ADMIN" --pt_desired "$pt_minted" --sy_desired "$sy_for_pool" --min_lp_out 0
}
seed_pool

# record_market <asset code> <display name>: appends the market to MARKETS_JSON (the manifest's
# markets, in deploy order) and sets MARKET_ID, by the one rule <network>-<code in lower case>-<maturity>.
record_market() {
  MARKET_ID="$NETWORK-$(tr "[:upper:]" "[:lower:]" <<<"$1")-$MATURITY"
  MARKETS_JSON="$(jq -c \
    --arg id "$MARKET_ID" --arg display "$2" --arg code "$1" --arg issuer "$ISSUER" --arg sac "$SAC" \
    --argjson maturity "$MATURITY" --arg router "$ROUTER" --arg oracle "$ORACLE" --arg sy "$SY" --arg pt "$PT" --arg yt "$YT" \
    --arg config "$CONFIG" --arg manager "$MANAGER" --arg pool "$POOL" --arg escrow "$ESCROW" '. + [{
      marketId: $id, displayName: $display,
      underlying: { code: $code, issuer: $issuer, sac: $sac, decimals: 7 },
      maturity: $maturity,
      contracts: { router: $router, oracle: $oracle, sy: $sy, pt: $pt, yt: $yt, config: $config,
                   manager: $manager, pool: $pool, recoveryEscrow: $escrow }
    }]' <<<"$MARKETS_JSON")" || die "could not record the market $MARKET_ID"
}
record_market "$ASSET_CODE" "$ASSET_DISPLAY"

# ---------------------------------------------------------------------------------------------
# The local stack's second market: its own asset ($ASSET_CODE_2) and its own OracleAdapter (genesis 1.4,
# source principal-oracle-source:local:<code>:app-team:keeper), then its own market contracts on the
# shared Permissioning and RiskControl, registered with the same Router, granted and seeded like the
# first. Its variables are local to the function: bash scope is dynamic, so the functions it calls set
# these locals, and once it returns SAC, ORACLE, SY ... and MARKET_ID are the first market's again (the
# manifest's testAsset and shared.oracle, the logs below). MATURITY is shared: both mature together.
# ---------------------------------------------------------------------------------------------
deploy_second_market() {
  local SAC ORACLE SY PT YT CONFIG MANAGER POOL ESCROW MARKET_ID
  log "Second market: $ASSET_CODE_2 on its own oracle (local only; SECOND_MARKET=0 skips it)"
  issue_asset "$ASSET_CODE_2"
  deploy_oracle "$ASSET_CODE_2" 14000000
  deploy_market "$ASSET_CODE_2"
  log "10. Router: register_market ($ASSET_CODE_2)"
  adm "$ROUTER" register_market --caller "$ADMIN" --pool "$POOL"
  grant_standing
  seed_pool
  record_market "$ASSET_CODE_2" "$ASSET_DISPLAY_2"
  log "Second market $MARKET_ID (oracle ${ORACLE:0:6}...)"
}
if [ "$NETWORK" = local ] && [ "$SECOND_MARKET" != 0 ]; then
  deploy_second_market
fi

# ---------------------------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------------------------
if [ -n "$MANIFEST_OUT" ]; then
  check_manifest_out # again, right before the write: the path may have changed during the deploy
  MANIFEST="$MANIFEST_OUT"
else
  MANIFEST="$DAPP_DIR/config/manifests/$NETWORK.json"
  mkdir -p "$(dirname "$MANIFEST")"
fi
# Write to a sibling temp file, then rename: a symlink or hard link at $MANIFEST is replaced, never followed.
MANIFEST_TMP="$(mktemp "$(dirname "$MANIFEST")/.manifest.XXXXXX")"

# The markets as record_market wrote them (one, or two locally); testAsset and shared.oracle are the
# first market's: SAC and ORACLE here are its variables.
jq -n \
  --arg passphrase "$NETWORK_PASSPHRASE" --arg rpc "$RPC_URL" --arg horizon "$HORIZON_URL" \
  --arg friendbot "$FRIENDBOT_URL" --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$COMMIT" --argjson deployLedger "$DEPLOY_LEDGER" --arg risk "$RISK_CONTROL" --arg perm "$PERMISSIONING" --arg factory "$FACTORY" \
  --arg issuer "$ISSUER" --arg sac "$SAC" --arg network "$NETWORK" \
  --arg code "$ASSET_CODE" --arg display "$ASSET_DISPLAY" --argjson fns "$ROUTER_FUNCTIONS" --argjson protocolAbi "$PROTOCOL_ABI" \
  --arg router "$ROUTER" --arg oracle "$ORACLE" \
  --argjson hashes "$HASHES_JSON" --argjson markets "$MARKETS_JSON" '{
    schemaVersion: 2, network: $network, networkPassphrase: $passphrase,
    rpcUrl: $rpc, horizonUrl: $horizon, friendbotUrl: $friendbot,
    generatedAt: $generatedAt, sourceCommit: $commit, deployLedger: $deployLedger,
    shared: { router: $router, oracle: $oracle, permissioning: $perm, riskControl: $risk, factory: $factory },
    wasmHashes: $hashes,
    routerFunctions: $fns,
    protocolAbi: $protocolAbi,
    testAsset: { code: $code, issuer: $issuer, sac: $sac, decimals: 7, displayName: $display },
    markets: $markets
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
log "Market $MARKET_ID matures at $MATURITY."
[ "$(jq 'length' <<<"$MARKETS_JSON")" -lt 2 ] || log "Second market $(jq -r '.[1].marketId' <<<"$MARKETS_JSON") ($ASSET_CODE_2, its own oracle) matures at $MATURITY too."
log "Keep every oracle fresh: scripts/dev-stack/oracle-tick.sh ticks each oracle of the manifest (every 30 minutes)."
