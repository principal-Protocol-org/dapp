#!/usr/bin/env bash
# Push a fresh, higher reference value to every OracleAdapter of the manifest (local, or testnet with
# PRINCIPAL_NETWORK=testnet, where the app's /api/cron/oracle schedule normally does it): each distinct
# .markets[].contracts.oracle, in manifest order. The local stack has two, one per market.
# Usage: [PRINCIPAL_NETWORK=local|testnet] [ORACLE_TICK_ORACLE=<contract id>] scripts/dev-stack/oracle-tick.sh [--apy <percent>] [rate]
#   rate: 7-decimal integer (10000000 = 1.0); when given it wins over --apy. A rate is one oracle's value:
#   with several oracles, name the one with ORACLE_TICK_ORACLE.
#   --apy <percent>: yearly growth, default 5. New rate = current x (1 + apy/100)^(elapsed/31536000),
#   elapsed = seconds since that oracle's last reference timestamp, rounded down, never below current.
#   ORACLE_TICK_ORACLE=<contract id>: tick that oracle only; the manifest must name it.
# Each oracle is read on its own: its current value, its last timestamp and its primary source.
# The timestamp is the latest ledger close time (the oracle rejects future timestamps), so run it
# at least every hour (the freshness window, max_stale_seconds, is 3600 s); every 30 minutes is comfortable.
# With one oracle it prints one line, "oracle rate <old> -> <new> at ledger time <t>"; with several, one
# line per oracle, "oracle <id> rate ...". The first failure stops the run.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

need stellar "Install the Stellar CLI."
need jq "brew install jq"
need node "Install Node.js."

MANIFEST="$DAPP_DIR/config/manifests/$NETWORK.json"
# ORACLE_TICK_MANIFEST: another local deployment's manifest (one written with deploy.sh's MANIFEST_OUT);
# drill.sh passes it on with DRILL_MANIFEST. Local only: on testnet the tick follows testnet.json.
if [ -n "${ORACLE_TICK_MANIFEST:-}" ]; then
  [ "$NETWORK" = local ] || die "ORACLE_TICK_MANIFEST is for the local network only"
  MANIFEST="$ORACLE_TICK_MANIFEST"
fi
[ -f "$MANIFEST" ] || die "$MANIFEST not found. Run scripts/dev-stack/deploy.sh first."
APY="5"
RATE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apy) [ $# -ge 2 ] || die "--apy needs a percent value"; APY="$2"; shift 2 ;;
    --apy=*) APY="${1#--apy=}"; shift ;;
    -*) die "unknown option '$1'" ;;
    *) [ -z "$RATE_ARG" ] || die "only one rate argument is accepted"; RATE_ARG="$1"; shift ;;
  esac
