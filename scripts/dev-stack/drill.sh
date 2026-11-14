#!/usr/bin/env bash
# The dashboard's history drill (spec 0004 D-31): real events for the public dashboard's history views,
# made the way an operator makes them, on the local network (tested) or on Testnet (the developer's run).
#
# Usage: [PRINCIPAL_NETWORK=local|testnet] [DRILL_STEPS=recovery,oracle,pause] [DRILL_PAUSE_SECONDS=15]
#        [DRILL_ONBOARD=faucet|issuer] [DRILL_FAUCET_ORIGIN=https://…] [DRILL_MANIFEST=<local manifest>]
#        scripts/dev-stack/drill.sh
#
# Steps, always in this order (DRILL_STEPS picks some of them):
#   recovery  A throwaway account, generated for this run and funded by Friendbot, trusts the test asset
#             and is onboarded: on Testnet through the app's public faucet (POST <origin>/api/faucet), on
#             the local network by the issuer's own steps (authorize the trustline, grant_account, the
#             account on the PT and YT allow-lists, pay 10 USDY); DRILL_ONBOARD switches. It deposits 10
#             USDY into the SY wrapper and mints PT and YT from 5 SY (skipped, and said, once the market
#             has matured or with a stale oracle; on testnet a stale oracle stops the run before it
#             signs). The SAC admin deauthorizes it on the asset's SAC, then
#             RecoveryEscrow.seize_all_positions([account]) moves everything to the escrow: one record
#             (its SY unwrapped at once, its PT and YT held for finalize_record after maturity) and one
#             `recovery` event. Its key is removed from the keystore right after, and by the exit trap if
#             the run stops earlier.
#   oracle    One value above the oracle's deviation cap (the cap plus 5 %), simulated first: it must
#             answer false, or nothing is sent. The oracle admin then sends it: set_reference_value
#             returns false in a successful transaction and the oracle emits `ref_rej` with reason
#             `deviate`. Then one keeper tick (oracle-tick.sh), so the oracle is fresh again; a tick
#             refused as stale_ts (the scheduled keeper landed in the same second) is retried once.
#   pause     RiskControl pause, DRILL_PAUSE_SECONDS (default 15, at most 30) of wait, then unpause: two
#             `paused` events. While it is paused every market refuses deposits and mints. Once the pause
#             is sent, the exit trap unpauses on any failure or interruption (Ctrl-C, TERM or Ctrl-\
#             unpause at once; the cleanup itself ignores further interrupts). Nothing can trap SIGKILL
#             or a lost machine: the README gives the command to unpause by hand.
#
# Keys, by identity name in the Stellar CLI keystore (a secret is never read, passed or printed):
#   local    principal-localdev-admin: the dev stack's one key (issuer, SAC admin, every admin).
#   testnet  principal-testnet-admin   SAC admin of the test asset and RiskControl admin: the deauthorize,
#                                      the seize (the escrow's issuer authority is the SAC admin), the
#                                      pause and the unpause;
#            principal-testnet-oracle  OracleAdapter admin: the deviating push and the keeper tick;
#            principal-testnet-issuer  only with DRILL_ONBOARD=issuer: the faucet's own key (classic
#                                      issuer and Permissioning admin), instead of the public faucet.
#
# Output: progress, and every transaction hash with its stellar.expert link (none on the local network),
# on stderr (Friendbot's from its answer; the faucet's authorization and payment from Horizon; the
# faucet's allow-list calls have no hash to print); one JSON summary on stdout ({ network, marketId,
# account, key, keyRemoved, recordIds, mint, record, rejection, pausedSeconds, txs: [{ step, hash, url }] }).
#
# Testnet is the developer's run only: it signs with the official keys. It refuses CI, an agent session
# (CLAUDECODE), Stellar CLI variables that would change the network, source, signer or sending, any key
# name but the official ones, DRILL_MANIFEST, and a run without a terminal; it then checks each key's
# role on chain and that RiskControl is not paused, shows what it will sign, and asks for the market id
# before the first transaction.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# ---------------------------------------------------------------------------------------------
# Refusals that need neither the keystore nor the network
# ---------------------------------------------------------------------------------------------
STEPS_ARG="${DRILL_STEPS:-recovery,oracle,pause}"
DO_RECOVERY=0 DO_ORACLE=0 DO_PAUSE=0
IFS=',' read -r -a STEP_LIST <<<"$STEPS_ARG"
[ "${#STEP_LIST[@]}" -gt 0 ] || die "DRILL_STEPS is empty: name one or more of recovery, oracle, pause"
for s in "${STEP_LIST[@]}"; do
  case "$s" in
    recovery) DO_RECOVERY=1 ;;
    oracle) DO_ORACLE=1 ;;
    pause) DO_PAUSE=1 ;;
    *) die "DRILL_STEPS: unknown step '$s' (the steps are recovery, oracle, pause)" ;;
  esac
done
PAUSE_SECONDS="${DRILL_PAUSE_SECONDS:-15}"
[[ "$PAUSE_SECONDS" =~ ^[0-9]{1,2}$ ]] && [ "$PAUSE_SECONDS" -le 30 ] ||
  die "DRILL_PAUSE_SECONDS must be 0 to 30 (RiskControl stays paused for under a minute)"
# Onboarding: the app's public faucet on testnet (no key of ours), the issuer's own steps locally.
DEFAULT_ONBOARD=issuer
DEFAULT_ORIGIN="http://localhost:3000"
if [ "$NETWORK" = testnet ]; then
  DEFAULT_ONBOARD=faucet
  DEFAULT_ORIGIN="https://testnet.principalmarket.fi"
