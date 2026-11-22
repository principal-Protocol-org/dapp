# Tranche 3 (Mainnet): how to verify each success criterion

This file is for the Stellar Community Fund reviewer of Principal's SCF #45 grant, Tranche 3. For each deliverable it
quotes the description and the success criteria as the submission words them. Then, for each part of the success
criteria, it gives numbered steps to check it yourself (where to click, what to run, what you should see) and a status.

The evidence the steps point to (addresses, transaction hashes, live reads, CI runs, screenshots and dates) is in
[TRANCHE_3_EVIDENCE.md](TRANCHE_3_EVIDENCE.md). Both files were written on 21 November 2026, the day the dApp went live
on Stellar Mainnet, and updated on 22 November 2026, after the contracts team widened the oracles' freshness window
and pinned their build toolchain. All times are UTC.

Each status is one of:
- **Met**, with the evidence in these files;
- **Met in the contracts repository**, with a link;
- **Open**, with the owner and the reason.

**The Mainnet markets use mock assets.** The five markets on Mainnet hold MOCKUSDY, MOCKUSTRY, MOCKGILTS, MOCKCETES
and MOCKXAUM: Stellar assets issued by Principal for testing. They are not USDY or the other real assets, and the app
says so on every page. Each market's OracleAdapter reads the price of the real asset it tracks (USDY, USTRY, GILTS,
CETES, XAUM) from RedStone's SEP-40 feed on Mainnet. Principal cannot open a market on the real USDY: market creation
must be signed by the asset's own issuer authority
([evidence, introduction](TRANCHE_3_EVIDENCE.md#tranche-3-mainnet-evidence)).

## What you need

- A desktop or phone browser. The dashboard needs no wallet.
- Optional, for the contract checks: the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) (we used 30.0.1).
  Every command below only simulates a call (`--send=no`): nothing is signed or sent. The CLI's built-in `mainnet`
  network has no RPC, so the commands name the public gateway and the network passphrase. Set them once:

  ```bash
  RPC=https://soroban-rpc.mainnet.stellar.gateway.fm
  NET='Public Global Stellar Network ; September 2015'
  ```

  The gateway limits how many requests it takes (in one measurement it answered 429 after about 100 reads in a row).
  The steps below need about 20.
- Optional, for the read-only deployment check: a clone of the dApp repository, Node 24 and pnpm 12.5.1
  ([Rerun the read-only check yourself](#rerun-the-read-only-check-yourself)).

## Where things are

| What | Where |
|---|---|
| The dApp on Mainnet | <https://principalmarket.fi/app> |
| The public dashboard | <https://principalmarket.fi/dashboard> |
| The docs (end users) | <https://principalmarket.fi/docs>, dashboard page: <https://principalmarket.fi/docs/using-the-app/dashboard> |
| The dApp on Testnet (Tranche 2, unchanged) | <https://testnet.principalmarket.fi> |
| dApp repository at the Production commit `783d51c` | <https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd> |
| The Mainnet manifest the app reads | [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json) |
| Contracts repository, branch `mainnet` at `ae6ccd9` (the contracts team's Mainnet evidence) | <https://github.com/principal-Protocol-org/principal/tree/ae6ccd96e5929ff8cbb36f889afd89875647fec2> |
| The deployed contract source, `3af9388` | <https://github.com/principal-Protocol-org/principal/tree/3af938853e5818aa8d56bd35670b9a19cfa55a78> |
| The contracts team's deployment record | [docs/MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md), [docs/MAINNET_ADDRESSES.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_ADDRESSES.md) |
| Block explorer | <https://stellar.expert/explorer/public> |

## Summary

| Deliverable | Success criterion (part) | Status |
|---|---|---|
| 1 | All contracts are live on Stellar Mainnet with verified addresses | Met ([1.1](#11-all-contracts-are-live-on-stellar-mainnet-with-verified-addresses)) |
| 1 | the initial market configuration is active | Met ([1.2](#12-the-initial-market-configuration-is-active)) |
| 1 | a smoke-test deposit and mint succeed | **Met in the contracts repository**: deposit and mint on all five markets ([1.3](#13-a-smoke-test-deposit-and-mint-succeed)). **Open** (developer, after a grant by the contracts team): the dApp's own signed run through principalmarket.fi |
| 1 | the build is reproducible from source | **Open** (contracts team): the instructions and checksums are published and match the chain; on Linux x86_64 a rebuild gives the deployed bytes for the 2 contracts that embed no machine path; the 10 others need a rebuild with the original cargo path ([1.4](#14-the-build-is-reproducible-from-source)) |
| 2 | Dashboard and monitoring views are live on the Mainnet dApp | Met ([2.1](#21-dashboard-and-monitoring-views-are-live-on-the-mainnet-dapp)) |
| 2 | reflect real on-chain state | Met ([2.2](#22-they-reflect-real-on-chain-state)) |
| 2 | correctly surface RiskControl, oracle, market, and RecoveryEscrow status | Met ([2.3](#23-they-correctly-surface-riskcontrol-oracle-market-and-recoveryescrow-status)); no seizure has happened on Mainnet, the seizure view is shown on Testnet |
| 3 | The production oracle source is integrated through OracleAdapter | Met ([3.1](#31-the-production-oracle-source-is-integrated-through-oracleadapter)). The staleness window is 24 hours since 22 November; MOCKGILTS can still turn stale for a few minutes on a day without a GILTS tick ([open item 1](#open-items)) |
| 3 | current price and freshness status are visible on the dashboard | Met ([3.2](#32-current-price-and-freshness-status-are-visible-on-the-dashboard)) |
| 3 | stale or unavailable prices block affected protocol operations as designed | Met ([3.3](#33-stale-or-unavailable-prices-block-affected-protocol-operations-as-designed)) |
| 3 | automated alerting is active | Met ([3.4](#34-automated-alerting-is-active)) |

The tranche's objective, as submitted:

> Deploy all production contracts to Stellar Mainnet, extend the dApp with a protocol dashboard and monitoring views,
> and integrate and monitor the production oracle source used by the first live market.

---

## Deliverable 1: Mainnet Deployment + Production Configuration

### As submitted

> **Description:** Deploy the complete protocol contract set to Stellar Mainnet using the same scripted pipeline from
> Tranche 2, adapted for production. Publish mainnet-deployment-manifest.json (contract addresses, WASM hashes,
> deployment transaction IDs) to the repository. Configure production parameters: RiskControl circuit-breaker limits
> appropriate for production volume, oracle configuration for the first RWA market, market maturity and fee
> parameters, and the compliance configuration inherited from the underlying Stellar Asset. Publish reproducible build
> instructions so any reviewer can rebuild the WASM artifacts from source and compare SHA-256 checksums against the
> on-chain hashes. Switch the dApp to point to Mainnet contracts and run a smoke test using a small amount before the
> tranche is considered complete.
>
> **Success Criteria:** All contracts are live on Stellar Mainnet with verified addresses, the initial market
> configuration is active, a smoke-test deposit and mint succeed, and the build is reproducible from source.

**Who delivered what.**
- **The contracts team** deployed the contracts, from the contracts repository at `3af9388`, with its
  `scripts/deploy/deploy.sh` and factory scripts, between 17 and 21 November 2026. They set the parameters, ran
  deposits and mints from the command line, and published the manifests, the build section and the transaction
  record on branch `mainnet` ([evidence §3](TRANCHE_3_EVIDENCE.md#3-the-contracts-teams-mainnet-evidence)).
- **The app team** switched the dApp to those contracts (one manifest file), added the read-only deployment check,
  the dashboard, the oracle keeper and the alerts, and went live at <https://principalmarket.fi> on 21 November 2026
  ([evidence §1](TRANCHE_3_EVIDENCE.md#1-production)).

### 1.1 All contracts are live on Stellar Mainnet with verified addresses

1. Open the manifest [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json).
   It lists:
   - 4 shared contracts under `shared`: `router`, `permissioning`, `riskControl`, `factory` (and `oracle`, which is
     MOCKUSDY's OracleAdapter);
   - 5 markets, each with its asset (`underlying`: code, issuer, SAC, `tracks`) and its 8 contracts under
     `contracts`: `oracle`, `sy`, `pt`, `yt`, `config`, `manager`, `pool`, `recoveryEscrow` (plus the shared `router`);
   - `wasmHashes` for the 12 contract codes, and `sourceCommit` `3af9388`.

   Its addresses and hashes equal those of the contracts team's
   [deployments/mainnet-dapp-manifest.json](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-dapp-manifest.json).
2. Open any address on stellar.expert. All 44 are linked in [evidence §2.2](TRANCHE_3_EVIDENCE.md#22-contracts). For
   example MOCKUSDY's PrincipalManager:
   <https://stellar.expert/explorer/public/contract/CBBKUZJWZDA7YLA6GHSXVLV62QJ6DLKCO4GXUWF43FXLPN5S3XVNUKCC>.
3. Check that the code on chain is the code the manifest names. For one contract:

   ```bash
   stellar contract fetch --id CDYH7UV24XS7G7MDRTBJUS4PJNKKUXTLUUTL67MR5CYJAXSPPHNWS65T \
     --rpc-url "$RPC" --network-passphrase "$NET" -o factory.wasm
   shasum -a 256 factory.wasm
   # 6c21fc0e78f3064f67ae30924b8f9ca0223fbb61a20ac640cceca7b152456759  = wasmHashes.factory
   ```

   For all 44 at once, run the read-only deployment check
   ([how](#rerun-the-read-only-check-yourself)). On 21 November 2026 at 20:24 UTC it printed "PASS: 5 of 5 topologies
   match, 44 of 44 code hashes match (12 pinned hashes), 0 failed reads"
   ([evidence §2.3](TRANCHE_3_EVIDENCE.md#23-the-read-only-deployment-check)). "Topology" means each market's contracts
   point at each other as the manifest says.

**Status: Met.**

### 1.2 The initial market configuration is active

Every value below is read live by the dashboard. Each figure's info button gives the call behind it.

1. **RiskControl.** Open <https://principalmarket.fi/dashboard/risk>. Under **Circuit breaker**: **Limit** 5,000.00
   (underlying units), the volume counted now and the remaining capacity, and a sliding window of 17,280 ledgers
   (about 24 hours). Under **Per-asset limits**: 5,000.00 for MOCKUSDY and MOCKUSTRY, "No limit (disabled)" for the
   three others. Under **Pauses**: RiskControl and each market's SY wrapper, manager and pool, all "Not paused".
2. **Oracles.** Open <https://principalmarket.fi/dashboard/oracle>: one OracleAdapter per market, each with **Max
   stale** 86,400 s (24 hours) since 22 November 2026 (3,600 s, 1 hour, on 21 November), **Deviation cap** 10.00% per update, and a **Feed** section naming the RedStone feed
   `CBMG…WYRF` and the real asset it reads. From the CLI, for MOCKUSDY's oracle:

   ```bash
   for fn in feed_source max_stale_seconds max_deviation_bps get_admin; do
     stellar contract invoke --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --rpc-url "$RPC" --network-passphrase "$NET" \
       --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- $fn
   done
   # ["CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF",{"Stellar":"CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP"}]
   # 86400   (3600 before 22 November)
   # 1000
   # "GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB"
   ```

   `CB3YA6…GAGP` is the real USDY's asset contract, used only as the key of its price in the feed. The other four
   oracles answer the same with their own asset ([evidence §4](TRANCHE_3_EVIDENCE.md#4-the-configuration-read-live)).
3. **Maturity and fees.** Open <https://principalmarket.fi/dashboard/markets>: every market is a 90-day market,
   maturing on 15 February 2027 (MOCKUSDY) or 18 February 2027 (the four others). Open MOCKUSDY's page,
   <https://principalmarket.fi/dashboard/markets/mainnet-CDQYZU-CCY5P6CC>: **Fees** shows the tokenization fee
   0.05%, the YT fee 10.00%, the swap fee tier 0.10% and the protocol share 20.00%, then the fee recipients.
4. **Compliance inherited from the asset.** Open <https://principalmarket.fi/dashboard/compliance>, **Underlying
   asset**: for each mock asset, its **Administrator** (the issuer) and the issuer's flags: authorization required
   No, revocable Yes, clawback enabled Yes, read from Horizon. These are the flags of the real USDY, which the mock
   assets copy. The contracts check an account's standing on the asset before a mint (and, as in Tranche 2, a deposit
   or a PT/YT transfer).
5. **The dApp points at these contracts.** Open <https://principalmarket.fi/app>. The banner reads "Stellar Mainnet ·
   These markets use mock assets issued by Principal for testing." and the five markets are listed, each marked
   "Mock asset issued by Principal for testing. It follows the price of USDY and is not USDY." (or USTRY, GILTS,
   CETES, XAUM).

**Status: Met.** The configuration is set and in force on chain. While an oracle is stale, the operations that need
its price are refused by the contracts. On 21 November at 20:24 UTC, under the 1-hour window, four of the five oracles
were stale; since 22 November the window is 24 hours, and at 16:35 UTC that day all five were fresh
([3.1](#31-the-production-oracle-source-is-integrated-through-oracleadapter)).

### 1.3 A smoke-test deposit and mint succeed

1. Open [evidence §3.1](TRANCHE_3_EVIDENCE.md#31-deposit-and-mint-on-every-market): one deposit and one mint on each
   of the five markets, ten transactions signed by the contracts team's test account. Open any hash on stellar.expert,
   for example MOCKUSDY's mint
   <https://stellar.expert/explorer/public/tx/ddbdd13683ffd9b93509d9c223556aaa04d57c2d0870195db304580b8e2b4906>: it is
   successful and calls `mint` on MOCKUSDY's PrincipalManager, `CBBKUZ…UKCC`.
2. The same transactions are recorded by the contracts team in
   [MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md):
   §5, "Real transaction testing (both markets) 2026-11-17/18", for MOCKUSDY, and §12, the table "Real testing proof
   on every v2 market", for the four others.
3. The app side: the read-only check of [1.1](#11-all-contracts-are-live-on-stellar-mainnet-with-verified-addresses)
   step 3 shows that the app reads every market's contracts on Mainnet. The signed run through the app is not done yet
   (below).

**Status: Met in the contracts repository**
([MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md)
§5 and §12): deposit and mint succeeded on all five Mainnet markets, from the command line.
**Open (developer, after the contracts team):** the dApp's own signed smoke test, a small deposit and mint through
principalmarket.fi. It needs a test wallet that the contracts team grants on the markets (only their Permissioning
admin can). It will be signed by the developer, never by an automated
test. Its two hashes will be added to the evidence file.

### 1.4 The build is reproducible from source

1. Read the contracts team's build section,
   [MAINNET_DEPLOYMENT_EVIDENCE.md §8](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md#8-reproducible-build-evidence):
   the build command `cargo build --workspace --release --target wasm32v1-none`, the toolchain (`rustc 1.94.1`,
   `stellar 26.0.0`), and the size and SHA-256 of the 12 wasm files. Since 22 November the repository also pins the
   toolchain (`rust-toolchain.toml`) and has a recipe,
   [deployments/mainnet/reproducible-build.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet/reproducible-build.md),
   with `scripts/deploy/reproducible_build.sh`.
2. Check that the chain holds those files: the hashes in §8 are the manifest's `wasmHashes`, and the on-chain code
   matches them, 44 of 44 ([1.1](#11-all-contracts-are-live-on-stellar-mainnet-with-verified-addresses) step 3).
3. Read a rebuild on another machine: the contracts team's
   [CI run 44974232705](https://github.com/principal-Protocol-org/principal/actions/runs/44974232705), job "wasm build
   (all contracts)" (Linux x86_64, rustc 1.94.1, the recipe's script). Its log prints `4437468d…` for
   `principal_permissioning.wasm` and `ac75508d…` for `principal_risk_control.wasm`: the on-chain hashes. The 10 others
   differ.
4. See why the 10 others differ. Fetch one and list its paths:

   ```bash
   stellar contract fetch --id CAON3FAQU5W6SGZFWOM22GONNKZEIN4AGVTKMCWCC6PI43QWB27MGW4I \
     --rpc-url "$RPC" --network-passphrase "$NET" -o pool.wasm
   strings pool.wasm | grep '\.cargo'
   # /home/<user>/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/soroban-sdk-26.0.1/src/env.rs (and others)
   ```

   The original build wrote its cargo directory into these 10 files (we mask the user name here); a rebuild elsewhere
   writes its own. Permissioning and RiskControl contain no such path.
5. Rebuild yourself, if you like:

   ```bash
   git clone https://github.com/principal-Protocol-org/principal && cd principal
   git checkout 3af938853e5818aa8d56bd35670b9a19cfa55a78
   rustup target add wasm32v1-none --toolchain 1.94.1
   cargo +1.94.1 build --workspace --release --locked --target wasm32v1-none
   shasum -a 256 target/wasm32v1-none/release/*.wasm
   ```

   The host matters. On macOS arm64 and on Linux arm64 we got 0 of 12, even for Permissioning, and the recipe's script
   gave the same on those hosts on 22 November. Only Linux x86_64 has reproduced the deployed bytes so far
   ([evidence §3.2](TRANCHE_3_EVIDENCE.md#32-the-reproducible-build)).

**Status: Open (contracts team).** The build instructions and the checksums are **published in the contracts
repository** ([§8](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md#8-reproducible-build-evidence)),
and the chain holds exactly those artifacts. A rebuild on Linux x86_64 already gives the deployed bytes for the two
contracts that embed no machine path. The ten others are expected to match when rebuilt on Linux x86_64 with the
cargo directory at the original path that their bytes contain. That run, in the contracts repository's CI, is the next
step ([open item 3](#open-items)).

### 1.5 The description, item by item

| Description item | What exists | Status |
|---|---|---|
| Deploy the complete protocol contract set to Stellar Mainnet | 4 shared contracts and 5 markets of 8 contracts each, live ([1.1](#11-all-contracts-are-live-on-stellar-mainnet-with-verified-addresses)) | Met |
| using the same scripted pipeline from Tranche 2, adapted for production | The contracts team's `scripts/deploy/deploy.sh` (with a new stop after the shared contracts) and factory scripts; their own check, `verify-deployment.sh`, passes 78 of 79 per market, the failing check being `git_tree_dirty` ([evidence §3.3](TRANCHE_3_EVIDENCE.md#33-the-deployment-manifests)) | Met in the contracts repository, with that caveat |
| Publish mainnet-deployment-manifest.json (contract addresses, WASM hashes, deployment transaction IDs) | Under another name: one `deployments/mainnet-<asset>/deployment-manifest.json` per market, with addresses, wasm SHA-256, deploy and init transactions of the shared contracts and the factory calls that created each market; `deployments/mainnet-dapp-manifest.json` for the app. MOCKUSDY's `transactions[]` repeats two hashes under wrong steps; use the per-contract fields ([evidence §3.3](TRANCHE_3_EVIDENCE.md#33-the-deployment-manifests)) | Met in the contracts repository, with that caveat |
| RiskControl circuit-breaker limits appropriate for production volume | 5,000 underlying units protocol-wide per sliding window of 17,280 ledgers; 5,000 per asset on MOCKUSDY and MOCKUSTRY. Set by the contracts team for this testing deployment on mock assets. The protocol-wide limit adds units of different assets ([evidence §4](TRANCHE_3_EVIDENCE.md#4-the-configuration-read-live)) | Done |
| oracle configuration for the first RWA market | MOCKUSDY's OracleAdapter reads RedStone's USDY price (`feed_source`), 24-hour staleness window since 22 November (1 hour before), 10% deviation cap; the four other markets the same with their asset ([1.2](#12-the-initial-market-configuration-is-active) step 2) | Done; MOCKGILTS's window is open item 1 |
| market maturity and fee parameters | 90-day maturities; fees on each market's page ([1.2](#12-the-initial-market-configuration-is-active) step 3) | Done |
| the compliance configuration inherited from the underlying Stellar Asset | each issuer is its SAC's admin, with revocable and clawback set ([1.2](#12-the-initial-market-configuration-is-active) step 4) | Done |
| Publish reproducible build instructions … compare SHA-256 checksums against the on-chain hashes | Instructions, recipe and checksums published; the chain matches the checksums; a rebuild on Linux x86_64 reproduces 2 of 12, the two without a machine path ([1.4](#14-the-build-is-reproducible-from-source)) | Instructions: met in the contracts repository. Reproduction: Open |
| Switch the dApp to point to Mainnet contracts | <https://principalmarket.fi/app> reads `config/manifests/mainnet.json` ([1.2](#12-the-initial-market-configuration-is-active) step 5) | Met |
| run a smoke test using a small amount | Read-only check: passes. Signed deposit and mint: done by the contracts team on all five markets; through the app: not yet ([1.3](#13-a-smoke-test-deposit-and-mint-succeed)) | Met in the contracts repository; the app's signed run is Open |

---

## Deliverable 2: dApp Dashboard + Protocol Monitoring

### As submitted

> **Description:** A public, real-time view into the protocol's on-chain state, built directly into the Mainnet dApp —
> no wallet, credentials, or special tooling required. Every figure below is read live from the contracts themselves;
> compliance-activity history uses a small indexing service where historical events cannot be read directly from
> contract state:
>
> Protocol health — total value locked, outstanding PT/YT supply per market, PT/SY pool liquidity, and pending yield
> claimable per position.
>
> Safety status — RiskControl's circuit-breaker volume, remaining capacity, and pause state; SYWrapper's own pause
> state; oracle freshness; and any deviation-guard rejections.
>
> Compliance activity — a monitoring feed surfacing RecoveryEscrow seizures and finalizations together with the
> current underlying SAC administrator and relevant compliance status.
>
> **Success Criteria:** Dashboard and monitoring views are live on the Mainnet dApp, reflect real on-chain state, and
> correctly surface RiskControl, oracle, market, and RecoveryEscrow status.

### 2.1 Dashboard and monitoring views are live on the Mainnet dApp

1. Open <https://principalmarket.fi/dashboard>, with no wallet. The banner reads "Stellar Mainnet · These markets use
   mock assets issued by Principal for testing." The tabs are **Overview**, **Markets**, **Oracle**, **Risk**,
   **Compliance** and **Activity**. Each view says its ledger, the age of its reads, and "Refreshes every 1 min".
2. Compare with the screenshots taken on the live site at 20:16 to 20:18 UTC on 21 November 2026, in
   [tranche-3/](tranche-3/): `01-overview.png` to `07-activity.png` (desktop, light), `08-overview-dark.png`, and
   `09-oracle-375px.png` and `10-oracle-how-to-verify-375px.png` at phone width
   ([evidence §5.4](TRANCHE_3_EVIDENCE.md#54-screenshots)).
3. The monitoring also has public JSON: <https://principalmarket.fi/api/health> (ledger, event index, keeper, open
   alerts) and <https://principalmarket.fi/api/dashboard/alerts>.

**Status: Met.** Production serves commit `783d51c` (Vercel deployment `dpl_9sWg9ZDDxDHGY1KgJKVhAvmUEKT4`), whose CI and
end-to-end runs are green ([evidence §1.1](TRANCHE_3_EVIDENCE.md#11-the-site-and-its-deployment)). The end-to-end suites
run on Stellar Testnet.

### 2.2 They reflect real on-chain state

1. **Repeat a figure yourself.** On <https://principalmarket.fi/dashboard/oracle>, pick the MOCKGILTS oracle, then the
   info button next to **Time until operations block**. The **How to verify** drawer shows the raw values, the
   contract, the functions, the ledger, the RPC host, and one command per read. Copy one and run it, for example:

   ```bash
   stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7 --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- get_reference_timestamp
   ```

   The answer equals the drawer's `get_reference_timestamp`. We ran the drawer's three commands as copied at
   20:31:38 UTC on 21 November: `1795291830`, `3600`, `true`, the drawer's values (since 22 November the second
   answers `86400`)
   ([evidence §5.3](TRANCHE_3_EVIDENCE.md#53-one-how-to-verify-command-run-as-copied)). The source account is the
   null account, so nothing can be signed.
2. **Compare two independent readers.** The read-only deployment check reads the chain with its own code. At 20:24 UTC
   it gave, per oracle, the same values and ages as the oracle page (MOCKGILTS fresh, 14 minutes old; the four others
   stale, 8 h 48 m to 10 h 26 m old), and nothing paused, as the risk page shows
   ([evidence §2.3](TRANCHE_3_EVIDENCE.md#23-the-read-only-deployment-check)).
3. **Copy evidence table**, on each view, copies every figure of the page as a Markdown table: the metric, the
   contract, the function and its parameters, the raw and displayed values, the ledger, and a blank "Verified" column
   for your own records.

**Status: Met.**

### 2.3 They correctly surface RiskControl, oracle, market, and RecoveryEscrow status

1. **RiskControl.** <https://principalmarket.fi/dashboard/risk>: limit, volume counted, remaining capacity, window,
   per-asset limits, every pause, the pausers, the exhaustion history (from the alert check) and the indexed limit
   changes. At 20:31 UTC: 2,749.25 left of 5,000.00, nothing paused, no exhaustion in the last 7 days.
2. **Oracle.** <https://principalmarket.fi/dashboard/oracle>: for each oracle, its state (Fresh or Stale), the time
   until operations block, the stored value and its date, the feed's latest price beside it, the update path, the last
   rejection, the rejection and update histories, and the keeper's runs ([3.2](#32-current-price-and-freshness-status-are-visible-on-the-dashboard)).
3. **Market.** <https://principalmarket.fi/dashboard/markets>: per market, PT and YT supply, the pool's reserves and LP
   supply, liquidity, TVL and TVL in USD, unclaimed fees. The overview's protocol **TVL** and **Pool liquidity** read
   "Unavailable" by design: the five markets hold different assets, so their amounts do not add up; the overview gives
   **TVL in USD** instead (3,285.10 USD in oracle units at 20:31 UTC).
4. **RecoveryEscrow.** <https://principalmarket.fi/dashboard/compliance>, **RecoveryEscrow records**: for each of the five
   escrows, "record_count 0, indexed 0: they match" and "No seizure recorded yet". No seizure has happened on Mainnet.
   To see the view with a seizure, open <https://testnet.principalmarket.fi/dashboard/compliance>: the **Testnet**
   drill of 21 November 2026 at 01:47 UTC seized an account's positions on the official Testnet market (record 0,
   transaction [0221e7ca…50e3](https://stellar.expert/explorer/testnet/tx/0221e7caa4e4041a59ecbe7d1b5f941f47d7a35937bc96a5a9701178367d50e3)).
   The same drill shows a rejected oracle update (`deviate`) on the Testnet oracle page and a pause and unpause on the
   Testnet risk page ([evidence §9](TRANCHE_3_EVIDENCE.md#9-recoveryescrow-and-the-safety-feeds-exercised-on-testnet)).

**Status: Met.** RecoveryEscrow's live status on Mainnet is "no record, index in agreement"; its seizure and
finalization display is shown on Testnet, with the same code.

### 2.4 The description, item by item

| Description item | Where on the dashboard | Status |
|---|---|---|
| no wallet, credentials, or special tooling | every view, and the JSON under `/api/` | Met |
| total value locked | **TVL** per market (Markets, and each market's page); protocol-wide **TVL in USD** (Overview). The protocol-wide TVL in asset units is "Unavailable" by design (different assets) | Met, per market |
| outstanding PT/YT supply per market | **Supply** on Markets; **PT supply**, **YT supply** on each market's page | Met |
| PT/SY pool liquidity | **Reserves** and **Liquidity** on Markets; **PT reserve**, **SY reserve**, **Pool liquidity** on each market's page | Met |
| pending yield claimable per position | **Pending yield** on each market's page: type any account or contract address; it shows what claiming would pay now, net of the YT fee (on MOCKUSDY, for the contracts team's test account GCOMBI…R5BM: 0.0366073 MOCKUSDY at 20:58 UTC) | Met |
| RiskControl's circuit-breaker volume, remaining capacity, and pause state | Risk: **Volume counted now**, **Remaining capacity**, **Pauses** | Met |
| SYWrapper's own pause state | Risk, **Pauses**: "SY wrapper (`<market>`)" for each market | Met |
| oracle freshness | Oracle: state, **Freshness**, **Time until operations block**; Overview: "Oracles: N of 5 fresh" | Met |
| any deviation-guard rejections | Oracle: **Last rejection** (read live) and **Rejection history** (indexed `ref_rej`). None on Mainnet so far; a `deviate` rejection shows on Testnet ([evidence §9](TRANCHE_3_EVIDENCE.md#9-recoveryescrow-and-the-safety-feeds-exercised-on-testnet)) | Met |
| a monitoring feed surfacing RecoveryEscrow seizures and finalizations | Compliance: **RecoveryEscrow records** (read live) and **Seizure history** (indexed); Activity | Met; none on Mainnet, shown on Testnet |
| the current underlying SAC administrator | Compliance, **Underlying asset**: **Administrator** for each mock asset | Met |
| relevant compliance status | Compliance: the issuer's flags, the Permissioning grants and revokes (58 account grants, 80 asset grants, 0 revokes at 20:32 UTC) and their history | Met |
| a small indexing service | `/api/cron/index` every 5 minutes; Overview, **Event index**: indexed ledger, lag, gaps. The history starts at the deployment's first event ([evidence §1.2](TRANCHE_3_EVIDENCE.md#12-scheduled-jobs)) | Met |

---

## Deliverable 3: Mainnet Oracle Integration + Monitoring

### As submitted

> **Description:** OracleAdapter remains the protocol contract responsible for the exchange rate used for PT/YT
> accounting and settlement, together with Principal-specific freshness, fallback, and deviation checks. For the
> initial USDY market, the primary source will integrate the RedStone USDY/USD SEP-40 feed. This deliverable completes
> the production integration, monitors oracle freshness and availability, exposes the current oracle status on the
> Deliverable 2 dashboard, and adds automated alerting when the feed becomes stale or unavailable.
>
> **Success Criteria:** The production oracle source is integrated through OracleAdapter, current price and freshness
> status are visible on the dashboard, stale or unavailable prices block affected protocol operations as designed, and
> automated alerting is active.

### 3.1 The production oracle source is integrated through OracleAdapter

1. **The wiring.** Read `feed_source()` on MOCKUSDY's OracleAdapter ([1.2](#12-the-initial-market-configuration-is-active)
   step 2): RedStone's SEP-40 feed `CBMGLK…WYRF`, keyed by the real USDY's asset contract. The four other oracles read
   the same feed with their own asset ([evidence §4](TRANCHE_3_EVIDENCE.md#4-the-configuration-read-live)).
2. **The price flows in.** The app's keeper (`/api/cron/oracle`, every 5 minutes) calls `sync_from_feed` when the feed
   has a newer price. It holds no role: anyone may call it, and the oracle reads only its own configured feed. Open its
   account on Horizon:
   <https://horizon.stellar.org/accounts/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS/transactions?order=desc>.
   On 21 November 2026 it made five successful syncs: MOCKUSDY, MOCKUSTRY, MOCKCETES and MOCKXAUM at 14:12 UTC,
   MOCKGILTS at 20:12:06 UTC ([ce93f473…9508](https://stellar.expert/explorer/public/tx/ce93f473351cb9d024860f403e9e4f87a07a42dc7c0568e84ce36f7d28399508)).
   Between syncs its runs say "Skipped: the feed had nothing newer" and send nothing
   ([evidence §6](TRANCHE_3_EVIDENCE.md#6-the-oracle-keeper)).
3. **The stored value equals the feed.** The oracle page's **Stored value against feed** reads "Equal" on all five
   oracles, as does the read-only check ([evidence §2.3](TRANCHE_3_EVIDENCE.md#23-the-read-only-deployment-check)).

**Status: Met.** `sync_from_feed` stores the feed tick's own time, and RedStone publishes each price on Stellar every
12 hours or so (the feed's `resolution()` is 43,200 s). On 21 November, with `max_stale_seconds` 3,600, each oracle was
fresh only during the hour after a tick, whatever the keeper did: at 20:24 UTC four of the five were stale, 8 h 48 m
to 10 h 26 m old ([evidence §6.3](TRANCHE_3_EVIDENCE.md#63-freshness-and-why-most-oracles-are-stale)). On 22 November
at 00:19 to 00:20 UTC the contracts team set the window to 86,400 s on all five; at 16:35 UTC all five were fresh
([evidence §6.4](TRANCHE_3_EVIDENCE.md#64-the-window-widened-22-november-2026)). One limit remains: GILTS once went
86,410 s without a tick, so the MOCKGILTS oracle can turn stale for a few minutes on such a day
([open item 1](#open-items)).

### 3.2 Current price and freshness status are visible on the dashboard

1. Open <https://principalmarket.fi/dashboard/oracle>. The list shows each oracle's asset, **State** (FRESH or STALE),
   **Blocks in** (a countdown, or "Stale") and **Update path** (Feed).
2. Pick an oracle. **Reference value** shows the **Value**, its **Timestamp**, **Freshness** ("age 20m 39s of 1 hour"
   for MOCKGILTS at 20:31 UTC on 21 November, under the 1-hour window) and **Time until operations block**, with "Operations blocked when stale: mint, trades,
   single-sided liquidity, redemption". **Feed** shows the feed contract, the asset key, the **Feed price**, its tick
   age, and **Stored value against feed**.
3. The overview's **Oracles** line says how many are fresh ("1 of 5 fresh" at 20:31 UTC on 21 November) and names the
   stale ones.

**Status: Met.**

### 3.3 Stale or unavailable prices block affected protocol operations as designed

1. Read whether each oracle is fresh now:

   ```bash
   for o in CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7; do
     stellar contract invoke --id $o --rpc-url "$RPC" --network-passphrase "$NET" \
       --source-account GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB --send=no -- is_available
   done
   # MOCKUSDY's oracle, then MOCKGILTS's: false, true at 20:30 UTC on 21 November 2026
   ```

2. Simulate a mint of 1 SY share on each market's PrincipalManager. `-v` prints the diagnostic events, which name the
   contract that fails:

   ```bash
   A=GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB   # any funded public account
   stellar contract invoke -v --id CBBKUZJWZDA7YLA6GHSXVLV62QJ6DLKCO4GXUWF43FXLPN5S3XVNUKCC --rpc-url "$RPC" \
     --network-passphrase "$NET" --source-account $A --send=no -- mint --from $A --sy_shares 1
   # MOCKUSDY: error: transaction simulation failed: HostError: Error(Contract, #7)
   stellar contract invoke -v --id CCDSONMQBNS4LNKKUBLG5XLNDNNDU4PQPWKJK2KQCVQHJ3AW5GNN7GBS --rpc-url "$RPC" \
     --network-passphrase "$NET" --source-account $A --send=no -- mint --from $A --sy_shares 1
   # MOCKGILTS: error: transaction simulation failed: HostError: Error(Contract, #11)
   ```

3. Read the result. In PrincipalManager, error 7 is
   [`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L221)
   and error 11 is
   [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L224).
   [`mint`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L362-L374)
   checks the oracle before compliance.
   - **Error 7**: the oracle answered `is_available` false and the manager refused the mint. The stale price blocks it.
   - **Error 11**: the oracle answered true, so the manager went on to compliance, and refused this account, which has
     no trustline to the asset. With a fresh oracle the price does not block the mint.

   The events of the `-v` output show it: the manager's `is_available` call on its oracle, the oracle's answer, then
   the manager's error. Freshness changes over time, so your run may find other markets fresh or stale: step 1 tells you
   which of the two errors to expect. On 21 November 2026 at 20:30 UTC, MOCKUSDY gave 7 and MOCKGILTS gave 11; the
   `-v` runs (MOCKUSDY at 20:31, MOCKGILTS at 20:48 UTC) gave the same
   ([evidence §7](TRANCHE_3_EVIDENCE.md#7-a-stale-oracle-blocks-operations)). Since the window became 24 hours on
   22 November, a stale oracle is rare, and you will most likely get error 11 on both (as at 17:42 UTC that day). The
   stale case is then the record of 21 November.
4. The other contracts check the oracle the same way: MarketPool (trades, single-sided liquidity) and YTToken (yield accrual)
   raise their own `OracleStale`; the OracleAdapter's `assert_available` raises `OracleUnavailable` (error 8)
   ([evidence §7](TRANCHE_3_EVIDENCE.md#7-a-stale-oracle-blocks-operations)).
5. The app refuses the same actions before any signature. Open MOCKUSDY's market in the app,
   <https://principalmarket.fi/app/markets/mainnet-CDQYZU-CCY5P6CC>, with no wallet: while its oracle is stale, the
   trade panel's **Signing is off** box lists "The oracle price is stale: it has not been updated in the last 1 hour.
   Wait for the next oracle update, then try again." (seen at 20:51 UTC on 21 November 2026, under the 1-hour window;
   with the 24-hour window you will rarely see it).

**Status: Met.**

### 3.4 Automated alerting is active

1. Open <https://principalmarket.fi/api/dashboard/alerts>. It answers `open`, `recent` and `lastTest`.
   - `lastTest`: the test alert of 21 November 2026 13:59:49 UTC, `delivered: true`.
   - `open`: four critical `oracle_stale` alerts, opened at 15:00:03 UTC (MOCKUSDY, MOCKUSTRY, MOCKCETES, MOCKXAUM), each
     with the asset, the age, the seconds past the block and the window in its payload.
   - `recent`: also MOCKGILTS's, opened at 15:00:03 and resolved at 20:15:01 UTC, three minutes after the keeper's sync
     made it fresh. It will open again when that oracle goes stale.
2. Open <https://principalmarket.fi/api/health>: `openAlerts` counts them (4 open, 4 critical at 20:25 UTC), and the
   keeper of each oracle is healthy. On 22 November at 16:32 UTC, after the window was widened, it read 1 open,
   0 critical: an `oracle_warning` on MOCKGILTS, opened at 14:15 UTC as its value aged
   ([evidence §8](TRANCHE_3_EVIDENCE.md#8-alerts)).
3. The alert check runs every 5 minutes and posts each opening and close to the team's alert channel (a Telegram
   group, not public). It also watches the keeper, the feed, RiskControl, the event index and the keeper's XLM
   ([evidence §8](TRANCHE_3_EVIDENCE.md#8-alerts)). While a critical alert is open, the scheduled route answers HTTP 500,
   by design, so the scheduler's own failure alert fires too.

**Status: Met.** The public endpoint shows the test's delivery, not each alert's; the opening of the five stale alerts
was posted (the developer's record of the run: 5 posted, 0 failures).

### 3.5 The description, item by item

| Description item | What exists | Status |
|---|---|---|
| OracleAdapter … the exchange rate used for PT/YT accounting and settlement | one OracleAdapter per market; the manager, the pool and the YT token read it | Met |
| Principal-specific freshness check | `max_stale_seconds` (86,400 since 22 November, 3,600 before) and `is_available()`; the contracts refuse with `OracleStale` ([3.3](#33-stale-or-unavailable-prices-block-affected-protocol-operations-as-designed)) | Met; MOCKGILTS's window is open item 1 |
| fallback check | the contract supports a fallback source (it may refresh the time, never move the value: Tranche 2, §1.5); none is configured on the Mainnet oracles, which read the feed | Done in the contracts; not configured |
| deviation check | `max_deviation_bps` 1,000 (10%) on all five; no rejection on Mainnet so far; a `deviate` rejection shown on Testnet ([evidence §9](TRANCHE_3_EVIDENCE.md#9-recoveryescrow-and-the-safety-feeds-exercised-on-testnet)) | Met |
| For the initial USDY market, the primary source will integrate the RedStone USDY/USD SEP-40 feed | MOCKUSDY's oracle reads RedStone's USDY price; the four other markets read RedStone's USTRY, GILTS, CETES and XAUM prices | Met (on a mock asset that tracks USDY) |
| completes the production integration | the keeper syncs every oracle from the feed ([3.1](#31-the-production-oracle-source-is-integrated-through-oracleadapter)) | Met |
| monitors oracle freshness and availability | the keeper's runs, the oracle page, `/api/health`, the alert check | Met |
| exposes the current oracle status on the Deliverable 2 dashboard | [3.2](#32-current-price-and-freshness-status-are-visible-on-the-dashboard) | Met |
| automated alerting when the feed becomes stale or unavailable | `oracle_warning`, `oracle_stale`, `oracle_unavailable`, `feed_broken` per oracle ([3.4](#34-automated-alerting-is-active)) | Met |

---

## Rerun the read-only check yourself

From a clone of the dApp repository (Node 24, pnpm 12.5.1):

```bash
git clone https://github.com/principal-Protocol-org/dapp && cd dapp
git checkout 783d51c51003376884ccec1d9eab6d44d27d59fd
pnpm install --frozen-lockfile
pnpm smoke:mainnet          # one table and a PASS or FAIL line
pnpm smoke:mainnet --json   # the same, with every contract's expected and actual code hash
```

It needs no key and no database, and signs nothing. It reads from the RPC that the manifest names and prints only its
host. It fails on a topology mismatch, a code hash mismatch or an unreadable contract. A stale oracle is reported as a
warning and does not fail it.

## Known limits

- The five markets use mock assets issued by Principal for testing. Access to them is granted by hand by the contracts
  team; the app's access contact is `hello@principalmarket.fi` (the manifest's `accessContact`).
- While an oracle is stale, its market refuses mint, trades, single-sided liquidity and redemption, and the app says so
  before signing ([3.3](#33-stale-or-unavailable-prices-block-affected-protocol-operations-as-designed) step 5). With
  the 24-hour window this is rare (open item 1).
- The overview's protocol-wide TVL and pool liquidity in asset units read "Unavailable" by design: the markets hold
  different assets. Per-market figures and the TVL in USD are given instead.
- The dashboard refreshes every minute on Mainnet, to stay within the RPC's limits.

## Open items

The same list, with the evidence, is in [evidence §10](TRANCHE_3_EVIDENCE.md#10-open-items).

| # | Item | Owner | Reason |
|---|---|---|---|
| 1 | MOCKGILTS's staleness window: 86,400 s since 22 November (3,600 s before, on all five), but GILTS once went 86,410 s without a tick, so this oracle can turn stale for a few minutes on such a day | contracts team | Only the oracle admin can widen it (`set_safety_params`, for example to 172,800 s). The four other feeds tick every 12 hours. |
| 2 | The dApp's own signed smoke test on Mainnet: a small deposit and mint through principalmarket.fi | developer, after the contracts team | Needs a test wallet granted by the contracts team. Signed by the developer, never by an agent or a test. |
| 3 | Reproducing the build: on Linux x86_64 a rebuild gives the deployed bytes for 2 of 12; the 10 others embed the original builder's cargo path | contracts team | A rebuild of `3af9388` on Linux x86_64 with rustc 1.94.1 and that cargo path, in the contracts repository's CI, is expected to give 12 of 12; not run yet. Other hosts give other bytes, so the recipe must name the host. |
| 4 | Contract lifetimes: the Mainnet contract instances live until about 17 to 21 March 2027 | contracts team, operations | Someone must extend them before mid-March 2027. |
| 5 | A table on `/dashboard/activity` scrolls 5 px inside its card at 375 px | app team | Minor layout issue. |
| 6 | The contracts team's manifests: duplicate hashes in MOCKUSDY's `transactions[]`, `git_tree_dirty: true` | contracts team | Stated so that no hash is cited under the wrong step. |
