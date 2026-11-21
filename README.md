# Principal dApp

The browser app for the Principal PT/YT yield-tokenization protocol on Stellar. With a Varial
wallet (formerly Freighter) you can split a yield-bearing asset into a principal token (PT) and a yield token (YT),
trade them, provide liquidity, claim yield and redeem at maturity. It runs on Stellar Testnet and
on a local network, and builds for Stellar Mainnet (see "Mainnet go-live"). It is Deliverable 2 of
Tranche 2 of SCF #45.

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
| `/dashboard` | The public dashboard's overview, without a wallet. The six views are listed in "Dashboard". |
| `/dashboard/markets`, `/dashboard/markets/[marketId]` | Every registry market, then one market's figures, fees and pending-yield lookup. |
| `/dashboard/oracle`, `/dashboard/risk`, `/dashboard/compliance`, `/dashboard/activity` | The oracle, RiskControl, compliance and indexed-activity views. |
| `POST /api/faucet` | Server route behind "Get test tokens". |
| `GET` or `POST /api/cron/record` | The rate recorder, called by a scheduler. Both methods run the same checks. Refuses any other caller. |
| `GET` or `POST /api/cron/index` | The event indexer, called by a scheduler. Same checks as the recorder. See "Event indexer". |
| `GET /api/dashboard/events` | The indexed protocol events, public and read-only. See "Event indexer". |
| `GET /api/dashboard/oracle-ticks` | The oracle keeper's recorded runs and its health, per oracle, public and read-only. See "Scheduler". |
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

`NEXT_PUBLIC_PRINCIPAL_NETWORK` selects the network: `testnet` (the default), `local` or `mainnet`.
It is read at build time, so set it before `pnpm dev` or `pnpm build`. The three manifests are
imported statically by `lib/protocol/manifest-source.ts`. The app refuses to sign when the wallet is
on another network.

`mainnet` reads `config/manifests/mainnet.json`: the Mainnet deployment, five markets on mock
assets, each with its own oracle (see Manifest). On Mainnet the app lists the manifest's own markets
only. A market someone else builds with the factory is checked and cached, but never listed, and the
manager view does not show it either. `POST /api/markets` answers 403 `not_available` there: markets
are created by the protocol team. CI also builds the app for Mainnet, so a Mainnet manifest that
does not parse fails the pull request.

One build serves one network: Production (`main`) is built with `mainnet`, the `testnet` branch with
`testnet`. The contract interface follows the manifest's `protocolAbi` (see Manifest), never the
network's name. What the network itself changes:

- **Test tokens.** "Get test tokens" is offered on `testnet` and `local` only; on `mainnet`
  `POST /api/faucet` answers 403 ("Get test tokens runs only on Testnet or a local network.").
- **Access.** On `mainnet`, the compliance card and the gates use network-neutral texts ("Access to
  this market is granted by the protocol team."), and an access block lists what is still missing
  (and, apart, what could not be checked, with its reason) and names the manifest's `accessContact`.
  A missing trustline has an **Add trustline** button there. On `testnet` and `local` it has none:
  Get test tokens adds the trustline (spec 0005).
- **The wizard** (`/app/manage/new`) is not offered on `mainnet`: every `create_*` call is signed by
  the asset's issuer, whose Mainnet keys are the protocol team's.
- **The banner** on `/app` and `/dashboard` says the network, and on `mainnet` that the markets use
  mock assets issued by Principal for testing.
- **The oracle keeper's push mode** refuses `mainnet`; feed mode runs anywhere (see "Keeper modes").

`pnpm smoke:mainnet` checks the Mainnet deployment against `mainnet.json`, read-only (see Scripts).

## Manifest

Every contract address comes from a manifest, never from code. Each network has one file in
`config/manifests/`, validated with zod (`lib/protocol/manifest.ts`) at build time and again at
runtime. Its format is `manifestSchema` in
[`lib/protocol/manifest.ts`](lib/protocol/manifest.ts): network settings,
`shared` contracts, and a `markets[]` list with the underlying, maturity and nine contract IDs per
market.

- The app speaks two contract versions, and the manifest's `protocolAbi` says which: 1 (or absent)
  is `principal` `665bb67`, the official Testnet deployment's; 2 is `3af9388`, Mainnet's and the local
  stack's (`deploy.sh` writes it from the Router it built). Version 2's Router takes extra arguments,
  which the app computes from the same reads as the preview. `validateManifest` refuses a
  `protocolAbi` that contradicts a Router code hash it knows (`ROUTER_ABI_BY_WASM`). Both versions
  have OracleAdapter v2, the one-transaction Router functions (flash Buy YT, LP only and LP withdraw
  in the underlying, the sales, Keep YT), the gain-based sweeps and `PrincipalManager.is_paused`. They
  are used when the manifest's `routerFunctions` lists them. `deploy.sh` leaves the Router's
  `quote_*` views out of that list.
- Plan 0009 added four optional fields:
  - `protocolAbi` (1 or 2, above);
  - `accessContact` (`{ label, url }`, an `https:` or `mailto:` URL): where a person without access
    can ask for it, named in a market's access block. Without it the block says "Ask the protocol
    team." `mainnet.json` has none until the contracts team names one;
  - `markets[].underlying.tracks` (1 to 12 characters): the asset a mock follows. It adds the note
    "Mock asset issued by Principal for testing. It follows the price of USDY and is not USDY." to the
    asset's rows, the market page and the dashboard's market detail;
  - `createdLedgers` (contract id to ledger): where the indexer starts a contract the manifest adds
    later (see Event indexer).
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
- `mainnet.json` is the contracts team's file `deployments/mainnet-dapp-manifest.json`, taken from
  the `mainnet` branch of the contracts repository (`principal`). Its contracts were built from
  `principal` at `3af9388`, the manifest's `sourceCommit`. It is the file after the contracts team's
  v2 redeploy of 2026-11-20/21 (branch `mainnet` at `94050d0`): MOCKUSTRY, MOCKGILTS, MOCKCETES and
  MOCKXAUM have new oracles and markets (their v1 contracts are abandoned: the v1 oracles' stored
  values could not be corrected, since an oracle never lowers its value); MOCKUSDY and the shared
  contracts are unchanged. We add `deployLedger` (65525735, the
  ledger before the first contract was created), `protocolAbi` 2 (the contract interface its Router
  speaks; absent means 1, as on Testnet) and each market's `underlying.tracks` (the asset its mock
  stands for, such as `USDY`) and `createdLedgers` (the ledger of the transaction that created each
  v2 oracle and market contract, from Horizon, so the indexer starts them there and not at
  `deployLedger`). A test checks that removing these additions gives back the contracts
  team's file unchanged (`lib/protocol/__tests__/fixtures/mainnet-handover.json`).
