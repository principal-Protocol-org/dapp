# Shared helpers for the dev-stack scripts. Sourced, not executed.
# shellcheck shell=bash disable=SC2034

# The network the scripts work on (also the Stellar CLI network name): `local` (default, the
# quickstart container) or `testnet` (PRINCIPAL_NETWORK=testnet).
NETWORK="${PRINCIPAL_NETWORK:-local}"
case "$NETWORK" in
  local)
    RPC_URL="${RPC_URL:-http://localhost:8000/rpc}"
    HORIZON_URL="${HORIZON_URL:-http://localhost:8000}"
    FRIENDBOT_URL="${FRIENDBOT_URL:-http://localhost:8000/friendbot}"
    NETWORK_PASSPHRASE="Standalone Network ; February 2017"
    ;;
  testnet)
    RPC_URL="https://soroban-testnet.stellar.org"
    HORIZON_URL="https://horizon-testnet.stellar.org"
    FRIENDBOT_URL="https://friendbot.stellar.org"
    NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    ;;
  *)
    echo "error: PRINCIPAL_NETWORK must be local or testnet, got '$NETWORK'" >&2
    exit 1
    ;;
esac
# Identity names in the Stellar CLI keystore (global, shared with any other project): names no one
# would use for a real key. Locally one dev key plays every role, so `.env.local` never receives the
# secret of a real account. On testnet the roles are split: the protocol admin and the treasury stay
# on this machine; the issuer (also SAC admin and Permissioning admin: the faucet's key) and the
# oracle admin (the keeper's key) are the only keys a server ever holds. On testnet each name can be
# overridden with ADMIN_KEY / TREASURY_KEY / ISSUER_KEY / ORACLE_KEY (deploy.sh EPHEMERAL=1 requires it).
if [ "$NETWORK" = local ]; then
  ADMIN_KEY="principal-localdev-admin"
  TREASURY_KEY="principal-localdev-treasury"
  ISSUER_KEY="$ADMIN_KEY"
  ORACLE_KEY="$ADMIN_KEY"
else
  ADMIN_KEY="${ADMIN_KEY:-principal-$NETWORK-admin}"
  TREASURY_KEY="${TREASURY_KEY:-principal-$NETWORK-treasury}"
  ISSUER_KEY="${ISSUER_KEY:-principal-$NETWORK-issuer}"
  ORACLE_KEY="${ORACLE_KEY:-principal-$NETWORK-oracle}"
fi

DEV_STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAPP_DIR="$(cd "$DEV_STACK_DIR/../.." && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. $2"
}

# The build cache of the principal sources: a private directory of your own, never a predictable path in a
# shared /tmp. Cargo runs a workspace's build scripts on the host even for a wasm target, so a cache that
# another account can write would let that account run code as you. PRINCIPAL_DEV_STACK_CACHE sets the
# place (CI does); the default is ${XDG_CACHE_HOME:-$HOME/.cache}/principal-dev-stack.
#
# dev_stack_cache_dir: creates the cache if needed and refuses it unless it is an absolute path to a
# directory you own (not a symlink) that no other account can write, and every parent of its physical path
# is owned by you or root and, if others can write it, sticky (as /tmp). Sets the cache to mode 700 and
# prints its physical path, which the callers then use, so no symlink on the way can be retargeted later.
dev_stack_cache_dir() {
  local root="${PRINCIPAL_DEV_STACK_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/principal-dev-stack}" uid dir
  case "$root" in
    /*) ;;
    *) die "the build cache must be an absolute path, got '$root'" ;;
  esac
  [ ! -L "$root" ] || die "the build cache $root is a symlink: refusing it"
  (umask 077 && mkdir -p "$root") || die "cannot create the build cache $root"
  { [ -d "$root" ] && [ ! -L "$root" ] && [ -O "$root" ]; } ||
    die "the build cache $root is not a directory you own: refusing it"
  # One that others could write may already hold their files: refused, not repaired.
  [ -n "$(find "$root" -maxdepth 0 ! -perm -0020 ! -perm -0002)" ] ||
    die "other accounts can write the build cache $root: remove it, or choose another PRINCIPAL_DEV_STACK_CACHE"
  chmod 700 "$root"
  root="$(cd -P "$root" && pwd)"
  uid="$(id -u)"
  dir="$root"
  while [ "$dir" != / ]; do
    dir="$(dirname "$dir")"
    [ -n "$(find "$dir" -maxdepth 0 \( -user 0 -o -user "$uid" \) \( -perm -1000 -o ! \( -perm -0020 -o -perm -0002 \) \))" ] ||
      die "other accounts can change $dir, a parent of the build cache: set PRINCIPAL_DEV_STACK_CACHE to a directory whose parents only you or root can change"
  done
  printf '%s\n' "$root"
}

# dev_stack_sources <commit>: prints the directory that holds the sources of <commit> in the build cache.
# They are extracted read-only with `git archive` (never a worktree, never a checkout in the principal
# repository) into a fresh directory, renamed into place once complete: the cache only ever holds whole
# commits, and a directory found there is one this function wrote. Progress goes to stderr.
dev_stack_sources() {
  local commit="$1" root dir tmp
  root="$(dev_stack_cache_dir)" || exit 1
  dir="$root/$commit"
  if [ ! -d "$dir" ]; then
    echo "==> Extracting $commit to $dir" >&2
    tmp="$(mktemp -d "$root/.extract.XXXXXX")" || die "cannot create a directory in $root"
    if ! git -C "$PRINCIPAL_REPO" archive "$commit" | tar -x -C "$tmp"; then
      rm -rf "$tmp"
      die "cannot extract $commit from $PRINCIPAL_REPO"
    fi
    if [ -d "$dir" ]; then rm -rf "$tmp"; else mv "$tmp" "$dir" || die "cannot move the sources into $dir"; fi
  fi
  printf '%s\n' "$dir"
}

# POST a JSON-RPC call to the Soroban RPC; prints the response body.
rpc_call() {
  local method="$1" params="${2:-null}"
  curl -sS --max-time 10 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" "$RPC_URL"
}

rpc_healthy() {
  rpc_call getHealth 2>/dev/null | grep -q '"status":"healthy"'
}

# Sequence of the latest ledger the RPC knows (getLatestLedger); fails on anything else.
latest_ledger() {
  rpc_call getLatestLedger 2>/dev/null | jq -er '.result.sequence | select(type == "number" and . > 0)'
}

# Close time (unix seconds) of the latest ledger, so the oracle never sees a future timestamp.
# Read from the RPC itself: Horizon can lag the RPC by a ledger.
ledger_close_time() {
  rpc_call getLatestLedger | jq -er '.result.closeTime | tonumber'
}

# ensure_funded_key <name>: create the identity if it is missing, and fund its account through
# friendbot if the account does not exist yet.
ensure_funded_key() {
  local key="$1" addr
  stellar keys address "$key" >/dev/null 2>&1 || stellar keys generate "$key" --network "$NETWORK" >/dev/null ||
    die "could not create the key $key"
  addr="$(stellar keys address "$key")"
  if ! curl -sf --max-time 15 "$HORIZON_URL/accounts/$addr" >/dev/null; then
    stellar keys fund "$key" --network "$NETWORK" >/dev/null 2>&1 || die "could not fund $key ($addr) through friendbot"
  fi
}

# stellar contract invoke on $NETWORK as $1 on contract $2; remaining args follow `--`.
invoke() {
  local source="$1" id="$2"
  shift 2
  stellar contract invoke --id "$id" --source "$source" --network "$NETWORK" -- "$@"
}
