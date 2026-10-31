# Local development stack

Dev-only scripts that run a local Stellar network with a real, seeded Principal market, so every
dApp flow works without the Testnet deployment. Nothing here is used in production.

Requirements: the Stellar CLI (v28), `jq`, `node`, a Rust toolchain with the `wasm32v1-none` target,
and Podman (an existing machine) or Docker.

## Use

```bash
scripts/dev-stack/up.sh                                   # network, Postgres + dev-only keys (see below)
MATURITY_SECONDS=3600 scripts/dev-stack/deploy.sh         # build, deploy one market, seed, write outputs
NEXT_PUBLIC_PRINCIPAL_NETWORK=local pnpm dev              # or pnpm build
scripts/dev-stack/oracle-tick.sh                          # run this every 30 minutes (grows ~5 %/year)
```

- `up.sh` starts the existing Podman machine if it is stopped (it never creates one), points the
  Stellar CLI at the Podman socket through `DOCKER_HOST`, starts (or reuses) a `postgres:17` container named `principal-pg` on port 5432 (user, password and
  database `principal`; safe to re-run), runs `stellar container start local`
  (the first run pulls the `stellar/quickstart` image), waits for `getHealth`, and creates and
  funds two dev-only keys in the Stellar CLI keystore, `principal-localdev-admin` and
  `principal-localdev-treasury`. The names are deliberately unlike any real key: the admin's secret is
  written to `.env.local`, so a real identity must never share them.
- `deploy.sh` reads `PRINCIPAL_REPO` (default `../principal`), `PRINCIPAL_REF` (default
  `origin/feat/tranche-1-mvp`) and `MATURITY_SECONDS` (default `3600`). It extracts the sources with
  `git archive` into `$TMPDIR/principal-dev-stack/<commit>` (read-only for the repository, cached per
  commit), builds the WASM, issues `USDY` (`ASSET_CODE`, default `USDY`, shown as "USDY (test)"; AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED) from
  `principal-localdev-admin`, deploys its SAC, and runs steps 1-11 of the repository's
  `docs/DEPLOYMENT.md`. It then deposits 200,000 USDY, mints PT/YT from 100,000 SY, and seeds the
  pool with all the PT and 95 % of its value in SY. It also deploys the stateless `MarketFactory` (its address is `shared.factory`, the wasm hashes of the seven market contracts are recorded) and runs `scripts/db-migrate.mjs` when that file exists. Every run deploys a new market and overwrites `config/manifests/local.json`.
  Allow for the run: a deploy takes a few minutes, so do not set `MATURITY_SECONDS` below about 600.
- `oracle-tick.sh [--apy <percent>] [rate]` sets the oracle to `rate` (7 decimals, `10000000` = 1.0) or, by default,
  to current x (1 + apy/100)^(elapsed/year) with `--apy` defaulting to 5 and elapsed counted from the last reference
  timestamp (rounded down, never decreasing); an explicit rate wins. The value is stamped with the latest ledger close time. The oracle is stale after
  one hour; the ticks keep minting, swaps and quotes working. Rates cannot go down.

Outputs (both git-ignored; never commit them):

- `config/manifests/local.json`: a v2 manifest (shared contracts, factory, `wasmHashes`, `routerFunctions`, `testAsset`, one market).
- `.env.local`: `NEXT_PUBLIC_PRINCIPAL_NETWORK=local`, `FAUCET_ISSUER_SECRET` (the
  `principal-localdev-admin` secret, valid on this throwaway network only) and `DATABASE_URL` for `principal-pg`.

## Teardown

```bash
stellar container stop local --docker-host "unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
podman machine stop   # optional
```

Stopping the container discards the chain; `podman rm -f principal-pg` drops the database. Run `up.sh` and `deploy.sh` again afterwards (the keys
are reused).