- Each market names its own oracle. The registry accepts a market only when its oracle is one the
  manifest names (a market's oracle or `shared.oracle`), and its manager and YT read that same
  oracle. The factory is open to anyone, so a market on any other oracle is never listed.
- `deployLedger` is required off the local network: the schema refuses a `testnet` or `mainnet`
  manifest without it, since the event indexer starts there. `deploy.sh` writes it on every network
  (the latest ledger before the deploy's first transaction). A file whose `network` is not the one
  `NEXT_PUBLIC_PRINCIPAL_NETWORK` names is refused.
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

## Dashboard

`/dashboard` is the protocol's public dashboard (spec 0004): what the contracts answer now, and the
history the event index holds. It needs no wallet: no page reads, asks for or signs with one. The
app header's "Dashboard" link and the landing footer open it.

| Route | What it shows |
|---|---|
| `/dashboard` | Overview: protocol totals (TVL, TVL in USD, markets, pool liquidity), safety (RiskControl capacity, pauses, the oracle's freshness and its time until operations block, open alerts), the latest compliance events and the event index's state. |
| `/dashboard/markets` | Every registry market with its supplies, reserves, liquidity, TVL and unclaimed fees, and totals over them. |
| `/dashboard/markets/[marketId]` | One market: its figures, settlement, fees, fee recipients, and the pending yield of any address. |
| `/dashboard/oracle` | The OracleAdapter: value and freshness on ledger time, policy, sources, update path and last rejection, read live; the indexed update and rejection history; the keeper's health from its recorded runs. |
| `/dashboard/risk` | RiskControl: circuit breaker, window and per-asset limits, every contract's pause and the pausers, read live; the indexed limit changes and pause history; the exhaustion history from the alerts. |
| `/dashboard/compliance` | The underlying asset's administrator and issuer flags, every RecoveryEscrow record (an archived one from the index), the Permissioning counts and the seizure history. |
| `/dashboard/activity` | Every indexed event, newest first, filtered by kind (the filters are in the URL, so a filtered view is a link). |

- **Provenance and the drawer.** Every contract figure keeps the reads behind it: contract, function,
  arguments, ledger, RPC endpoint and raw XDR. Its info button opens the How-to-verify drawer: those
  fields, a stellar.expert link per contract (plain text on `local`), the status (Live, "Read across
  ledgers X–Y" when the reads answered at different ledgers, or "Unavailable" with its reason), and a
  copyable `stellar contract invoke … --send=no` command per read, which repeats it as a simulation:
  nothing is signed. A read answered by one of the manifest's `rpcFallbackUrls` says "via fallback
  <host>". "Copy evidence table" copies every figure of a page with its reads.
- **Never a guess.** A figure that cannot be read shows "Unavailable" and why. A total over markets is
  Unavailable when any market's figure is, never a partial sum. A refresh that fails never leaves the
  old value showing as current.
- **Cadence.** Live widgets (the oracle, RiskControl, pauses and pausers, one market's page) refresh
  every 15 s on Testnet and the local network, and every 60 s on Mainnet (`dashboardLiveMs`): the
  public Mainnet RPC refused reads after about 96 in one measurement, and one `/dashboard` tab reads
  about 70 oracle values per refresh (see "Mainnet go-live", step 4). Aggregates (the totals and the
  markets list) and history (the event index, keeper runs, alerts, RecoveryEscrow records) refresh
  every 60 s on every network. `/app` keeps its 6 s. Each panel says when it was read ("Ledger N ·
  read 4s ago · Refreshes every 15 s", "every 1 min" on Mainnet), and "Stale: no new read for over
  30 s" (2 min on Mainnet) past twice the cadence.
- **History** comes from the event index (`GET /api/dashboard/events`, see "Event indexer"). Each list
  says how far it goes ("Indexed through ledger N"), its lag and any stored gap. The keeper's runs come
  from `GET /api/dashboard/oracle-ticks` and the alerts from `GET /api/dashboard/alerts`. Without
  `DATABASE_URL` those panels read "Unavailable" with the reason, and the live figures still work.
- **Layout check.** `pnpm dashboard:layout --base <app>` checks every view at 375 px (no sideways
  scroll, no table that hides columns, the drawer included); `--shots <dir>` also writes screenshots.
  It runs by hand against a running app, never in CI.

## Environment variables

Copy `.env.example` to `.env.local`. Never commit real keys.

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_PRINCIPAL_NETWORK` | Browser and server | `testnet` (default), `local` or `mainnet` (see Network selection). |
| `FAUCET_ISSUER_SECRET` | Server only | Required for "Get test tokens". Secret key of the test asset issuer. |
| `FAUCET_PERMISSIONING_ADMIN_SECRET` | Server only | Optional. Defaults to the issuer key. |
| `DATABASE_URL` | Server only | Postgres for the market recorder (pooled string on Neon; the local stack writes one for `principal-pg`). |
| `DATABASE_URL_UNPOOLED` | Server only | Optional. Direct connection for migrations; else `DATABASE_URL` with `-pooler` removed from the host. |
| `CRON_SECRET` | Server only | Optional. Bearer secret Vercel Cron sends to `GET /api/cron/record`. Unset, the route refuses every Bearer call. |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Server only | Verify Upstash QStash signatures on the cron routes. |
| `ORACLE_ADMIN_SECRET` | Server only | Testnet and local only. The oracle admin key `GET`/`POST /api/cron/oracle` signs with (see Scheduler). It is the OracleAdapter's admin: besides pushing the value, it can change the oracle's window, deviation cap, sources and value bounds, and hand the role over. Never set on mainnet: the route refuses to run there. |
| `ORACLE_KEEPER_MODE` | Server only | `push` (default) or `feed`: how `cron/oracle` keeps the oracle fresh (see "Keeper modes" under Scheduler). Any other value answers 503 `not_configured`. |
| `ORACLE_KEEPER_SECRET` | Server only | Feed mode's key: funded, with no protocol role. It only pays the fee of `sync_from_feed`, which anyone may call, so feed mode may run on any network. The oracle admin's key is refused (503 `not_configured`). In feed mode the alert check watches its XLM. |
| `ORACLE_KEEPER_ORACLE_ID` | Server only | Optional, feed mode only, for tests and the local proof. One contract id, or a comma-separated list, that `cron/oracle` syncs instead of the manifest's oracles (for example the standalone oracles of `scripts/dev-stack/feed-oracle.sh`). Their runs are recorded under those oracles, so the dashboard and the alert check, which follow the manifest, do not show them; each run logs a warning. Off the local network, any value other than the manifest's own single oracle answers 503 `not_configured`. |
| `ORACLE_KEEPER_INTERVAL_SECONDS` | Server only | Optional. The keeper's schedule in seconds (default 1800; 300 on Mainnet). Keeper health and the alerts measure against it, so set it to the schedule you configure. A value that is not a whole number from 60 to 86400 makes `cron/oracle` answer 503 `not_configured` in feed mode, and the keeper's health unavailable. |
| `ORACLE_KEEPER_RECORD_REJECTIONS` | Server only | Optional, feed mode only. Exactly `1` (no spaces) puts each new significant rejection on-chain with one transaction (one fee). Anything else, or unset, records it from the simulation with no transaction (the default; Mainnet). |
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
| `main` | Production | `principalmarket.fi` | `principalmarket-mainnet` | Mainnet, from the go-live on (see "Mainnet go-live") |

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
| 503 | `{ error: "not_configured" }` | No key, a key that is not the oracle admin, an oracle with no primary source, mainnet, or an `ORACLE_KEEPER_MODE` that is neither `push` nor `feed`. |
| 500 | `{ error: "failed" }` | Anything else, including a v1 oracle, which has no `get_primary_source()`. |

#### Keeper modes

`ORACLE_KEEPER_MODE` picks how the route keeps the oracle fresh. `push` (the default) is the
behavior above. `feed` (spec 0004 D-21) is for an oracle that reads its own SEP-40 feed: the
OracleAdapter's `sync_from_feed` (principal 24d980d) takes the feed's price itself and anyone may
call it, so the route signs with `ORACLE_KEEPER_SECRET`, a funded key with no protocol role, and the
server holds no oracle admin key.

One feed-mode run covers every oracle of the manifest (one per market, five on Mainnet), from that
one key. For each oracle it checks the oracle's `feed_source()` and `get_admin()`, simulates
`sync_from_feed` as that key, and acts on the result. The oracles are read and simulated at the
same time. The reason comes from the simulation's `ref_rej` event:

| Simulation | Reasons | The route | Outcome |
|---|---|---|---|
| no feed | `feed_source()` is `None` (`set_feed_source` was never called) | Sends nothing. | `skipped`, reason `no_feed` |
| `true` | | Submits. | `synced` with `value` (the oracle's, 7 decimals), `timestamp` and `hash` |
| `false`, routine | `stale_ts` (no newer price), `no_data` (the feed has none), `throttle` (sooner than the oracle's minimum interval after its last accepted feed update; principal 3af9388) | Sends nothing, pays no fee. | `skipped` with `reason` |
| `false`, significant | `oob`, `decrease`, `deviate`, `fb_value` | Sends nothing by default. With `ORACLE_KEEPER_RECORD_REJECTIONS=1`, submits once per new (reason, value), so the rejection is on-chain with a hash; the same rejection again is not sent. Either way the alert check raises `oracle_rejection`. | `rejected` with `reason`, and `hash` when sent |
| `false`, broken feed | `bad_price`, `rescale`, `future_ts`, `feed_err` (the feed's `decimals` or `lastprice` call failed; principal 3af9388) | Sends nothing. The alert check raises `feed_broken`. | `rejected` with `reason` |
| `false`, no `ref_rej` event | | Sends nothing. | `rejected`, reason `unknown` |

The answer is `{ mode: "feed", oracles: [{ oracle, ...outcome }] }`, one entry per oracle in the
manifest's order. Each outcome has its `mode` and `signer` (the key's public key). An oracle that
could not run is `not_configured` with a `message`, or `failed` with a `name` (and the `hash` once its
transaction was signed). The status covers the whole run:

| Status | When |
|---|---|
| 200 | No oracle failed, and at least one was not `not_configured`. A `rejected` or `skipped` oracle is a 200. |
| 500 | At least one oracle is `failed`. The other entries are in the body as usual. |
| 503 | Every oracle is `not_configured` (no key, a key that is not a Stellar secret, the admin's key on every oracle). `{ error: "not_configured" }` before anything runs, for a bad `ORACLE_KEEPER_INTERVAL_SECONDS` or `ORACLE_KEEPER_ORACLE_ID`. |

A `rejected` oracle answers 200, not 500, and is logged as a warning: the rejection is the feed's
state, not a failed run, and the alert check reports it. A 5xx would make QStash retry the call, and
each retry would record the same rejection again (counted in `rejected24h` and in the alert's
`occurrences`). Push mode keeps its 500.

- **One account, one transaction at a time.** The run reads the key's sequence number once. It then
  builds, prepares, checks, signs and sends each `sync_from_feed` one after another, each on the next
  number. The network keeps only one transaction per account in its queue, so each one is sent after
  the previous one is in a ledger. The hash is computed before the send, so a send that throws still
  records its hash.
- **Checked again right before the send.** A later oracle's turn can come several ledgers after its
  first simulation, so the simulation RPC runs to prepare the transaction is checked too. The call is
  sent only while it still simulates `true`, or, for a rejection being put on-chain, the same reason
  and value. Otherwise nothing is sent, the sequence number goes to the next oracle, and the oracle is
  recorded from that fresh simulation (`skipped` for a routine reason, `rejected` with no hash else).
- **Inside 45 s, whatever the network does.** Every network call is cut at 45 s from the start of the
  call. The route may run 60 s, and the last 15 s are kept to write its rows: a cold database pool can
  take several seconds to connect. An oracle whose reads and
  simulation are not done 15 s in is `failed: not decided`, so the others keep time to send. A
  transaction still not in a ledger at 45 s is `failed: not confirmed`, with its hash. An oracle whose
  turn never came is `failed: not sent`, with no hash. A transaction that lands after the run keeps
  that record; its effect is on-chain and in the indexed events, and the next run starts from it.
- **Two runs at once** (a manual call during a scheduled one) use the same account. The network then
  refuses the later transactions with `txBadSeq` (the other run used the number) or
  `TRY_AGAIN_LATER` (the other run's transaction is still queued). Each such oracle is `failed` with
  that code and its hash, the others still run, and nothing is retried: the next scheduled run starts
  again from the account. A refused transaction uses no sequence number.
- **Rejections cost a fee only on request (spec 0005 M-14).** Without
  `ORACLE_KEEPER_RECORD_REJECTIONS=1`, a significant rejection is recorded from the simulation, so a
  falling price does not cost a transaction every run. The local integration test turns it on.
- **Its memory** of the last rejection it sent is the newest feed-mode `rejected` row of that oracle
  in `oracle_ticks` with a tx hash. Without a database (or when the read fails, logged by error
  name), it has none, so with `ORACLE_KEEPER_RECORD_REJECTIONS=1` every significant rejection is sent
  again on each scheduled run (one fee each; the 200 answer means no retries) until the feed recovers.
  That is the safe side, and the alert check still sees each one.
- **The call that lands decides.** If the feed moved between the simulation and the transaction, the
  answer follows the landed return value, and the recorded (reason, value) comes from the landed
  transaction's own `ref_rej` (or `ref_set`) event when RPC returns its events. Without them, the
  simulated pair stands, and a simulated accept that lands `false` is recorded with reason `unknown`
  (the indexed `ref_rej` event keeps the real one).
- **An oracle with no feed** (`feed_source()` is `None`) is `skipped` with reason `no_feed` and costs
  nothing: it is no keeper error. An oracle whose code predates `sync_from_feed` (it has no
  `feed_source` function, as with 665bb67, our Testnet oracle today) is `not_configured` instead. The
  oracle raises `FeedNotConfigured` (error 15) only when it has no feed, and the route reads
  `feed_source()` first, so an error 15 after it named a feed comes from the feed contract: that
  oracle is also `not_configured`, recorded as "the feed answered an error (#15)".
- **Never the admin's key.** Each run reads each oracle's `get_admin()`. When `ORACLE_KEEPER_SECRET`
  is that key (copied from `ORACLE_ADMIN_SECRET`, say), nothing is sent for that oracle, and it is
  `not_configured`, recorded as "ORACLE_KEEPER_SECRET is the oracle admin's key". The call would work,
  since `sync_from_feed` needs no auth, but the admin key must not sit in a server variable (D-21).
- **Any network.** Feed mode runs on mainnet too; push mode keeps its refusal.
- **Which oracles.** It syncs the manifest's oracles, or `ORACLE_KEEPER_ORACLE_ID` when set: one
  contract id or a comma-separated list (tests and the local proof only; see Environment variables).
  An override logs a warning on every run, and off the local network it answers 503 `not_configured`.
- **Its schedule.** Every 30 minutes by default. On Mainnet it runs every 5 minutes (cron
  `2-57/5 * * * *`, with retries 0, and `ORACLE_KEEPER_INTERVAL_SECONDS=300`): a run with nothing to
  submit costs nothing. The cron runs 2 minutes after `index` and `alerts`, which can share its
  per-process read cap, and it has no retries because it answers 500 when any oracle fails: the next
  scheduled run is the retry (see "Mainnet go-live", step 7).

`scripts/dev-stack/feed-oracle.sh` proves it on the local stack: it deploys a SEP-40 mock feed and a
standalone OracleAdapter of 3af9388 wired to it (`FEED_MIN_INTERVAL` sets its throttle, 0 by default;
`FEED_INITIALIZED=0` leaves the feed uninitialized). `tests/integration/oracle-feed.test.ts` drives
the route through each row of the table above but the last, and syncs two oracles in one run (see
`scripts/dev-stack/README.md`). The "no `ref_rej` event" row is covered by unit tests only: the
contract emits `ref_rej` on every rejection, so no local feed can produce it.

#### Telemetry

Every run, whatever its answer, writes one row to `oracle_ticks` (migration 0004) per oracle it
covered (one in push mode): its time, mode, decision (`pushed` or, in feed mode, `synced`;
`skipped`, `rejected` or `error`), value, reason (a feed-mode `skipped` run keeps its routine reason,
or `no_feed`), tx hash and signer (a public key). An error's reason is `not_configured: <the route's own words>` or
`failed: <error name>`, never an error's text. A transaction the keeper sent that did not land keeps
its hash, with `failed: <result code>` (e.g. `invokeHostFunctionTrapped`) or `failed: not confirmed`. A row that cannot be written (no `DATABASE_URL`, a
database down) is logged by error name and never changes the answer.
`GET /api/dashboard/oracle-ticks?oracle=&limit=` serves them, public and without a wallet, one entry
per oracle of the manifest's markets, in the manifest's order:
`{ intervalSeconds, oracles: [{ oracle, asset, health, ticks }] }`. `asset` names the underlying codes
of the markets on that oracle (`USDY`, or `USTRY, GILT` for two markets on one oracle). `ticks` are
that oracle's newest runs, newest first. `?oracle=C…` answers that oracle's entry alone; an id that is
not one of the manifest's oracles is 400 `unknown_oracle`. `?limit=` (1 to 100, default 20) applies
per oracle. The answer is cached 60 s at the edge; bad input and errors never are (400, or 503
`not_configured` or `unavailable`). Each `health` is
`{ healthy, lastSuccessAt, lastOkAt, lastTickAt, rejected24h, failures24h }`. Health is about the
keeper (spec 0005 M-15): it is healthy while `lastOkAt`, the last run whose decision is not `error`,
is younger than 2 × `intervalSeconds` (`ORACLE_KEEPER_INTERVAL_SECONDS`, 1,800 s by default). A
skipped or rejected run counts: in feed mode a correct run often changes nothing, because the feed
has no new tick. Whether the oracle is fresh is the oracle alerts' job. `lastSuccessAt` (the last
`pushed` or `synced` run) is kept for display. `lastTickAt` null means no run is recorded: an unknown
state, which the oracle page reads "No keeper run recorded yet". The answer is cached, so the page
measures the age itself, on the ledger clock.

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
contract events with the RPC's `getEvents` into the `events` table (migrations 0004 to 0006 and
0008), one row per RPC event id, so a retry or two overlapping runs never duplicate a row. Each row
keeps the contract, topic, ledger, close time, transaction hash, the market's pool, the decoded
fields (`data`) and the event value as the RPC sent it (`raw_xdr`, base64 XDR of the `ScVal`;
decode it with `stellar xdr decode --type ScVal`).

Contracts are indexed in five groups, each with its own cursor in `ingest_cursor`
(`events:<group>:<network>`):

| Group | Contracts |
|---|---|
| `market` | Every listed market's SY wrapper, manager and pool |
| `escrow` | Every listed market's RecoveryEscrow |
| `oracle` | Every OracleAdapter the manifest names: each market's oracle and `shared.oracle` |
| `permissioning` | The shared Permissioning contract |
| `risk` | The shared RiskControl contract |

- The `oracle` group's contracts come from the manifest, not from the market list. It runs even when
  the registry cannot be read.
- A first run starts at the manifest's `deployLedger`, or at the RPC's oldest ledger if that is
  later. The RPC keeps about 7 days.
- Each run reads pages of 200 events (at most 5 contracts per request), saves the cursor after
  every page, and starts no page after its 50 s budget. The next run resumes there.
- A cursor only moves forward. A run that is behind cannot rewind one that is ahead.
- A cursor names the contracts it has read through its ledger (`members`). Any other contract of
  its group (a market listed after its creation, a market dropped from the list and listed again, a
  new deployment or contract in the manifest) is read in its own requests until it catches up. It
  starts at its creation ledger when that is known and later than `deployLedger`, else at
  `deployLedger`. The cursor moves only once every contract has.
- A contract's creation ledger is the manifest's `createdLedgers` entry for it (contract id to
  ledger), else its market's `createdLedger` (below). Add an entry when a manifest names a contract
  that is not a market, such as a new oracle, after `deployLedger` has left the RPC's window. Without
  one, the contract would start at `deployLedger` and record a gap for ledgers before it existed. An
  entry must be at or before the contract's creation ledger; earlier is safe. A later value silently
  loses the contract's first events, and no gap is recorded for them.
- A market's creation ledger (`createdLedger` in its registry row) is the earliest ledger at which
  discovery saw the factory build it: its salt's `mkt_tok`, `mkt_eng` or `mkt_new`, in the page of
  events that named the pool, or else the salt index's ledger for it (its `mkt_new`). A market the
  wizard publishes takes it from the salt index when the recorder has already seen its build, or
  from the next discovery run that sees it. The seeds have none: they start at `deployLedger`.
- When the registry cannot be read (the market list is the manifest seeds alone), the run skips the
  `market` and `escrow` groups and says so (`skipped`). Their cursors keep every market, so no market
  is read again from its start, and no gap is recorded for it, when the list comes back.
- When a cursor (or a new contract's start) is older than the RPC's oldest ledger, the run goes on
  from the oldest ledger and records the gap. The save that moves the cursor past it also stores it
  on the cursor (`gap_from`, `gap_to`, widened if one is already open), so a cursor never passes a gap
  without recording it. It never skips silently. A stored gap stays until an import fills it, or the
  operator clears one known to be false (`indexer:clear-gap`, below). The read API lists it (`gaps`),
  and monitoring reads it from `ingest_cursor` (`gap_from is not null`).
- When the escrow group finishes within the budget, the run compares every RecoveryEscrow's
  `record_count` with its indexed `recovery` events, and keeps the result on the escrow cursor
  (`reconcile`, with its time). A run cut short by the budget skips it.

The route answers:

| Status | Body | When |
|---|---|---|
| 200 | `{ inserted, groups, reconcile }`, plus `skipped` | Each group: `indexedThrough`, `gap`, `complete` (false when the budget ran out). Each escrow: `recordCount`, `indexed`, `ok`. `skipped` (`{ groups, reason }`) only when the registry could not be read: the `market` and `escrow` groups wait for the next run. |
| 401 | | The caller sent neither a valid `Authorization: Bearer $CRON_SECRET` nor a valid QStash signature. |
| 503 | `{ error: "not_configured" }` | `DATABASE_URL` is missing. |
| 500 | The same body, a group with `error: "failed"`, or `{ error: "failed" }` | The RPC failed, or the manifest could not be read. The next run resumes at the cursor. |

Schedule (ops, with the developer's go): a QStash schedule with cron `*/5 * * * *` to
`https://<domain>/api/cron/index`, as for the recorder. Apply migrations 0004 to 0008 to the
network's database first (`pnpm db:migrate --env-file .env.testnet`).

`GET /api/dashboard/events` serves the index, public and without a wallet. `?group=`, `?pool=`,
`?contract=<C…>` (one contract's events, such as one oracle's history), `?topic=<a,b,…>` (at most
10 topics, filtered in the query so a page holds only them), `?before=<event id>` (older rows, for
paging) and `?limit=` (1 to 200, default 50) filter the list. A `contract` that is not a contract id
answers 400 `invalid_contract`. `?counts=1` adds `counts`: the number of indexed events per topic
for the group, pool and contract asked, over every row, not one page (the compliance page's
Permissioning counts).
It answers `{ rows, indexedThrough, indexedThroughCloseTime, lagSeconds, gaps, pendingGroups, reconcile }`,
newest first and cached 60 s at the edge: `indexedThrough` is the slowest group's cursor (0 while a
group has none), and `indexedThroughCloseTime` its close time, from which a page computes a fresh lag
whatever the cache's age. `gaps` lists the stored gaps (`{ group, from, to }`), `pendingGroups` the
groups no run has indexed yet, and `reconcile` the last reconciliation.
Rows never carry the raw XDR; `?id=<event id>` answers `{ event }` with its `rawXdr`.

Operator commands (`scripts/indexer.mjs`). The database is `--database-url <url>`, else the
`DATABASE_URL` of `--env-file <path>`, else `DATABASE_URL`, else `.env.local`'s. None prints it, but
pnpm echoes the command line and the shell keeps it: use `--env-file` for a real database.

```bash
pnpm indexer:reindex --network testnet --group escrow --from 5710000            # read the group again from that ledger
pnpm indexer:clear-gap --network testnet --group market --env-file .env.testnet  # print a stored gap; add --yes to clear it
pnpm indexer:export --network testnet --out events.jsonl                         # events rows and cursors, as JSON Lines
pnpm indexer:import --network testnet --in events.jsonl --env-file .env.testnet  # upsert them (see below)
pnpm indexer:capture --network testnet                                           # list the markets, index them locally, export
```

- `reindex` sets the group's cursor to the ledger before `--from`. Rows already indexed are kept,
  and the events read again are not duplicated. It refuses to move a cursor forward. A `--from`
  older than the RPC's oldest ledger (or one it cannot check) needs `--force`: the next run would
  record those ledgers as a gap, which the index may already hold from an import. Run it when no
  indexer run is in progress, or that run may move the cursor on again.
- `clear-gap` is for a gap known to be false: the contracts it names had no events in those
  ledgers. One case: a market created inside the RPC's window but indexed before its creation ledger
  was known (the wizard published it, and an index run listed it before discovery saw its build),
  which starts it at `deployLedger`. That false gap lands on two groups, `market` and `escrow`, each
  with its own alert: run it for each group. It prints the stored gap first. On a database that is not on this
  machine (the Testnet one) it clears nothing without `--yes`, so run it once to read the gap, then
  again with `--yes`. It clears exactly the gap it printed (one an indexer run widened meanwhile is
  refused) and keeps the cursor and its members. The next `cron/alerts` run then closes the open
  `indexer_gap` alert and posts the close. A real gap is filled by an import instead.
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

Each oracle of the manifest's markets is judged on its own (one per market on Mainnet). Its alerts
have the oracle's id as subject, and their payload names `asset`, the underlying codes of the markets
on that oracle.

| Kind | Severity | Opens when | Subject | Source |
|---|---|---|---|---|
| `oracle_warning` | warning | The oracle value's age is at least 75% of `max_stale_seconds`. | The oracle's id. | The OracleAdapter's views at the latest ledger time (age in ledger time). |
| `oracle_stale` | critical | The age is over `max_stale_seconds`, or the contract's own `is_available()` is false. It replaces the warning. | The oracle's id. | The same. |
| `oracle_unavailable` | critical | The oracle, or the latest ledger, cannot be read by this server. It opens at once but is posted, and counts as critical, only once a check at least 120 s after it opened still cannot read it (`payload.confirmedAt`); one that clears before then closes without a post. A scheduler retry seconds later never confirms it. Without the latest ledger, every oracle opens one. | The oracle's id. | The same. |
| `oracle_rejection` | warning | A significant rejection (`oob`, `decrease`, `deviate`, `fb_value`) in the last 24 h, one alert per oracle and reason (the payload names the newest value). It closes, without a post, 24 h after its last occurrence. | `<oracle id>:<reason>`. | The oracle's indexed `ref_rej` events, and the keeper's `rejected` runs for it in `oracle_ticks`. |
| `feed_broken` | warning | A keeper run with reason `bad_price`, `rescale`, `future_ts` or `feed_err` in the last 2 × the keeper interval (3,600 s by default). It closes without a post. | The oracle's id. | `oracle_ticks` (feed mode). |
| `keeper_unhealthy` | critical | Keeper runs are recorded for the oracle and its last run without an error (`lastOkAt`) is 2 × the interval (3,600 s by default) old or more. No run recorded is unknown: no alert. | The oracle's id. | `oracle_ticks`. |
| `seed_invalid` | critical | A manifest market's stored registry verdict is `valid = false`, so the app hides it until a check passes. It closes when the verdict is no longer false. A verdict not given yet, or one the chain could not answer, opens nothing. The payload has `marketId`, `pool`, `reason` and `asset`. | The market id. | `market_registry` (the seeds' rows). |
| `paused` | warning | A contract is paused. One alert per contract. | Its role and short id (`sy:CA62…7F2I`). | `is_paused` of RiskControl and of each market's SY wrapper, pool and manager. |
| `risk_warning` | warning | The circuit breaker's window volume is at least 90% of its limit, protocol-wide or for one asset. | RiskControl's id, or `asset:<asset id>`. | RiskControl `get_cb_limit`, `get_cb_volume`, `get_asset_limit`, `get_asset_volume`. |
| `risk_exhausted` | critical | The volume is at or over the limit. It replaces the warning. A limit of 0 is off: neither opens. A per-asset limit and the protocol-wide one are two breakers, so the same deposits can open an alert on each. | The same. | The same. |
| `signer_low` | warning | The keeper signer holds less than `ALERT_SIGNER_MIN_XLM` (default 20) XLM, or its account does not exist. | The signer's public key. | Horizon. The signer follows `ORACLE_KEEPER_MODE`: `ORACLE_ADMIN_SECRET`'s public key in push mode (the default), `ORACLE_KEEPER_SECRET`'s in feed mode. Without that key, there is no check. |
| `indexer_lag` | warning | An index group's cursor is more than 3,600 s behind (the close time of its ledger). | The group. | `ingest_cursor`. |
| `indexer_gap` | critical | An index group has a stored gap (`gap_from is not null`), with `{ from, to }`. | The group. | `ingest_cursor`. |

- A source the check cannot read (the RPC, Horizon, the database) keeps the alerts it feeds as they
  were: none of them closes, so a flaky read never closes an alert and opens it again. The hold is as
  narrow as the source. An oracle that cannot be read holds only its own alerts, and the
  other oracles are judged as usual. An unreadable registry holds `seed_invalid`. The run's answer
  names the sources (`unread`, per oracle as `oracle:<id>`, `ticks:<id>`, `rejectionEvents:<id>`,
  `keeper:<id>`) and what was held (`held`: a kind alone, or `kind:subject` for one alert). Not being
  able to read the oracle itself opens `oracle_unavailable`.
- An `ORACLE_KEEPER_INTERVAL_SECONDS` that is not valid does not stop the check. It logs the variable's
  name, and only `keeper_unhealthy` and `feed_broken`, which are measured against the interval, are
  held for every oracle (`unread` names `keeperInterval`). Every other kind is judged. The check no
  longer answers 500 for it: only the keeper (`cron/oracle`, in feed mode) answers 503 `not_configured`.
- Before the per-oracle alerts, a rejection's subject was its reason alone (`deviate`). Such an open
  alert closes, without a post, on the first run of this version, and the per-oracle one opens.
- A circuit-breaker trip rolls its transaction back and leaves no event, so the risk page's
  exhaustion history is the open and close times of these `risk_*` alerts.

**Webhook.** Every opening and every close is posted once to `ALERT_WEBHOOK_URL` as JSON:

```json
{ "text": "[Principal testnet] Critical alert opened: Oracle stale (CDYG…YIPS, USDY). Value age 3,700 s, over the 3,600 s allowed: …",
  "content": "(the same line)", "kind": "oracle_stale", "subject": "CDYG…", "severity": "critical",
  "network": "testnet", "at": "2026-11-14T12:00:00.000Z", "status": "opened", "test": false, "details": { … } }
```

- `text` (Slack) and `content` (Discord) carry the same line, so either incoming webhook takes the
  payload as is. A close reads "Resolved: Oracle stale (…), open since …". Event kinds
  (`oracle_rejection`, `feed_broken`) have no close post.
- The line shortens every contract id in the subject ("Oracle rejected an update (CDYG…YIPS:deviate,
  USDY)") and names the asset of an oracle's alert and of `seed_invalid`. `subject` keeps it whole.
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
| 500 | The same body with `critical: true`, or `{ error: "failed" }` | A critical alert is open (`oracle_stale`, `oracle_unavailable` once confirmed, `keeper_unhealthy`, `seed_invalid`, `risk_exhausted`, `indexer_gap`), so the scheduler's own failure alert fires too; or an unexpected error. Five stale oracles are five critical alerts. |
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
  "indexer": { "status": "ok", "indexedThrough": 5719940, "indexedThroughCloseTime": "…", "lagSeconds": 300, "gaps": [], "pendingGroups": [] },
  "keeper": { "status": "ok", "healthy": true, "lastSuccessAt": "…", "lastOkAt": "…", "lastTickAt": "…" },
  "keepers": [{ "oracle": "CDYG…", "asset": "USDY", "healthy": true, "lastOkAt": "…", "lastTickAt": "…" }],
  "openAlerts": { "status": "ok", "count": 1, "critical": 0 } }
```

Each part is read on its own, within 4 s. A part that fails or hangs reads
`{ "status": "unavailable", "reason": "…" }` and the others still answer. Before the first run of a
group (no cursor yet, for example `market` and `escrow` before the first market) the indexer reads
`{ "status": "pending", "reason": "no index run yet", …, "pendingGroups": ["escrow", "market"] }`,
with `indexedThrough` 0 and `lagSeconds` null. Pending is not unavailable: it changes no status code.
When every part is unavailable it answers 503 (not cached), with the same body. The keeper is read per
oracle of the manifest's markets. `keepers` lists each oracle, and is null while the keeper part is
unavailable. `keeper` stays one object for monitors and describes the worst oracle: an unhealthy one
first, then one with no run recorded, then a healthy one; among equals, the oldest `lastOkAt`.
`healthy` is null while no keeper run is recorded for that oracle, so one oracle with no run makes
`keeper.healthy` null, never true. `openAlerts.critical` counts an `oracle_unavailable` only once
confirmed. An uptime monitor can watch the status code, `ledger.status`, `indexer.lagSeconds` or
`openAlerts.critical`. For the keeper, monitors read `GET /api/health` and test
`keeper.healthy !== false`: `null` (no run recorded yet) is unknown, not a failure, and a bad
`ORACLE_KEEPER_INTERVAL_SECONDS` makes the keeper part `unavailable`.

## Operations for Tranche 3 go-live

The developer's checklist for putting the dashboard and its monitoring live on Testnet, in order.
Each step waits for the developer's go. No step needs a secret in this repository.

1. **Migrate the Testnet database.** `pnpm db:migrate --env-file .env.testnet` applies 0004 to 0008
   (events, ticks and alerts; the cursor's close time; gaps and members; the alerts' post flags; the
   events' contract and topic index). 0001 to 0003 are already applied there.
2. **Load the history.** Run the capture once more just before the import (the next one is due by
   2026-11-20 in any case, see "Event indexer"), then import it:
   `pnpm indexer:capture --network testnet`, then
   `pnpm indexer:import --network testnet --in var/indexer-capture/testnet-<YYYYMMDD>.jsonl --env-file .env.testnet`.
3. **Set the alert variables** in Vercel, scoped to the `testnet` branch: `ALERT_WEBHOOK_URL` (the
   channel's incoming webhook), and `ALERT_SIGNER_MIN_XLM` only to change the 20 XLM floor.
4. **Deploy** this branch to `testnet` (the Vercel Preview behind `testnet.principalmarket.fi`).
   `/dashboard`, the cron routes and `/api/health` exist from this deployment on. Check that
   `/dashboard` loads and `GET /api/health` answers 200.
5. **Schedule the indexer.** A QStash schedule, cron `*/5 * * * *`, to
   `https://testnet.principalmarket.fi/api/cron/index`. Wait for its first run to complete:
   `GET /api/health` then shows `indexer.status` `ok` and a `lagSeconds` under 3,600. Until every
   group has run once it shows `pending`, with the reason "no index run yet" and the groups still to
   run (`pendingGroups`). Let the first run happen before 2026-11-20 09:00 UTC. After that date, each
   registry market that is not a seed starts as new at `deployLedger` and records a false gap. Clear
   it with `clear-gap` on the `market` group and on the `escrow` group (see "Event indexer").
6. **Schedule the alert check**, only after step 5: cron `*/5 * * * *` to
   `https://testnet.principalmarket.fi/api/cron/alerts`, with retries set to 0. The route answers 500
   while a critical alert is open, so the scheduler's own failure alert fires too. With retries, each
   500 would be run again seconds later: a full check each time, and a failure log that fills for as
   long as the critical lasts. The schedule runs it again in 5 minutes anyway. Before the first index
   run, the old or missing cursors would open (and post) `indexer_lag` for every group.
7. **Send a test alert.** One POST to `https://testnet.principalmarket.fi/api/cron/alerts?test=1`,
   signed by QStash: publish one message to that exact URL from the QStash console, with retries set
   to 0 (a 502 would otherwise be retried and send the test again). The signature is checked against
   the URL the request came in on, `?test=1` included. A `CRON_SECRET` set in that environment works
   too, with the curl in "Alerts". It answers 200 with `delivered: true` once the channel took it, and
   `GET /api/dashboard/alerts` then shows it as `lastTest`.
8. **Run the drill** from your own terminal (below). After the next `cron/index` run (at most 5
   minutes, plus the API's 60 s cache) the dashboard shows its seizure, its rejection and its pause.
9. **Publish the docs**, last: push `org/docs` `main` (8979cd3, "the public dashboard"), only after
   the app deployment of step 4. The page tells readers to open **Dashboard** from the app's header,
   which exists only from that deployment on. Vercel deploys the docs site from the push.

Why this order: the cron routes and `?test=1` exist only on the new deployment, so the schedules and
the test come after it. A Vercel variable applies only to deployments made after it is set, so it
comes before. The tables must exist before the import and before the deployed code writes to them
(`cron/oracle`, already scheduled, starts recording its runs in `oracle_ticks`). The drill comes after
them so the index and the alert check are watching when it runs. The docs come last: they point at a
dashboard that must be live.

### The Testnet drill (`scripts/dev-stack/drill.sh`)

On the official deployment nothing has been seized, refused or paused yet, so every history view on
Testnet would stay empty. The drill makes one of each, as an operator would, and prints every
transaction hash with its stellar.expert link. It is proven on the local stack first
(`tests/integration/drill.test.ts`). It never runs in CI or from an agent: on Testnet it signs with
the official keys.

```bash
PRINCIPAL_NETWORK=testnet scripts/dev-stack/drill.sh
```

| Step | What it does | Signed by |
|---|---|---|
| Recovery | A throwaway account (a key made for the run, funded by Friendbot) adds a USDY trustline, is onboarded by the app's public faucet, deposits 10 USDY into the SY wrapper and mints PT and YT from 5 SY. It is then deauthorized on the USDY SAC, and `seize_all_positions` moves everything to the RecoveryEscrow: one record (its SY unwrapped to USDY at once, its PT and YT held until `finalize_record`), one `recovery` event. Its key is then removed from the keystore. | The throwaway key (trustline, deposit, mint). `principal-testnet-admin`, the SAC admin and so the escrow's issuer authority (deauthorize, seize). |
| Oracle | A value over the deviation cap (the cap plus 5 %: 15 % above the current value with the 1,000 bps cap), simulated first: the drill stops unless the simulation answers `false`. Sent, it returns `false` and the oracle emits `ref_rej` with reason `deviate`. Then one `oracle-tick.sh`, so the oracle is fresh again. A tick refused as `stale_ts` (the scheduled keeper landed in the same ledger second) is retried once, 6 s later, and both hashes are printed. | `principal-testnet-oracle`, the OracleAdapter admin. |
| Pause | RiskControl `pause`, about 15 s, then `unpause`: two `paused` events. Every market refuses deposits and mints meanwhile. | `principal-testnet-admin`, the RiskControl admin. |

- **Before it signs anything**, it refuses CI, an agent session (`CLAUDECODE`: "The Testnet drill is
  run by the developer, not by an agent."), a `.env` file in the working directory or any parent (the
  Stellar CLI loads one, and its `STELLAR_*` or `SOROBAN_*` lines would reach it unseen: the drill names
  the file and never reads it; it then runs every command from a fresh temporary directory, whose
  physical parents it checks the same way and which holds an empty `.env` of its own, so the CLI loads
  no parent's), the Stellar CLI variables that would change the network,
  the config, the default source, the signer or the sending (`STELLAR_RPC_URL`, `STELLAR_RPC_HEADERS`,
  `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_NETWORK`, `STELLAR_ACCOUNT`, `STELLAR_SIGN_WITH_KEY`,
  `STELLAR_SIGN_WITH_LEDGER`, `STELLAR_SIGN_WITH_LAB`, `STELLAR_SEND`, `STELLAR_INVOKE_VIEW`,
  `STELLAR_CONFIG_HOME`, and every `SOROBAN_*` variable, which the CLI reads as its `STELLAR_*` twin; it
  unsets them on every network, so `oracle-tick.sh` never inherits one), any key name but the official
  ones, `DRILL_MANIFEST`, and a run without a terminal. It checks that the CLI's own `testnet` network
  (built in, or from a config file) is the SDF RPC and passphrase (a list it cannot read in full stops
  the run), each key against the contract's own
  admin (`admin()`, `get_admin()`), that RiskControl is not already paused (it never unpauses a pause
  it did not make) and that the oracle reads as fresh (the mint needs it: a stale or unreadable oracle
  stops the run; it is checked again right before the mint, where it stops the run before the admin
  key signs anything), shows what it will sign, and asks you to type the market id.
- **The pause always ends.** Once the pause is sent, an exit trap unpauses on any failure, Ctrl-C, TERM,
  `Ctrl-\` (QUIT) or the terminal closing (HUP). It decides from the pause's own transaction, waiting for
  one still in flight, not from an `is_paused` read that may lag. While it cleans up it ignores further
  interrupts (INT, TERM, QUIT, HUP, a closed output's PIPE, Ctrl-Z), so a second Ctrl-C, or Ctrl-C then
  closing the terminal tab, cannot cut the unpause short. Ctrl-Z is ignored while RiskControl is paused.
  `DRILL_PAUSE_SECONDS` (0 to 30, default 15) sets the wait, so the pause lasts under a minute; the drill
  prints how long it lasted in ledger time. A Ctrl-C during the unpause itself sends a second, harmless
  unpause (a third `paused` event).
- **Other pausers.** RiskControl's admin and any registered pauser can pause it. The drill refuses to
  start when RiskControl is already paused, but a pause made by someone else during the drill's own
  window is undone by the drill's unpause. Tell the other pausers before you run it, and after it, check
  the risk page's pause history for a pause that was not the drill's.
- **When no trap can run** (SIGKILL, a `kill -STOP`, the machine asleep or off), check and unpause by
  hand (a stopped drill can also be resumed with `fg`). RiskControl
  is `shared.riskControl` of `config/manifests/testnet.json` (`jq -r .shared.riskControl
  config/manifests/testnet.json`), `CCRZ55SG273OTUZSFME6A6XXXEZ3GM5IMVRLF4NEEWNC54NGCRHIMHJC` today.
  These commands have the same exposure as the drill: run them where no `.env` sits in the directory or
  any parent (the CLI would load it and could send them to another RPC), with no `STELLAR_*` or
  `SOROBAN_*` variable set:

  ```bash
  RC=$(jq -r .shared.riskControl config/manifests/testnet.json)
  stellar contract invoke --id "$RC" --source-account "$(stellar keys address principal-testnet-admin)" --network testnet --send=no -- is_paused
  stellar contract invoke --id "$RC" --source principal-testnet-admin --network testnet -- unpause --caller "$(stellar keys address principal-testnet-admin)"
  ```

- **Options.** `DRILL_STEPS=oracle,pause` runs only those steps, in the same order.
  `DRILL_ONBOARD=issuer` onboards with `principal-testnet-issuer` (the faucet's own key, the classic
  issuer and Permissioning admin) instead of the public faucet; `DRILL_FAUCET_ORIGIN` changes the
  faucet's origin. `DRILL_MANIFEST` (local only) runs on another local deployment's manifest, e.g. one
  written by `MANIFEST_OUT=<path> deploy.sh` for a market that has not matured.
- **No secret, every hash.** It passes identity names to the Stellar CLI, never a secret, discards
  `keys generate`'s output and prints the CLI's errors with anything shaped like a secret key redacted.
  Every hash goes to stderr with its link: Friendbot's from its answer, the faucet's authorization and
  payment from Horizon (the faucet's answer carries no hash). The faucet's allow-list calls are
  contract calls by its own key: Horizon does not list them under the account and the faucet does not
  return them, so the drill cannot print them; the dashboard's Activity view shows them once indexed.
  A JSON summary (hashes, the throwaway account, the mint, the record) goes to stdout.
- **What each run leaves** on Testnet, and a rerun adds another full set:
  - a deauthorized throwaway account holding about 99,990 test USDY (the faucet's 100,000 less the
    deposit) and Friendbot's XLM, unspendable once its key is deleted;
  - its Permissioning grants (the account, and each market's PT and YT);
  - one RecoveryEscrow record (the USDY from its SY, and its PT and YT until finalized);
  - one `ref_rej` `deviate`, one keeper `ref_set` and two RiskControl `paused` events (plus a
    `ref_rej` `stale_ts` when the keeper tick was retried, and a third `paused` event after a Ctrl-C
    during the unpause);
  - an `oracle_rejection` alert (warning, posted) open for 24 h. An alert check that happens to run
    during the pause also opens and then closes `paused`.
- **Finalization.** `finalize_record` settles the record's PT and YT into USDY, and only after the
  market's maturity (11 February 2027, 08:59:04 UTC for `testnet-usdy-1802336344`), so it is not part of
  the drill. The drill prints the command with the record's id; after maturity, as the SAC admin:

  ```bash
  stellar contract invoke --id CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q --source principal-testnet-admin --network testnet -- \
    finalize_record --caller "$(stellar keys address principal-testnet-admin)" --id <record id>
  ```

  It answers `(underlying_from_pt, underlying_from_yt)` and emits `finalize`. A record without PT or YT
  (a drill run on a matured market, where the mint is skipped and said) has nothing to settle:
  `finalize_record` refuses it with `NothingToFinalize`. A demo of the finalization before February 2027
  works on the local stack only: run the drill there with `DRILL_MANIFEST` on a short-maturity market. On
  Testnet the official market matures on 2027-02-11, so finalize its record after that date.

## Mainnet go-live

The developer's checklist for putting the app live on Stellar Mainnet at `principalmarket.fi` (Vercel
Production, branch `main`), in order. Each step waits for the developer's go. No step needs a secret
in this repository, and nothing is signed on Mainnet by an agent, a test or CI. Merge the `testnet`
pull request and go live the same day: the landing's "Live on Stellar Mainnet and Testnet" line
deploys with that pull request on `testnet.principalmarket.fi`, while Mainnet is not live until step 5.

1. **The Mainnet database.** Its own Neon branch (`mainnet`), with its connection strings in
   `.env.mainnet` (git-ignored). `pnpm db:migrate --env-file .env.mainnet` applies 0001 to 0008.
2. **Load the history, before any `cron/index` run.** `pnpm indexer:capture --network mainnet`
   (Mainnet is only read; the rows go to this machine's database), then
   `pnpm indexer:import --network mainnet --in var/indexer-capture/mainnet-<YYYYMMDD>.jsonl --env-file .env.mainnet`.
   `var/indexer-capture/mainnet-v2-20261121.jsonl` is on the developer's machine: 235 events and the
   five cursors, through ledger 65586642, from the dRPC `rpcUrl` of step 4 and the current manifest
   (the five markets, v2 contracts for MOCKUSTRY, MOCKGILTS, MOCKCETES and MOCKXAUM), with no gap.
   It holds 180 rows of the shared contracts and 11 per market (the first of MOCKUSDY at ledger
   65531529; the v2 markets' first events at 65584567, 65584825, 65584974 and 65585100, after their
   `createdLedgers`). For MOCKUSDY's contracts and the shared ones, up to ledger 65577228, it holds
   the same 109 events as the older `mainnet-20261120.jsonl`. That older file (taken from the public
   gateway before the v2 redeploy) also holds 40 events of the abandoned v1 contracts of MOCKUSTRY,
   MOCKGILTS, MOCKCETES and MOCKXAUM and none of the v2 ones: do not import it as the history.
   The RPC keeps about 7 days (120,960 ledgers): MOCKUSDY's and the shared contracts' history (from
   2026-11-17) leaves the window around 2026-11-24, the v2 markets' (created 2026-11-20/21) around
   2026-11-27/28. The file keeps what it holds, but a file whose cursors have left the window makes
   the first scheduled run record a gap, and events after the capture are only in the RPC. Run the
   capture again just before the import in any case: it resumes from the local cursors and rewrites
   the day's file.
3. **Production variables** in Vercel, scoped to Production only:
   - `NEXT_PUBLIC_PRINCIPAL_NETWORK=mainnet`;
   - `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` of the Mainnet branch;
   - `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` of the `principalmarket-mainnet`
     QStash account;
   - `ALERT_WEBHOOK_URL`, the alert channel's incoming webhook;
   - `ORACLE_KEEPER_MODE=feed`, `ORACLE_KEEPER_SECRET` (a new key with no protocol role, funded with
     XLM by the developer) and `ORACLE_KEEPER_INTERVAL_SECONDS=300`. A keeper key funded with less
     than 20 XLM raises `signer_low` (the default floor) from the first alert run: fund it with more
     than 20 XLM, or set `ALERT_SIGNER_MIN_XLM` here, below its balance.

   Never a faucet or admin secret: `FAUCET_ISSUER_SECRET`, `FAUCET_PERMISSIONING_ADMIN_SECRET` and
   `ORACLE_ADMIN_SECRET` stay unset there, as do `ORACLE_KEEPER_ORACLE_ID` and
   `ORACLE_KEEPER_RECORD_REJECTIONS` (a rejection is then recorded from the simulation, at no fee). A
   variable applies only to deployments made after it is set, so this comes before step 5.
4. **Choose the read path.** Decided: a keyed dRPC endpoint (`lb.drpc.live`) is `rpcUrl` in
   `config/manifests/mainnet.json`, and the public gateway
   (`https://soroban-rpc.mainnet.stellar.gateway.fm`, which answered HTTP 429 after about 96 reads in
   one measurement on 2026-11-20, 6 at a time) is its `rpcFallbackUrls` entry. One `/dashboard` tab
   reads about 70 oracle values per refresh, so the public pages alone can use up a public allowance.
   Every read goes to dRPC first; a contract read it refuses (HTTP 429 or 5xx, a timeout, a network
   error) is asked again of the gateway, which is then asked last for 30 s (see the manifest's
   `rpcFallbackUrls` above). Only contract reads (`createRpcReader`, most of the dashboard's load) and
   the alert check's ledger clock fall back; trade simulations, event pages (history and the
   indexer), preparing and sending a transaction, transaction lookups and the keeper stay on `rpcUrl`.
   `rpcUrl` is a field of the contracts team's file, so
   `lib/protocol/__tests__/mainnet-manifest.test.ts` asserts that the handover's `rpcUrl` is among our
   `rpcFallbackUrls` and puts it back before it compares: any other difference is still caught.

   dRPC has no `getHealth` (HTTP 400, JSON-RPC -32601) and refuses a request without `params`. The
   RPC's ledger window is therefore read with `getHealth` first and, only when that method is
   unsupported, with `getLedgers` (`oldestLedger`, `latestLedger`; asked a few ledgers behind the
   latest, since a load balancer's backend may not hold the newest one): `lib/protocol/rpc-window.ts`,
   used by the indexer, the registry and the in-app history, and a copy in `scripts/indexer.mjs`. dRPC
   also refuses an event start older than its events state ("First available state is N"), which the
   pruned-start retries read. Any other failure behaves as before.

   The manifest is public (this repository, and every browser that loads the app), so a key in its
   URL is public too, and it is not a server secret. The key has a usage cap the developer accepts. The
   server jobs (keeper, alert check, indexer) read through the same URL, so a key that only answers
   requests from the site's origin can refuse them. On Mainnet the dashboard's live widgets already
   refresh every 60 s instead of 15 s (see "Cadence" under "Dashboard").
5. **Move `main` to the app.** `main` has three commits the app line (`testnet`) lacks: `0d2754c`
   (a period in the landing's compliance title), `f280f7d` (the `/docs` rewrite, which the app line
   has too) and `f6bf73c` (the E2E workflow, which the app line has in a newer form). So `main`
   cannot simply fast-forward. A merge either way stops on two files: keep the app line's
   `.github/workflows/e2e-testnet.yml` and `lib/content.ts` (its `dashboard` link); the title's
   period merges by itself. Pick one:
   - **Bring the three commits onto the app line, then move `main` to it.** Merge `main` into
     `testnet` (by pull request, like any change there), then `git push origin testnet:main`, a
     fast-forward. `main` and `testnet` are then the same commit.
   - **One merge commit on `main`.** `git switch main`, `git merge testnet`, resolve, push `main`.
     `testnet` stays as it is, and `main` is that merge commit ahead of it.

   The push deploys Production. Check that `/app` and `/dashboard` load with the Mainnet banner, and
   that `GET /api/health` answers 200. Then check the read path of step 4: open a fresh `/dashboard`
   and a fresh `/app` (a private window each, with the browser's network panel open) and leave them
   for several minutes, at least five refreshes of the dashboard's live widgets. The figures must stay
   readable, and no RPC request may answer 429. If some do, go back to step 4. Look again once the
   schedules of step 7 run, since they read through the same RPC.
6. **Check the deployment against the manifest:** `pnpm smoke:mainnet` (see Scripts). It must end
   with `PASS`: five topologies and 44 code hashes (12 pinned hashes) match. A stale oracle is only a
   warning there. On 2026-11-20 all five oracles were stale (no relay was running), and the run
   says so: it ends `PASS` with five warnings, never with a fresh oracle it did not read. All five
   oracles of the v2 manifest name a feed (`feed_source()` is set), so the keeper has something to
   sync on each; the stored values were at the feed's price (equal for MOCKUSDY, MOCKUSTRY and
   MOCKGILTS, under 0.01 % and 0.41 % apart for MOCKCETES and MOCKXAUM). The keeper refreshes all
   five. A feed value that moved past an oracle's deviation cap is refused (a significant rejection,
   which opens `oracle_rejection`), so read the table's "Value against feed" column again at go-live.
7. **The schedules**, on the `principalmarket-mainnet` QStash account, each to the exact
   `https://principalmarket.fi/api/cron/<job>` URL: `record` (`*/15 * * * *`) and `index`
   (`*/5 * * * *`). Then wait until the index has caught up: `GET /api/health` shows
   `indexer.lagSeconds` under 3,600 and `indexer.gaps` empty (`[]`). `indexer.status` `ok` alone
   does not show it: it reads `ok` right after step 2's import, whose cursors are hours or days old.
   A gap there means the capture's cursors had left the RPC's window (see "Event indexer"). Only
   then `alerts` (`*/5 * * * *`, retries 0): started earlier, its first run would open (and post)
   `indexer_lag` for every group. While an oracle is stale, `cron/alerts` answers 500 (a critical
   alert is open), so with retries every run would be repeated seconds later. Then `oracle`
   (`2-57/5 * * * *`, retries 0): every 5 minutes too, but 2 minutes after `index` and `alerts`.
   These jobs can share one instance and its cap of 6 reads in flight (see "Read concurrency" under
   "Before mainnet"); started together, the keeper's reads would wait behind the alert check's (about
   90), and its oracles would end `failed: not decided` at 15 s. The keeper answers 500 when any
   oracle fails, so with retries QStash would run it again within seconds, with more reads on a
   rate-limited RPC and a send that can meet the previous run's transaction still queued. The next
   scheduled run is its retry.
8. **A test alert.** One QStash message to `https://principalmarket.fi/api/cron/alerts?test=1`, with
   retries 0, as in the Testnet steps. It answers 200 with `delivered: true`, and
   `GET /api/dashboard/alerts` then shows it as `lastTest`.
9. **The signed smoke test**, by the developer: with a wallet the contracts team has granted, deposit
   a small amount of MOCKUSDY in the app (Quick actions: Deposit), then split a separate amount of
   MOCKUSDY into PT and YT (Quick actions: Split), and note the two transaction hashes for the
   reviewer files. Split (`wrap_and_mint`) starts from MOCKUSDY, not from the deposit's SY, which
   stays in the wallet. Keep both amounts small: on 2026-11-18 the protocol-wide circuit breaker had
   about 699 units of room left for all five assets together (requests-arthur-0004 §10), and a split
   counts twice against it (its wrap into SY and its mint). The split needs MOCKUSDY's oracle fresh:
   wait for a keeper run that `synced` it (the oracle page, or `GET /api/dashboard/oracle-ticks`).
10. **The first keeper runs.** Note the fee of one `sync_from_feed` (its transaction on
    stellar.expert), then set `ALERT_SIGNER_MIN_XLM` so that `signer_low` warns while the keeper key
    still holds several days of runs, and redeploy so the variable applies. Until then the floor is 20
    XLM, or the value step 3 set: a keeper key holding less raises `signer_low` from the first alert
    run, which is why step 3 funds it above that.

## Local network

`scripts/dev-stack/` runs a local Stellar network with a real, seeded market, so every flow works
without the Testnet deployment. It needs the Stellar CLI, `jq`, a Rust toolchain and Podman or
Docker. Full details are in [`scripts/dev-stack/README.md`](scripts/dev-stack/README.md).

```bash
scripts/dev-stack/up.sh                              # start the network, create keys
scripts/dev-stack/deploy.sh                          # deploy and seed two markets, maturing in a day
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
| `pnpm smoke:mainnet` | The read-only Mainnet check: the deployment against `mainnet.json` (below). |

`pnpm smoke:mainnet` (spec 0005 M-22) reads the Mainnet deployment through the app's own read
functions and compares it with `config/manifests/mainnet.json`. It reads, in this order: the ledger
clock; the code hash of every contract the manifest names against its pin in `wasmHashes` (44
contracts, 12 pinned hashes); each market's topology (`Router.market(pool)` and the manager's
maturity); each oracle's state on the ledger clock, with its feed's price when it names a feed; each
market's state, RiskControl and the pauses. Only simulations and ledger-entry reads, on the
manifest's RPC and passphrase: no key, no database, nothing signed.

- It prints one table (market, topology, oracle state, feed, value against feed, paused), what it
  found, and a summary line, `PASS` or `FAIL`.
- It exits 1 when a topology differs, a pinned code hash differs, or a contract the manifest names
  cannot be read (its code, pinned or not, or any of its views); 2 for a usage error. A stale oracle,
  a paused contract, a contract with no pin (its code read) and a feed it cannot read are warnings:
  reported, never a failure.
- `--json` prints the same as JSON. `node --experimental-transform-types scripts/smoke.mjs --network testnet`
  checks another network (`testnet` or `local`).
- Its reads take the app's read cap (6 in flight). The Mainnet gateway still refuses a burst as busy
  (about 100 reads at once on 2026-11-20), so a read refused as busy, or not answered, is asked again
  after a pause; stderr says how many were. A contract's own answer is never asked again. The run's
  budget is 4 minutes: no read is asked after it (a read not asked fails the check), and a run still
  going a minute later stops with exit 1.
- It is not part of CI, since it depends on a public RPC. Run it by hand, and before the go-live.

`pnpm test:integration` needs the local stack running and a deployed `config/manifests/local.json`
(`scripts/dev-stack/README.md`). If the network is not reachable, the suite skips and says why.

- It runs the routes, curve, oracle, oracle feed, registry, recorder, indexer, alerts and drill suites against the existing local market.
  The indexer suite also needs the local Postgres migrated (`pnpm db:migrate`) and refuses a
  `DATABASE_URL` that is not on this machine: it seizes a throwaway account's positions and deletes
  and restores local `events` rows. The oracle feed suite (`oracle-feed.test.ts`) deploys its own
  mock feeds and four standalone oracles (`scripts/dev-stack/feed-oracle.sh`), needs Rust with
  `wasm32v1-none` and the same local Postgres, and deletes its rows afterwards. The drill suite
  (`drill.test.ts`) runs `scripts/dev-stack/drill.sh` on the local market (a throwaway account seized,
  with PT and YT when the market can still mint, else SY only; one `deviate` rejection; RiskControl
  paused for a few seconds, then stopped mid-pause to prove the trap unpauses) and checks the indexed
  rows; its rows stay in the local database. `DRILL_MANIFEST=<path>` runs it on another local
  deployment, e.g. a fresh one made with `MANIFEST_OUT=<path> MATURITY_SECONDS=1500 deploy.sh`.
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
  server-secret bundle check. It then builds again with `NEXT_PUBLIC_PRINCIPAL_NETWORK=mainnet` and
  runs the same check on that bundle.
- `.github/workflows/e2e-testnet.yml` runs the live end-to-end suites on Stellar Testnet on every
  pull request to `testnet` or `main`, and also nightly and by hand (see below). They sign real Testnet transactions with keypairs made in the run. The workflow uses no
  repository secret, and no key is set in its environment.

| Job | Suite | What it covers | Time |
|---|---|---|---|
| Suite A: live journey | `tests/e2e-testnet/journey.test.ts` | The user journey on the official deployment (`config/manifests/testnet.json`). Two fresh accounts are onboarded through the public faucet, then: deposit, split, Buy and Sell PT and YT in USDY, liquidity in and out, a PT and a YT transfer, the History page's reads, and the refusal of an account that was not onboarded. | about 5 min |
| Suite B: ephemeral lifecycle | `tests/e2e-testnet/lifecycle.test.ts` | A throwaway market with a 20-minute maturity, deployed on Testnet by `scripts/dev-stack/deploy.sh` (`EPHEMERAL=1`) with four keys generated in the run, from `principal` at the Mainnet manifest's `sourceCommit` (`3af9388`, read from `config/manifests/mainnet.json`), so each run proves Mainnet's contracts on a deployment it controls. It covers an oracle tick, a yield claim, compliance recovery (deauthorize, seize, settle the record), the stale-oracle and post-maturity refusals, and redemption at maturity. The keys are removed at the end. | about 22 min |

- Suite A runs on the official market, so it needs at least 6 hours (`MIN_RUNWAY_SECONDS` in
  `journey.test.ts`) before that market's maturity. Near maturity (February 2027),
  `config/manifests/testnet.json` must move to a new market.
- The two jobs run in parallel, so a run takes about 25 minutes. Suite A stops at 20 minutes and
  Suite B at 55 (room for a cold build and a failed deploy, with the record still uploaded).
- Suite B builds the contracts with cargo and Rust 1.95.0 (pinned, so every run builds the same
  wasm) and deploys them with the Stellar CLI 28.1.0. On the developer's machine Rust 1.95.0
  reproduced the official Testnet deployment (`665bb67`) byte for byte; Mainnet's wasm was built with
  rustc 1.94.1. Each run's job summary compares the Linux build with `mainnet.json`'s `wasmHashes`,
  for information only: a difference is expected with another toolchain, and the wasm files embed the
  builder's home directory (through the cargo registry's path; ten of twelve at `665bb67`), so the
  bytes also depend on the machine that builds them.
- The build (a few minutes) is cached by `sourceCommit` and Rust version. It runs again when either
  changes, when the cache has not been used for 7 days, and on a pull request's first run until the
  nightly run on `main` has warmed the cache (a pull request's cache is its own).
- Each job uploads its run record (`e2e-artifacts/journey.json` or `lifecycle.json`: public keys,
  transaction hashes, the refusals) as an artifact, kept 30 days, also when the run fails.
- A newer push to a pull request cancels its older run.

The nightly run and manual runs use the workflow file on the default branch, `main`. Until the
Mainnet go-live, `main` is the landing site alone and carries a copy of this one file: keep the two
copies identical. From the go-live on, `main` holds the app (this file included), and pull requests
to it run the suites too. The nightly run, and any run started from `main`, check out branch
`testnet` and test it with its own `testnet.json`. Run it by hand from the Actions tab ("E2E
Testnet", then "Run workflow"), or:

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
- **A later step could fail on rent.** Step 2 of a multi-step route, prepared in the ledger its
  previous step landed in, could fail with an insufficient refundable fee (reproduced twice locally).
  Every review now declares a 30% headroom on the simulated resource fee (see Before mainnet). If it
  still happens, the app says "prepare it again" and the route stays continuable.
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

Fine on Testnet; each needed a change before mainnet traffic (R2-79). The items marked done are in
place; the others are still open.

- **Bounded registry reads.** Done, in the Mainnet-preparation commit (`feat(mainnet-prep): …`).
  The markets list (`resolvedMarkets`, behind every page render, `GET /api/markets`, sparks and
  history) reads `where valid is true`, plus the seeds' own rows so a seed marked invalid stays
  hidden. Junk factory markets' invalid rows are never read there; discovery, re-validation,
  publishing and the manager view keep their own full read. `GET /api/markets` is cached 60 s at
  the CDN (`public, s-maxage=60, stale-while-revalidate=300`), and `no-store` on the seeds-only
  fallback and on errors.
- **Sparks above 50 pools.** Done, in the same commit. The client asks `GET /api/markets/sparks`
  in chunks of 50 pools, side by side, and merges the answers: 120 pools make 3 requests. A failed
  chunk marks only its own pools' sparks as unavailable.
- **Header role polling.** Done, in the same commit. The about 7 role views per market are polled
  every 30 s only while the manage view (`/app/manage` and below) is open, and every 120 s
  elsewhere.
- **Step quote against the route preview.** Done, in the same commit. A later step is signed with
  the floor from its own fresh simulation. When that quote is worse than the route preview by more
  than the slippage setting, the step review says "This step's quote is worse than the route
  preview by more than your slippage setting." above the sign button. It is a warning: the step can
  still be signed. Routes where no single step makes the previewed amount (an LP withdraw to SY,
  one after maturity) are not compared.
- **Refundable-fee margin.** Done, in the commit "declare 30 % headroom on the simulated resource
  fee". Every review declares the simulated Soroban resource fee plus 30% (rounded up), and the
  total fee with it, under the existing fee cap (`MAX_TX_FEE_STROOPS`). The unused refundable part
  is refunded, so it costs nothing (R2-80).
- **Read concurrency.** Done, in the commit "at most six browser requests at a time;
  shared in-flight reads; fallback rules". The dashboard's markets page fires about 28 reads per
  market at once every 60 s (853 for 30 markets, with shared reads de-duplicated). Every contract
  read (`simulateContractRead`, behind `createRpcReader`), every request of `simulateInvocation`,
  every code read (`contractWasmHashesSettled`) and every history page (`getEvents` in
  `lib/protocol/events.ts`) now waits for one of 6 slots (`RPC_CONCURRENCY`,
  `lib/protocol/rpc-limiter.ts`), per tab in the browser and per process on the server. Identical
  reads in flight share one request, until a transaction lands (`forgetInFlight`). The `/app`
  market list and the manage list refresh every 30 s; a market page keeps 6 s.
  - **On the server** the cap of 6 applies per process too (R9-4): the recorder, the indexer, the
    alert check and the keeper share it on one instance. A job that gives up at its deadline leaves
    its reads still queued; they run later, on the same instance while it stays warm, and their
    answers are dropped.
  - **History** in the browser takes a slot for each `getEvents` page, so a tab with a wallet and
    Mainnet's five markets has at most 6 in flight, not 10.
  - **The Mainnet gateway** still refused reads as busy (HTTP 429) after about 100 sent 6 at a time
    (2026-11-20). A figure refused that way reads "Unavailable" until its next refresh;
    `rpcFallbackUrls` stays empty until the developer names a second provider ("Mainnet go-live",
    step 4).
  - **Paths still outside the cap**, with the most requests each can have in flight on Mainnet (five
    markets, five oracles), on top of the 6 capped ones in the same tab or process:

    | Path | Where | RPC calls | At most in flight |
    |---|---|---|---|
    | Keeper, phase 1 | `lib/server/oracle-keeper.ts` `FeedChain.simulate`, every oracle at once | `simulateTransaction` | 5, one per oracle (its two view reads are capped) |
    | Keeper, prepare and send | `KeeperAccount` `sequence`, `prepare`, `send`, one oracle after another | `getAccount`, `simulateTransaction`, `sendTransaction` | 1 |
    | Keeper, confirmations | the sent hashes, looked up about once a second | `getTransaction` | 5, one per sent hash |
    | Indexer (`cron/index`) | `lib/server/indexer.ts`, the five groups at once; pages in sequence inside a group | `getEvents`, at times `getLedgers` or `getHealth` | 5, one per group (its reconciliation reads are capped) |
    | Registry discovery (`cron/record`) | `lib/server/registry.ts` `discover`, pages in sequence | `getEvents` | 1 |
    | Recorder close time (`cron/record`) | `app/api/cron/record/route.ts`, cached per ledger, markets in sequence | `getLedgers` | 1 |
    | Ledger clocks | `hooks/use-ledger-clock.ts` (one per tab), `app/api/health/route.ts`, the wizard's seed step (not on Mainnet) | `getLatestLedger` | 1 each |
    | Alert check's ledger clock | `lib/server/alerts.ts` `ledgerClockOf`, the primary then each fallback | `getLatestLedger` | 1 |
    | Faucet (not on Mainnet) | `lib/server/faucet.ts` | `getLedgerEntries`, `getAccount`, `sendTransaction` | 1 per run |
    | Review, onboarding, route and pending-action lookups | `lib/protocol/review.ts`, `lib/protocol/onboarding.ts`, `lib/protocol/tx-lookup.ts`, one user action at a time | `getAccount`, `prepareTransaction` (or a restore's `simulateTransaction`), `sendTransaction`, `getTransaction` | 1 per action |
- **An events index for the alert check and the reconciliation.** Done, in migration 0008
  (`events_network_contract_topic` on `(network, contract_id, topic, ledger desc)`). The
  RecoveryEscrow reconciliation and the alert check's rejection read filter by contract and topic,
  and `GET /api/dashboard/events?counts=1` counts by topic.
- **RPC fallbacks.** Done, in the same commit as the read cap; still inert while no manifest sets
  `rpcFallbackUrls`:
  - when every endpoint fails, the primary's error is reported, not the last fallback's;
  - a `TypeError` is transient (`isTransientRpcError` in `lib/protocol/reader.ts`) only when it is
    a fetch failure ("Failed to fetch", "fetch failed", "Load failed", "NetworkError"), so a bug in
    the client code no longer falls over to the next endpoint;
  - an endpoint that just failed transiently is asked last for 30 s, so a read stops waiting about
    20 s for a primary that is down. With no fallback, the primary is still asked.

  One exception: the alert check's ledger clock (`ledgerClockOf` in `lib/server/alerts.ts`) keeps
  its own primary-then-fallback loop. It has the narrowed transient rule, but not the primary's
  error or the 30 s memory.
- **Keeper capacity.** Done for Mainnet's five oracles. One feed-mode run covers about five to
  seven oracles: the network takes one transaction per account per ledger, so the sends go one after
  another, each after the previous one is in a ledger. Phase 1 (the reads and simulations) holds
  every send for up to 15 s, and the run's deadline is its start plus 45 s. More oracles need more
  keeper accounts or more schedules.
- **"Unavailable" with its reason in every `/app` figure.** Open. Spec 0004 D-27 says the reason is
  shown everywhere. The `/app` Safety and Details rows show it (`showLiveReason`), but 26 other
  `showLive` sites in `/app` (the mint and redeem tabs, the portfolio's position card) still show
  "Unavailable" alone. Move them to `showLiveReason` with `UnavailableTip`.
