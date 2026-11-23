# Tranche 3 (Mainnet): how to verify each success criterion

For the Stellar Community Fund reviewer of Principal's SCF #45 grant, Tranche 3. For each success criterion: the steps
to check it yourself, and its status. The addresses, hashes and transactions behind the steps are in
[TRANCHE_3_EVIDENCE.md](TRANCHE_3_EVIDENCE.md). You need nothing else. State as of 23 November 2026; times are UTC.

**The Mainnet markets use mock assets.** MOCKUSDY, MOCKUSTRY, MOCKGILTS, MOCKCETES and MOCKXAUM are Stellar assets
issued by Principal for testing; the app says so on every page. Each market's OracleAdapter reads the real asset's price
(USDY, USTRY, GILTS, CETES, XAUM) from RedStone's SEP-40 feed on Mainnet. A market on the real USDY would have to be
created by USDY's issuer.

## Before you start

| What | Where |
|---|---|
| The app on Mainnet | <https://principalmarket.fi/app> |
| The public dashboard (no wallet) | <https://principalmarket.fi/dashboard> |
| The app's code, at `783d51c` | <https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd> |
| The deployed contract source, `3af9388` | <https://github.com/principal-Protocol-org/principal/tree/3af938853e5818aa8d56bd35670b9a19cfa55a78> |
| Block explorer | <https://stellar.expert/explorer/public> |

