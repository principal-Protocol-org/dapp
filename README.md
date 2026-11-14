# Principal dApp

The browser app for the Principal PT/YT yield-tokenization protocol on Stellar. With a Varial
wallet (formerly Freighter) you can split a yield-bearing asset into a principal token (PT) and a yield token (YT),
trade them, provide liquidity, claim yield and redeem at maturity. It runs on Stellar Testnet and
on a local network. It is Deliverable 2 of Tranche 2 of SCF #45.

## Routes

| Route | What it shows |
|---|---|
| `/` | The landing page. |
| `/app` | Markets grouped by asset, one row per maturity, with fixed APY, 30-day spark line, liquidity and status. |
| `/app/markets/[marketId]` | One market: stats and chart (fixed against variable rate), the info card (Details, Compliance, Safety), and the action panel (PT, YT and LP tabs, plus Quick actions). |
| `/app/portfolio` | Your PT, YT and LP positions and pending yield; claim yield. |
| `/app/history` | Your transactions, read from RPC events and a local log. |
| `/app/manage` | Manager view: the markets where your wallet holds a role, with the actions that role can sign, and the half-finished markets you can resume. |
| `/app/manage/new` | The market-creation wizard (seven steps). See "Manager view and the wizard". |
| `POST /api/faucet` | Server route behind "Get test tokens". |
| `GET` or `POST /api/cron/record` | The rate recorder, called by a scheduler. Both methods run the same checks. Refuses any other caller. |
| `GET` or `POST /api/cron/index` | The event indexer, called by a scheduler. Same checks as the recorder. See "Event indexer". |
| `GET /api/dashboard/events` | The indexed protocol events, public and read-only. See "Event indexer". |
| `GET /api/dashboard/oracle-ticks` | The oracle keeper's recorded runs and its health, public and read-only. See "Scheduler". |
| `GET` or `POST /api/cron/alerts` | The alert check, called by a scheduler. Same checks as the recorder. See "Alerts". |
| `GET /api/dashboard/alerts` | The open alerts, the last 7 days of alerts and the last webhook test, public and read-only. See "Alerts". |
| `GET /api/health` | What the server sees (latest ledger, index, keeper, open alerts), public, for uptime monitors. See "Alerts". |

## Trade flows

Each trade is one signature when the manifest's `routerFunctions` lists the Router function it
needs. Otherwise the planner falls back to a multi-step route and says why.

- **Buy PT and Sell PT**, paid or received in USDY: one signature.
- **Buy YT** is a flash swap, for an SY payer and for a USDY payer. No temporary capital: the
  pool lends the SY inside the call. The budget is sized from the quote, and the review shows the net cost.
- **Sell YT** to USDY: one signature.
- **LP only** (Keep YT off), from SY or from USDY: one signature. The pool keeps the PT dust.
- **LP withdraw** before maturity pays out USDY in one signature.
- **Keep YT** (add liquidity and keep the minted YT): one signature, with the contract's new arguments.
- The sales, Buy YT and the LP withdraw sweep only what the call produced (gain-based), so SY or PT
  already in the wallet no longer blocks them.
- The PrincipalManager's pause is read (`is_paused`) and shown like the other pauses. While it is
  paused, mint, YT, claim and redeem actions are blocked.

## Network selection

`NEXT_PUBLIC_PRINCIPAL_NETWORK` selects the network: `testnet` (the default) or `local`. It is read
at build time, so set it before `pnpm dev` or `pnpm build`. Both manifests are imported statically
by `lib/protocol/manifest-source.ts`. The app refuses to sign when the wallet is on another network.

## Manifest

Every contract address comes from a manifest, never from code. Each network has one file in
`config/manifests/`, validated with zod (`lib/protocol/manifest.ts`) at build time and again at
runtime. Its format is `manifestSchema` in
[`lib/protocol/manifest.ts`](lib/protocol/manifest.ts): network settings,
`shared` contracts, and a `markets[]` list with the underlying, maturity and nine contract IDs per
market.

- The app targets the contracts at `principal` `665bb67`: OracleAdapter v2, the one-transaction
  Router functions (flash Buy YT, LP only and LP withdraw in USDY, the sales, Keep YT), the gain-based
  sweeps and `PrincipalManager.is_paused`. They are used when the manifest's `routerFunctions` lists them.
  `deploy.sh` leaves the Router's `quote_*` views out of that list.
- `testnet.json` is committed. It holds the official Testnet deployment, the app team's, made with
  `PRINCIPAL_NETWORK=testnet scripts/dev-stack/deploy.sh` from `principal` at `665bb67`: one market,
  `testnet-usdy-1802336344` (USDY test asset), with `wasmHashes` pinned, a v2 oracle and the
  one-transaction Router functions. It replaced the earlier interim deployments
  (`testnet-usdy-1801581040` from `97ac23e`, and `testnet-usdy-1801356335` from `be2a1a5`), whose
  contracts stay on-chain unused. The contracts team's own pipeline (`principal` `scripts/deploy/`) deployed a separate
  proof market that the app does not use. Tests use a frozen copy of the earlier
  interim file (`lib/protocol/__tests__/fixtures/testnet-interim.json`); they only check that the
  committed file is valid, so a new deployment never breaks them.
- `rpcFallbackUrls` (optional, https off the local network): RPC endpoints tried in order when
  `rpcUrl` fails a read for a reason that is not the contract's (a network error, a timeout, HTTP 5xx
  or 429, the RPC's busy answer `-32004`). A contract's own error is never asked again elsewhere. Each
  read records the endpoint that answered, and a page's "Ledger N" line adds "via fallback <host>"
  when one of its reads came from a fallback.
- `local.example.json` is a committed example. `local.json` is generated by the local stack and is
  git-ignored. `pnpm dev`, `build`, `test` and `typecheck` copy the example there if it is missing.