fi
ONBOARD="${DRILL_ONBOARD:-$DEFAULT_ONBOARD}"
case "$ONBOARD" in faucet | issuer) ;; *) die "DRILL_ONBOARD must be faucet or issuer" ;; esac
FAUCET_ORIGIN="${DRILL_FAUCET_ORIGIN:-$DEFAULT_ORIGIN}"
FAUCET_ORIGIN="${FAUCET_ORIGIN%/}"
[[ "$FAUCET_ORIGIN" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "DRILL_FAUCET_ORIGIN must be an origin such as https://testnet.principalmarket.fi"

# Stellar CLI variables that would change what a call reads, signs or sends (another RPC or network, a
# default source, another signer, a simulation instead of a send). Refused on testnet; unset below on
# every network, so neither the CLI calls nor oracle-tick.sh inherit them.
CLI_OVERRIDES="STELLAR_RPC_URL STELLAR_RPC_HEADERS STELLAR_NETWORK_PASSPHRASE STELLAR_NETWORK STELLAR_ACCOUNT STELLAR_SIGN_WITH_KEY STELLAR_SEND STELLAR_INVOKE_VIEW"

if [ "$NETWORK" = testnet ]; then
  # Every refusal here comes before the keystore or the network is touched.
  [ -z "${CI:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ] ||
    die "drill.sh never runs from CI on testnet: it signs with the official keys. Run it from your own terminal."
  [ -z "${CLAUDECODE:-}" ] || die "The Testnet drill is run by the developer, not by an agent."
  for var in $CLI_OVERRIDES; do
    [ -z "${!var:-}" ] || die "$var is set: on testnet the drill uses the Stellar CLI's own testnet settings only. Unset $var."
  done
  [ -z "${DRILL_MANIFEST:-}" ] && [ -z "${ORACLE_TICK_MANIFEST:-}" ] ||
    die "DRILL_MANIFEST and ORACLE_TICK_MANIFEST are for the local network only: on testnet the drill reads config/manifests/testnet.json."
  # common.sh lets ADMIN_KEY / ORACLE_KEY / ISSUER_KEY rename the testnet roles; the drill is for the
  # official deployment and its keys only (the value is not echoed: it could be anything).
  [ "$ADMIN_KEY" = principal-testnet-admin ] || die "ADMIN_KEY names another key: on testnet the drill signs with principal-testnet-admin only. Unset ADMIN_KEY."
  [ "$ORACLE_KEY" = principal-testnet-oracle ] || die "ORACLE_KEY names another key: on testnet the drill signs with principal-testnet-oracle only. Unset ORACLE_KEY."
  [ "$ISSUER_KEY" = principal-testnet-issuer ] || die "ISSUER_KEY names another key: on testnet the drill uses principal-testnet-issuer only. Unset ISSUER_KEY."
  [ -t 0 ] && [ -t 2 ] ||
    die "drill.sh on testnet needs a terminal: it shows what it will sign and asks you to type the market id first."
fi
# shellcheck disable=SC2086 # a list of names
unset $CLI_OVERRIDES

need stellar "Install the Stellar CLI."
need jq "brew install jq"
need curl ""
need node "Install Node.js (oracle-tick.sh needs it)."

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
WORK="$(mktemp -d)"
CLI_ERR="$WORK/cli.err"
log() { echo "$*" >&2; }
scalar() { tr -d '"[:space:]'; }
# Anything shaped like a secret key (S + 55 base32 characters) is redacted, as tests/live/util.ts does.
redacted() { sed -E 's/S[A-Z2-7]{55}/S…[redacted]/g'; }
# cli <stellar args...>: its stdout as is; on failure its stderr, redacted, and its status.
cli() {
  stellar "$@" 2>"$CLI_ERR" && return 0
  local status=$?
  redacted <"$CLI_ERR" >&2
  return "$status"
}
# explorer_url tx|contract|account <id>: lib/protocol/explorer.ts's rule; empty on the local network.
explorer_url() {
  [ "$NETWORK" = local ] && return 0
  echo "https://stellar.expert/explorer/$NETWORK/$1/$2"
}
TXS_JSON="[]"
# log_tx <step> <hash>: the hash and its link.
log_tx() {
  local url
  url="$(explorer_url tx "$2")"
  log "  $1: tx $2"
  [ -z "$url" ] || log "    $url"
}
record_tx() {
  TXS_JSON="$(jq -c --arg s "$1" --arg h "$2" --arg u "$(explorer_url tx "$2")" \
    '. + [{ step: $s, hash: $h, url: (if $u == "" then null else $u end) }]' <<<"$TXS_JSON")"
}
# send <step> <stellar args...>: one transaction, signed by the --source identity. Sets SENT_OUT (its
# return value) and SENT_HASH (from the CLI's "Signing transaction: <hash>" line). A hash is recorded
# only when the CLI reports success; a failed call prints its error (redacted) and, if it got that
# far, its hash.
SENT_OUT="" SENT_HASH=""
send() {
  local step="$1" status=0
  shift
  SENT_OUT="" SENT_HASH=""
  SENT_OUT="$(stellar "$@" 2>"$CLI_ERR")" || status=$?
  SENT_HASH="$(sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' "$CLI_ERR" | tail -n1)"
  if [ "$status" -ne 0 ]; then
    redacted <"$CLI_ERR" >&2
    [ -z "$SENT_HASH" ] || log_tx "$step (failed)" "$SENT_HASH"
    return "$status"
  fi
  if [ -z "$SENT_HASH" ]; then
    log "error: $step: the Stellar CLI printed no transaction hash"
    return 1
  fi
  log_tx "$step" "$SENT_HASH"
  record_tx "$step" "$SENT_HASH"
}
READER=""
# view <contract id> <fn> [args...]: a simulation only (--send=no), from a public address. A read that
# fails is tried once more a second later (an RPC can briefly answer an error, e.g. a snapshot not ready).
view() {
  local id="$1" out
  shift
  if out="$(stellar contract invoke --id "$id" --source-account "$READER" --network "$NETWORK" --send=no -- "$@" 2>"$CLI_ERR")"; then
    printf '%s\n' "$out"
    return 0
  fi
  sleep 1
  cli contract invoke --id "$id" --source-account "$READER" --network "$NETWORK" --send=no -- "$@"
}
# flag <contract id> <fn>: a boolean view, printed as true or false. A read that fails, or answers
# anything else, is an error: it is never taken for either state.
flag() {
  local v
  v="$(view "$@" | scalar)" || {
    log "error: could not read $2 on $1"
    return 1
  }
  case "$v" in
    true | false) echo "$v" ;;
    *)
      log "error: $2 on $1 answered '$v'"
      return 1
      ;;
  esac
}
# tx_close_time <hash>: the close time (unix seconds) of the ledger that included it.
tx_close_time() {
  rpc_call getTransaction "{\"hash\":\"$1\"}" | jq -er '.result | select(.status == "SUCCESS") | .createdAt | tonumber'
}

# ---------------------------------------------------------------------------------------------
# The exit trap: unpause if the pause was sent, remove the throwaway key, delete the work files
# ---------------------------------------------------------------------------------------------
PAUSED=0
PAUSE_HASH=""
THROWAWAY=""
SLEEP_PID=""
RISK=""
ADMIN=""
THROWAWAY_RE='^drill-(local|testnet)-[0-9]+-[0-9]+$'

# remove_throwaway: `stellar keys rm` of this run's own key, never any other name.
remove_throwaway() {
  [ -n "$THROWAWAY" ] || return 0
  [[ "$THROWAWAY" =~ $THROWAWAY_RE ]] || {
    log "error: refusing to remove '$THROWAWAY': not a drill key name"
    return 1
  }
  if stellar keys rm "$THROWAWAY" --force >/dev/null 2>&1; then
    log "  removed the throwaway key $THROWAWAY from the keystore"
    THROWAWAY=""
  else
    log "warning: could not remove the throwaway key: run  stellar keys rm $THROWAWAY --force"
    return 1
  fi
}

# tx_settled <hash>: waits (at most 40 s) until RPC knows the transaction as SUCCESS or FAILED; prints that,
# or NOT_FOUND when it never landed.
tx_settled() {
  local deadline=$((SECONDS + 40)) status
  while :; do
    status="$(rpc_call getTransaction "{\"hash\":\"$1\"}" 2>/dev/null | jq -r '.result.status // empty' 2>/dev/null || true)"
    case "$status" in SUCCESS | FAILED)
      echo "$status"
      return 0
      ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 2
  done
  echo NOT_FOUND
}