The commands are optional and only simulate (`--send=no`): nothing is signed. They need the
[Stellar CLI](https://developers.stellar.org/docs/tools/cli) and:

```bash
RPC=https://soroban-rpc.mainnet.stellar.gateway.fm
NET='Public Global Stellar Network ; September 2015'
```

## Summary

| Deliverable | Success criterion (part) | Status |
|---|---|---|
| 1 | All contracts are live on Stellar Mainnet with verified addresses | Met ([1.1](#11-all-contracts-are-live-on-stellar-mainnet-with-verified-addresses)) |
| 1 | the initial market configuration is active | Met ([1.2](#12-the-initial-market-configuration-is-active)) |
| 1 | a smoke-test deposit and mint succeed | Met, on all five markets and through the app ([1.3](#13-a-smoke-test-deposit-and-mint-succeed)) |
| 1 | the build is reproducible from source | Met in the contracts repository: 12 of 12 on Linux x86_64. **Open:** a public log of that rebuild ([1.4](#14-the-build-is-reproducible-from-source)) |
| 2 | Dashboard and monitoring views are live on the Mainnet dApp | Met ([2.1](#21-dashboard-and-monitoring-views-are-live-on-the-mainnet-dapp)) |
| 2 | reflect real on-chain state | Met ([2.2](#22-they-reflect-real-on-chain-state)) |
| 2 | correctly surface RiskControl, oracle, market, and RecoveryEscrow status | Met; no seizure yet on Mainnet, the seizure view is shown on Testnet ([2.3](#23-they-correctly-surface-riskcontrol-oracle-market-and-recoveryescrow-status)) |
| 3 | The production oracle source is integrated through OracleAdapter | Met ([3.1](#31-the-production-oracle-source-is-integrated-through-oracleadapter)) |
| 3 | current price and freshness status are visible on the dashboard | Met ([3.2](#32-current-price-and-freshness-status-are-visible-on-the-dashboard)) |
| 3 | stale or unavailable prices block affected protocol operations as designed | Met ([3.3](#33-stale-or-unavailable-prices-block-affected-protocol-operations-as-designed)) |
| 3 | automated alerting is active | Met ([3.4](#34-automated-alerting-is-active)) |

## Deliverable 1: Mainnet Deployment + Production Configuration

> **Success Criteria:** All contracts are live on Stellar Mainnet with verified addresses, the initial market
> configuration is active, a smoke-test deposit and mint succeed, and the build is reproducible from source.

The contracts team deployed the contracts from `3af9388` with their scripted pipeline; the app team switched the dApp to
them and went live at <https://principalmarket.fi> on 21 November 2026.

### 1.1 All contracts are live on Stellar Mainnet with verified addresses

1. [Evidence §2.1](TRANCHE_3_EVIDENCE.md#21-addresses) lists the 44 contracts (4 shared, 8 per market), each linked to
   stellar.expert. The app reads them from one file,
   [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json).
2. Check one contract's code against its published hash ([evidence §2.2](TRANCHE_3_EVIDENCE.md#22-code-hashes)):

   ```bash
   stellar contract fetch --id CDYH7UV24XS7G7MDRTBJUS4PJNKKUXTLUUTL67MR5CYJAXSPPHNWS65T \
     --rpc-url "$RPC" --network-passphrase "$NET" -o factory.wasm
   shasum -a 256 factory.wasm   # 6c21fc0e78f3064f67ae30924b8f9ca0223fbb61a20ac640cceca7b152456759
   ```

3. Check all 44 at once with the app's read-only check (Node 24, pnpm 12.5.1; no key):

   ```bash
   git clone https://github.com/principal-Protocol-org/dapp && cd dapp
   git checkout 783d51c51003376884ccec1d9eab6d44d27d59fd && pnpm install --frozen-lockfile
   pnpm smoke:mainnet   # PASS: 5 of 5 topologies match, 44 of 44 code hashes match …
   ```

   "Topology" means each market's contracts point at each other as the manifest says
   ([evidence §2.3](TRANCHE_3_EVIDENCE.md#23-the-read-only-deployment-check)).

The contracts team publishes the deployment record as one `deployment-manifest.json` per market (addresses, wasm
SHA-256, transactions), not under the name `mainnet-deployment-manifest.json`
([evidence §2](TRANCHE_3_EVIDENCE.md#2-contracts)).

**Status: Met.**

### 1.2 The initial market configuration is active

Every value is read live by the dashboard; each figure's info button gives the call behind it
([evidence §5](TRANCHE_3_EVIDENCE.md#5-the-configuration)).

1. **RiskControl:** <https://principalmarket.fi/dashboard/risk>. **Limit** 5,000.00 per sliding window of 17,280 ledgers
   (about 24 hours); per asset, 5,000.00 on MOCKUSDY and MOCKUSTRY; **Pauses**: all "Not paused". The contracts team set
   these limits for a test deployment on mock assets.
2. **Oracles:** <https://principalmarket.fi/dashboard/oracle>. One OracleAdapter per market reading RedStone's feed;
   **Max stale** 86,400 s (172,800 s on MOCKGILTS); **Deviation cap** 10.00%. From the CLI, on MOCKUSDY's oracle:

   ```bash
   for fn in feed_source max_stale_seconds max_deviation_bps; do
     stellar contract invoke --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --rpc-url "$RPC" --network-passphrase "$NET" \
       --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- $fn
   done
   # ["CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF",{"Stellar":"CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP"}]
   # 86400
   # 1000
   ```

3. **Maturity and fees:** <https://principalmarket.fi/dashboard/markets>. Five 90-day markets, maturing on 15 February
   2027 (MOCKUSDY) and 18 February 2027 (the others). Each market's page gives its fees: on MOCKUSDY, tokenization 0.05%,
   YT 10.00%, swap 0.10%, protocol share 20.00%.
4. **Compliance from the asset:** <https://principalmarket.fi/dashboard/compliance>, **Underlying asset**: each asset's
   **Administrator** (its issuer) and its flags, revocable and clawback enabled, as on the real USDY.
5. **The app points at these contracts:** <https://principalmarket.fi/app> lists the five markets, each marked "Mock
   asset issued by Principal for testing. It follows the price of USDY and is not USDY." (or USTRY, GILTS, CETES, XAUM).

**Status: Met.**

### 1.3 A smoke-test deposit and mint succeed

1. **On every market, by the contracts team:** [evidence §3.1](TRANCHE_3_EVIDENCE.md#31-on-every-market-by-the-contracts-team),
   a deposit and a mint on each of the five markets. Open one on stellar.expert, for example MOCKUSDY's mint
   [ddbdd136…4906](https://stellar.expert/explorer/public/tx/ddbdd13683ffd9b93509d9c223556aaa04d57c2d0870195db304580b8e2b4906):
   successful, `mint` on MOCKUSDY's PrincipalManager.
2. **Through the app:** [evidence §3.2](TRANCHE_3_EVIDENCE.md#32-through-the-app), a deposit and a mint of 1 MOCKUSDY
   each, signed in principalmarket.fi with the developer's test wallet, for example the mint
   [dba674d5…5ee6](https://stellar.expert/explorer/public/tx/dba674d509368d8eae9b00b3a74c7f016da05fd08de9e7ddebfd4a1db3045ee6):
   successful, `wrap_and_mint` on the Router (deposit and mint in one transaction).

**Status: Met.**

### 1.4 The build is reproducible from source

1. The published checksums: the 12 SHA-256 in [evidence §2.2](TRANCHE_3_EVIDENCE.md#22-code-hashes) are the contracts
   team's build output, and the chain matches them, 44 of 44 (1.1 step 3).
2. Rebuild, on Linux x86_64 (natively or in a `linux/amd64` container). Ten of the twelve files contain the cargo
   directory of the original build; the command reads it from a deployed file and maps yours to it
   ([evidence §4](TRANCHE_3_EVIDENCE.md#4-the-reproducible-build)):

   ```bash
   stellar contract fetch --id CAON3FAQU5W6SGZFWOM22GONNKZEIN4AGVTKMCWCC6PI43QWB27MGW4I \
     --rpc-url "$RPC" --network-passphrase "$NET" -o pool.wasm
   git clone https://github.com/principal-Protocol-org/principal && cd principal
   git checkout 3af938853e5818aa8d56bd35670b9a19cfa55a78
   rustup toolchain install 1.94.1 --target wasm32v1-none
   ORIG=$(grep -ao '/home/[^/]*/\.cargo' ../pool.wasm | head -1)
   RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=$ORIG --remap-path-prefix=$PWD=/build" \
     cargo +1.94.1 build --workspace --release --locked --target wasm32v1-none
   sha256sum target/wasm32v1-none/release/*.wasm   # compare with evidence §2.2
   ```

3. The result: the contracts team's rebuild gives 12 of 12. Their public CI shows the two files without a cargo path
   (Permissioning, RiskControl) matching; a public log of the full 12 of 12 is still to come. On macOS or Linux arm64
   the bytes differ.

**Status: Met in the contracts repository.** Open: the public log ([Open items](#open-items), 1).

## Deliverable 2: dApp Dashboard + Protocol Monitoring

> **Success Criteria:** Dashboard and monitoring views are live on the Mainnet dApp, reflect real on-chain state, and
> correctly surface RiskControl, oracle, market, and RecoveryEscrow status.

### 2.1 Dashboard and monitoring views are live on the Mainnet dApp

1. Open <https://principalmarket.fi/dashboard>, with no wallet: **Overview**, **Markets**, **Oracle**, **Risk**,
   **Compliance**, **Activity**. Each view gives its ledger and refreshes every minute.
2. Screenshots of the live site, 23 November 2026: [tranche-3/](tranche-3/)
   ([evidence §6](TRANCHE_3_EVIDENCE.md#6-the-dashboard)). Public JSON: <https://principalmarket.fi/api/health> and
   <https://principalmarket.fi/api/dashboard/alerts>.

**Status: Met.**

### 2.2 They reflect real on-chain state

1. On <https://principalmarket.fi/dashboard/oracle>, click the info button of any figure. **How to verify** gives the
   contract, the function, the ledger and a command; run it, and the chain gives the same value (a recorded run:
   [evidence §6](TRANCHE_3_EVIDENCE.md#6-the-dashboard)).
2. **Copy evidence table**, on each view, copies every figure with its contract, function, raw value and ledger.

**Status: Met.**

### 2.3 They correctly surface RiskControl, oracle, market, and RecoveryEscrow status

- **RiskControl**, `/dashboard/risk`: limit, volume counted, remaining capacity, per-asset limits, and the pause state
  of RiskControl and of each market's SY wrapper, manager and pool.
- **Oracle**, `/dashboard/oracle`: freshness, time until operations block, stored value, feed price, and every
  deviation-guard rejection. None has happened on Mainnet; one shows on Testnet
  ([evidence §10](TRANCHE_3_EVIDENCE.md#10-on-testnet-a-seizure-a-rejected-update-and-a-pause)).
- **Market**, `/dashboard/markets`: TVL, PT and YT supply, pool liquidity; on each market's page, **Pending yield** for
  any address. The protocol-wide TVL in asset units reads "Unavailable" by design (different assets); TVL in USD is
  given.
- **RecoveryEscrow**, `/dashboard/compliance`: each escrow's records and the seizure history, with each asset's
  administrator. No seizure has happened on Mainnet ("record_count 0, indexed 0: they match"). The same view with a
  seizure: <https://testnet.principalmarket.fi/dashboard/compliance>
  ([evidence §10](TRANCHE_3_EVIDENCE.md#10-on-testnet-a-seizure-a-rejected-update-and-a-pause)).

The compliance history comes from an event index updated every 5 minutes (**Event index** on the overview).

**Status: Met.**

## Deliverable 3: Mainnet Oracle Integration + Monitoring

> **Success Criteria:** The production oracle source is integrated through OracleAdapter, current price and freshness
> status are visible on the dashboard, stale or unavailable prices block affected protocol operations as designed, and
> automated alerting is active.

### 3.1 The production oracle source is integrated through OracleAdapter

1. Each OracleAdapter's `feed_source()` is RedStone's SEP-40 feed `CBMGLK…WYRF`, keyed by its real asset (1.2 step 2).
   The contract supports a fallback source; none is configured.
2. The app's keeper calls `sync_from_feed` every 5 minutes when the feed has a newer price; it holds no role. Its
   transactions: [GBLY3F…MZXS on stellar.expert](https://stellar.expert/explorer/public/account/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS)
   ([evidence §7](TRANCHE_3_EVIDENCE.md#7-the-oracle-keeper-and-freshness)).
3. The oracle page's **Stored value against feed** reads "Equal" when the oracle holds the feed's latest price.

**Status: Met.**

### 3.2 Current price and freshness status are visible on the dashboard

1. <https://principalmarket.fi/dashboard/oracle>: each oracle's **State** (FRESH or STALE) and **Blocks in**.
2. Pick one: **Value**, **Timestamp**, **Freshness**, **Time until operations block**, **Feed price**. The overview's
   **Oracles** line counts the fresh ones.

**Status: Met.**

### 3.3 Stale or unavailable prices block affected protocol operations as designed

1. Read whether an oracle is fresh, then simulate a mint on its market:

   ```bash
   A=GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB   # any funded public account
   stellar contract invoke --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --rpc-url "$RPC" \
     --network-passphrase "$NET" --source-account $A --send=no -- is_available
   stellar contract invoke -v --id CBBKUZJWZDA7YLA6GHSXVLV62QJ6DLKCO4GXUWF43FXLPN5S3XVNUKCC --rpc-url "$RPC" \
     --network-passphrase "$NET" --source-account $A --send=no -- mint --from $A --sy_shares 1
   ```

2. Read the error. Error 7 is `OracleStale`: the stale price blocked the mint. Error 11 is `NotAuthorizedOnSac`: the
   oracle check passed and the compliance check refused an account without a trustline. Oracles are fresh most of the
   time, so you will most likely get error 11. The stale case, recorded on 21 November 2026: error 7 on MOCKUSDY while
   its oracle was stale, error 11 on fresh MOCKGILTS
   ([evidence §8](TRANCHE_3_EVIDENCE.md#8-a-stale-oracle-blocks-operations)).
3. The pool (trades, single-sided liquidity) and the YT token (yield) refuse the same way, and the app refuses before
   any signature: its **Signing is off** box says "The oracle price is stale".

**Status: Met.**

### 3.4 Automated alerting is active

1. <https://principalmarket.fi/api/dashboard/alerts>: `lastTest` with `delivered: true`, and the open and recent
   alerts. The first Mainnet `oracle_stale` alerts opened on 21 November 2026 and closed when their oracles were fresh
   again ([evidence §9](TRANCHE_3_EVIDENCE.md#9-alerts)).
2. The alert check runs every 5 minutes and posts each alert to the team's private channel.

**Status: Met.**

## Known limits

- Access to the mock-asset markets is granted by the contracts team; the app's contact is `hello@principalmarket.fi`.
- An OracleAdapter never lowers its value. If the feed's price stays below the stored value for longer than the
  window, the oracle turns stale. The alerts warn 6 hours before (12 hours on MOCKGILTS); the contracts team's admin
  can then restart the window, best effort, with no committed response time.

## Open items

| # | Item | Owner |
|---|---|---|
| 1 | A public log of the 12-of-12 rebuild. A CI job that reads the cargo path from a deployed file is planned, not built. | contracts team |
| 2 | The contract instances live until about 17 to 21 March 2027; they must be extended before mid-March 2027. | contracts team |
| 3 | In the contracts team's manifests: `git_tree_dirty: true`, and two hashes listed under wrong steps in MOCKUSDY's `transactions[]` ([evidence §2](TRANCHE_3_EVIDENCE.md#2-contracts)). | contracts team |
