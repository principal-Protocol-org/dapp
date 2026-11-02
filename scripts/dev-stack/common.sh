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
# oracle admin (the keeper's key) are the only keys a server ever holds.
if [ "$NETWORK" = local ]; then
  ADMIN_KEY="principal-localdev-admin"
  TREASURY_KEY="principal-localdev-treasury"
  ISSUER_KEY="$ADMIN_KEY"
  ORACLE_KEY="$ADMIN_KEY"
else
  ADMIN_KEY="principal-$NETWORK-admin"
  TREASURY_KEY="principal-$NETWORK-treasury"
  ISSUER_KEY="principal-$NETWORK-issuer"
  ORACLE_KEY="principal-$NETWORK-oracle"
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

# POST a JSON-RPC call to the Soroban RPC; prints the response body.
rpc_call() {
  local method="$1" params="${2:-null}"
  curl -sS --max-time 10 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" "$RPC_URL"
}

rpc_healthy() {
  rpc_call getHealth 2>/dev/null | grep -q '"status":"healthy"'
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
