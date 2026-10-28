#!/usr/bin/env bash
# Push a fresh, slightly higher reference value to the local market's OracleAdapter.
# Usage: scripts/dev-stack/oracle-tick.sh [rate]
#   rate: 7-decimal integer (10000000 = 1.0). Default: the current rate + 0.01 %.
# The timestamp is the latest ledger close time (the oracle rejects future timestamps), so run it
# at least every hour (the freshness window is 3600 s); every 30 minutes is comfortable.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

need stellar "Install the Stellar CLI."
need jq "brew install jq"
need node "Install Node.js."

MANIFEST="$DAPP_DIR/config/manifests/local.json"
[ -f "$MANIFEST" ] || die "$MANIFEST not found. Run scripts/dev-stack/deploy.sh first."
ORACLE="$(jq -er '.markets[0].contracts.oracle' "$MANIFEST")" || die "cannot read the oracle id from $MANIFEST"
[[ "$ORACLE" =~ ^C[A-Z2-7]{55}$ ]] || die "manifest oracle id is not a contract id (is local.json still the example file?)"
rpc_healthy || die "the local network is not answering on $RPC_URL. Run scripts/dev-stack/up.sh."
ADMIN="$(stellar keys address "$ADMIN_KEY")" || die "key $ADMIN_KEY is missing"

CURRENT="$(invoke "$ADMIN_KEY" "$ORACLE" get_reference_value | tr -d '"[:space:]')"
[[ "$CURRENT" =~ ^[0-9]+$ ]] || die "unexpected oracle value '$CURRENT'"
if [ $# -ge 1 ]; then
  NEW="$1"
  [[ "$NEW" =~ ^[0-9]+$ ]] || die "rate must be a positive integer with 7 decimals (e.g. 10001000), got '$NEW'"
else
  NEW="$(node -e 'const c=BigInt(process.argv[1]); const d=c/10000n; console.log((c+(d>0n?d:1n)).toString())' "$CURRENT")"
fi
[ "$NEW" -ge "$CURRENT" ] || die "the oracle never decreases: new $NEW < current $CURRENT"

TS="$(ledger_close_time)"
invoke "$ADMIN_KEY" "$ORACLE" set_reference_value --caller "$ADMIN" --value "$NEW" --timestamp "$TS" >/dev/null ||
  die "set_reference_value failed (a second tick within the same ledger second is rejected as TimestampTooOld)"
echo "oracle rate $CURRENT -> $NEW at ledger time $TS"
