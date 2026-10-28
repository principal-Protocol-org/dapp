# Local development stack

Dev-only scripts that run a local Stellar network with a real, seeded Principal market, so every
dApp flow works without the Testnet deployment. Nothing here is used in production.

Requirements: the Stellar CLI (v28), `jq`, `node`, a Rust toolchain with the `wasm32v1-none` target,
and Podman (an existing machine) or Docker.

## Use

```bash
scripts/dev-stack/up.sh                                   # network + dev-only keys (see below)
MATURITY_SECONDS=3600 scripts/dev-stack/deploy.sh         # build, deploy one market, seed, write outputs
NEXT_PUBLIC_PRINCIPAL_NETWORK=local pnpm dev              # or pnpm build
scripts/dev-stack/oracle-tick.sh                          # run this every 30 minutes
```

- `up.sh` starts the existing Podman machine if it is stopped (it never creates one), points the
  Stellar CLI at the Podman socket through `DOCKER_HOST`, runs `stellar container start local`
  (the first run pulls the `stellar/quickstart` image), waits for `getHealth`, and creates and
  funds two dev-only keys in the Stellar CLI keystore, `principal-localdev-admin` and
  `principal-localdev-treasury`. The names are deliberately unlike any real key: the admin's secret is
  written to `.env.local`, so a real identity must never share them.
- `deploy.sh` reads `PRINCIPAL_REPO` (default `../principal`), `PRINCIPAL_REF` (default
  `origin/feat/tranche-1-mvp`) and `MATURITY_SECONDS` (default `3600`). It extracts the sources with
  `git archive` into `$TMPDIR/principal-dev-stack/<commit>` (read-only for the repository, cached per
  commit), builds the WASM, issues `STA` (AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED) from
  `principal-localdev-admin`, deploys its SAC, and runs steps 1-11 of the repository's
  `docs/DEPLOYMENT.md`. It then deposits 200,000 STA, mints PT/YT from 100,000 SY, and seeds the
  pool with all the PT and 95 % of its value in SY. Every run deploys a new market and overwrites `config/manifests/local.json`.
  Allow for the run: a deploy takes a few minutes, so do not set `MATURITY_SECONDS` below about 600.
- `oracle-tick.sh [rate]` sets the oracle to `rate` (7 decimals, `10000000` = 1.0) or, by default, to
  the current rate plus 0.01 %, stamped with the latest ledger close time. The oracle is stale after
  one hour; the ticks keep minting, swaps and quotes working. Rates cannot go down.

Outputs (both git-ignored; never commit them):

- `config/manifests/local.json`: network, contract ids and per-contract `wasmHashes`.
- `.env.local`: `NEXT_PUBLIC_PRINCIPAL_NETWORK=local` and `FAUCET_ISSUER_SECRET` (the
  `principal-localdev-admin` secret, valid on this throwaway network only).

## Teardown

```bash
stellar container stop local --docker-host "unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
podman machine stop   # optional
```

Stopping the container discards the chain. Run `up.sh` and `deploy.sh` again afterwards (the keys
are reused).