unpause_command() {
  echo "stellar contract invoke --id $RISK --source $ADMIN_KEY --network $NETWORK -- unpause --caller $ADMIN"
}

# The trap's unpause. The pause's own transaction decides, not an is_paused read (which can lag the
# ledger that included the pause): SUCCESS means ours is in force, so unpause (it has no precondition);
# FAILED means it never applied. Only a pause that never landed falls back to reading is_paused.
unpause_in_trap() {
  local attempt state settled
  log "==> Unpausing RiskControl (exit trap)"
  if [ -z "$PAUSE_HASH" ]; then
    # The CLI prints the hash before it submits: without one, the pause was never sent.
    log "  the pause was never sent: nothing to undo"
    PAUSED=0
    return 0
  fi
  # A pause the run stopped in the middle of sending may still land: wait for it first.
  settled="$(tx_settled "$PAUSE_HASH")"
  log "  pause transaction $PAUSE_HASH: $settled"
  case "$settled" in
    FAILED)
      log "  the pause did not apply: nothing to undo"
      PAUSED=0
      return 0
      ;;
    NOT_FOUND)
      state="$(view "$RISK" is_paused 2>/dev/null | scalar || true)"
      if [ "$state" = false ]; then
        log "  RiskControl is not paused. If $PAUSE_HASH lands later, unpause by hand: $(unpause_command)"
        PAUSED=0
        return 0
      fi
      ;;
  esac
  for attempt in 1 2 3; do
    if send "unpause (trap)" contract invoke --id "$RISK" --source "$ADMIN_KEY" --network "$NETWORK" -- unpause --caller "$ADMIN"; then
      PAUSED=0
      return 0
    fi
    log "  unpause attempt $attempt failed"
    sleep 3
  done
  log "ERROR: RiskControl may still be paused. Unpause it now:"
  log "  $(unpause_command)"
  return 1
}

