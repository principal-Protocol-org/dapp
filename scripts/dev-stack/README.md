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
  `origin/feat/tranche-1-mvp`, which is `665bb67` today) and `MATURITY_SECONDS` (default `3600`). It extracts the sources with
  `git archive` into `$TMPDIR/principal-dev-stack/<commit>` (read-only for the repository, cached per
  commit), builds the WASM, issues `USDY` (`ASSET_CODE`, default `USDY`, shown as "USDY (test)"; AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED) from
  `principal-localdev-admin`, deploys its SAC, and runs steps 1-11 of the repository's
  `docs/DEPLOYMENT.md`. It then deposits 200,000 USDY, mints PT/YT from 100,000 SY, and seeds the
  pool with all the PT and 95 % of its value in SY. It also deploys the stateless `MarketFactory` (its address is `shared.factory`, the wasm hashes of the seven market contracts are recorded) and runs `scripts/db-migrate.mjs` when that file exists (migrations 0001 to 0003; 0003 adds `market_salts`). Every run deploys a new market and overwrites `config/manifests/local.json`.
  Allow for the run: a deploy takes a few minutes, so do not set `MATURITY_SECONDS` below about 600.
- The OracleAdapter is v2, which the dApp requires (R4-9). `deploy.sh` initializes it with
  `max_stale_seconds = 3600` and `max_deviation_bps = 1000`, sets one primary source and no
  fallback (`set_sources`, signed by the oracle admin), and pushes the genesis value `10000000`
  (1.0). The primary source id is `sha256("principal-oracle-source:<network>:<ASSET_CODE>:app-team:keeper")`
  in hex; on the local stack, the hash of `principal-oracle-source:local:USDY:app-team:keeper`.
- `oracle-tick.sh [--apy <percent>] [rate]` sets the oracle to `rate` (7 decimals, `10000000` = 1.0) or, by default,
  to current x (1 + apy/100)^(elapsed/year) with `--apy` defaulting to 5 and elapsed counted from the last reference
  timestamp (rounded down, never decreasing); an explicit rate wins. The value is stamped with the latest ledger close time
  and sent under the oracle's primary source (`get_primary_source()`). The oracle is stale after
  one hour; the ticks keep minting, swaps and quotes working. Rates cannot go down.
  A v2 oracle may refuse a value: `set_reference_value` then returns `false` in a successful
  transaction, and the script fails with the oracle's `last_rejection()`. It also fails on an oracle
  with no primary source (a v1 oracle, or one never given `set_sources`).

Outputs (both git-ignored; never commit them):

- `config/manifests/local.json`: a v2 manifest (shared contracts, factory, `wasmHashes`, `routerFunctions` (every Router function the wasm exposes except the `quote_*` views), `testAsset`, one market).
- `.env.local`: `NEXT_PUBLIC_PRINCIPAL_NETWORK=local`, `FAUCET_ISSUER_SECRET` (the
  `principal-localdev-admin` secret, valid on this throwaway network only) and `DATABASE_URL` for `principal-pg`.

## Testnet

`PRINCIPAL_NETWORK=testnet scripts/dev-stack/deploy.sh` runs the same deployment on Stellar
Testnet, as an interim market until the contract team's Deliverable 1 manifest replaces it. There
is no `up.sh` step: the script creates and funds (friendbot) four keys in the Stellar CLI keystore,
and the roles are split so the server never holds the protocol admin:

| Key | Role | Where it lives |
|---|---|---|
| `principal-testnet-admin` | Admin of every market contract, the Router and the factory; SAC admin of the test asset (every Principal contract requires its admin to be the SAC admin) | This machine only |
| `principal-testnet-treasury` | Receives the fee shares | This machine only |
| `principal-testnet-issuer` | Classic issuer of the test asset and Permissioning admin: the faucet's key | Server: `FAUCET_ISSUER_SECRET` |
| `principal-testnet-oracle` | OracleAdapter admin: can only push the value | Server: `ORACLE_ADMIN_SECRET` |

- `MATURITY_SECONDS` defaults to 90 days on testnet. The market id is `testnet-usdy-<maturity>`.
- It writes `config/manifests/testnet.json` (committed: public addresses and hashes only), no env
  file and no database migration. Apply migration 0003 to the Testnet database yourself
  (`pnpm db:migrate --env-file .env.testnet`). It never prints a secret: copy them yourself with
  `stellar keys secret <name>` into the testnet environment of the hosting.
- The oracle is kept fresh by the app's `/api/cron/oracle` schedule (see the main README);
  `PRINCIPAL_NETWORK=testnet scripts/dev-stack/oracle-tick.sh` does it by hand.
- Every run deploys a new market and overwrites `testnet.json` (or writes `MANIFEST_OUT` when set).

### Ephemeral deploy (end-to-end suites, local experiments)

Extra variables, all optional:

| Variable | Effect |
|---|---|
| `MANIFEST_OUT=<path>` | Writes the manifest there instead of `config/manifests/<network>.json`, and writes no `.env.*` (locally it also skips the database migration). |
| `EPHEMERAL=1` | Throwaway market on Testnet. Requires `MANIFEST_OUT` and `PRINCIPAL_NETWORK=testnet`; never writes `config/manifests/*`, `.env.*` or touches a database; prints no cron/QStash notes. `MANIFEST_OUT` must be a new (or empty) file outside the dApp repository, not a symlink or directory. Refuses key names starting with `principal-` (any letter case), names that already exist in the keystore, and repeated names, so a local run can never sign with, or delete, the official keys. |
| `ADMIN_KEY`, `TREASURY_KEY`, `ISSUER_KEY`, `ORACLE_KEY` | Keystore names for the four roles on Testnet (defaults `principal-testnet-*`). Use run-unique names, e.g. `e2e-<runid>-admin`. They also apply to `oracle-tick.sh` (`ORACLE_KEY`). A non-ephemeral Testnet deploy that rewrites `testnet.json` refuses non-default names and a non-3600 `ORACLE_MAX_STALE_SECONDS` unless `ALLOW_TESTNET_OVERRIDES=1`. |
| `ORACLE_MAX_STALE_SECONDS` | Oracle freshness window passed to `initialize` (default `3600`). |

Missing names are generated and funded by the script itself (`stellar keys generate <name>`, then Friendbot
through `ensure_funded_key`). Afterwards remove them, since the secrets live in the local keystore:

```bash
RUNID=${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-0}-$$
EPHEMERAL=1 MANIFEST_OUT="$(mktemp -d)/manifest.json" PRINCIPAL_NETWORK=testnet \
  ADMIN_KEY=e2e-$RUNID-admin TREASURY_KEY=e2e-$RUNID-treasury ISSUER_KEY=e2e-$RUNID-issuer ORACLE_KEY=e2e-$RUNID-oracle \
  ORACLE_MAX_STALE_SECONDS=300 scripts/dev-stack/deploy.sh
# cleanup afterwards (--force skips the confirmation prompt):
for r in admin treasury issuer oracle; do stellar keys rm "e2e-$RUNID-$r" --force; done
```

## Keep the oracle fresh

The oracle goes stale after about 1 h. A stale oracle refuses most writes and the app shows
"Unavailable". Run `scripts/dev-stack/oracle-tick.sh` again (every 30 minutes is enough).

## Postgres: `principal-pg`

`up.sh` starts a `postgres:17` container named `principal-pg` on port 5432 and `deploy.sh` writes its
`DATABASE_URL` to `.env.local`. It holds the recorder's tables (`pnpm db:migrate` creates them; `deploy.sh`
runs it for you). Call `GET /api/cron/record` with `Authorization: Bearer $CRON_SECRET` (set a throwaway
`CRON_SECRET` in `.env.local`) to record a snapshot by hand. `podman rm -f principal-pg` drops the data.

## Integration suites

`pnpm test:integration` (from the repository root) runs against the market in
`config/manifests/local.json`:

| Suite | What it proves |
|---|---|
| `routes.test.ts` | Every trade route, Quick actions, and interruption and unwind, signed on the local network. |
| `curve.test.ts` | The off-chain curve port equals the pool's quote views. |
| `registry.test.ts` | Market discovery and validation against the real contracts and `principal-pg`. |
| `history.test.ts` | The history queries, and the recorder writing one snapshot of the live market to `principal-pg` (the row is deleted afterwards). |
| `oracle.test.ts` | The OracleAdapter v2 policy read through the app's reader (the primary source id above, no fallback, no rejection, 3,600 s, 1,000 bps), and one keeper tick (`tickOracle`, behind `/api/cron/oracle`) that reports `updated`. |
| `lifecycle.test.ts` | The full lifecycle proof of plan 0001. Skipped unless `LIFECYCLE_REDEPLOY=1`. |
| `wizard.test.ts` | The market-creation wizard's seven steps signed on the local network, then a fresh account trading the new market. Skipped unless `WIZARD_LIVE=1`. |

- The suites sign with the throwaway dev accounts (`principal-localdev-admin`, `principal-localdev-treasury`).
- Cases that need a market near maturity are skipped.
- `lifecycle.test.ts` deploys a new market and rewrites `local.json`. Run it
  (`LIFECYCLE_REDEPLOY=1 pnpm test:integration`) only on a stack nobody is using.
- `wizard.test.ts` creates a new market through the factory and publishes it to the registry. The
  market stays on the local chain and in `/app` for good (deleting its registry row does not remove
  it: the recorder lists it again from the Router's event), so each run adds one. Run it
  (`WIZARD_LIVE=1 pnpm test:integration`) only when that is wanted. It needs `principal-pg` with the
  migrations applied (`pnpm db:migrate`).

## Teardown

```bash
stellar container stop local --docker-host "unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
podman machine stop   # optional
```

Stopping the container discards the chain; `podman rm -f principal-pg` drops the database. Run `up.sh` and `deploy.sh` again afterwards (the keys
are reused).
