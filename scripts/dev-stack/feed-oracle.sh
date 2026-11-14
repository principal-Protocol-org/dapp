#!/usr/bin/env bash
# Deploy a SEP-40 mock feed and a standalone OracleAdapter that pulls from it, on the LOCAL network
# only (spec 0004 D-22): the proof of the keeper's feed mode (ORACLE_KEEPER_MODE=feed, D-21).
#
# Usage: [PRINCIPAL_REPO=../principal] [PRINCIPAL_REF=24d980d] [FEED_DECIMALS=8] scripts/dev-stack/feed-oracle.sh
#
# 1. Builds the mock feed (tests/fixtures/sep40-mock, its Cargo.lock) and the OracleAdapter of
#    PRINCIPAL_REF (24d980d: sync_from_feed with the rejection-masking fix), both for wasm32v1-none.
#    The principal sources are extracted read-only with `git archive` into a cache keyed by the commit,
#    as deploy.sh does: never a worktree, never a checkout in the principal repository.
# 2. Deploys both as the dev stack's local admin (principal-localdev-admin), then:
#    - feed.initialize(FEED_DECIMALS): 8 by default (RedStone's scale), so a sync really rescales to 7;
#    - oracle.initialize(admin, max_stale_seconds 3600, max_deviation_bps 1000);
#    - oracle.set_feed_source(admin, feed, {"Other":"USDY"}).
# 3. Prints {"oracle": "C…", "feed": "C…"} on stdout, and nothing else (progress goes to stderr).
#
# Nothing else changes: the market, config/manifests/local.json and .env.local are untouched. Point the
# keeper at the new oracle with ORACLE_KEEPER_MODE=feed and ORACLE_KEEPER_ORACLE_ID=<oracle>. The mock's
# set_price and clear_price take no authorization: anyone may move this feed, which is why it exists on
# the local network only.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

[ "$NETWORK" = local ] || die "feed-oracle.sh runs on the local network only (its feed takes a price from anyone); PRINCIPAL_NETWORK is '$NETWORK'"
# common.sh gives the local network one throwaway key; never a principal-testnet-* name.
[ "$ADMIN_KEY" = principal-localdev-admin ] || die "unexpected local admin key name"

need stellar "Install the Stellar CLI."
need cargo "Install Rust with the wasm32v1-none target: rustup target add wasm32v1-none"
need jq "brew install jq"
need git ""