cleanup() {
  local status=$?
  # Once cleaning up, a second Ctrl-C (or TERM, or Ctrl-\) must not cut the unpause short: the shell and
  # every command it starts from here (the Stellar CLI included) ignore them.
  trap - EXIT
  trap '' INT TERM QUIT
  set +e
  if [ -n "$SLEEP_PID" ]; then
    # Never waited for: a kill that lands while the background sleep is still starting can be lost, and
    # the unpause must not sit out the rest of the pause. Disowned (no "Terminated" notice) and off the
    # caller's stdout and stderr, a sleep left behind holds nothing.
    disown "$SLEEP_PID" 2>/dev/null
    kill "$SLEEP_PID" 2>/dev/null
  fi
  # Stopped while the pause was being sent: its hash is in the CLI's stderr (it is printed before the
  # transaction is submitted), read before any other call overwrites it.
  if [ "$PAUSED" = 1 ] && [ -z "$PAUSE_HASH" ] && [ -f "$CLI_ERR" ]; then
    PAUSE_HASH="$(sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' "$CLI_ERR" | tail -n1)"
  fi
  [ "$PAUSED" = 0 ] || unpause_in_trap || status=1
  remove_throwaway || status=1
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 131' QUIT

# ---------------------------------------------------------------------------------------------
# Preflight: manifest, network, keys and their roles on chain (reads only)
# ---------------------------------------------------------------------------------------------
# DRILL_MANIFEST (local only, refused on testnet above): another local deployment's manifest, e.g. one
# written by `MANIFEST_OUT=… deploy.sh` for a market that has not matured yet.
MANIFEST="${DRILL_MANIFEST:-$DAPP_DIR/config/manifests/$NETWORK.json}"
[ -f "$MANIFEST" ] || die "$MANIFEST not found."
m() { jq -er "$1" "$MANIFEST" || die "cannot read $1 from $MANIFEST"; }
MARKET_ID="$(m '.markets[0].marketId')"
SY="$(m '.markets[0].contracts.sy')"
ESCROW="$(m '.markets[0].contracts.recoveryEscrow')"
MANAGER="$(m '.markets[0].contracts.manager')"
PT="$(m '.markets[0].contracts.pt')"
YT="$(m '.markets[0].contracts.yt')"
MARKET_ORACLE="$(m '.markets[0].contracts.oracle')"
MATURITY="$(m '.markets[0].maturity')"
SAC="$(m '.markets[0].underlying.sac')"
CODE="$(m '.markets[0].underlying.code')"
ISSUER="$(m '.markets[0].underlying.issuer')"
DECIMALS="$(m '.markets[0].underlying.decimals')"
ORACLE="$(m '.shared.oracle')"
RISK="$(m '.shared.riskControl')"
PERM="$(m '.shared.permissioning')"
for id in "$SY" "$ESCROW" "$MANAGER" "$PT" "$YT" "$MARKET_ORACLE" "$SAC" "$ORACLE" "$RISK" "$PERM"; do
  [[ "$id" =~ ^C[A-Z2-7]{55}$ ]] || die "the manifest holds '$id' where a contract id belongs"
done
[[ "$ISSUER" =~ ^G[A-Z2-7]{55}$ ]] || die "the manifest's issuer is not an account id"
[[ "$DECIMALS" =~ ^[0-9]$ ]] || die "unexpected decimals '$DECIMALS'"
[[ "$MATURITY" =~ ^[0-9]+$ ]] || die "unexpected maturity '$MATURITY'"
AMOUNT=$((10 * 10 ** DECIMALS)) # 10 USDY, paid (issuer onboarding) and deposited
MINT_SHARES=$((AMOUNT / 2))     # 5 SY of it split into PT and YT, so the seizure record holds PT and YT

rpc_healthy || die "the $NETWORK network is not answering on $RPC_URL."
PASSPHRASE="$(rpc_call getNetwork | jq -er '.result.passphrase')" || die "the RPC on $RPC_URL did not name its network"
[ "$PASSPHRASE" = "$NETWORK_PASSPHRASE" ] || die "the RPC on $RPC_URL is not the $NETWORK network (passphrase '$PASSPHRASE')"

ADMIN="$(stellar keys address "$ADMIN_KEY" 2>/dev/null)" || die "key $ADMIN_KEY is missing from the keystore"
ORACLE_ADMIN="$(stellar keys address "$ORACLE_KEY" 2>/dev/null)" || die "key $ORACLE_KEY is missing from the keystore"
READER="$ADMIN"
log "==> Drill on $NETWORK, market $MARKET_ID ($RPC_URL)"
[ "$NETWORK" != local ] || log "  (the local network has no explorer: hashes only)"

# expect_admin <what> <contract id> <fn> <address> <key name>
expect_admin() {
  local got
  got="$(view "$2" "$3" | scalar)" || die "could not read $1 ($3 on $2)"
  [ "$got" = "$4" ] || die "$5 ($4) is not $1: the contract answers $got. Nothing was signed."
}
if [ "$DO_RECOVERY" = 1 ]; then
  # The escrow's issuer authority is the SAC admin (assert_issuer_admin), so one key does both.
  expect_admin "the $CODE SAC admin" "$SAC" admin "$ADMIN" "$ADMIN_KEY"
  if [ "$ONBOARD" = issuer ]; then
    ISSUER_ACCOUNT="$(stellar keys address "$ISSUER_KEY" 2>/dev/null)" || die "key $ISSUER_KEY is missing from the keystore"
    [ "$ISSUER_ACCOUNT" = "$ISSUER" ] || die "$ISSUER_KEY ($ISSUER_ACCOUNT) is not the $CODE issuer ($ISSUER). Nothing was signed."
    expect_admin "the Permissioning admin" "$PERM" get_admin "$ISSUER_ACCOUNT" "$ISSUER_KEY"
  fi
fi
if [ "$DO_ORACLE" = 1 ]; then
  expect_admin "the OracleAdapter admin" "$ORACLE" get_admin "$ORACLE_ADMIN" "$ORACLE_KEY"
  ORACLE_SOURCE="$(view "$ORACLE" get_primary_source | scalar)" || die "could not read the oracle's primary source"
  [[ "$ORACLE_SOURCE" =~ ^[0-9a-f]{64}$ ]] || die "the oracle has no primary source"
  CAP="$(view "$ORACLE" max_deviation_bps | scalar)" || die "could not read the oracle's deviation cap"
  [[ "$CAP" =~ ^[0-9]{1,5}$ ]] || die "unexpected deviation cap '$CAP'"
fi
if [ "$DO_PAUSE" = 1 ]; then
  expect_admin "the RiskControl admin" "$RISK" get_admin "$ADMIN" "$ADMIN_KEY"
  # Never unpause a pause the drill did not make.
  RC_STATE="$(flag "$RISK" is_paused)" || exit 1
  [ "$RC_STATE" = false ] || die "RiskControl is already paused: the drill stops (it would unpause a pause it did not make)."
fi

# deviate_value: the current value plus the cap plus 5 % (and one unit), so it is over the cap.
deviate_value() {
  local current
  current="$(view "$ORACLE" get_reference_value | scalar)" || return 1
  [[ "$current" =~ ^[0-9]{1,15}$ ]] || {
    log "error: unexpected oracle value '$current'"
    return 1
  }
  echo $((current + current * (CAP + 500) / 10000 + 1))
}
if [ "$DO_ORACLE" = 1 ]; then
  PLANNED="$(deviate_value)" || die "could not read the oracle's value"
  BOUNDS="$(view "$ORACLE" value_bounds)" || die "could not read the oracle's value bounds"
  if [ "$(jq -r 'type' <<<"$BOUNDS")" = array ] &&
    [ "$(jq -r --arg v "$PLANNED" '($v | tonumber) > (.[1] | tonumber)' <<<"$BOUNDS")" = true ]; then
    die "the oracle's value bounds ($BOUNDS) refuse $PLANNED as oob before the deviation cap: no deviate push is possible. Nothing was signed."
  fi
fi

# mint_skip_reason: why the PT and YT mint cannot run now (the manager refuses a mint at or after
# maturity, and with a stale oracle), or nothing when it can.
mint_skip_reason() {
  local now
  now="$(ledger_close_time)" || {
    echo "the ledger clock could not be read"
    return 0
  }
  if [ "$now" -ge $((MATURITY - 120)) ]; then
    echo "the market has matured, or matures within 2 minutes: the manager mints no more PT and YT"
    return 0
  fi
  local available
  available="$(flag "$MARKET_ORACLE" is_available 2>/dev/null)" || {
    echo "the oracle's freshness could not be read"
    return 0
  }
  [ "$available" = true ] || echo "the oracle is stale: the manager mints only with a fresh value"
}
if [ "$DO_RECOVERY" = 1 ]; then
  MINT_PREVIEW="$(mint_skip_reason)"
  # On testnet the record must hold PT and YT (finalize_record settles them after maturity): a stale
  # oracle stops the run here, before anything is signed.
  if [ "$NETWORK" = testnet ] && [ -n "$MINT_PREVIEW" ] && [[ "$MINT_PREVIEW" != *matured* ]]; then
    die "the throwaway account could not mint PT and YT ($MINT_PREVIEW). If the oracle is stale, wait for the keeper's next tick (or run oracle-tick.sh), then run the drill again. Nothing was signed."
  fi
fi

if [ "$NETWORK" = testnet ]; then
  log ""
  log "This drill signs on Stellar Testnet, on the official market $MARKET_ID:"
  if [ "$DO_RECOVERY" = 1 ]; then
    if [ "$ONBOARD" = faucet ]; then log "  - a throwaway account (new key, Friendbot) is onboarded through $FAUCET_ORIGIN/api/faucet,"; else
      log "  - a throwaway account (new key, Friendbot) is onboarded by $ISSUER_KEY (authorize, grant_account, PT and YT, pay 10 $CODE),"
    fi
    if [ -z "$MINT_PREVIEW" ]; then
      log "    deposits 10 $CODE and mints PT and YT from 5 SY, then $ADMIN_KEY ($ADMIN) deauthorizes it on the SAC"
      log "    and seizes everything (one RecoveryEscrow record holding PT and YT, settled by finalize_record after maturity)"
    else
      log "    deposits 10 $CODE (no PT and YT mint: $MINT_PREVIEW), then $ADMIN_KEY ($ADMIN) deauthorizes it on the SAC and seizes its SY"
    fi
  fi
  [ "$DO_ORACLE" = 1 ] && log "  - $ORACLE_KEY ($ORACLE_ADMIN) pushes $PLANNED, over the $CAP bps cap (simulated first: refused), then one keeper tick"
  [ "$DO_PAUSE" = 1 ] && log "  - $ADMIN_KEY pauses RiskControl for about $PAUSE_SECONDS s (every market refuses deposits and mints meanwhile), then unpauses"
  log ""
  printf 'Type the market id (%s) to go on; anything else stops: ' "$MARKET_ID" >&2
  read -r ANSWER || ANSWER=""
  [ "$ANSWER" = "$MARKET_ID" ] || die "not confirmed: nothing was signed."
fi

# ---------------------------------------------------------------------------------------------
# 1. Compliance recovery
# ---------------------------------------------------------------------------------------------
ACCOUNT=""
KEY_NAME=""
RECORD_IDS="[]"
RECORD="null"
MINT="null"
# friendbot: funds the throwaway account through the network's Friendbot, whose answer carries the hash.
friendbot() {
  local attempt body hash
  for attempt in 1 2; do
    body="$(curl -sS --max-time 60 "$FRIENDBOT_URL?addr=$ACCOUNT" 2>/dev/null || true)"
    hash="$(jq -r '.hash // empty' <<<"$body" 2>/dev/null || true)"
    if [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
      log_tx friendbot "$hash"
      record_tx friendbot "$hash"
      return 0
    fi
    log "  Friendbot attempt $attempt did not fund the account"
    sleep 5
  done
  die "Friendbot did not fund the throwaway account"
}
# faucet_hashes: the faucet's answer carries no hash, so its classic operations (the trustline's
# authorization and the payment) are read from Horizon, where they are listed under the account.
faucet_hashes() {
  local ops type hash step
  ops="$(curl -sf --max-time 10 "$HORIZON_URL/accounts/$ACCOUNT/operations?order=asc&limit=50" 2>/dev/null |
    jq -r --arg a "$ACCOUNT" '._embedded.records[] | select(.source_account != $a and .type != "create_account") | "\(.type) \(.transaction_hash)"' 2>/dev/null || true)"
  while read -r type hash; do
    [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || continue
    case "$type" in
      set_trust_line_flags) step=faucet_authorize ;;
      payment) step=faucet_pay ;;
      *) step="faucet_$type" ;;
    esac
    log_tx "$step" "$hash"
    record_tx "$step" "$hash"
  done <<<"$ops"
  log "  (the faucet's allow-list calls, for the account and each market's PT and YT, are contract calls signed by its"
  log "  own key: its answer carries no hash and Horizon does not list them under this account. The dashboard's"
  log "  Activity view shows them once indexed.)"
}
wait_onboarded() {
  local deadline=$((SECONDS + 90)) line authorized balance
  while :; do
    line="$(curl -sf --max-time 10 "$HORIZON_URL/accounts/$ACCOUNT" 2>/dev/null |
      jq -c --arg c "$CODE" --arg i "$ISSUER" '.balances[] | select(.asset_code == $c and .asset_issuer == $i) | { a: .is_authorized, b: .balance }' 2>/dev/null || true)"
    if [ -n "$line" ]; then
      authorized="$(jq -r .a <<<"$line")"
      balance="$(jq -r '.b | sub("\\."; "")' <<<"$line")"
      if [ "$authorized" = true ] && [[ "$balance" =~ ^[0-9]+$ ]] && [ $((10#$balance)) -ge "$AMOUNT" ]; then return 0; fi
    fi
    [ "$SECONDS" -lt "$deadline" ] || die "the throwaway account's $CODE trustline is not authorized with 10 $CODE after 90 s (Horizon: ${line:-no trustline})"
    sleep 2
  done
}
onboard_faucet() {
  local attempt code body wait
  body="$(jq -cn --arg a "$ACCOUNT" '{ account: $a }')"
  for attempt in 1 2 3 4; do
    code="$(curl -sS --max-time 150 -o "$WORK/faucet.json" -w '%{http_code}' -H 'Content-Type: application/json' \
      --data "$body" "$FAUCET_ORIGIN/api/faucet")" || code=000
    case "$code" in
      200)
        log "  faucet: $(jq -r '.performed | join(", ")' "$WORK/faucet.json") (its own transactions are on the account's page)"
        return 0
        ;;
      429 | 503)
        wait="$(jq -r '.retryAfterSeconds // 60' "$WORK/faucet.json" 2>/dev/null || echo 60)"
        [[ "$wait" =~ ^[0-9]{1,3}$ ]] || wait=60
        log "  faucet answered $code ($(jq -r '.error // "busy"' "$WORK/faucet.json" 2>/dev/null)); attempt $attempt, waiting $wait s"
        sleep "$wait"
        ;;
      *) die "the faucet answered $code: $(jq -r '"\(.error // "?"): \(.message // "")"' "$WORK/faucet.json" 2>/dev/null || echo "no JSON")" ;;
    esac
  done
  die "the faucet stayed busy; try again later, or with DRILL_ONBOARD=issuer"
}
onboard_issuer() {
  send authorize tx new set-trustline-flags --source "$ISSUER_KEY" --asset "$CODE:$ISSUER" --trustor "$ACCOUNT" \
    --set-authorize --network "$NETWORK" || die "authorizing the trustline failed"
  send grant_account contract invoke --id "$PERM" --source "$ISSUER_KEY" --network "$NETWORK" -- \
    grant_account --caller "$ISSUER" --account "$ACCOUNT" || die "grant_account failed"
  # PT and YT check the account against the allow-list for each token (is_allowed_for_asset) when they mint.
  send grant_pt contract invoke --id "$PERM" --source "$ISSUER_KEY" --network "$NETWORK" -- \
    grant_asset --caller "$ISSUER" --account "$ACCOUNT" --asset "$PT" || die "grant_asset (PT) failed"
  send grant_yt contract invoke --id "$PERM" --source "$ISSUER_KEY" --network "$NETWORK" -- \
    grant_asset --caller "$ISSUER" --account "$ACCOUNT" --asset "$YT" || die "grant_asset (YT) failed"
  send pay tx new payment --source "$ISSUER_KEY" --destination "$ACCOUNT" --asset "$CODE:$ISSUER" \
    --amount "$AMOUNT" --network "$NETWORK" || die "the payment failed"
}
step_recovery() {
  local name skip id
  log "==> 1. Compliance recovery: a throwaway account, deauthorized and seized"
  name="drill-$NETWORK-$(date +%s)-$$"
  [[ "$name" =~ $THROWAWAY_RE ]] || die "unexpected key name $name"
  ! stellar keys address "$name" >/dev/null 2>&1 || die "a key named $name already exists"
  THROWAWAY="$name" # from here on the exit trap removes it
  KEY_NAME="$name"
  # Nothing of `keys generate` is shown.
  stellar keys generate "$name" --network "$NETWORK" >/dev/null 2>&1 || die "could not create the throwaway key"
  ACCOUNT="$(stellar keys address "$name")"
  log "  throwaway account $ACCOUNT (key $name, removed at the end)"
  [ -z "$(explorer_url account "$ACCOUNT")" ] || log "    $(explorer_url account "$ACCOUNT")"
  friendbot
  send trustline tx new change-trust --source "$name" --line "$CODE:$ISSUER" --network "$NETWORK" || die "the trustline failed"
  if [ "$ONBOARD" = faucet ]; then onboard_faucet; else onboard_issuer; fi
  wait_onboarded
  [ "$ONBOARD" = issuer ] || faucet_hashes
  send deposit contract invoke --id "$SY" --source "$name" --network "$NETWORK" -- \
    deposit --from "$ACCOUNT" --amount "$AMOUNT" --min_shares_out 0 || die "the SY deposit failed"
  # PT and YT for the record (finalize_record settles them after maturity; SY is unwrapped at seizure).
  skip="$(mint_skip_reason)"
  if [ -z "$skip" ]; then
    send mint contract invoke --id "$MANAGER" --source "$name" --network "$NETWORK" -- \
      mint --from "$ACCOUNT" --sy_shares "$MINT_SHARES" || die "the PT and YT mint failed"
    log "  minted from $MINT_SHARES SY shares: $(jq -c . <<<"$SENT_OUT" 2>/dev/null || echo "$SENT_OUT")"
    MINT="$(jq -cn --argjson s "$MINT_SHARES" '{ done: true, syShares: $s }')"
  else
    log "  no PT and YT mint: $skip. The record will hold SY only, unwrapped at seizure: finalize_record has nothing to settle."
    MINT="$(jq -cn --arg r "$skip" '{ done: false, reason: $r }')"
  fi
  send deauthorize contract invoke --id "$SAC" --source "$ADMIN_KEY" --network "$NETWORK" -- \
    set_authorized --id "$ACCOUNT" --authorize false || die "the deauthorization failed"
  send seize contract invoke --id "$ESCROW" --source "$ADMIN_KEY" --network "$NETWORK" -- \
    seize_all_positions --caller "$ADMIN" --accounts "[\"$ACCOUNT\"]" || die "seize_all_positions failed"
  RECORD_IDS="$(jq -c 'map(tonumber)' <<<"$SENT_OUT")" || die "seize_all_positions returned '$SENT_OUT', not record ids"
  [ "$(jq 'length' <<<"$RECORD_IDS")" = 1 ] || die "seize_all_positions returned $RECORD_IDS, not one record id"
  id="$(jq -r '.[0]' <<<"$RECORD_IDS")"
  RECORD="$(view "$ESCROW" get_record --id "$id" |
    jq -c '{ id: '"$id"', account, sy_shares: (.sy_shares | tostring), pt_amount: (.pt_amount | tostring), yt_amount: (.yt_amount | tostring), lp_amount: (.lp_amount | tostring), finalized }')" || RECORD="null"
  log "  RecoveryEscrow record $id: $RECORD"
  if [ "$(jq -r '.done' <<<"$MINT")" = true ]; then
    log "  it holds PT and YT: after the market's maturity, settle it as the SAC admin with"
    log "    stellar contract invoke --id $ESCROW --source $ADMIN_KEY --network $NETWORK -- finalize_record --caller $ADMIN --id $id"
  fi
  [ -z "$(explorer_url contract "$ESCROW")" ] || log "    $(explorer_url contract "$ESCROW")"
  remove_throwaway || true
}

