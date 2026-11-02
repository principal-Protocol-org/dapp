#!/usr/bin/env bash
# Push a fresh, higher reference value to the OracleAdapter (local, or testnet with PRINCIPAL_NETWORK=testnet,
# where the app's /api/cron/oracle schedule normally does it).
# Usage: [PRINCIPAL_NETWORK=local|testnet] scripts/dev-stack/oracle-tick.sh [--apy <percent>] [rate]
#   rate: 7-decimal integer (10000000 = 1.0); when given it wins over --apy.
#   --apy <percent>: yearly growth, default 5. New rate = current x (1 + apy/100)^(elapsed/31536000),
#   elapsed = seconds since the oracle's last reference timestamp, rounded down, never below current.
# The timestamp is the latest ledger close time (the oracle rejects future timestamps), so run it
# at least every hour (the freshness window is 3600 s); every 30 minutes is comfortable.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

need stellar "Install the Stellar CLI."
need jq "brew install jq"
need node "Install Node.js."

MANIFEST="$DAPP_DIR/config/manifests/$NETWORK.json"
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

ORACLE="$(jq -er '.shared.oracle // .markets[0].contracts.oracle' "$MANIFEST")" || die "cannot read the oracle id from $MANIFEST"
[[ "$ORACLE" =~ ^C[A-Z2-7]{55}$ ]] || die "manifest oracle id is not a contract id (is $NETWORK.json still the example file?)"
rpc_healthy || die "the $NETWORK network is not answering on $RPC_URL."
ORACLE_ADMIN="$(stellar keys address "$ORACLE_KEY")" || die "key $ORACLE_KEY is missing"

CURRENT="$(invoke "$ORACLE_KEY" "$ORACLE" get_reference_value | tr -d '"[:space:]')"
[[ "$CURRENT" =~ ^[0-9]+$ ]] || die "unexpected oracle value '$CURRENT'"
TS="$(ledger_close_time)"
if [ -n "$RATE_ARG" ]; then
  NEW="$RATE_ARG"
  [[ "$NEW" =~ ^[0-9]+$ ]] || die "rate must be a positive integer with 7 decimals (e.g. 10001000), got '$NEW'"
else
  LAST_TS="$(invoke "$ORACLE_KEY" "$ORACLE" get_reference_timestamp | tr -d '"[:space:]')"
  [[ "$LAST_TS" =~ ^[0-9]+$ ]] || die "unexpected oracle timestamp '$LAST_TS'"
  # current x (1 + apy/100)^(elapsed/year), floored; a double is exact enough for a dev rate, the result stays >= current.
  NEW="$(node -e '
    const c = BigInt(process.argv[1]); const apy = Number(process.argv[2]);
    const elapsed = Math.max(0, Number(process.argv[3]) - Number(process.argv[4]));
    const f = Math.pow(1 + apy / 100, elapsed / 31536000);
    const scaled = BigInt(Math.floor(f * 1e12));
    const n = (c * scaled) / 1000000000000n;
    console.log((n > c ? n : c).toString())' "$CURRENT" "$APY" "$TS" "$LAST_TS")"
fi
[ "$NEW" -ge "$CURRENT" ] || die "the oracle never decreases: new $NEW < current $CURRENT"

invoke "$ORACLE_KEY" "$ORACLE" set_reference_value --caller "$ORACLE_ADMIN" --value "$NEW" --timestamp "$TS" >/dev/null ||
  die "set_reference_value failed (a second tick within the same ledger second is rejected as TimestampTooOld)"
echo "oracle rate $CURRENT -> $NEW at ledger time $TS"