done
[[ "$APY" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--apy must be a non-negative number (percent), got '$APY'"
[ -z "$RATE_ARG" ] || [[ "$RATE_ARG" =~ ^[0-9]+$ ]] || die "rate must be a positive integer with 7 decimals (e.g. 10001000), got '$RATE_ARG'"

# The oracles: each distinct market oracle in manifest order (shared.oracle when no market is listed),
# one id per line.
ORACLES="$(jq -r '([.markets[]?.contracts.oracle] | reduce .[] as $o ([]; if any(.[]; . == $o) then . else . + [$o] end)) as $list |
  (if ($list | length) > 0 then $list else [.shared.oracle // empty] end) | .[]' "$MANIFEST")" ||
  die "cannot read the oracle ids from $MANIFEST"
[ -n "$ORACLES" ] || die "$MANIFEST names no oracle"
while IFS= read -r id; do
  [[ "$id" =~ ^C[A-Z2-7]{55}$ ]] || die "manifest oracle id is not a contract id (is $NETWORK.json still the example file?)"
done <<<"$ORACLES"
if [ -n "${ORACLE_TICK_ORACLE:-}" ]; then
  grep -qxF -- "$ORACLE_TICK_ORACLE" <<<"$ORACLES" ||
    die "ORACLE_TICK_ORACLE $ORACLE_TICK_ORACLE is not an oracle of $MANIFEST (it names $(tr '\n' ' ' <<<"$ORACLES" | sed 's/ $//'))"
  ORACLES="$ORACLE_TICK_ORACLE"
fi
COUNT="$(grep -c . <<<"$ORACLES")"
# Checked before anything is read or signed: a rate meant for one oracle would push a value that is
# lower than (never allowed), or far from (refused as deviate), another oracle's.
[ -z "$RATE_ARG" ] || [ "$COUNT" -eq 1 ] || die "a rate is one oracle's value, and $MANIFEST names $COUNT oracles: set ORACLE_TICK_ORACLE=<contract id> to pick one, or leave the rate out (each grows by --apy)"

rpc_healthy || die "the $NETWORK network is not answering on $RPC_URL."
ORACLE_ADMIN="$(stellar keys address "$ORACLE_KEY")" || die "key $ORACLE_KEY is missing"

# view <oracle id> <fn> [args...]: reads are simulations only (--send=no): they never sign or send,
# whatever the CLI's default would do.
view() {
  local id="$1"
  shift
  stellar contract invoke --id "$id" --source "$ORACLE_KEY" --network "$NETWORK" --send=no -- "$@"
}

# tick <oracle id>: one push to that oracle, from its own current value and under its own primary source.
# With several oracles, its line and its errors name it.
tick() {
  local id="$1" label="oracle" at="" current ts new last_ts primary result
  if [ "$COUNT" -gt 1 ]; then
    label="oracle $id"
    at="$id: "
  fi
  current="$(view "$id" get_reference_value | tr -d '"[:space:]')"
  [[ "$current" =~ ^[0-9]+$ ]] || die "${at}unexpected oracle value '$current'"
  ts="$(ledger_close_time)"
  if [ -n "$RATE_ARG" ]; then
    new="$RATE_ARG"
  else
    last_ts="$(view "$id" get_reference_timestamp | tr -d '"[:space:]')"
    [[ "$last_ts" =~ ^[0-9]+$ ]] || die "${at}unexpected oracle timestamp '$last_ts'"
    # current x (1 + apy/100)^(elapsed/year), floored; a double is exact enough for a dev rate, the result stays >= current.
    new="$(node -e '
      const c = BigInt(process.argv[1]); const apy = Number(process.argv[2]);
      const elapsed = Math.max(0, Number(process.argv[3]) - Number(process.argv[4]));
      const f = Math.pow(1 + apy / 100, elapsed / 31536000);
      const scaled = BigInt(Math.floor(f * 1e12));
      const n = (c * scaled) / 1000000000000n;
      console.log((n > c ? n : c).toString())' "$current" "$APY" "$ts" "$last_ts")"
  fi
  [ "$new" -ge "$current" ] || die "${at}the oracle never decreases: new $new < current $current"

  # v2 (R4-8): the source id is the oracle's primary source; Option<BytesN<32>> prints as a JSON hex string.
  primary="$(view "$id" get_primary_source | tr -d '"[:space:]')"
  [[ "$primary" =~ ^[0-9a-f]{64}$ ]] || die "${at}the oracle has no primary source (not initialized with set_sources, or a v1 oracle)"
  result="$(invoke "$ORACLE_KEY" "$id" set_reference_value --caller "$ORACLE_ADMIN" --source "$primary" --value "$new" --timestamp "$ts" | tr -d '"[:space:]')" ||
    die "${at}set_reference_value failed (the transaction reverted)"
  # A rejection is a successful transaction that returns false (a second tick within the same ledger second returns false with reason stale_ts).
  [ "$result" = "true" ] || die "${at}the oracle rejected the value (returned '$result'): $(view "$id" last_rejection)"
  echo "$label rate $current -> $new at ledger time $ts"
}

# Read from fd 3: the CLI calls inside keep the caller's stdin.
while IFS= read -r id <&3; do
  tick "$id"
done 3<<<"$ORACLES"