# ---------------------------------------------------------------------------------------------
# 2. Oracle rejection, then the keeper's tick
# ---------------------------------------------------------------------------------------------
REJECTION="null"
step_oracle() {
  local value last_ts ts sim rejection deadline tick_hash attempt state
  log "==> 2. Oracle rejection: one value over the $CAP bps deviation cap, then the keeper's tick"
  value="$(deviate_value)" || die "could not read the oracle's value"
  last_ts="$(view "$ORACLE" get_reference_timestamp | scalar)" || die "could not read the oracle's timestamp"
  [[ "$last_ts" =~ ^[0-9]+$ ]] || die "unexpected oracle timestamp '$last_ts'"
  # stale_ts is checked before deviate: the timestamp must be newer than the stored one.
  deadline=$((SECONDS + 60))
  while :; do
    ts="$(ledger_close_time)" || die "could not read the ledger clock"
    [ "$ts" -le "$last_ts" ] || break
    [ "$SECONDS" -lt "$deadline" ] || die "the ledger clock did not pass the oracle's timestamp $last_ts"
    sleep 2
  done
  # Simulated first: a value the oracle would accept is never sent (it could not be taken back).
  sim="$(cli contract invoke --id "$ORACLE" --source-account "$ORACLE_ADMIN" --network "$NETWORK" --send=no -- \
    set_reference_value --caller "$ORACLE_ADMIN" --source "$ORACLE_SOURCE" --value "$value" --timestamp "$ts" | scalar)" ||
    die "simulating set_reference_value failed"
  [ "$sim" = false ] || die "the oracle would accept $value (simulated '$sim'): nothing was sent."
  send deviate contract invoke --id "$ORACLE" --source "$ORACLE_KEY" --network "$NETWORK" -- \
    set_reference_value --caller "$ORACLE_ADMIN" --source "$ORACLE_SOURCE" --value "$value" --timestamp "$ts" ||
    die "set_reference_value failed"
  [ "$(scalar <<<"$SENT_OUT")" = false ] || die "set_reference_value returned '$SENT_OUT', not false"
  rejection="$(view "$ORACLE" last_rejection)" || die "could not read last_rejection"
  REJECTION="$(jq -c '{ reason, value: (.value | tostring), timestamp: (.timestamp | tostring) }' <<<"$rejection")" ||
    die "unexpected last_rejection '$rejection'"
  log "  refused as expected: $REJECTION"
  [ "$(jq -r .reason <<<"$REJECTION")" = deviate ] && [ "$(jq -r .value <<<"$REJECTION")" = "$value" ] ||
    die "the oracle refused the value, but not as deviate: $REJECTION (re-run with DRILL_STEPS=oracle,pause)"

  log "  keeper tick (oracle-tick.sh as $ORACLE_KEY)"
  for attempt in 1 2; do
    # ORACLE_TICK_MANIFEST: the drill's manifest when DRILL_MANIFEST names another (local) deployment.
    if PRINCIPAL_NETWORK="$NETWORK" ORACLE_KEY="$ORACLE_KEY" ORACLE_TICK_MANIFEST="${DRILL_MANIFEST:-}" \
      "$DEV_STACK_DIR/oracle-tick.sh" >"$WORK/tick.out" 2>"$WORK/tick.err"; then
      break
    fi
    tick_hash="$(sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' "$WORK/tick.err" | tail -n1)"
    # The scheduled keeper (cron/oracle) can land in the same ledger second: the oracle then refuses this
    # tick as stale_ts (not newer than its value). That refusal is a transaction too: print it, retry once.
    if [ "$attempt" = 1 ] && grep -q stale_ts "$WORK/tick.err"; then
      [ -z "$tick_hash" ] || {
        log_tx "oracle_tick (refused: stale_ts)" "$tick_hash"
        record_tx "oracle_tick (refused: stale_ts)" "$tick_hash"
      }
      log "  the tick was refused as stale_ts (another tick landed in the same ledger second): retrying once in 6 s"
      sleep 6
      continue
    fi
    redacted <"$WORK/tick.err" >&2
    [ -z "$tick_hash" ] || log_tx "oracle_tick (failed)" "$tick_hash"
    die "the keeper tick failed: the oracle goes stale after max_stale_seconds unless cron/oracle ticks"
  done
  tick_hash="$(sed -nE 's/.*Signing transaction: ([0-9a-f]{64}).*/\1/p' "$WORK/tick.err" | tail -n1)"
  log "  $(redacted <"$WORK/tick.out")"
  [ -n "$tick_hash" ] || die "oracle-tick.sh printed no transaction hash"
  log_tx oracle_tick "$tick_hash"
  record_tx oracle_tick "$tick_hash"
  state="$(flag "$ORACLE" is_available)" || die "could not read the oracle's freshness after the tick"
  [ "$state" = true ] || die "the oracle is still not available after the tick"
}

