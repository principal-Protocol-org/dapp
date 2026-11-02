#!/usr/bin/env bash
# Start the local Stellar network (quickstart container), a Postgres container and prepare the dev keys.
# Usage: scripts/dev-stack/up.sh
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
[ "$NETWORK" = local ] || die "up.sh starts the local network only. For testnet run PRINCIPAL_NETWORK=testnet scripts/dev-stack/deploy.sh."

need stellar "Install the Stellar CLI: https://developers.stellar.org/docs/tools/cli"
need curl ""
need jq "brew install jq"

# --- Container engine: Podman (preferred, if installed) or Docker ---------------------------
if command -v podman >/dev/null 2>&1; then
  state="$(podman machine list --format '{{.Running}}' 2>/dev/null | head -n1 || true)"
  if [ -z "$state" ]; then
    die "no Podman machine exists. Create one yourself (this script never does): podman machine init"
  fi
  if [ "$state" != "true" ]; then
    echo "Podman machine is not running; starting it (podman machine start)..."
    podman machine start || die "could not start the Podman machine. Run: podman machine start"
  fi
  sock="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null | head -n1 || true)"
  [ -n "$sock" ] && [ -S "$sock" ] || die "Podman socket not found ('${sock:-unset}'). Run: podman machine start"
  export DOCKER_HOST="unix://$sock"
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop."
  ENGINE=docker
else
  die "neither Podman nor Docker is installed. Install one, then run: podman machine init && podman machine start"
fi

# --- Network ---------------------------------------------------------------------------------
if rpc_healthy; then
  echo "Local network already answering on $RPC_URL."
else
  echo "Starting the local network (first run pulls the stellar/quickstart image)..."
  stellar container start local >/dev/null || die "'stellar container start local' failed (is port 8000 already in use? try: stellar container stop local)"
  echo -n "Waiting for the RPC to become healthy"
  for _ in $(seq 1 180); do
    if rpc_healthy; then break; fi
    echo -n "."
    sleep 2
  done
  echo
  rpc_healthy || die "RPC at $RPC_URL did not become healthy within 6 minutes. Check: stellar container logs local"
fi

# --- Postgres (rate recorder) --------------------------------------------------------------------
# Idempotent: reuse the container if it exists (start it if stopped), else create it. Dev-only credentials.
if "$ENGINE" container exists principal-pg >/dev/null 2>&1 || "$ENGINE" inspect principal-pg >/dev/null 2>&1; then
  if [ "$("$ENGINE" inspect -f '{{.State.Running}}' principal-pg 2>/dev/null)" != "true" ]; then
    echo "Starting the existing principal-pg container..."
    "$ENGINE" start principal-pg >/dev/null || die "could not start principal-pg. Check: $ENGINE logs principal-pg"
  fi
else
  echo "Creating the principal-pg Postgres container (port 5432)..."
  "$ENGINE" run -d --name principal-pg -p 5432:5432 \
    -e POSTGRES_USER=principal -e POSTGRES_PASSWORD=principal -e POSTGRES_DB=principal \
    postgres:17 >/dev/null || die "could not create principal-pg (is port 5432 in use?)"
fi
echo -n "Waiting for Postgres"
pg_ok=""
for _ in $(seq 1 60); do
  if "$ENGINE" exec principal-pg pg_isready -U principal -d principal >/dev/null 2>&1; then pg_ok=1; break; fi
  echo -n "."
  sleep 1
done
echo
[ -n "$pg_ok" ] || die "Postgres did not become ready. Check: $ENGINE logs principal-pg"

# --- Keys ------------------------------------------------------------------------------------
for key in "$ADMIN_KEY" "$TREASURY_KEY"; do
  if ! stellar keys address "$key" >/dev/null 2>&1; then
    echo "Generating key $key..."
    stellar keys generate "$key" --network "$NETWORK" >/dev/null
  fi
  addr="$(stellar keys address "$key")"
  funded=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$HORIZON_URL/accounts/$addr" || true)"
    if [ "$code" = "200" ]; then funded=1; break; fi
    # Friendbot may still be starting; retry quietly.
    stellar keys fund "$key" --network "$NETWORK" >/dev/null 2>&1 || true
    sleep 2
  done
  [ -n "$funded" ] || die "could not fund $key ($addr) through friendbot at $FRIENDBOT_URL"
  echo "  $key  $addr"
done

echo "Local network is up. Next: MATURITY_SECONDS=3600 scripts/dev-stack/deploy.sh"
