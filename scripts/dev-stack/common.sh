# Shared helpers for the dev-stack scripts. Sourced, not executed.
# shellcheck shell=bash disable=SC2034

NETWORK="local"
RPC_URL="${RPC_URL:-http://localhost:8000/rpc}"
HORIZON_URL="${HORIZON_URL:-http://localhost:8000}"
FRIENDBOT_URL="${FRIENDBOT_URL:-http://localhost:8000/friendbot}"
NETWORK_PASSPHRASE="Standalone Network ; February 2017"
# Dev-only identity names in the Stellar CLI keystore (global, shared with any other project): a
# name no one would use for a real key, so `.env.local` never receives the secret of a real account.
ADMIN_KEY="principal-localdev-admin"
TREASURY_KEY="principal-localdev-treasury"

DEV_STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAPP_DIR="$(cd "$DEV_STACK_DIR/../.." && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. $2"
}

# POST a JSON-RPC call to the local Soroban RPC; prints the response body.
rpc_call() {
  local method="$1" params="${2:-null}"
  curl -sS --max-time 10 -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" "$RPC_URL"
}

rpc_healthy() {
  rpc_call getHealth 2>/dev/null | grep -q '"status":"healthy"'
}

# Close time (unix seconds) of the latest ledger, so the oracle never sees a future timestamp.
ledger_close_time() {
  local seq
  seq="$(rpc_call getLatestLedger | jq -er '.result.sequence')" || return 1
  curl -sS --max-time 10 "$HORIZON_URL/ledgers/$seq" |
    jq -er '.closed_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'
}

# stellar contract invoke against the local network as $1 on contract $2; remaining args follow `--`.
invoke() {
  local source="$1" id="$2"
  shift 2
  stellar contract invoke --id "$id" --source "$source" --network "$NETWORK" -- "$@"
}
