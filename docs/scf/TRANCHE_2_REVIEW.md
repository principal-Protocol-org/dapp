# Tranche 2 (Testnet): how to verify each success criterion

This file is for the Stellar Community Fund reviewer of Principal's SCF #45 grant, Tranche 2. For each deliverable it
quotes the description and the success criteria as the submission words them. Then, for each part of the success
criteria, it gives numbered steps to check it yourself (where to click, what to run, what you should see) and a status.

The evidence the steps point to (addresses, transaction hashes, run records, screenshots and dates) is in
[TRANCHE_2_EVIDENCE.md](TRANCHE_2_EVIDENCE.md). Both files were written on 13 November 2026. All times are UTC.

Each status is one of:
- **Met**, with the evidence in these files;
- **Met in the contracts repository**, with a link;
- **Open**, with the owner and the reason.

## What you need

- For the browser checks (Deliverables 2 and 3): a desktop browser with the Varial wallet extension, set to Testnet.
  Varial is the Stellar wallet formerly called Freighter; it uses the same `@stellar/freighter-api`.
- Optional, for the read-only contract checks: the [Stellar CLI](https://developers.stellar.org/docs/tools/cli) v28.
  The reads below only simulate a call: `--send=no`, nothing is signed, and any public address works as
  `--source-account`. The examples use the test asset's issuer address.
- Optional, to rerun the end-to-end suites: see [Rerun the suites yourself](#rerun-the-suites-yourself).

## Where things are

| What | Where |
|---|---|
| Public app (Stellar Testnet) | <https://testnet.principalmarket.fi> |
| The walkthrough (end-user docs) | <https://principalmarket.fi/docs/using-the-app/testnet-walkthrough> |
| dApp repository, branch `testnet` (the dApp work; `main` is behind it) | <https://github.com/principal-Protocol-org/dapp/tree/testnet> |
| Contracts repository at the deployed commit `665bb67` | <https://github.com/principal-Protocol-org/principal/tree/665bb6760372d30307a1a035da24e51776f727e8> |
| Official deployment manifest | [config/manifests/testnet.json](https://github.com/principal-Protocol-org/dapp/blob/testnet/config/manifests/testnet.json) |
| End-to-end workflow | [.github/workflows/e2e-testnet.yml](https://github.com/principal-Protocol-org/dapp/blob/testnet/.github/workflows/e2e-testnet.yml) |
| Block explorer | <https://stellar.expert/explorer/testnet> |

## Summary

| Deliverable | Success criterion (part) | Status |
|---|---|---|
| 1 | All protocol contracts are deployed on Stellar Testnet and publicly visible | Met ([1.1](#11-all-protocol-contracts-are-deployed-and-publicly-visible)) |
| 1 | deployment is scripted and repeatable | Met ([1.2](#12-deployment-is-scripted-and-repeatable)); some pipeline details of the description are open ([1.6](#16-the-description-item-by-item)) |
| 1 | the complete PT/YT and AMM flows are operational | Met ([1.3](#13-the-complete-ptyt-and-amm-flows-are-operational)) |
| 1 | SAC compliance controls and RecoveryEscrow are active on-chain | Met ([1.4](#14-sac-compliance-controls-and-recoveryescrow-are-active-on-chain)) |
| 1 | oracle safety guards are working | Met: staleness on this deployment, deviation guard in the contracts repository ([1.5](#15-oracle-safety-guards-are-working)) |
| 2 | dApp is live at a public Testnet URL | Met ([2.1](#21-the-dapp-is-live-at-a-public-testnet-url)) |
| 2 | all user flows work end-to-end | Met on branch `testnet`; redeem in the browser only after maturity ([2.2](#22-all-user-flows-work-end-to-end)) |
| 2 | compliance, oracle, and maturity restrictions are enforced in the interface | Met ([2.3](#23-compliance-oracle-and-maturity-restrictions-are-enforced-in-the-interface)) |
| 3 | E2E tests pass in CI against the live Testnet deployment | Open until the first green CI run is linked ([3.1](#31-e2e-tests-pass-in-ci-against-the-live-testnet-deployment)) |
| 3 | the walkthrough is reproducible by an independent reviewer | Met ([3.2](#32-the-walkthrough-is-reproducible-by-an-independent-reviewer)) |

The tranche's objective, as submitted:

> Deploy the complete protocol to Stellar Testnet, extend OracleAdapter with the safety features required for public
> deployment, and deliver a working dApp at a public URL. By the end of this tranche, a reviewer can connect a
> Freighter wallet, deposit a test asset, receive PT and YT tokens, trade through the PT/YT market, provide liquidity,
> claim yield, and view their position — entirely through a browser.

---

## Deliverable 1: Testnet Deployment + Oracle Safety

### As submitted

> **Description:** Deploy the complete protocol contract set to Stellar Testnet using a scripted, repeatable pipeline:
> a deploy.sh script reading from a single .env file and producing a deployment-manifest.json with contract addresses,
> WASM hashes, and deployment transaction IDs; a post-deploy verification script asserting expected initial state;
> idempotent re-deploy logic; and complete initial configuration, including a testnet oracle rate submitted via
> set_reference_value, RiskControl limits, and a 90-day maturity for the first yield market.
>
> Ongoing Testnet oracle freshness during this tranche is maintained via manual/scripted rate updates, not a dedicated
> background service.
>
> OracleAdapter — configurable primary and fallback price sources, automatic protocol-wide block when no fresh price
> is available (OracleUnavailable on mint/deposit), and price-deviation guard rejecting updates that move more than
> ±10% from the previous value.
>
> **Success Criteria:** All protocol contracts are deployed on Stellar Testnet and publicly visible; deployment is
> scripted and repeatable; the complete PT/YT and AMM flows are operational; SAC compliance controls and RecoveryEscrow
> are active on-chain; and oracle safety guards are working.

**Who delivered what.** The official Testnet deployment is the app team's market `testnet-usdy-1802336344`, deployed
on 13 November 2026 from the contracts at commit
[`665bb67`](https://github.com/principal-Protocol-org/principal/tree/665bb6760372d30307a1a035da24e51776f727e8) with
the dApp repository's [`scripts/dev-stack/deploy.sh`](https://github.com/principal-Protocol-org/dapp/blob/testnet/scripts/dev-stack/deploy.sh).
The app at <https://testnet.principalmarket.fi> runs on it. The OracleAdapter safety extension is contract code in the
contracts repository. The contracts team also ran Testnet deployments of its own, documented in that repository; this
review does not depend on them.

### 1.1 All protocol contracts are deployed and publicly visible

1. Open the manifest [config/manifests/testnet.json](https://github.com/principal-Protocol-org/dapp/blob/testnet/config/manifests/testnet.json).
   It lists:
   - 5 shared contracts under `shared`: `router`, `oracle`, `permissioning`, `riskControl`, `factory`;
   - the market `testnet-usdy-1802336344` with its 7 own contracts under `contracts`: `sy`, `pt`, `yt`, `config`,
     `manager`, `pool`, `recoveryEscrow` (`router` and `oracle` are repeated there);
   - the test asset `USDY` with its issuer and its Stellar Asset Contract (`sac`);
   - a `wasmHashes` entry for each of the 12 contracts, and the contracts' `sourceCommit`.
2. Open each address on stellar.expert. The links are in [evidence §1.2](TRANCHE_2_EVIDENCE.md#12-contracts). For example the Router:
   <https://stellar.expert/explorer/testnet/contract/CC4BQRFRQQZF5VQUHZV3PS4LSIPNNAGI3UOL3K24DZNTCHGZQ3JHQ3E2>. Each
   page shows when and by which account the contract was created, its wasm hash and its calls.
3. Optional: check that the code on chain is the code the manifest names. For each contract, fetch its wasm and hash it:

   ```bash
   stellar contract fetch --id CC4BQRFRQQZF5VQUHZV3PS4LSIPNNAGI3UOL3K24DZNTCHGZQ3JHQ3E2 --network testnet -o router.wasm
   shasum -a 256 router.wasm
   # 9cd0403a156b192e09c1c614743e99c0b167e9a3c65c7e5553596639e772fd39  = wasmHashes.router
   ```

   We ran this for all 12 contracts on 13 November 2026: all 12 match ([evidence §1.2](TRANCHE_2_EVIDENCE.md#12-contracts)).

**Status: Met.**

### 1.2 Deployment is scripted and repeatable

1. Read [`scripts/dev-stack/deploy.sh`](https://github.com/principal-Protocol-org/dapp/blob/testnet/scripts/dev-stack/deploy.sh)
   and its [README, section "Testnet"](https://github.com/principal-Protocol-org/dapp/blob/testnet/scripts/dev-stack/README.md#testnet).
   One command, `PRINCIPAL_NETWORK=testnet scripts/dev-stack/deploy.sh`:
   - builds the contracts from the contracts repository at a given commit (`git archive`, then `cargo build`);
   - issues the test asset with `AUTH_REQUIRED`, `AUTH_REVOCABLE` and `AUTH_CLAWBACK_ENABLED`, and deploys its SAC;
   - deploys and initializes every contract in the order of the contracts repository's
     [docs/DEPLOYMENT.md](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/docs/DEPLOYMENT.md)
     (steps 1 to 11), including the compliance standing of each protocol contract;
   - seeds the pool and writes the manifest.
2. Check that it repeats. The end-to-end Suite B runs the same script on every CI run and deploys a complete
   throwaway market from scratch, with four keys generated in the run. On 13 November 2026 that deploy took 376 s, and
   its 12 wasm hashes are byte-identical to the official manifest's ([evidence §4.1](TRANCHE_2_EVIDENCE.md#41-the-deploy)). Each CI
   run's job summary also compares a fresh Linux build with the official hashes (step "Compare the wasm with the
   official deployment's" in the [workflow](https://github.com/principal-Protocol-org/dapp/blob/testnet/.github/workflows/e2e-testnet.yml)).
3. Check the post-deploy assertions. Right after its deploy, Suite B asserts
   ([tests/e2e-testnet/lifecycle.test.ts, lines 486 to 538](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/lifecycle.test.ts#L486-L538)):
   the manifest validates with no error; the Router lists the one-step functions; the asset's SAC admin is the admin
   key; the oracle admin is the oracle key; the contracts are wired to each other as the manifest says; the pool is
   seeded; the oracle is fresh. Suite A checks the official deployment the same way before its journey (manifest,
   Router functions, oracle available, pool seeded).

**Status: Met** for "scripted and repeatable". The description asks for more pipeline details than the success
criterion; [1.6](#16-the-description-item-by-item) maps them one by one, including what is not done.

### 1.3 The complete PT/YT and AMM flows are operational

1. Open [evidence §3.2](TRANCHE_2_EVIDENCE.md#32-transactions): the 12 transactions of Suite A on the official market, 13 November 2026,
   15:04 to 15:08 UTC: deposit, split into PT + YT, buy and sell PT, buy and sell YT, two liquidity deposits, a
   liquidity withdrawal, a PT transfer and a YT transfer. Open any hash on stellar.expert: it is successful, and its
   invocation names the contract function.
2. Open [evidence §6.2](TRANCHE_2_EVIDENCE.md#62-browser-runs-on-the-official-market): the same journey done in a browser on the official market, with a yield
   claim.
3. Open [evidence §4](TRANCHE_2_EVIDENCE.md#4-suite-b-the-ephemeral-lifecycle): Suite B's oracle tick, yield claim and redemption at maturity, on its own
   market built from the same contract code.
4. Or run the flows yourself in the app: follow the walkthrough ([3.2](#32-the-walkthrough-is-reproducible-by-an-independent-reviewer)).

**Status: Met.** Redemption at maturity is shown on Suite B's 20-minute market. The official market matures on
11 February 2027 at 08:59:04 UTC.

### 1.4 SAC compliance controls and RecoveryEscrow are active on-chain

1. **The asset's flags.** Open <https://horizon-testnet.stellar.org/accounts/GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT>
   (the USDY issuer) and find `"flags"`: `auth_required`, `auth_revocable` and `auth_clawback_enabled` are `true`. In
   the app: open the market, then the **Compliance** tab, part **Underlying asset**.
2. **A non-onboarded account is refused by the contracts.** [Evidence §3.3](TRANCHE_2_EVIDENCE.md#33-compliance-refusal-of-an-account-that-was-not-onboarded): on the official
   market, a deposit simulated by an account that is not authorized on the SAC fails with SY contract error #9,
   [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/sy_wrapper/src/lib.rs#L103),
   and a PT transfer to it fails with PT contract error #10,
   [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/pt_token/src/lib.rs#L73).
   To see it yourself, use [2.3](#23-compliance-oracle-and-maturity-restrictions-are-enforced-in-the-interface) step 1.
3. **The RecoveryEscrow is wired into the official market.** Each position contract returns the escrow's address:

   ```bash
   for c in CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I CCQPYQNDIHVLZZPK6CCF3CNBUP25BHJHX36PQXV6MG3ELPM7JYWDSPA5 \
            CAXVQIHH7US4DUK2E2GE2N6VNXDECC6D4DOGXUSEG6SPKS7USNMYXDCB CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ; do
     stellar contract invoke --id "$c" --network testnet --send=no \
       --source-account GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT -- recovery_escrow
   done
   # SY, PT, YT and pool each print "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q", the manifest's recoveryEscrow
   ```

4. **Compliance recovery, end to end.** [Evidence §4.5](TRANCHE_2_EVIDENCE.md#45-compliance-recovery): on Suite B's market, the issuer authority
   deauthorizes an account on the SAC, `seize_all_positions` moves its SY, PT, YT and LP to the escrow, and after
   maturity `finalize_record` settles the seized PT and YT into USDY. The record reads back `finalized: true`. Each step
   has its transaction hash.

**Status: Met.** The recovery sequence ran on Suite B's market, with the same contract code as the official one. It
needs the admin key, which never leaves the developer's machine, so it is not run on the official market.

### 1.5 Oracle safety guards are working

1. **In the app.** Open the market, then the **Safety** tab. It reads the official oracle live: **Oracle** "Fresh"
   with the time of the last update, **Oracle deviation cap** 10%, **Oracle primary source** `8f157e…`, **Oracle
   fallback source** None, **Oracle last rejected update** None.
2. **From the contract.** Read the official oracle:

   ```bash
   for fn in max_stale_seconds max_deviation_bps is_available get_primary_source get_fallback_source last_rejection; do
     stellar contract invoke --id CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS --network testnet --send=no \
       --source-account GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT -- $fn
   done
   # 3600, 1000, true, "8f157e8d…b3b4", null, null on 13 November 2026 (evidence §1.4)
   ```

3. **The staleness guard blocks a real call.** [Evidence §4.6](TRANCHE_2_EVIDENCE.md#46-refusals-at-maturity): on Suite B's market, ledger
   5712285, the first redemption after maturity was refused because the oracle was stale: PrincipalManager contract
   error #7, [`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/principal_manager/src/lib.rs#L199).
   The app showed its blocker before any signature.
4. **The deviation guard and the availability block, live.** The contracts repository's
   [ORACLE_SAFETY_EXTENSION.md §4](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/docs/ORACLE_SAFETY_EXTENSION.md#4-live-testnet-evidence)
   records, with transaction links: a 20% jump against the 10% cap returns `false`, leaves the price unchanged and is
   read back from `last_rejection()`; a 5% move is accepted; a mint reverts `OracleStale` while the oracle is stale and
   succeeds once it is fresh again. The fallback's rule (it may only refresh the timestamp, never the value) is covered
   by the unit tests in
   [contracts/oracle_adapter/src/test.rs](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/oracle_adapter/src/test.rs).
5. **Ongoing freshness.** Open the official oracle on stellar.expert,
   <https://stellar.expert/explorer/testnet/contract/CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS>. Its calls
   show a `set_reference_value` every 30 minutes, sent by the app's scheduled keeper (`/api/cron/oracle`) from the
   oracle admin account; Horizon lists them too:
   <https://horizon-testnet.stellar.org/accounts/GABQLCMTB2M2E4O3GWAG3ZIMLDVIGQJE3CKPLRRZK2GJF3LABSOLTGD5/operations?order=desc>.
   [`scripts/dev-stack/oracle-tick.sh`](https://github.com/principal-Protocol-org/dapp/blob/testnet/scripts/dev-stack/oracle-tick.sh)
   does the same by hand.

**Status: Met.** The staleness guard is shown on this deployment's contract code (Suite B). The deviation guard is
**met in the contracts repository** (live transactions on a contracts-team oracle instance, plus unit tests); it has not
fired on the official oracle, whose `last_rejection` is `null`. The official oracle has one primary source and no
fallback configured.

### 1.6 The description, item by item

The success criteria are covered above. This table maps each part of the description to what exists, so nothing is
claimed by omission. "Open" items are owned by the app team, whose script became the official pipeline (13 November
2026); they were not built.

| Description item | What exists | Status |
|---|---|---|
| a deploy.sh script | [`scripts/dev-stack/deploy.sh`](https://github.com/principal-Protocol-org/dapp/blob/testnet/scripts/dev-stack/deploy.sh) | Done |
| reading from a single .env file | It reads environment variables with defaults (`PRINCIPAL_NETWORK`, `PRINCIPAL_REF`, `MATURITY_SECONDS`, `ASSET_CODE`, the four key names, `ORACLE_MAX_STALE_SECONDS`). It reads no `.env` file. | Not as described |
| producing a deployment-manifest.json with contract addresses, WASM hashes | `config/manifests/testnet.json`: addresses, wasm hashes, source commit, generation time, Router functions | Done, under another file name |
| and deployment transaction IDs | Not in the manifest. Each contract's stellar.expert page shows when and by which account it was created. | Open |
| a post-deploy verification script asserting expected initial state | No standalone script. The same assertions run at the start of Suites A and B on every CI run ([1.2](#12-deployment-is-scripted-and-repeatable) step 3). | Partly |
| idempotent re-deploy logic | Not idempotent: every run deploys a new market and writes a new manifest. A rerun reuses the build (cached per commit), the asset's contract and the funded keys, and guards refuse to rewrite the official manifest with other keys or settings. | Open |
| a testnet oracle rate submitted via set_reference_value | Genesis value 1.0 at deploy, signed by the oracle key | Done |
| RiskControl limits | RiskControl is deployed and wired to SY and PrincipalManager, but its circuit breaker is off: `get_cb_limit` returns 0 (window 17,280 ledgers). The app's Safety tab shows "No limit (disabled)". | Open |
| a 90-day maturity for the first yield market | Maturity 1802336344 = 11 February 2027 08:59:04 UTC, 7,776,000 s (90 days) after the deploy's ledger time | Done |
| Ongoing oracle freshness via manual/scripted rate updates | The app's keeper every 30 minutes, and `oracle-tick.sh` by hand ([1.5](#15-oracle-safety-guards-are-working) step 5) | Done |
| OracleAdapter: configurable primary and fallback price sources | `set_sources` in the contract; the official oracle has a primary source and no fallback | Done in the contracts; fallback not configured here |
| automatic protocol-wide block when no fresh price is available (OracleUnavailable on mint/deposit) | `is_available()` / `assert_available()` (error #8 `OracleUnavailable`) in the oracle; mint, trades, single-sided liquidity and redemption revert `OracleStale` in their own contracts. Deposit into SY is not blocked: SY wraps the asset 1:1 and does not read the oracle. | Done for mint; deposit differs from the text |
| price-deviation guard rejecting updates that move more than ±10% | `max_deviation_bps` 1000 on the official oracle. A rise above 10% is rejected; any decrease is refused outright (`ValueDecreased`). | Done in the contracts ([1.5](#15-oracle-safety-guards-are-working) step 4) |

The contracts repository's [ORACLE_SAFETY_EXTENSION.md §7](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/docs/ORACLE_SAFETY_EXTENSION.md#7-what-is-still-open)
lists the pipeline as outside that repository's scope; the app team's `deploy.sh` is that pipeline.

---

## Deliverable 2: dApp on Testnet

### As submitted

> **Description:** A React dApp deployed at a public Testnet URL: wallet connection (Freighter, @stellar/freighter-api,
> persistent session); market page (maturity date, current oracle rate, time-to-maturity countdown, total PT/YT
> outstanding, and pool liquidity); compliance status derived from the underlying Stellar Asset; deposit panel (live
> SY-share preview); mint panel (live PT/YT preview); trading panel for PT/YT market flows; liquidity
> deposit/withdrawal panel; position dashboard (PT/YT balance, locked initial_rate, current oracle rate, projected fixed
> return); yield-claim and redeem panels; and transaction history based on protocol events.
>
> **Success Criteria:** dApp is live at a public Testnet URL, all user flows work end-to-end, and compliance, oracle,
> and maturity restrictions are enforced in the interface.

### 2.1 The dApp is live at a public Testnet URL

1. Open <https://testnet.principalmarket.fi>. A banner on every page reads "Stellar Testnet — test assets only, no real
   value."
2. Click **Launch app**. The app opens on **Markets** (`/app`) and lists the market **USDY (test)**, maturing on
   11 February 2027. Its page is <https://testnet.principalmarket.fi/app/markets/testnet-usdy-1802336344>.

**Status: Met.**

### 2.2 All user flows work end-to-end

1. Follow the walkthrough's steps 1 to 10 with your own Varial account
   ([3.2](#32-the-walkthrough-is-reproducible-by-an-independent-reviewer)).
2. Check each feature of the description where the table below says:

   | Description item | Where to see it in the app |
   |---|---|
   | wallet connection (Freighter, @stellar/freighter-api, persistent session) | **Connect wallet**, top right. Reload the page: you stay connected. |
   | market page: maturity date, current oracle rate, time-to-maturity countdown, total PT/YT outstanding, pool liquidity | The market page: the header shows the maturity date and a countdown ("Matures in …"); the stats show **Liquidity** and **TVL**; the **Details** tab shows **Oracle rate**, **Oracle updated**, **Maturity**, **PT outstanding**, **YT outstanding** and the pool's reserves. |
   | compliance status derived from the underlying Stellar Asset | The **Compliance** tab: the asset's issuer settings, then your account's checks (trustline, issuer authorization, permissioning), each **OK**, **Action needed** or **Blocked**. |
   | deposit panel (live SY-share preview) | **Quick actions**, **Deposit USDY → SY**: the SY you receive updates as you type. |
   | mint panel (live PT/YT preview) | **Quick actions**, **Split USDY → PT + YT**: the PT and YT you receive, marked **Exact (simulated)**. |
   | trading panel for PT/YT market flows | The **PT** and **YT** tabs of the Trade panel, **Buy** and **Sell**. |
   | liquidity deposit/withdrawal panel | The **LP** tab, **Deposit** and **Withdraw**. |
   | position dashboard (PT/YT balance, locked initial_rate, current oracle rate, projected fixed return) | **Portfolio**: balances; an entry line ("Entry rate … from your mint on …", or the fixed APY locked when you bought PT); **Oracle rate**; the **Fixed return if held to maturity** block. |
   | yield-claim and redeem panels | **Claim yield** on the Portfolio card. **Redeem at maturity** replaces the sell shortcuts once the market has matured. |
   | transaction history based on protocol events | **History**: your transactions read from the contracts' events, with links to stellar.expert. |

3. Compare with the recorded runs: Suite A ([evidence §3](TRANCHE_2_EVIDENCE.md#3-suite-a-the-live-journey-on-the-official-market)) runs every user flow on the official
   market through the app's own protocol layer (`lib/protocol/`: the same previews, gates, transaction building and
   History reads the pages use). Two browser runs of the walkthrough on the official market are recorded with their
   transaction hashes, one of them complete ([evidence §6.2](TRANCHE_2_EVIDENCE.md#62-browser-runs-on-the-official-market)).

**Status: Met on branch `testnet`**, with two limits:
- **Redeem in the browser** is possible only after the official market matures (11 February 2027). Redemption is shown
  on Suite B's market through the same protocol layer ([evidence §4.7](TRANCHE_2_EVIDENCE.md#47-redemption-at-maturity)), and the redeem panel is
  covered by [components/app/\_\_tests\_\_/redeem-tab.test.tsx](https://github.com/principal-Protocol-org/dapp/blob/testnet/components/app/__tests__/redeem-tab.test.tsx).
- **The deployed build.** The site must serve a build that includes commit `df52bc7` (13 November 2026). The build it
  served before that failed some sales and the liquidity withdrawal with "its refundable fee is too low"
  ([evidence §6](TRANCHE_2_EVIDENCE.md#6-walkthrough)).

### 2.3 Compliance, oracle and maturity restrictions are enforced in the interface

The app checks every action against these restrictions before it asks for a signature. A blocked action shows a box
headed **Signing is off** that lists the reasons, and its review button stays off. Evidence for each:
[evidence §5](TRANCHE_2_EVIDENCE.md#5-gate-refusals).

1. **Compliance (you can reproduce it).** In Varial, create a new Testnet account and fund it with Friendbot
   (<https://friendbot.stellar.org/?addr=YOUR_ADDRESS>). Connect it to the app but do not use **Get test tokens**. Open
   the market: the **Compliance** tab marks the trustline and permissioning checks, and the Trade panel's **Signing is
   off** box lists the reasons, such as "You have no trustline to the underlying asset. Add one before you can hold
   it." Suite A recorded the same messages on the official market, and the contracts' own refusal (SY error #9).
2. **Wrong network (you can reproduce it).** Switch Varial to Mainnet while connected. Within a few seconds the wallet
   button turns red and reads **Wrong network · switch your wallet to Testnet**, and every write is blocked with "Your
   wallet is on a different network from this market. Switch it to the network …". The unit tests in
   [evidence §5](TRANCHE_2_EVIDENCE.md#5-gate-refusals) pin this.
3. **Stale oracle (recorded, not reproducible on the official market).** The keeper keeps the official oracle fresh, so
   a reviewer cannot make it stale. Suite B let its own oracle go stale: the app refused the redemption with "The
   oracle price is stale: it has not been updated in the last 5 minutes. …", and the contract refused it too (error
   #7). The app's rules for a stale oracle are pinned in
   [lib/protocol/\_\_tests\_\_/gates.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/gates.test.ts#L372-L435).
4. **Maturity (recorded; on the official market after 11 February 2027).** On Suite B's market after maturity, the app
   refused a PT purchase with "Trading closed at maturity: this market has matured, so PT and YT can no longer be bought
   or sold in the pool. …", and the pool refused it too (error #6,
   [`Expired`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/market_pool/src/lib.rs#L162)).
   The rules are pinned in the same [gates.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/gates.test.ts#L313-L369).

**Status: Met.**

---

## Deliverable 3: End-to-End Tests + Testnet Walkthrough

### As submitted

> **Description:** End-to-End Tests: an automated suite exercising the full protocol flow against live Testnet
> contracts — faucet funding, deposit, PT/YT issuance, transfers, trading, liquidity operations, yield claiming,
> maturity settlement, and compliance recovery — running in CI on every pull request. Testnet Walkthrough: a
> step-by-step guide with screenshots letting a reviewer replicate the full user journey without prior knowledge of the
> protocol.
>
> **Success Criteria:** E2E tests pass in CI against the live Testnet deployment, and the walkthrough is reproducible by
> an independent reviewer.

### 3.1 E2E tests pass in CI against the live Testnet deployment

1. Open the workflow [.github/workflows/e2e-testnet.yml](https://github.com/principal-Protocol-org/dapp/blob/testnet/.github/workflows/e2e-testnet.yml).
   It runs on every pull request to `testnet` and `main`, by hand and nightly. It has two jobs, run in parallel:
   - **Suite A: live journey**, on the official deployment, with fresh accounts onboarded through the app's public
     faucet;
   - **Suite B: ephemeral lifecycle**, on a market it deploys on Testnet with `deploy.sh`, for the steps that need admin
     powers (oracle tick, compliance recovery, settlement at a 20-minute maturity).

   It uses no repository secret: both suites make their keys in the run. The [README's CI section](https://github.com/principal-Protocol-org/dapp/blob/testnet/README.md#ci)
   explains it.
2. Find the runs: the repository's **Actions** tab, workflow **E2E Testnet**,
   <https://github.com/principal-Protocol-org/dapp/actions/workflows/e2e-testnet.yml>. Pull-request runs appear there.
   Nightly and manual runs start once the workflow file is on `main`, the default branch.
3. Open a run. Both jobs should be green. Each uploads its run record as an artifact (`e2e-journey-<attempt>`,
   `e2e-lifecycle-<attempt>`): a JSON file with the public keys, the transaction hashes and the refusals. Suite B's job
   summary lists the wasm it built and whether each matches the official deployment's.
4. Check that the suites cover the description's list:

   | Description item | Suite and test |
   |---|---|
   | faucet funding | A: two fresh accounts onboarded through `POST https://testnet.principalmarket.fi/api/faucet` (Friendbot, trustline, then the faucet) |
   | deposit | A and B: Deposit USDY → SY |
   | PT/YT issuance | A and B: Split USDY → PT + YT |
   | transfers | A: a PT and a YT transfer between the two accounts, exact on both sides |
   | trading | A: Buy and Sell PT, Buy YT (flash) and Sell YT, each paid in USDY; B: Buy PT |
   | liquidity operations | A: LP paid in USDY, LP with Keep YT, LP withdrawal to USDY; B: LP paid in USDY |
   | yield claiming | B: oracle tick to 1.05, then Claim yield pays exactly the pending yield |
   | maturity settlement | B: `redeem_at_maturity`, which settles the market; the stale and post-maturity refusals |
   | compliance recovery | B: deauthorize on the SAC, `seize_all_positions`, then `finalize_record` after maturity |

   Plus, in Suite A: the History reads list every transaction once, and an account that was not onboarded is refused.

**Status: Open until the first green CI run is linked** in [evidence §2](TRANCHE_2_EVIDENCE.md#2-ci), row "First green CI
run". Owner: the app team. Both suites passed against live Testnet on 13 November 2026, run locally with the same
command the workflow uses (records in [evidence §3](TRANCHE_2_EVIDENCE.md#3-suite-a-the-live-journey-on-the-official-market) and [§4](TRANCHE_2_EVIDENCE.md#4-suite-b-the-ephemeral-lifecycle)); the workflow
had not run on GitHub yet when this file was written. If that row holds a link to a green run, this criterion is met.

"The live Testnet deployment": Suite A runs on the official deployment. Suite B runs on live Testnet too, on a market
it deploys from the same contract code, because its admin-only steps cannot run on the official market without its
admin key leaving the developer's machine.

### 3.2 The walkthrough is reproducible by an independent reviewer

1. Open the walkthrough: <https://principalmarket.fi/docs/using-the-app/testnet-walkthrough> (source:
   [using-the-app/testnet-walkthrough.md](https://github.com/principal-Protocol-org/docs/blob/main/using-the-app/testnet-walkthrough.md)).
   It assumes no knowledge of the protocol and links the docs pages that explain each term.
2. Follow steps 1 to 10 with a new Varial account on Testnet: install and connect, get test tokens, deposit, mint, buy
   and sell PT and YT, add and withdraw liquidity, claim yield, then read Portfolio and History. Allow about 15 minutes,
   plus up to 30 minutes before Claim yield: yield accrues only when the oracle updates.
3. Compare each screen with the step's screenshot. Prices, APYs and fees move with trading and with the oracle, so your
   figures will differ a little.
4. Check your own transactions: each result notice links to stellar.expert, and **History** lists them.
5. Step 11 (redeem) can be done only after the market matures on 11 February 2027. Before that, the page shows the
   Portfolio's **Fixed return if held to maturity** block.

**Status: Met.** The page's journey was run in a browser on the official market: in full on a production build of
branch `testnet`, and on the live site except Sell YT and the withdrawal, which the site's older build failed (see
[2.2](#22-all-user-flows-work-end-to-end), "The deployed build"). Every transaction is recorded ([evidence §6.2](TRANCHE_2_EVIDENCE.md#62-browser-runs-on-the-official-market)). Varial's own pop-ups and the screens after maturity are described in
text, not shown ([evidence §6.4](TRANCHE_2_EVIDENCE.md#64-screens-not-captured)).

---

## Rerun the suites yourself

From a clone of the dApp repository on branch `testnet` (Node 24, pnpm 12.5.1):

```bash
pnpm install --frozen-lockfile
pnpm test:e2e:testnet tests/e2e-testnet/journey.test.ts     # Suite A, about 5 minutes, needs only Node
pnpm test:e2e:testnet tests/e2e-testnet/lifecycle.test.ts   # Suite B, about 22 minutes
```

Suite B also needs the Stellar CLI 28, Rust 1.95.0 with the `wasm32v1-none` target, `jq`, and a clone of the
contracts repository at `../principal` (or `PRINCIPAL_REPO=<path>`). It creates four throwaway keys in your local
Stellar CLI keystore and removes them at the end. Each suite writes its record to `e2e-artifacts/journey.json` or
`e2e-artifacts/lifecycle.json`.

The unit tests (`pnpm test`) need no network.

## Known limits

- Testnet is shared. The faucet serves each account, and each connection, once a minute; a suite that hits the limit
  waits and retries once.
- A trade whose amounts are derived from the pool's reserves can fail with `Error(Auth, InvalidAction)` if another
  trade moves the pool between the simulation and the inclusion. Only the network fee is spent; trying again works.
  This is a contract-level limit, known to the contracts team, that only matters on a busy pool.
- Redemption on the official market, in the browser, is possible only from 11 February 2027 08:59:04 UTC.