- Each market should pin `wasmHashes` (the Wasm hash of each contract, in hex). Restoring archived
  contract code is refused without them, and the registry hides a market whose code it cannot
  check.

## Manager view and the wizard

`/app/manage` lists the markets where the connected wallet holds a role, with the oracle, the
liquidity, the pause state of the contracts it administers, the fees to claim, and the actions that
role can sign (Pause or Unpause for the pool, the SY wrapper and the manager, and the fee claims). Every call goes through the same review and signature path as a
trade. Half-finished markets are listed too, for the underlying's SAC admin and the protocol admin.

`/app/manage/new` creates a market in seven steps. The `?salt=` in the URL fixes the market's
addresses, and where the market stands is read from the chain, never from a saved draft.

| Step | What it does | Who signs |
|---|---|---|
| 1. Parameters | Maturity, fees, treasury and the curve parameters. Defaults come from the current market. | Nobody |
| 2. Addresses | Shows the seven addresses the salt gives (`predict_market`). | Nobody |
| 3. Deploy | The factory's `create_tokens`, `create_engine` and `create_pool_and_escrow`, one transaction each. | The underlying SAC's `admin()` |
| 4. Wire | RiskControl lists the SY wrapper and the manager as consumers; the Router registers the pool. | RiskControl admin, Router admin |
| 5. Grants | The compliance grants (asset `set_authorized`, Permissioning `grant_account` and `grant_asset`), each read from the chain. Only the missing ones are offered. | The SAC admin for the asset, the Permissioning admin for the rest |
| 6. Seed the pool | Mints and deposits from a starting fixed APY and an amount, then adds the first liquidity. PT must stay below par. | The SAC admin (the market's issuer) |
| 7. Publish | Posts the pool to the registry so the market appears in `/app`. Nothing is signed. | Nobody |

- **Resume.** A step that another wallet must sign names that account, and can be finished from that
  wallet. The factory indexes each market's salt (migration 0003, table `market_salts`), so
  `/app/manage` shows "Resume at step N" from any browser. Opening the link also resumes it.
- **Publish.** The registry checks the market like any discovered one, and lists it as `published`
  only when it passes. A refresh of `/app` then shows it.

## Environment variables

Copy `.env.example` to `.env.local`. Never commit real keys.

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_PRINCIPAL_NETWORK` | Browser and server | `testnet` (default) or `local`. |
| `FAUCET_ISSUER_SECRET` | Server only | Required for "Get test tokens". Secret key of the test asset issuer. |
| `FAUCET_PERMISSIONING_ADMIN_SECRET` | Server only | Optional. Defaults to the issuer key. |
| `DATABASE_URL` | Server only | Postgres for the market recorder (pooled string on Neon; the local stack writes one for `principal-pg`). |
| `DATABASE_URL_UNPOOLED` | Server only | Optional. Direct connection for migrations; else `DATABASE_URL` with `-pooler` removed from the host. |
| `CRON_SECRET` | Server only | Optional. Bearer secret Vercel Cron sends to `GET /api/cron/record`. Unset, the route refuses every Bearer call. |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Server only | Verify Upstash QStash signatures on the cron routes. |
| `ORACLE_ADMIN_SECRET` | Server only | Testnet and local only. The oracle admin key `GET`/`POST /api/cron/oracle` signs with (see Scheduler). It is the OracleAdapter's admin: besides pushing the value, it can change the oracle's window, deviation cap, sources and value bounds, and hand the role over. Never set on mainnet: the route refuses to run there. |
| `ORACLE_KEEPER_MODE` | Server only | `push` (default) or `feed`: how `cron/oracle` keeps the oracle fresh. Until the feed mode ships, the route runs push only. |
| `ORACLE_KEEPER_SECRET` | Server only | Feed mode's key: funded, with no protocol role. In feed mode the alert check watches its XLM. |
| `ALERT_WEBHOOK_URL` | Server only | Where `cron/alerts` posts each alert it opens or closes (Slack or Discord incoming webhook, or any http(s) endpoint). Never logged or answered. Unset, the check answers 503 `not_configured`. |
| `ALERT_SIGNER_MIN_XLM` | Server only | Optional. The keeper signer's XLM floor for `signer_low` (default 20). |

`pnpm db:migrate [--env-file .env.testnet]` applies `db/migrations/*.sql` over a direct connection and
never prints the connection string. Run it on each Neon branch (testnet, mainnet) before you deploy
to it:

```bash
pnpm db:migrate --env-file .env.testnet
pnpm db:migrate --env-file .env.mainnet
```

The `FAUCET_*`, `DATABASE_URL`, `CRON_SECRET`, `QSTASH_*`, `ORACLE_ADMIN_SECRET`, `ORACLE_KEEPER_*` and
`ALERT_*` variables are read only in files that start with `import "server-only"` (a unit test checks
it). CI fails the build if `FAUCET_`, `DATABASE_URL`, `CRON_SECRET`, `QSTASH_`, `ORACLE_ADMIN_`,
`ORACLE_KEEPER_`, `ALERT_WEBHOOK` or `ALERT_SIGNER` appears in `.next/static`. The local stack writes its own throwaway secret to
`.env.local`, which is git-ignored.

## Rate recorder and database

A scheduled job calls `/api/cron/record` (GET or POST) every 15 minutes. For each registered market it reads
the pool, the manager and the oracle at one ledger and stores one row per market per 15-minute slot
in `market_state_snapshots`. A retry does not duplicate a row. A failed read stores nothing for
that market. The charts and the market list read these rows; a gap stays a gap.

The route answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ recorded, failed }` | No market failed. |
| 401 | | The caller sent neither a valid `Authorization: Bearer $CRON_SECRET` nor a valid QStash signature. |
| 503 | `{ error: "not_configured" }` | `DATABASE_URL` is missing. |
| 500 | `{ recorded, failed }` with a non-empty `failed` | At least one market failed (an unexpected error answers `{ error: "failed" }`, also 500). Schedulers alert on non-2xx; the retry is safe. |

### Scheduler

One Vercel project serves both networks. Each environment calls the recorder through its own Upstash
QStash account, because Vercel Cron runs only on Production deployments.

| Branch | Vercel environment | Domain | QStash | Network |
|---|---|---|---|---|
| `testnet` | Preview, branch `testnet` | `testnet.principalmarket.fi`, public through a Deployment Protection exception | `principalmarket-testnet` | Testnet |
| `main` | Production | `principalmarket.fi` | `principalmarket-mainnet` | Mainnet, once supported (Tranche 3) |

For each environment:

- Create a QStash schedule with cron `*/15 * * * *` that calls the exact URL
  `https://<domain>/api/cron/record`, on the final host (no redirect). POST is QStash's default; the
  route accepts GET and POST with the same checks.
- Set `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` from that QStash account. A
  signature is bound to the URL it was sent to; the route checks it against the URL the request
  came in on, so no URL variable is needed in any environment. That URL is trusted only where
  Vercel sets the host, so QStash calls are accepted only on Vercel (`VERCEL=1`, set when the
  project exposes system environment variables, the default); elsewhere use `CRON_SECRET`.
- Keep the environment's secrets (faucet key, `DATABASE_URL`, QStash keys) in that environment only:
  scope the testnet ones to the `testnet` branch, so Preview deployments of other branches get none
  of them. Those other previews stay behind Vercel Authentication.
- No `vercel.json` and no `CRON_SECRET` are needed.

On testnet a second schedule keeps the oracle fresh: cron `*/30 * * * *` to
`https://<domain>/api/cron/oracle`. The OracleAdapter's value is fresh for the oracle's own
`max_stale_seconds` (3600 s on the app team's deployments) and only its admin may push one, so the
route signs with `ORACLE_ADMIN_SECRET`, a key that is the oracle's admin and nothing else. It checks
that key against the oracle's `get_admin` before it sends anything, then pushes the value grown at
5 % a year for the time elapsed, under the oracle's primary source (`get_primary_source()`). It
answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ status: "updated" \| "unchanged", mode, signer, value, timestamp }` (`hash` when updated) | The value was pushed, or the ledger clock has not moved since the last one. `mode` is `push`; `signer` is the key's public key. |
| 500 | `{ status: "rejected", mode, signer, value, timestamp, hash, reason }` | The oracle refused the value: `set_reference_value` returned `false` in a successful transaction. `reason` is from the oracle's `last_rejection()`. The route also logs it as an error. |
| 503 | `{ error: "not_configured" }` | No key, a key that is not the oracle admin, an oracle with no primary source, or mainnet. |
| 500 | `{ error: "failed" }` | Anything else, including a v1 oracle, which has no `get_primary_source()`. |

Every run, whatever its answer, writes one row to `oracle_ticks` (migration 0004): its time, mode,
decision (`pushed`, `skipped`, `rejected` or `error`; `synced` is for the feed mode), value, reason,
tx hash and signer (a public key). An error's reason is `not_configured: <the route's own words>` or
`failed: <error name>`, never an error's text. A transaction the keeper sent that did not land keeps
its hash, with `failed: <result code>` (e.g. `invokeHostFunctionTrapped`) or `failed: not confirmed`. A row that cannot be written (no `DATABASE_URL`, a
database down) is logged by error name and never changes the answer.
`GET /api/dashboard/oracle-ticks?limit=` (1 to 100, default 20) serves them, public and without a
wallet, for this network's oracle: `{ ticks, health, intervalSeconds }`, newest first, cached 60 s
at the edge, errors never cached (503 `not_configured` or `unavailable`). `health` is
`{ healthy, lastSuccessAt, lastTickAt, rejected24h, failures24h }`: healthy while the last success
(`pushed` or `synced`; a skipped run changes nothing, so it is none) is younger than
2 × `intervalSeconds` (1,800 s, the schedule). `lastTickAt` null means no run is recorded: an unknown
state, which the oracle page reads "No keeper run recorded yet". The answer is cached, so the page
measures the last success's age itself, on the ledger clock, with the same rule.

Do not create the mainnet schedule before the dApp supports Mainnet. `NEXT_PUBLIC_PRINCIPAL_NETWORK`
accepts `testnet` or `local` only, so the recorder would write Testnet data into the mainnet database.

Vercel Cron also works, on Production only: add
`{ "crons": [{ "path": "/api/cron/record", "schedule": "*/15 * * * *" }] }` to `vercel.json` and set
`CRON_SECRET`. Vercel then sends `Authorization: Bearer $CRON_SECRET`. Vercel Hobby rejects
sub-daily crons at deploy time.

### Neon

- Put `sslmode=verify-full` in both connection strings.
- `DATABASE_URL` is the pooled string (host with `-pooler`). The app uses `pg` with a small pool.
- A Neon compute scales to zero. The first query after idle waits while it wakes. The pool allows
  `connectionTimeoutMillis` of 5 s for that, so the first cron run of the day may be slow but
  should not fail. Page renders do not wait: they fall back to the manifest markets after 1.5 s.
- Never put a real connection string or secret in this repository. Use `.env.local`, `.env.testnet`
  and `.env.mainnet` (all git-ignored) and the Vercel project settings.

## Event indexer

A scheduled job calls `/api/cron/index` (GET or POST) every 5 minutes. It reads the protocol's
contract events with the RPC's `getEvents` into the `events` table (migrations 0004 to 0006), one
row per RPC event id, so a retry or two overlapping runs never duplicate a row. Each row keeps the
contract, topic, ledger, close time, transaction hash, the market's pool, the decoded fields (`data`)
and the event value as the RPC sent it (`raw_xdr`, base64 XDR of the `ScVal`; decode it with
`stellar xdr decode --type ScVal`).

Contracts are indexed in five groups, each with its own cursor in `ingest_cursor`
(`events:<group>:<network>`):

| Group | Contracts |
|---|---|
| `market` | Every listed market's SY wrapper, manager and pool |
| `escrow` | Every listed market's RecoveryEscrow |
| `oracle` | The shared OracleAdapter |
| `permissioning` | The shared Permissioning contract |
| `risk` | The shared RiskControl contract |

- A first run starts at the manifest's `deployLedger`, or at the RPC's oldest ledger if that is
  later. The RPC keeps about 7 days on Testnet.
- Each run reads pages of 200 events (at most 5 contracts per request), saves the cursor after
  every page, and starts no page after its 50 s budget. The next run resumes there.
- A cursor only moves forward. A run that is behind cannot rewind one that is ahead.
- A cursor names the contracts it has read through its ledger (`members`). Any other contract of
  its group (a market listed after its creation, a market a run could not list because the registry
  read failed, a new deployment in the manifest) is read in its own requests from the manifest's
  `deployLedger` until it catches up. The cursor moves only once every contract has.
- When a cursor (or `deployLedger`) is older than the RPC's oldest ledger, the run goes on from the
  oldest ledger and records the gap. The save that moves the cursor past it also stores it on the
  cursor (`gap_from`, `gap_to`, widened if one is already open), so a cursor never passes a gap
  without recording it. It never skips silently. A stored gap stays until an import fills it; the
  read API lists it (`gaps`), and monitoring reads it from `ingest_cursor` (`gap_from is not null`).
- When the escrow group finishes within the budget, the run compares every RecoveryEscrow's
  `record_count` with its indexed `recovery` events, and keeps the result on the escrow cursor
  (`reconcile`, with its time). A run cut short by the budget skips it.

The route answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ inserted, groups, reconcile }` | Each group: `indexedThrough`, `gap`, `complete` (false when the budget ran out). Each escrow: `recordCount`, `indexed`, `ok`. |
| 401 | | The caller sent neither a valid `Authorization: Bearer $CRON_SECRET` nor a valid QStash signature. |
| 503 | `{ error: "not_configured" }` | `DATABASE_URL` is missing. |
| 500 | The same body, a group with `error: "failed"`, or `{ error: "failed" }` | The RPC failed. The next run resumes at the cursor. |

Schedule (ops, with the developer's go): a QStash schedule with cron `*/5 * * * *` to
`https://<domain>/api/cron/index`, as for the recorder. Apply migrations 0004 to 0006 to the
network's database first (`pnpm db:migrate --env-file .env.testnet`).