# ---------------------------------------------------------------------------------------------
# 3. RiskControl pause and unpause
# ---------------------------------------------------------------------------------------------
PAUSED_SECONDS="null"
step_pause() {
  local pause_hash unpause_hash from to state
  log "==> 3. RiskControl pause for about $PAUSE_SECONDS s, then unpause"
  state="$(flag "$RISK" is_paused)" || die "could not read whether RiskControl is paused"
  [ "$state" = false ] || die "RiskControl is already paused: the drill stops."
  PAUSED=1 # from here on the exit trap unpauses (it reads is_paused first)
  : >"$CLI_ERR" # so the trap never takes an earlier call's hash for the pause's
  send pause contract invoke --id "$RISK" --source "$ADMIN_KEY" --network "$NETWORK" -- pause --caller "$ADMIN" ||
    die "the pause failed"
  pause_hash="$SENT_HASH"
  PAUSE_HASH="$SENT_HASH"
  state="$(flag "$RISK" is_paused)" || die "could not read is_paused after the pause (the exit trap unpauses)"
  [ "$state" = true ] || die "RiskControl does not read paused after the pause"
  # In the background with `wait`, so a signal runs the trap at once; off the caller's stdout and stderr, so a sleep
  # left behind by a signal between these two lines holds no pipe of the caller's open.
  sleep "$PAUSE_SECONDS" >/dev/null 2>&1 &
  SLEEP_PID=$!
  log "  RiskControl is paused; unpausing in $PAUSE_SECONDS s (Ctrl-C unpauses at once)"
  wait "$SLEEP_PID" || true
  SLEEP_PID=""
  send unpause contract invoke --id "$RISK" --source "$ADMIN_KEY" --network "$NETWORK" -- unpause --caller "$ADMIN" ||
    die "the unpause failed (the exit trap tries again)"
  unpause_hash="$SENT_HASH"
  PAUSED=0
  state="$(flag "$RISK" is_paused)" || die "could not read is_paused after the unpause"
  [ "$state" = false ] || die "RiskControl still reads paused after the unpause"
  if from="$(tx_close_time "$pause_hash")" && to="$(tx_close_time "$unpause_hash")"; then
    PAUSED_SECONDS=$((to - from))
    log "  RiskControl was paused for $PAUSED_SECONDS s of ledger time"
    [ "$PAUSED_SECONDS" -lt 60 ] || log "warning: the pause lasted a minute or more"
  fi
}