PRINCIPAL_REPO="${PRINCIPAL_REPO:-../principal}"
PRINCIPAL_REF="${PRINCIPAL_REF:-24d980d}"
FEED_DECIMALS="${FEED_DECIMALS:-8}"
FEED_ASSET='{"Other":"USDY"}'
MAX_STALE_SECONDS=3600
MAX_DEVIATION_BPS=1000
case "$FEED_DECIMALS" in '' | *[!0-9]*) die "FEED_DECIMALS must be a non-negative integer" ;; esac
[ "${#FEED_DECIMALS}" -le 2 ] || die "FEED_DECIMALS is too large"
case "$PRINCIPAL_REPO" in /*) ;; *) PRINCIPAL_REPO="$DAPP_DIR/$PRINCIPAL_REPO" ;; esac
[ -d "$PRINCIPAL_REPO" ] || die "PRINCIPAL_REPO '$PRINCIPAL_REPO' does not exist"

log() { echo "==> $*" >&2; }

rpc_healthy || die "the local network is not answering on $RPC_URL. Run scripts/dev-stack/up.sh first."
# The RPC must be the quickstart's own network, whatever RPC_URL says.
PASSPHRASE="$(rpc_call getNetwork | jq -er '.result.passphrase')" || die "the RPC on $RPC_URL did not name its network"
[ "$PASSPHRASE" = "$NETWORK_PASSPHRASE" ] || die "the RPC on $RPC_URL is not the local network (passphrase '$PASSPHRASE')"
stellar keys address "$ADMIN_KEY" >/dev/null 2>&1 || die "key $ADMIN_KEY is missing. Run scripts/dev-stack/up.sh first."
ADMIN="$(stellar keys address "$ADMIN_KEY")"

# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------
log "Rust: $(rustc --version)"
MOCK_DIR="$DAPP_DIR/tests/fixtures/sep40-mock"
log "Building the SEP-40 mock feed (cargo build --release --target wasm32v1-none --locked)"
(cd "$MOCK_DIR" && cargo build --release --target wasm32v1-none --locked >&2) ||
  die "cargo build of the mock feed failed. Is the target installed? rustup target add wasm32v1-none"
FEED_WASM="$MOCK_DIR/target/wasm32v1-none/release/sep40_mock.wasm"

COMMIT="$(git -C "$PRINCIPAL_REPO" rev-parse --verify "${PRINCIPAL_REF}^{commit}")" ||
  die "cannot resolve PRINCIPAL_REF '$PRINCIPAL_REF' in $PRINCIPAL_REPO"
SRC_DIR="${TMPDIR:-/tmp}/principal-dev-stack/${COMMIT}"
ORACLE_WASM="$SRC_DIR/target/wasm32v1-none/release/principal_oracle_adapter.wasm"
if [ ! -f "$ORACLE_WASM" ]; then
  if [ ! -f "$SRC_DIR/Cargo.toml" ]; then
    log "Extracting $PRINCIPAL_REF ($COMMIT) to $SRC_DIR"
    rm -rf "$SRC_DIR"
    mkdir -p "$SRC_DIR"
    git -C "$PRINCIPAL_REPO" archive "$COMMIT" | tar -x -C "$SRC_DIR"
  fi
  # The whole workspace, as deploy.sh builds it: the same wasm, byte for byte, as a full deploy of this commit.
  log "Building the contracts of $COMMIT (cargo build --workspace --release --target wasm32v1-none)"
  (cd "$SRC_DIR" && cargo build --workspace --release --target wasm32v1-none >&2) ||
    die "cargo build failed. Is the target installed? rustup target add wasm32v1-none"
else
  log "Reusing the OracleAdapter built for $COMMIT"
fi

# ---------------------------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------------------------
# deploy_wasm <file>: uploads and deploys it as the local admin; prints the contract id.
deploy_wasm() {
  local file="$1" hash id
  [ -f "$file" ] || die "missing build artifact $file"
  hash="$(stellar contract upload --wasm "$file" --source "$ADMIN_KEY" --network "$NETWORK" 2>/dev/null | tail -n1)"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "uploading $(basename "$file") returned an unexpected hash: '$hash'"
  log "  $(basename "$file"): wasm hash $hash"
  id="$(stellar contract deploy --wasm-hash "$hash" --source "$ADMIN_KEY" --network "$NETWORK" 2>/dev/null | tail -n1)"
  [[ "$id" =~ ^C[A-Z2-7]{55}$ ]] || die "deploying $(basename "$file") returned an unexpected contract id: '$id'"
  echo "$id"
}
adm() { invoke "$ADMIN_KEY" "$@" >/dev/null 2>&1; } # adm <contract id> <fn> [args...]

log "Deploying the mock feed"
FEED="$(deploy_wasm "$FEED_WASM")"
adm "$FEED" initialize --decimals "$FEED_DECIMALS" || die "the mock feed's initialize failed"
log "  feed $FEED, $FEED_DECIMALS decimals"

log "Deploying a standalone OracleAdapter ($PRINCIPAL_REF)"
ORACLE="$(deploy_wasm "$ORACLE_WASM")"
adm "$ORACLE" initialize --admin "$ADMIN" --max_stale_seconds "$MAX_STALE_SECONDS" --max_deviation_bps "$MAX_DEVIATION_BPS" ||
  die "the oracle's initialize failed"
adm "$ORACLE" set_feed_source --caller "$ADMIN" --feed "$FEED" --asset "$FEED_ASSET" || die "set_feed_source failed"
SOURCE="$(invoke "$ADMIN_KEY" "$ORACLE" feed_source 2>/dev/null)" || die "feed_source could not be read"
log "  oracle $ORACLE: max_stale $MAX_STALE_SECONDS s, deviation cap $MAX_DEVIATION_BPS bps, feed_source $SOURCE"

jq -cn --arg oracle "$ORACLE" --arg feed "$FEED" '{oracle: $oracle, feed: $feed}'