`GET /api/dashboard/events` serves the index, public and without a wallet. `?group=`, `?pool=`,
`?topic=<a,b,…>` (at most 10 topics, filtered in the query so a page holds only them),
`?before=<event id>` (older rows, for paging) and `?limit=` (1 to 200, default 50) filter the list.
`?counts=1` adds `counts`: the number of indexed events per topic for the group and pool asked, over
every row, not one page (the compliance page's Permissioning counts).
It answers `{ rows, indexedThrough, indexedThroughCloseTime, lagSeconds, gaps, reconcile }`, newest
first and cached 60 s at the edge: `indexedThrough` is the slowest group's cursor, and
`indexedThroughCloseTime` its close time, from which a page computes a fresh lag whatever the cache's
age. `gaps` lists the stored gaps (`{ group, from, to }`), and `reconcile` the last reconciliation.
Rows never carry the raw XDR; `?id=<event id>` answers `{ event }` with its `rawXdr`.

Operator commands (`scripts/indexer.mjs`). The database is `--database-url <url>`, else the
`DATABASE_URL` of `--env-file <path>`, else `DATABASE_URL`, else `.env.local`'s. None prints it, but
pnpm echoes the command line and the shell keeps it: use `--env-file` for a real database.

```bash
pnpm indexer:reindex --network testnet --group escrow --from 5710000            # read the group again from that ledger
pnpm indexer:export --network testnet --out events.jsonl                         # events rows and cursors, as JSON Lines
pnpm indexer:import --network testnet --in events.jsonl --env-file .env.testnet  # upsert them (see below)
pnpm indexer:capture --network testnet                                           # list the markets, index them locally, export
```

- `reindex` sets the group's cursor to the ledger before `--from`. Rows already indexed are kept,
  and the events read again are not duplicated. It refuses to move a cursor forward. A `--from`
  older than the RPC's oldest ledger (or one it cannot check) needs `--force`: the next run would
  record those ledgers as a gap, which the index may already hold from an import. Run it when no
  indexer run is in progress, or that run may move the cursor on again.
- `import` needs `--network` and refuses a file, or a line, of another network. It runs in one
  transaction: each event once, then each cursor, moved only forward (a file ahead brings its
  members and widens the stored gap with its own). It clears a stored gap when the file's rows fill
  it: the file's cursor is at or past the gap's end, it indexes every contract the database's cursor
  names, and it has no gap of its own there.
- `capture` first lists the network's markets as the app does (the registry's discovery from the
  Router's and the factory's events, written to the local registry tables), then indexes them from
  the manifest's RPC into a database on this machine only (a host that resolves to loopback, with no
  `host` query parameter; it refuses any other), and exports that network's rows and cursors (with
  any stored gap) to `var/indexer-capture/<network>-<YYYYMMDD>.jsonl` (`--out` to change it). `var/`
  is git-ignored. On the network it only reads.