[ "$DO_RECOVERY" = 0 ] || step_recovery
[ "$DO_ORACLE" = 0 ] || step_oracle
[ "$DO_PAUSE" = 0 ] || step_pause

log "==> Done: $(jq 'length' <<<"$TXS_JSON") transactions"
jq -r '.[] | "  \(.step): \(.hash)\(if .url then "  \(.url)" else "" end)"' <<<"$TXS_JSON" >&2
if [ "$NETWORK" = testnet ]; then
  log "  The dashboard shows them once cron/index has run (every 5 min): https://testnet.principalmarket.fi/dashboard/compliance,"
  log "  /dashboard/oracle and /dashboard/risk, and every one on /dashboard/activity."
fi
jq -n --arg network "$NETWORK" --arg marketId "$MARKET_ID" --arg account "$ACCOUNT" --arg key "$KEY_NAME" \
  --argjson keyRemoved "$([ -z "$THROWAWAY" ] && echo true || echo false)" --argjson recordIds "$RECORD_IDS" \
  --argjson rejection "$REJECTION" --argjson pausedSeconds "$PAUSED_SECONDS" --argjson txs "$TXS_JSON" \
  --argjson mint "$MINT" --argjson record "$RECORD" \
  '{ network: $network, marketId: $marketId, account: (if $account == "" then null else $account end),
     key: (if $key == "" then null else $key end), keyRemoved: $keyRemoved, recordIds: $recordIds,
     mint: $mint, record: $record, rejection: $rejection, pausedSeconds: $pausedSeconds, txs: $txs }'