**Testnet history capture (deadline 2026-11-20).** The RPC drops the official deployment's first
events (the Permissioning grants, the oracle's `src_set` and first `ref_set`) around 2026-11-20
09:00 UTC, and the two `cb_limit` changes around 2026-11-21. A capture taken before then keeps them.
To load it into the Testnet database (with the developer's go):

Until the import, re-run `pnpm indexer:capture --network testnet` at least every 6 days. The next
run is due by 2026-11-20: the 2026-11-14 file's cursors leave the RPC's ~7-day window around
2026-11-21, and a file whose cursors have left it makes the first scheduled run record a gap from
them to the RPC's oldest ledger. Each run resumes from the local cursors and rewrites the day's file.

1. Run `pnpm indexer:capture --network testnet` again just before the import, so the file's cursors
   are recent.
2. `pnpm db:migrate --env-file .env.testnet`, then
   `pnpm indexer:import --network testnet --in var/indexer-capture/testnet-<YYYYMMDD>.jsonl --env-file .env.testnet`.
3. Create the `*/5 * * * *` schedule.

If the schedule already ran before the import, the import fills the history and keeps the newer
cursors.

## Alerts

A scheduled job calls `/api/cron/alerts` (GET or POST) every 5 minutes. Each run reads the protocol's
state, opens the alerts whose condition holds and closes those whose condition has passed, in the
`alerts` table (migrations 0004 and 0007). Each alert opens once and closes once: a condition that
lasts many runs keeps one open alert, and one that comes back after its close opens a new one. The
table is also the evidence store: every alert's open and close times, and every webhook test.

| Kind | Severity | Opens when | Source |
|---|---|---|---|
| `oracle_warning` | warning | The oracle value's age is at least 75% of `max_stale_seconds`. | The OracleAdapter's views at the latest ledger time (age in ledger time). |
| `oracle_stale` | critical | The age is over `max_stale_seconds`, or the contract's own `is_available()` is false. It replaces the warning. | The same. |
| `oracle_unavailable` | critical | The oracle, or the latest ledger, cannot be read by this server. It opens at once but is posted, and counts as critical, only once the next check still cannot read it (`payload.confirmedAt`); one that clears before then closes without a post. | The same. |
| `oracle_rejection` | warning | A significant rejection (`oob`, `decrease`, `deviate`, `fb_value`) in the last 24 h, one alert per reason (the payload names the newest value). It closes, without a post, 24 h after its last occurrence. | The indexed `ref_rej` events, and the keeper's `rejected` runs in `oracle_ticks`. |
| `feed_broken` | warning | A keeper run with reason `bad_price`, `rescale` or `future_ts` in the last 2 × the keeper interval (3,600 s). It closes without a post. | `oracle_ticks` (feed mode). |
| `keeper_unhealthy` | critical | Keeper runs are recorded and the last success (`pushed` or `synced`) is 2 × the interval (3,600 s) old or more. No run recorded is unknown: no alert. | `oracle_ticks`. |
| `paused` | warning | A contract is paused. One alert per contract; the subject is its role and short id (`sy:CA62…7F2I`). | `is_paused` of RiskControl and of each market's SY wrapper, pool and manager. |
| `risk_warning` | warning | The circuit breaker's window volume is at least 90% of its limit, protocol-wide or for one asset. | RiskControl `get_cb_limit`, `get_cb_volume`, `get_asset_limit`, `get_asset_volume`. |
| `risk_exhausted` | critical | The volume is at or over the limit. It replaces the warning. A limit of 0 is off: neither opens. A per-asset limit and the protocol-wide one are two breakers, so the same deposits can open an alert on each. | The same. |
| `signer_low` | warning | The keeper signer holds less than `ALERT_SIGNER_MIN_XLM` (default 20) XLM, or its account does not exist. | Horizon. The signer follows `ORACLE_KEEPER_MODE`: `ORACLE_ADMIN_SECRET`'s public key in push mode (the default), `ORACLE_KEEPER_SECRET`'s in feed mode. Without that key, there is no check. |
| `indexer_lag` | warning | An index group's cursor is more than 3,600 s behind (the close time of its ledger). One alert per group. | `ingest_cursor`. |
| `indexer_gap` | critical | An index group has a stored gap (`gap_from is not null`). One alert per group, with `{ from, to }`. | `ingest_cursor`. |

- A source the check cannot read (the RPC, Horizon, the database) keeps its kinds' alerts as they
  were: nothing of that kind closes, so a flaky read never closes an alert and opens it again. The
  run's answer names those sources (`unread`) and kinds (`held`). Not being able to read the oracle
  itself opens `oracle_unavailable`.
- A circuit-breaker trip rolls its transaction back and leaves no event, so the risk page's
  exhaustion history is the open and close times of these `risk_*` alerts.

**Webhook.** Every opening and every close is posted once to `ALERT_WEBHOOK_URL` as JSON:

```json
{ "text": "[Principal testnet] Critical alert opened: Oracle stale (CDYG…YIPS). Value age 3,700 s, over the 3,600 s allowed: …",
  "content": "(the same line)", "kind": "oracle_stale", "subject": "CDYG…", "severity": "critical",
  "network": "testnet", "at": "2026-11-14T12:00:00.000Z", "status": "opened", "test": false, "details": { … } }
```

- `text` (Slack) and `content` (Discord) carry the same line, so either incoming webhook takes the
  payload as is. A close reads "Resolved: Oracle stale (…), open since …". Event kinds
  (`oracle_rejection`, `feed_broken`) have no close post.
- Each post waits at most 5 s. A post that fails or times out keeps the alert's state, and the notice
  stays undelivered (`opened_posted`, `resolved_posted`, migration 0007): the next run sends it again,
  an opening before its close. After an outage, the openings it missed are still sent, before their
  closes, so the channel gets the whole history, late.
- A run is timed from its start: its reads (RPC, Horizon, database) all run at once and any still
  pending at 30 s counts as unread; every post ends by 50 s. A notice is claimed only while a whole
  5 s post still fits, so a claimed notice is always posted or given back before `maxDuration` (60 s).
  A run sends the notices of at most 25 alerts; the rest wait for the next run. Delivery is at least
  once: a webhook that took a post but answered after 5 s gets it again.
- The URL is never logged, stored or answered. A failed post is logged with the webhook's status or
  the error's name only; the answer counts failures (`postFailures`).
- Payloads hold contract ids, public keys and figures. Every stored or posted string is scrubbed of
  URLs and secret-shaped text.

The route answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ network, opened, resolved, open, posted, postFailures, held, unread, critical: false }` | No critical alert is open. |
| 500 | The same body with `critical: true`, or `{ error: "failed" }` | A critical alert is open (`oracle_stale`, `oracle_unavailable` once confirmed, `keeper_unhealthy`, `risk_exhausted`, `indexer_gap`), so the scheduler's own failure alert fires too; or an unexpected error. |
| 401 | | The caller sent neither a valid `Authorization: Bearer $CRON_SECRET` nor a valid QStash signature. |
| 503 | `{ error: "not_configured" }` | `ALERT_WEBHOOK_URL` (an http or https URL) or `DATABASE_URL` is missing. |

Schedule (ops, with the developer's go): a QStash schedule with cron `*/5 * * * *` to
`https://<domain>/api/cron/alerts`, as for the recorder. Apply migration 0007 to the network's
database first (`pnpm db:migrate --env-file .env.testnet`), and set `ALERT_WEBHOOK_URL` in that
environment only. Create it after the history import and after the first `cron/index` run has
completed: before that, the cursors are old or missing, and the first check would open (and post)
`indexer_lag` for every group. Until the deployed keeper has written a run, `keeper_unhealthy` stays
quiet (no run recorded is unknown). Who owns the channel, the escalation and the paging is for ops
to decide.

**Send a test alert** (the alert-test evidence). `?test=1` sends one clearly marked test alert
("[Principal testnet] TEST alert: This is a test of the alert webhook…"), stores it (`test = true`,
resolved at once) and runs nothing else:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<domain>/api/cron/alerts?test=1"
```

It answers 200 `{ "test": { "openedAt": "…", "delivered": true } }`, or 502 with `delivered: false`
when the webhook did not take it. `GET /api/dashboard/alerts` then shows it as `lastTest`.

**Alerts API.** `GET /api/dashboard/alerts` answers `{ open, recent, lastTest }`, public and without a
wallet: `open` lists the open alerts (`kind`, `subject`, `severity`, `openedAt`, `payload`), `recent`
every alert open at some time in the last 7 days (with `resolvedAt`, null while open), and `lastTest`
the last test and whether it was delivered. Test alerts are never in `open` or `recent`. It is cached
30 s at the edge; errors never are (503 `not_configured` or `unavailable`). The overview's "Open
alerts" line (its critical count leaves out an `oracle_unavailable` not confirmed yet) and the risk
page's exhaustion history (the last 7 days) read it.

**Health.** `GET /api/health` is public, cached 15 s, and answers 200 while any part reads:

```json
{ "network": "testnet",
  "ledger": { "status": "ok", "sequence": 5720000, "closeTime": "2026-11-14T12:00:00.000Z" },
  "indexer": { "status": "ok", "indexedThrough": 5719940, "indexedThroughCloseTime": "…", "lagSeconds": 300, "gaps": [] },
  "keeper": { "status": "ok", "healthy": true, "lastSuccessAt": "…", "lastTickAt": "…" },
  "openAlerts": { "status": "ok", "count": 1, "critical": 0 } }
```

Each part is read on its own, within 4 s. A part that fails or hangs reads
`{ "status": "unavailable", "reason": "…" }` and the others still answer. When every part is
unavailable it answers 503 (not cached), with the same body. `keeper.healthy` is null while no keeper
run is recorded. `openAlerts.critical` counts an `oracle_unavailable` only once confirmed. An uptime
monitor can watch the status code, `ledger.status`, `indexer.lagSeconds` or `openAlerts.critical`.

## Local network

`scripts/dev-stack/` runs a local Stellar network with a real, seeded market, so every flow works
without the Testnet deployment. It needs the Stellar CLI, `jq`, a Rust toolchain and Podman or
Docker. Full details are in [`scripts/dev-stack/README.md`](scripts/dev-stack/README.md).

```bash
scripts/dev-stack/up.sh                              # start the network, create keys
MATURITY_SECONDS=3600 scripts/dev-stack/deploy.sh    # deploy and seed one market
NEXT_PUBLIC_PRINCIPAL_NETWORK=local pnpm dev
scripts/dev-stack/oracle-tick.sh                     # run every 30 minutes; the oracle goes stale after one hour
```

## Scripts

Use `pnpm`.

| Script | What it does |
|---|---|
| `pnpm dev` | Start the dev server. |
| `pnpm build` | Production build. |
| `pnpm test` | Unit and component tests (Vitest, jsdom). |
| `pnpm test:integration` | Live run of the protocol layer against the local network (see below). |
| `pnpm test:e2e:testnet` | The live end-to-end suites on Stellar Testnet (see [CI](#ci)). |
| `pnpm lint` | ESLint. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm indexer:reindex`, `indexer:export`, `indexer:import`, `indexer:capture` | The event indexer's operator commands (see "Event indexer"). |

`pnpm test:integration` needs the local stack running and a deployed `config/manifests/local.json`
(`scripts/dev-stack/README.md`). If the network is not reachable, the suite skips and says why.

- It runs the routes, curve, oracle, registry, recorder and indexer suites against the existing local market.
  The indexer suite also needs the local Postgres migrated (`pnpm db:migrate`) and refuses a
  `DATABASE_URL` that is not on this machine: it seizes a throwaway account's positions and deletes
  and restores local `events` rows.
  It does not redeploy the stack or rewrite `local.json`.
- It signs with throwaway local accounts (the stack's dev keys), never a real key.
- It skips the cases that need a market near maturity, and says so.
- The lifecycle suite (`tests/integration/lifecycle.test.ts`, the proof for plan 0001) redeploys a
  market and rewrites `local.json`. It runs only with `LIFECYCLE_REDEPLOY=1`, and only on a stack
  nobody else is using:

```bash
LIFECYCLE_REDEPLOY=1 pnpm test:integration
```

- The wizard suite (`tests/integration/wizard.test.ts`, plan 0005) creates, seeds and publishes a new
  market through the wizard's steps, which stays on the local chain and in the market list. It runs
  only with `WIZARD_LIVE=1`:

```bash
WIZARD_LIVE=1 pnpm test:integration
```

## CI

Two workflows run on pull requests:

- `.github/workflows/ci.yml` runs lint, typecheck, test and build on every pull request, then the
  server-secret bundle check.
- `.github/workflows/e2e-testnet.yml` runs the live end-to-end suites on Stellar Testnet on every
  pull request to `testnet`, and also nightly and by hand (see below). They sign real Testnet transactions with keypairs made in the run. The workflow uses no
  repository secret, and no key is set in its environment.

| Job | Suite | What it covers | Time |
|---|---|---|---|
| Suite A: live journey | `tests/e2e-testnet/journey.test.ts` | The user journey on the official deployment (`config/manifests/testnet.json`). Two fresh accounts are onboarded through the public faucet, then: deposit, split, Buy and Sell PT and YT in USDY, liquidity in and out, a PT and a YT transfer, the History page's reads, and the refusal of an account that was not onboarded. | about 5 min |
| Suite B: ephemeral lifecycle | `tests/e2e-testnet/lifecycle.test.ts` | A throwaway market with a 20-minute maturity, deployed by `scripts/dev-stack/deploy.sh` (`EPHEMERAL=1`) with four keys generated in the run, from `principal` at the manifest's `sourceCommit`. It covers an oracle tick, a yield claim, compliance recovery (deauthorize, seize, settle the record), the stale-oracle and post-maturity refusals, and redemption at maturity. The keys are removed at the end. | about 22 min |

- Suite A runs on the official market, so it needs at least 6 hours (`MIN_RUNWAY_SECONDS` in
  `journey.test.ts`) before that market's maturity. Near maturity (February 2027),
  `config/manifests/testnet.json` must move to a new market.
- The two jobs run in parallel, so a run takes about 25 minutes. Suite A stops at 20 minutes and
  Suite B at 55 (room for a cold build and a failed deploy, with the record still uploaded).
- Suite B builds the contracts with cargo and Rust 1.95.0, the toolchain that built the official
  deployment, and deploys them with the Stellar CLI 28.1.0. On the developer's machine that toolchain
  reproduces the deployment's `wasmHashes` byte for byte; each run's job summary compares the Linux
  build with them. That build is not byte-identical (0 of 12 on the first run): ten of the twelve
  wasm files embed the builder's home directory, through the path of the cargo registry, so the bytes
  depend on the machine that builds them.
- The build (a few minutes) is cached by `sourceCommit` and Rust version. It runs again when either
  changes, when the cache has not been used for 7 days, and on a pull request's first run until the
  nightly run on `main` has warmed the cache (a pull request's cache is its own).
- Each job uploads its run record (`e2e-artifacts/journey.json` or `lifecycle.json`: public keys,
  transaction hashes, the refusals) as an artifact, kept 30 days, also when the run fails.
- A newer push to a pull request cancels its older run.

The nightly run and manual runs need the workflow file on the default branch, `main`, so `main`
carries a copy of this one file. `main` is the production landing site (see Deployments) and holds
no app code until Mainnet, so pull requests to `main` do not run these suites. The nightly run, and
any run started from `main`, check out branch `testnet` and test it with its own `testnet.json`. Keep
the two copies of the workflow identical. Run it by hand from the Actions tab ("E2E Testnet", then
"Run workflow"), or:

```bash
gh workflow run e2e-testnet.yml --ref testnet
```

Locally, `pnpm test:e2e:testnet` runs both suites, one after the other (about 26 minutes), and
`pnpm test:e2e:testnet tests/e2e-testnet/journey.test.ts` runs one. Suite B needs the Stellar CLI,
Rust with the `wasm32v1-none` target, `jq`, and a clone of `principal` at `../principal` (or
`PRINCIPAL_REPO=<path>`). It creates its keys (`e2e-*`) in the local keystore and removes them at
the end. A run killed midway can leave them: `stellar keys rm <name> --force`.

## Design system

The app uses the landing page's design system: tokens in `app/globals.css` and components in
`components/ui` (shadcn, restyled only through those tokens). A navy "par" colour and a gold
"coupon" accent, on a light grey ground with a dark theme. Headings use Newsreader, body text
Hanken Grotesk and figures IBM Plex Mono. The app works from 375 px wide and both themes.

## For SCF reviewers

Where each funded Tranche 2 item lives in the final interface. Open a market from `/app`.
To verify the work, follow the guide in [`docs/scf/TRANCHE_2_REVIEW.md`](docs/scf/TRANCHE_2_REVIEW.md); the
evidence it points to is in [`docs/scf/TRANCHE_2_EVIDENCE.md`](docs/scf/TRANCHE_2_EVIDENCE.md).

| Funded item | Where to find it |
|---|---|
| Wallet connection, persistent session | The wallet button in the header. |
| Market page: maturity, oracle rate, countdown, PT/YT outstanding, pool liquidity | The market page header and stats; the Details tab of the info card. |
| Compliance status from the underlying asset | The Compliance tab of the info card. The Safety tab shows the pause and risk checks. |
| Deposit and mint panels, with live previews | The Quick actions button on the Trade header: Deposit, Withdraw, Split, Recombine PT + YT (receive USDY in 2 steps, or SY in 1). |
| Trading panel | The PT and YT tabs. |
| Liquidity deposit and withdrawal | The LP tab. |
| Position dashboard | `/app/portfolio`. |
| Claim yield | `/app/portfolio`. |
| Redeem at maturity | The PT tab once the market has matured; before maturity, Quick actions → Recombine PT + YT. |
| Transaction history | `/app/history`. |
| Market manager | `/app/manage`, shown for a wallet that holds a role on a market; `/app/manage/new` creates a market. |

## Known limits

Short list.

- **The official Testnet deployment is the app team's market `testnet-usdy-1802336344`.** The older
  Testnet v1 seed pins no Wasm hashes, so the recorder's validation marks it invalid and it stays
  hidden or refused.
- **A PrincipalManager older than `665bb67` has no `is_paused`.** The dApp reads it, so on an older
  manager mint, YT and claim actions read "unavailable" and are blocked (fail closed). Ship the dApp
  together with a deployment from `665bb67` or later. The committed Testnet market was made at `665bb67`.
- **The wizard must be signed by the underlying SAC's `admin()`.** The contracts check it live, so
  any other wallet is told which account must sign.
- **Testnet needs migration 0003 applied** (`pnpm db:migrate --env-file .env.testnet`) for Resume to
  work across browsers. Until then Resume lists only the salts this browser saved.
- **LP only in USDY and the USDY flash Buy YT sign at the current SY rate, with no headroom** (R5-5).
  LP only signs `sy_in` at that rate; the flash caps `max_net_cost` at `previewDeposit(amount, xr)`
  from the simulation. If the rate rose between simulation and inclusion, the call would revert, or
  (LP only) take a few raw units of SY the wallet already held, or (flash) leave the deposit a few
  raw units short of the cap. Harmless while every SYWrapper is at rate 1.0, as all deployed ones are.
- **OracleAdapter v2 is required.** The app reads `is_available()` and the oracle's policy (R4-2).
  On a v1 oracle (such as the earlier `be2a1a5` Testnet deployment), the oracle shows unavailable and
  every gated write is refused, and `/api/cron/oracle` answers 500 `failed`.
- **Two-sided add and Keep YT can fail** if the pool or oracle moves between review and
  inclusion. The one-step Keep YT signs the desired PT and SY as literals, so an
  oracle rise between review and inclusion leaves a little extra PT in the wallet, and the oracle
  rejects decreases. In the cases that do fail, the user loses only the network fee. The panel names
  the cause. Prepare again.
- **A later step can fail on rent.** Step 2 of a multi-step route, prepared in the ledger its
  previous step landed in, can fail with an insufficient refundable fee (reproduced twice locally).
  The app says "prepare it again" and the route stays continuable. The fix is the refundable-fee
  margin under Before mainnet (R2-80).
- **Failed transactions show a cause.** The specific "amounts moved" and "refund rounding moved"
  hints rely on RPC returning diagnostic events for failed transactions. The first is verified on
  the local network; neither is verified on Testnet.
- **No mint from SY.** The dApp does not offer `PrincipalManager.mint`, which has no floor. Mint
  starts from the underlying.
- **Manifest `wasmHashes` are needed** to restore archived contract code. See Manifest.
- **Faucet.**
  - Rate limits: one request per address and per IP every 60 s, 4 runs per minute and 120
    accepted requests per minute per instance, all in memory. A run is queued only if it should
    finish within 90 s; otherwise the route answers `busy`. Each Vercel instance keeps its own
    counts, so on the public testnet domain back them with a Vercel Firewall rate-limit rule on
    `/api/faucet`.
  - One shared underlying across all manifest markets. Several different underlyings are not supported.
  - `maxDuration` is 120 s. That needs Vercel Fluid compute, which is not yet verified.
- **History** reads RPC `getEvents`. Its retention window is limited and it takes at most 5
  contract IDs per request. Entries older than the window come only from the local log in the
  browser.
- **SEP-57 compliance path** is untested on Testnet.

### Before mainnet

Fine on Testnet; each needs a change before mainnet traffic (R2-79).

- **Bounded registry reads.** `sqlRegistryStore.rows()` reads every `market_registry` row, with its
  JSON, on every page render (`resolvedManifest`), on the uncached `GET /api/markets` and per sparks
  or history request. Junk factory markets each add an invalid row, and past the 1.5 s race pages
  fall back to the seeds only. Give `resolvedMarkets` a `where valid is true` query, and cache or
  drop `GET /api/markets`.
- **Sparks above 50 pools.** `GET /api/markets/sparks` refuses more than 50 pools in one request, so
  every spark would show its error state. Chunk the request on the client.
- **Header role polling.** The header reads about 7 role views per market every 30 s for the
  connected wallet. That scales with markets × users: gate it on the manager view, or lengthen it.
- **Step quote against the route preview.** A later step is signed with the floor from its own fresh
  simulation, which the step review shows. Warn when that quote is worse than the route preview by
  more than the slippage setting.
- **Refundable-fee margin.** A transaction's Soroban resource fee is the simulation's own figure,
  with no margin. If ledger state moves between simulation and inclusion, a step can fail with
  `invokeHostFunctionInsufficientRefundableFee`. Reproduced twice locally, both on a step prepared
  in the ledger its previous step landed in. The app already says "prepare it again" and the route stays continuable. Add a small
  refundable-fee margin under the existing fee cap (R2-80).
