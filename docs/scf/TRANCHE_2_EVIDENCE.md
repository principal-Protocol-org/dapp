# Tranche 2 (Testnet): evidence

The facts behind [TRANCHE_2_REVIEW.md](TRANCHE_2_REVIEW.md): deployed addresses, wasm hashes, transaction hashes, CI
runs, screenshots and dates. Each section says where its data comes from. Written on 13 November 2026; all times are
UTC.

Every address here is public. No secret key, and no name of a key in a keystore, appears in this file.

Links:
- transactions and contracts on stellar.expert: `https://stellar.expert/explorer/testnet/tx/<hash>` and
  `https://stellar.expert/explorer/testnet/contract/<address>`;
- the same transactions on Horizon, as JSON: `https://horizon-testnet.stellar.org/transactions/<hash>`;
- the dApp at branch `testnet`, the contracts pinned at commit
  [`665bb6760372d30307a1a035da24e51776f727e8`](https://github.com/principal-Protocol-org/principal/tree/665bb6760372d30307a1a035da24e51776f727e8).

## 1. Official deployment

### 1.1 The manifest

Source: [config/manifests/testnet.json](https://github.com/principal-Protocol-org/dapp/blob/testnet/config/manifests/testnet.json),
written by `PRINCIPAL_NETWORK=testnet scripts/dev-stack/deploy.sh` and committed in the dApp repository.

| Field | Value |
|---|---|
| Market id | `testnet-usdy-1802336344` |
| Maturity | `1802336344` = 11 February 2027 08:59:04 UTC, 90 days after the deploy's ledger time (13 November 2026 08:59:04 UTC) |
| `generatedAt` | 2026-11-13T09:08:56Z |
| `sourceCommit` (contracts) | [`665bb6760372d30307a1a035da24e51776f727e8`](https://github.com/principal-Protocol-org/principal/commit/665bb6760372d30307a1a035da24e51776f727e8), also `main` of the contracts repository |
| Network | Stellar Testnet, `Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org` |
| Test asset | `USDY`, 7 decimals, shown as "USDY (test)" |

### 1.2 Contracts

Source: the manifest. "On chain" is our check of 13 November 2026: `stellar contract fetch --id <address> --network
testnet`, then `shasum -a 256`, compared with the manifest's `wasmHashes`. All 12 match. A local build of `665bb67`
with Rust 1.95.0 (`cargo build --workspace --release --target wasm32v1-none`) also gives the same 12 hashes.

| Contract | Address | Wasm SHA-256 | On chain |
|---|---|---|---|
| Router (shared) | [CC4BQRFRQQZF5VQUHZV3PS4LSIPNNAGI3UOL3K24DZNTCHGZQ3JHQ3E2](https://stellar.expert/explorer/testnet/contract/CC4BQRFRQQZF5VQUHZV3PS4LSIPNNAGI3UOL3K24DZNTCHGZQ3JHQ3E2) | `9cd0403a156b192e09c1c614743e99c0b167e9a3c65c7e5553596639e772fd39` | match |
| OracleAdapter (shared) | [CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS](https://stellar.expert/explorer/testnet/contract/CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS) | `adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce` | match |
| Permissioning (shared) | [CAFQMOCW3673DBKJBJ7C555IYPOULPH2WFOEOX52JAUCZRGZF5FRVLBA](https://stellar.expert/explorer/testnet/contract/CAFQMOCW3673DBKJBJ7C555IYPOULPH2WFOEOX52JAUCZRGZF5FRVLBA) | `bf902fe36e73da56ec9aa9ab72728d9e0a4ea923814925fa4259e025ff98eb9e` | match |
| RiskControl (shared) | [CCRZ55SG273OTUZSFME6A6XXXEZ3GM5IMVRLF4NEEWNC54NGCRHIMHJC](https://stellar.expert/explorer/testnet/contract/CCRZ55SG273OTUZSFME6A6XXXEZ3GM5IMVRLF4NEEWNC54NGCRHIMHJC) | `0e55d8200021b680176eca83738a639de6bfc8ab7f70a5985d3ef2d4669fa7a0` | match |
| MarketFactory (shared) | [CCTRU7IYGPXPY57FAT2TOYRYU6FZY7EPXZBZWDHGQB42V5JXPLN6XTXK](https://stellar.expert/explorer/testnet/contract/CCTRU7IYGPXPY57FAT2TOYRYU6FZY7EPXZBZWDHGQB42V5JXPLN6XTXK) | `790244c989a4c1f59c52d19250c5d63763b359cfc0d77ffc3317a176abfdbab8` | match |
| SYWrapper | [CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I](https://stellar.expert/explorer/testnet/contract/CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I) | `64a8f41122a1599f100c1fd288b1879c19e6b71aed1b6dc3bc22604f0d008bcb` | match |
| PTToken | [CCQPYQNDIHVLZZPK6CCF3CNBUP25BHJHX36PQXV6MG3ELPM7JYWDSPA5](https://stellar.expert/explorer/testnet/contract/CCQPYQNDIHVLZZPK6CCF3CNBUP25BHJHX36PQXV6MG3ELPM7JYWDSPA5) | `6464745ba7eb96c77a59f724d29d8f7ed6f378a77e1d2bff4fc08663e315078b` | match |
| YTToken | [CAXVQIHH7US4DUK2E2GE2N6VNXDECC6D4DOGXUSEG6SPKS7USNMYXDCB](https://stellar.expert/explorer/testnet/contract/CAXVQIHH7US4DUK2E2GE2N6VNXDECC6D4DOGXUSEG6SPKS7USNMYXDCB) | `f45e230ba03149ece9a3bbad0d8173ce6dfa456f066c139cf1fd8b2b4ac2fb47` | match |
| MarketConfig | [CBJT4OZDU2LFYQU5D6EQAYTLCLFOUJ3JK55HUBZVUMZ5FQVHK37VHJJ4](https://stellar.expert/explorer/testnet/contract/CBJT4OZDU2LFYQU5D6EQAYTLCLFOUJ3JK55HUBZVUMZ5FQVHK37VHJJ4) | `3ab03fa1ee0cd13b871174f9478def5e34df599932358ba457ece80b6e295000` | match |
| PrincipalManager | [CDYL4ZOIZ3DKEDWIMBUXHYQUAT4BAZTYZ7ZRCVLAMFAXGTJZRTOLVG47](https://stellar.expert/explorer/testnet/contract/CDYL4ZOIZ3DKEDWIMBUXHYQUAT4BAZTYZ7ZRCVLAMFAXGTJZRTOLVG47) | `adcc724a270398a5c48bb20f417f37ad8d2def6a7f6897aa371170e363875f48` | match |
| MarketPool | [CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ](https://stellar.expert/explorer/testnet/contract/CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ) | `ab240fd7f4da359cc562ebb9d21761b9f4513fb96d5b0c0e829dfd441596e3eb` | match |
| RecoveryEscrow | [CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q](https://stellar.expert/explorer/testnet/contract/CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q) | `795f16109536cf8908796d6315d21e0e7bccf29d043ddd0f5763520fa9b88c74` | match |
| USDY Stellar Asset Contract | [CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ](https://stellar.expert/explorer/testnet/contract/CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ) | built-in | n/a |

The manifest does not record the deployment transactions. Each contract's stellar.expert page shows when and by which
account it was created (for the Router: 13 November 2026 09:06:44 UTC, by the admin GBLPAJ…B7UA).

### 1.3 Test asset and roles

| Role | Public address | Source |
|---|---|---|
| Issuer: USDY classic issuer and Permissioning admin; held by the app's server (faucet) | [GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT](https://stellar.expert/explorer/testnet/account/GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT) | manifest; Permissioning `get_admin`; Horizon flags |
| Market admin: SAC admin of USDY; admin of the Router, RiskControl, SYWrapper, PTToken, YTToken, PrincipalManager and MarketPool; MarketConfig's protocol admin and creator; stays on the developer's machine | [GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA](https://stellar.expert/explorer/testnet/account/GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA) | SAC `admin`; `get_admin` of each listed contract; MarketConfig `protocol_admin`, `creator` |
| Oracle admin: OracleAdapter admin; held by the app's server (keeper) | [GABQLCMTB2M2E4O3GWAG3ZIMLDVIGQJE3CKPLRRZK2GJF3LABSOLTGD5](https://stellar.expert/explorer/testnet/account/GABQLCMTB2M2E4O3GWAG3ZIMLDVIGQJE3CKPLRRZK2GJF3LABSOLTGD5) | OracleAdapter `get_admin` |

What each key can do, from the contracts at `665bb67` and the asset's flags on Horizon:

- **Market admin** (GBLPAJ…B7UA). The SAC admin of USDY and the admin of the contracts listed above. Suite B used this
  role on its own market to deauthorize an account on the SAC, `seize_all_positions` and `finalize_record` (§4.3). It
  stays on the developer's machine, as does the treasury key, which only receives fee shares. The app's server never
  holds either.
- **Issuer** (GDUGKH…FIDT), held by the app's server for the faucet. The classic issuer of USDY, with `auth_required`,
  `auth_revocable` and `auth_clawback_enabled` set (§1.4; holders' trustlines show `is_clawback_enabled: true`). With
  classic operations it can authorize and deauthorize any account's USDY trustline, claw back USDY from it, and pay
  out new USDY (the faucet's `pay` step). As the Permissioning admin it can grant and revoke accounts and PT/YT grants
  (`grant_account`, `grant_accounts`, `revoke_account`, `grant_asset`, `revoke_asset`) and hand the role to another
  key (`transfer_admin`). It is not the SAC admin and administers no other Principal contract.
- **Oracle admin** (GABQLC…TGD5), held by the app's server for the keeper. It pushes values (`set_reference_value`,
  within the deviation cap and never lower than the current value). It can also change the freshness window and the
  deviation cap (`set_safety_params`: any window above 0 s, a cap up to 10,000 bps), set the primary and fallback
  sources (`set_sources`), set value bounds (`set_value_bounds`) and hand the role to another key (`transfer_admin`).
  Suite B used its own oracle admin for `set_safety_params` (§4.3).

So the server cannot administer the market contracts or the SAC. With its two keys, though, it controls the oracle's
settings and values, and which accounts may hold and use USDY, PT and YT.

### 1.4 Live reads, 13 November 2026

Read between 18:00 and 18:40 UTC with `stellar contract invoke … --send=no` (a simulation; nothing signed) and Horizon.

| Read | Result |
|---|---|
| USDY issuer flags ([Horizon account](https://horizon-testnet.stellar.org/accounts/GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT)) | `auth_required: true`, `auth_revocable: true`, `auth_clawback_enabled: true`, `auth_immutable: false` |
| OracleAdapter `max_stale_seconds` | `3600` |
| OracleAdapter `max_deviation_bps` | `1000` (10%) |
| OracleAdapter `is_available` | `true` |
| OracleAdapter `get_reference_value`, `get_reference_timestamp` | `10000487` (1.0000487), set at 1794592799 = 17:59:59 UTC |
| OracleAdapter `get_primary_source` | `8f157e8dfc6b0bef22553de5a980e24fc7c7c9eacc8bccbb8df0f2cab866b3b4` = SHA-256 of `principal-oracle-source:testnet:USDY:app-team:keeper` |
| OracleAdapter `get_fallback_source` | `null` |
| OracleAdapter `last_rejection` | `null` (no update has been rejected) |
| RiskControl `get_cb_limit`, `get_window_ledgers` | `0` (circuit breaker off), `17280` |
| `recovery_escrow` on SYWrapper, PTToken, YTToken, MarketPool | each `CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q` |
| USDY SAC `admin` | `GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA` |

## 2. CI

Source: [.github/workflows/e2e-testnet.yml](https://github.com/principal-Protocol-org/dapp/blob/testnet/.github/workflows/e2e-testnet.yml)
and the [README's CI section](https://github.com/principal-Protocol-org/dapp/blob/testnet/README.md#ci).

| Item | Value |
|---|---|
| Workflow | "E2E Testnet": jobs "Suite A: live journey" and "Suite B: ephemeral lifecycle", in parallel |
| Triggers | every pull request to `testnet`; `workflow_dispatch`; nightly at 03:17 UTC. The nightly and manual runs use the copy on `main` (the production landing site, which holds only this workflow file) and test branch `testnet`. |
| Secrets | none: no repository secret is used and no key is set in the environment |
| Run records | artifacts `e2e-journey-<attempt>` and `e2e-lifecycle-<attempt>`, kept 30 days |
| All runs | <https://github.com/principal-Protocol-org/dapp/actions/workflows/e2e-testnet.yml> |
| First green CI run (pull request) | added after the first green run |

## 3. Suite A: the live journey on the official market

Source: the run record `e2e-artifacts/journey.json` of 13 November 2026, written by
[tests/e2e-testnet/journey.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/journey.test.ts),
run locally with `pnpm test:e2e:testnet tests/e2e-testnet/journey.test.ts`. The record is not committed; every hash
below is on the public ledger.

| Item | Value |
|---|---|
| Market | `testnet-usdy-1802336344`, contracts at `665bb67` |
| Started, finished | 15:04:33 UTC, 15:08:51 UTC (258 s) |
| Result | 13 of 13 tests passed (`complete: true`) |
| Transactions | 12, all successful |

### 3.1 Accounts and onboarding

Three fresh keypairs made in the run. Each was funded by Friendbot and opened a USDY trustline; the first two were then
onboarded by the public faucet (`POST https://testnet.principalmarket.fi/api/faucet`).

| Account | Address | Trustline transaction | Faucet |
|---|---|---|---|
| trader | [GAFAESJGN22CQAWGZCQZYVMBJT5EUYCFQAAT37RY6NTFIHEPFKFC2N54](https://stellar.expert/explorer/testnet/account/GAFAESJGN22CQAWGZCQZYVMBJT5EUYCFQAAT37RY6NTFIHEPFKFC2N54) | [8e6c07f7…8511](https://stellar.expert/explorer/testnet/tx/8e6c07f73b251eb9d578c082280ca8473cba6b830bdaa1b6c5b17121ead88511) | performed `authorize`, `grant_account`, `grant_pt`, `grant_yt`, `pay` |
| recipient | [GB6MAEDJYAO2CWPPOZ6HGIIVSMZQ7QOJEV7AOXF4W4ZGA2GXPKNWAXA6](https://stellar.expert/explorer/testnet/account/GB6MAEDJYAO2CWPPOZ6HGIIVSMZQ7QOJEV7AOXF4W4ZGA2GXPKNWAXA6) | [17cbd415…c40d](https://stellar.expert/explorer/testnet/tx/17cbd41573512ea823b03e99fbd7f9e44b7984d27ea65f0767304d6d3420c40d) | first answer `rate_limited` (retry after 60 s), then the same five steps |
| outsider | [GB4EYJG7HFIUJG57AJBWIMW5NOYV52T2DVAYG2HIKTLBNYUG2PB5UUF7](https://stellar.expert/explorer/testnet/account/GB4EYJG7HFIUJG57AJBWIMW5NOYV52T2DVAYG2HIKTLBNYUG2PB5UUF7) | [4d327d64…abfc](https://stellar.expert/explorer/testnet/tx/4d327d64573e541862804beb9eff8eb46ad23f143bfaae68d0470e2ab166abfc) | never onboarded, on purpose ([§3.3](#33-compliance-refusal-of-an-account-that-was-not-onboarded)) |

After the faucet, the trader and the recipient each held 100,000 USDY and nothing else.

### 3.2 Transactions

Signed by the trader, except the last row, which the outsider signed. Amounts in USDY unless stated.

| Step | Contract function | Amount | Ledger | Transaction |
|---|---|---|---|---|
| Deposit USDY → SY | `deposit` | 500 | 5711759 | [e18a15ba…4615](https://stellar.expert/explorer/testnet/tx/e18a15ba84e81d05c663a0d9af09a41a8c70a333372e863f1531713cf8b14615) |
| Split USDY → PT + YT | `wrap_and_mint` | 300 | 5711760 | [3739b751…3858](https://stellar.expert/explorer/testnet/tx/3739b75147f477a50e80ca56ca9436c3c0607a20a6ff9641151828b0cb413858) |
| Buy PT with USDY | `swap_underlying_for_pt` | 200 | 5711762 | [57f6cafa…14af](https://stellar.expert/explorer/testnet/tx/57f6cafabe85c196f86c880abece3fa30c002664179a0e3dd2e0519fe55014af) |
| Sell PT for USDY | `swap_pt_for_underlying` | 100 PT | 5711764 | [2111ac79…5dc7](https://stellar.expert/explorer/testnet/tx/2111ac796885b00ad836ff7874e1956d019241c312a9210abf1e176aa4c45dc7) |
| Buy YT with USDY (flash) | `flash_mint_yt_from_underlying` | budget 0.5 | 5711765 | [40bff3d3…b0c5](https://stellar.expert/explorer/testnet/tx/40bff3d33deb55cd2e5617188ba077cafa9522eded926afc38e5cec07a7eb0c5) |
| Sell YT for USDY | `swap_yt_for_underlying` | half the YT | 5711767 | [857b877d…3882](https://stellar.expert/explorer/testnet/tx/857b877d5a10aa082de40b7cb65e3283b04af68e2a23897934820d0ff0423882) |
| Add liquidity, USDY only | `add_liquidity_single_underlying` | 200 | 5711769 | [067e6d9f…d546](https://stellar.expert/explorer/testnet/tx/067e6d9fee7cdf5afdcf924e3bd836717faef7905276e5dca7309ac6eba7d546) |
| Add liquidity, Keep YT | `add_liquidity_keep_yt` | 300 | 5711770 | [cdfa378b…17fd](https://stellar.expert/explorer/testnet/tx/cdfa378b45d9cbc6f9ea017418f6205480983acbf55e986b9e83b462530717fd) |
| Withdraw liquidity to USDY | `remove_liquidity_to_underlying` | half the LP | 5711772 | [8c087c2b…0b6a](https://stellar.expert/explorer/testnet/tx/8c087c2b6f13993310931cdb0c48c801d84a296ed5eff4124cbac7b84b3f0b6a) |
| PT transfer to the recipient | PTToken `transfer` | 10 PT | 5711773 | [4a3f0fd4…442d](https://stellar.expert/explorer/testnet/tx/4a3f0fd4f06fb61ebd1c8a60d546383945299d5d5bca8f56aeda9c235829442d) |
| YT transfer to the recipient | YTToken `transfer` | 10 YT | 5711774 | [675bf7b2…1ce4](https://stellar.expert/explorer/testnet/tx/675bf7b21d4d206c52a484b8762530c81e9f65a2858920dfd647c8f7f7b61ce4) |
| The outsider's trustline | `change_trust` (signed by the outsider) | | 5711777 (from Horizon) | [4d327d64…abfc](https://stellar.expert/explorer/testnet/tx/4d327d64573e541862804beb9eff8eb46ad23f143bfaae68d0470e2ab166abfc) |

Each step checks the account's balances before and after against the simulated result, exactly.

**History.** The suite then read the History page's sources for both accounts. The trader's history lists the 11
transactions above, once each, with their kinds (deposit, mint, buy_pt, sell_pt, buy_yt, sell_yt, add_liquidity ×2,
remove_liquidity, transfer ×2); the recipient's lists the two transfers.

### 3.3 Compliance refusal of an account that was not onboarded

The outsider (GB4EYJ…UUF7), on the official market, simulating a 100 USDY deposit. These refusals are simulations, so
they have no transaction hash, and the record holds no ledger number for them. They ran between 15:04:33 and 15:08:51
UTC: the first before the outsider's trustline landed (ledger 5711777, read from Horizon), the second after it.

| State | The app's blockers (verbatim) | The contracts |
|---|---|---|
| Funded by Friendbot, no trustline | "You have no trustline to the underlying asset. Add one before you can hold it." / "The issuer cannot authorize you until you add a trustline." / "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet." | SYWrapper (CA62AC…7F2I) error #9, [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/sy_wrapper/src/lib.rs#L103) |
| Trustline added ([4d327d64…abfc](https://stellar.expert/explorer/testnet/tx/4d327d64573e541862804beb9eff8eb46ad23f143bfaae68d0470e2ab166abfc)), no Get test tokens | "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it." / "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet." | SYWrapper error #9, `NotAuthorizedOnSac` |
| A PT transfer from the trader to the outsider | | PTToken (CCQPYQ…SPA5) error #10, [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/pt_token/src/lib.rs#L73) |

## 4. Suite B: the ephemeral lifecycle

Source: the run record `e2e-artifacts/lifecycle.json` of 13 November 2026, written by
[tests/e2e-testnet/lifecycle.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/lifecycle.test.ts),
run locally with `pnpm test:e2e:testnet tests/e2e-testnet/lifecycle.test.ts`. The record is not committed.

| Item | Value |
|---|---|
| Started, finished | 15:29:54 UTC, 15:51:35 UTC (1,301 s) |
| Result | 10 of 10 tests passed (`complete: true`) |
| Transactions | 14, all successful |
| Keys | four run-unique keys (admin, treasury, issuer, oracle), generated in the run and all removed at the end (`keysNotRemoved: []`) |

### 4.1 The deploy

`scripts/dev-stack/deploy.sh` with `EPHEMERAL=1`, from the contracts at `665bb67`, in 376 s. Manifest written
outside the repository; nothing points the app at this market.

| Item | Value |
|---|---|
| Market id | `testnet-usdy-1794585049` |
| Maturity | `1794585049` = 15:50:49 UTC, 20 minutes after the deploy's ledger time |
| `generatedAt` | 2026-11-13T15:36:11Z |
| Oracle window at deploy | 3,600 s, shortened to 300 s later by the run ([§4.3](#43-transactions)) |
| Wasm hashes | all 12 identical to the official manifest's ([§1.2](#12-contracts)) |

| Contract | Address |
|---|---|
| Router | [CDF6V52RZPBGSB4ELNPSTTHWFGHEZXRLRDBJH54PN7EMFBZ4BVHPZANK](https://stellar.expert/explorer/testnet/contract/CDF6V52RZPBGSB4ELNPSTTHWFGHEZXRLRDBJH54PN7EMFBZ4BVHPZANK) |
| OracleAdapter | [CCPZPGYJWJSXA32WVZ2CZDIBQDZGZB7XMGT4USHWSYATJFZPZD7AINVI](https://stellar.expert/explorer/testnet/contract/CCPZPGYJWJSXA32WVZ2CZDIBQDZGZB7XMGT4USHWSYATJFZPZD7AINVI) |
| Permissioning | [CCUKBHHYT3BENMLSKYTXKEPWNE2DZB4TR2QORCZXVL2GWN2COEONDSHO](https://stellar.expert/explorer/testnet/contract/CCUKBHHYT3BENMLSKYTXKEPWNE2DZB4TR2QORCZXVL2GWN2COEONDSHO) |
| RiskControl | [CCEWKHCDFHTHPUTJQCIE53XYTH33MCZF3YSOAQ4X52AWZHGQBKSKBN2Y](https://stellar.expert/explorer/testnet/contract/CCEWKHCDFHTHPUTJQCIE53XYTH33MCZF3YSOAQ4X52AWZHGQBKSKBN2Y) |
| MarketFactory | [CBIMYD5JPJ223RY6CPWASQEYMX5ZLSZLZXJEB4JBWVCYP5ZA4ANMJW6C](https://stellar.expert/explorer/testnet/contract/CBIMYD5JPJ223RY6CPWASQEYMX5ZLSZLZXJEB4JBWVCYP5ZA4ANMJW6C) |
| SYWrapper | [CD52KRIM34NIRK6F4GFQ2FNP5MDCR54J65TDMSLJG65IHDPQ52WHTATM](https://stellar.expert/explorer/testnet/contract/CD52KRIM34NIRK6F4GFQ2FNP5MDCR54J65TDMSLJG65IHDPQ52WHTATM) |
| PTToken | [CCNDCLGAO2EMQEU6S5RI2HJFQIWSSBXVCQLW6ILGU2SKJAWTIL4XPC2K](https://stellar.expert/explorer/testnet/contract/CCNDCLGAO2EMQEU6S5RI2HJFQIWSSBXVCQLW6ILGU2SKJAWTIL4XPC2K) |
| YTToken | [CCNKN7TTSAT6EZHW7NANJ4LHTV54K4Q5SQEJLK77HGNKFVA3QTNRGXAP](https://stellar.expert/explorer/testnet/contract/CCNKN7TTSAT6EZHW7NANJ4LHTV54K4Q5SQEJLK77HGNKFVA3QTNRGXAP) |
| MarketConfig | [CC7ZZMQ4H3DTP3ZEIIBS75OXCEOG6BFCEOZ3WZX7EOOOJ7HEXDZOTYYV](https://stellar.expert/explorer/testnet/contract/CC7ZZMQ4H3DTP3ZEIIBS75OXCEOG6BFCEOZ3WZX7EOOOJ7HEXDZOTYYV) |
| PrincipalManager | [CCNCWVZ4XUPQ6Q3ZIRHFKYALPU6VT4UGOOZTKM4HEK2EBEV5EGYA3XCI](https://stellar.expert/explorer/testnet/contract/CCNCWVZ4XUPQ6Q3ZIRHFKYALPU6VT4UGOOZTKM4HEK2EBEV5EGYA3XCI) |
| MarketPool | [CC7TBGNHMADSFPTEICG3YNXXL4YUBERMB7BIQQ35BMBXIYK3GFTVDVQ7](https://stellar.expert/explorer/testnet/contract/CC7TBGNHMADSFPTEICG3YNXXL4YUBERMB7BIQQ35BMBXIYK3GFTVDVQ7) |
| RecoveryEscrow | [CBEZSBJCXRNBTNX26SNCQ6OBA2V7I2CZJ5BAQ2LIJ5T5ZDROFKZTA2QQ](https://stellar.expert/explorer/testnet/contract/CBEZSBJCXRNBTNX26SNCQ6OBA2V7I2CZJ5BAQ2LIJ5T5ZDROFKZTA2QQ) |
| USDY SAC (this run's issuer) | [CAC2OZ6PDBU3HGYJBQIQLSPMQWMDBXBF24V2NETJOIXT6X6LHOSAYFTP](https://stellar.expert/explorer/testnet/contract/CAC2OZ6PDBU3HGYJBQIQLSPMQWMDBXBF24V2NETJOIXT6X6LHOSAYFTP) |

Right after the deploy the suite asserted the market's initial state: manifest valid, Router functions listed, the
issuer key issues the asset, the admin key is the SAC admin, the oracle key is the oracle admin, contracts wired as
the manifest says, pool seeded, oracle fresh.

### 4.2 Roles and accounts

| Who | Public address |
|---|---|
| admin (SAC admin, market admin) | [GDINNAGRUUJIM7PPDACRDZXTERF2REJ2B5NDKEMGIRAZALV262VPWJMO](https://stellar.expert/explorer/testnet/account/GDINNAGRUUJIM7PPDACRDZXTERF2REJ2B5NDKEMGIRAZALV262VPWJMO) |
| treasury | [GCGRKGRINRRKE5TDM7DNGHHPGITJS2XRQB5SNKWKTYZQ2VQPYLJIZFYV](https://stellar.expert/explorer/testnet/account/GCGRKGRINRRKE5TDM7DNGHHPGITJS2XRQB5SNKWKTYZQ2VQPYLJIZFYV) |
| issuer (USDY of this run, Permissioning admin) | [GAJMGHQ6OL3IQFTXUB64FKLXBQ6NLMQLEK5RB6NETVR5UCXX7GMN57PJ](https://stellar.expert/explorer/testnet/account/GAJMGHQ6OL3IQFTXUB64FKLXBQ6NLMQLEK5RB6NETVR5UCXX7GMN57PJ) |
| oracle admin | [GCJGITUCGYUHZEELFUQFSZL2AN5WZAMN7LNFOZ4WHIWB4QE3P42TZPMZ](https://stellar.expert/explorer/testnet/account/GCJGITUCGYUHZEELFUQFSZL2AN5WZAMN7LNFOZ4WHIWB4QE3P42TZPMZ) |
| trader | [GAZZJ7AEWBDG5JWWQ7RCJP3SMS3BJTOX5L7J6HWBOL6MV5WDAOBF5MQD](https://stellar.expert/explorer/testnet/account/GAZZJ7AEWBDG5JWWQ7RCJP3SMS3BJTOX5L7J6HWBOL6MV5WDAOBF5MQD) |
| holder | [GDUPXULMY3Z75P5GKLVEEDRZHSCD3L5WQPHM2OWHSBFD6JSRN2SBO3CG](https://stellar.expert/explorer/testnet/account/GDUPXULMY3Z75P5GKLVEEDRZHSCD3L5WQPHM2OWHSBFD6JSRN2SBO3CG) |

The trader and the holder were funded by Friendbot, opened a trustline and were onboarded by the run's own issuer.

### 4.3 Transactions

| Step | Signer | Call | Ledger | Transaction |
|---|---|---|---|---|
| Deposit 500 USDY | trader | `deposit` | 5712120 | [abb4631d…cde3](https://stellar.expert/explorer/testnet/tx/abb4631d7698eb035e69aa1236728329c7e2911456880d1985087a05fac6cde3) |
| Split 300 USDY | trader | `wrap_and_mint` | 5712121 | [e98afd53…e9c6](https://stellar.expert/explorer/testnet/tx/e98afd53532e33e7f15090612505b0077accfb4743fb8e9609cba80e75a4e9c6) |
| Deposit 100 USDY | holder | `deposit` | 5712122 | [cb835a75…b399](https://stellar.expert/explorer/testnet/tx/cb835a758d1e89479fc6ae95b1018425e0d6155a7be953218e56ff2a979ab399) |
| Split 300 USDY | holder | `wrap_and_mint` | 5712123 | [a085a5e1…34ee](https://stellar.expert/explorer/testnet/tx/a085a5e1a0cff0c1b116d0a1e23d5ad7021510e4549d08c5c346d82a635134ee) |
| Buy PT, 200 USDY | trader | `swap_underlying_for_pt` | 5712125 | [b4f7d326…ff15](https://stellar.expert/explorer/testnet/tx/b4f7d3262ca3b07c8572754f278651455aa85cf5126d6aa235123625b743ff15) |
| Add liquidity, 200 USDY | trader | `add_liquidity_single_underlying` | 5712127 | [d886aee4…4205](https://stellar.expert/explorer/testnet/tx/d886aee4ed51adac84b5ea9242530d4411cdf7d19584c37d6356fe7873f34205) |
| Oracle tick to 1.05 | oracle | OracleAdapter `set_reference_value` | 5712128 | [c97cf151…6a11](https://stellar.expert/explorer/testnet/tx/c97cf1515bca16ed0da4953073b2465227adf92b55b90b193b9369d8fd166a11) |
| Claim yield | trader | `claim_yield` | 5712131 | [04c2e257…775f](https://stellar.expert/explorer/testnet/tx/04c2e2575ad918eaefd12e9fd3b685516983e487f778964dfb4b53274b78775f) |
| Deauthorize the trader | admin | USDY SAC `set_authorized(false)` | 5712132 | [6bafb0bc…8401](https://stellar.expert/explorer/testnet/tx/6bafb0bc989d38cae83ee3205405e200b3bbad07bb536696a276f7ec5fef8401) |
| Seize all positions | admin | RecoveryEscrow `seize_all_positions` | 5712133 | [3633c94d…32c7](https://stellar.expert/explorer/testnet/tx/3633c94da5f7892bf4985e1aaca0114b67cd883ab7bb7f2f04cc154efec432c7) |
| Shorten the oracle window to 300 s | oracle | OracleAdapter `set_safety_params` | 5712134 | [21395887…fe7f](https://stellar.expert/explorer/testnet/tx/2139588767be03c3dc5ace03419d05b53e3baa8591cb8cafff33837eac9bfe7f) |
| Oracle tick after maturity | oracle | OracleAdapter `set_reference_value` | 5712287 | [c5e49a0d…9460](https://stellar.expert/explorer/testnet/tx/c5e49a0daa8ad8ac91e760b5ab57cadb6c4c9ff7b83ce519fa397736cb499460) |
| Redeem at maturity | holder | `redeem_at_maturity` | 5712289 | [96da70dc…4344](https://stellar.expert/explorer/testnet/tx/96da70dc096292522538912b7a8f15a4316922b43df426c52ee43052c6d44344) |
| Finalize the recovery record | admin | RecoveryEscrow `finalize_record` | 5712290 | [090d80a0…af35](https://stellar.expert/explorer/testnet/tx/090d80a03a69b2e885d01833a27b6010fba82602bab2ece3bf54350d9860af35) |

### 4.4 Yield claim

The oracle moved from 1.0000000 to 1.0500000. The trader's pending yield, computed before the claim, was
12.8507142 USDY; the claim paid exactly 12.8507142 USDY.

### 4.5 Compliance recovery

The sequence of the contracts' recovery design: the issuer authority (the SAC admin, here the run's market admin
key) deauthorizes the account on the SAC, the escrow seizes every position, and after maturity the record is settled
into the underlying.

1. **Deauthorize** the trader (GAZZJ7…5MQD) on the USDY SAC, ledger 5712132. The app's gate logic then returns, for that
   account, "Blocked by the issuer: your trustline exists but is not authorized. …". Its own USDY balance (98,812.8507142)
   stays on its trustline, now deauthorized (Horizon, 13 November 2026: `balance` 98812.8507142, `is_authorized`
   false).
2. **Seize** with `seize_all_positions([trader])`, ledger 5712133 (15:38:29 UTC). Record `0`, read back with
   `get_record`:

   | Field | Value |
   |---|---|
   | `sy_shares`, `underlying_from_sy` | 500.0004065, 500.0004065 USDY |
   | `lp_amount` → `lp_pt`, `lp_sy_shares`, `underlying_from_lp` | 99.9669314 LP → 102.2537491 PT, 97.7458704 SY, 97.7458704 USDY |
   | `pt_amount`, `yt_amount` | 499.8500558 PT, 299.8500000 YT |
   | `finalized` | `false` |

   Escrow holdings: before, all zero; after, 597.7462769 USDY, 602.1038049 PT, 299.8500000 YT.
3. **Finalize** with `finalize_record(0)` after maturity, ledger 5712290. The record reads back `finalized: true`,
   `underlying_from_pt` 573.4315397 USDY and `underlying_from_yt` 0.0002936 USDY. Escrow holdings: 1,171.1781102 USDY,
   0 PT, 0 YT.

### 4.6 Refusals at maturity

Simulations, so no transaction hash; the ledger is the one the suite read the state from.

| Refusal | Account | Ledger (time) | The app's blockers (verbatim) | The contracts |
|---|---|---|---|---|
| The first `redeem_at_maturity` (which settles the market) with a stale oracle: its value was stamped 15:37:59 UTC, so 790 s old against a 300 s window, 20 s past maturity | holder | 5712285 (15:51:09 UTC) | "The oracle price is stale: it has not been updated in the last 5 minutes. The first redemption settles the market at the current oracle price, so that price must be fresh. Wait for the next oracle update, then try again." / "The simulation was refused with contract error #7, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again." | PrincipalManager (CCNCWV…3XCI) error #7, [`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/principal_manager/src/lib.rs#L199) |
| Buy PT after maturity, with the oracle fresh again | holder | 5712287 (15:51:19 UTC) | "Trading closed at maturity: this market has matured, so PT and YT can no longer be bought or sold in the pool. You can still redeem, claim yield, remove liquidity and withdraw SY." / "The simulation was refused with contract error #6, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again." | MarketPool (CC7TBG…DVQ7) error #6, [`Expired`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/market_pool/src/lib.rs#L162) |

### 4.7 Redemption at maturity

The holder redeemed all its 299.8500000 PT and 299.8500000 YT in one call, ledger 5712289: 285.5711022 USDY from PT
and 12.8510079 USDY from YT. The call settled the market at the rate 1.0500012. Balances checked exactly.

## 5. Gate refusals

Every gate the plan names, with where it was shown.

| Gate | Where | Evidence |
|---|---|---|
| Compliance: an account that was not onboarded | Suite A, official market | [§3.3](#33-compliance-refusal-of-an-account-that-was-not-onboarded): the app's blockers, SY #9 and PT #10 |
| Stale oracle | Suite B, its market, ledger 5712285 | [§4.6](#46-refusals-at-maturity): the app's blocker, PrincipalManager #7 |
| Post-maturity trade | Suite B, its market, ledger 5712287 | [§4.6](#46-refusals-at-maturity): the app's blocker, MarketPool #6 |
| Wrong network | the app's unit tests (`pnpm test`) | below |

Wrong network, the unit tests:
- [lib/protocol/\_\_tests\_\_/gates.test.ts, rule "a wrong network blocks every write"](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/gates.test.ts#L264-L271):
  every action is blocked with "Your wallet is on a different network from this market. Switch it to the network …";
  also [the wallet states table](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/gates.test.ts#L889-L907)
  (`wrong_network` and `unverified_network` block every action).
- lib/protocol/\_\_tests\_\_/wallet.test.ts, [restore](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/wallet.test.ts#L133-L157)
  and [connect](https://github.com/principal-Protocol-org/dapp/blob/testnet/lib/protocol/__tests__/wallet.test.ts#L184-L194):
  restore and connect report `wrong_network` when the wallet's passphrase differs from the manifest, and
  `unverified_network` when it cannot be read.
- [components/app/\_\_tests\_\_/shell.test.tsx](https://github.com/principal-Protocol-org/dapp/blob/testnet/components/app/__tests__/shell.test.tsx#L131-L141):
  the wallet button shows "Wrong network" and names Testnet.
- [components/app/\_\_tests\_\_/action-panel.test.tsx](https://github.com/principal-Protocol-org/dapp/blob/testnet/components/app/__tests__/action-panel.test.tsx#L558-L566):
  an open review is discarded when the wallet changes network.

## 6. Walkthrough

### 6.1 The page

| Item | Value |
|---|---|
| Published at | <https://principalmarket.fi/docs/using-the-app/testnet-walkthrough> |
| Source | [using-the-app/testnet-walkthrough.md](https://github.com/principal-Protocol-org/docs/blob/main/using-the-app/testnet-walkthrough.md) in the docs repository |
| Screenshots | 22 PNG files in [public/images/walkthrough/](https://github.com/principal-Protocol-org/docs/tree/main/public/images/walkthrough), taken on 13 November 2026 |
| How they were taken | [tests/e2e-testnet/walkthrough-shots.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/walkthrough-shots.ts) (`pnpm walkthrough:shots`): Playwright drives the app in Chromium, and a test-only wallet injected into the page answers the app's wallet requests and signs with a throwaway Testnet keypair. Nothing is added to the app. |

### 6.2 Browser runs on the official market

Both runs used a fresh throwaway account, onboarded through the live faucet, and the official contracts. Run A‴ used
the live site. Run B″ used a local production build of branch `testnet` at `821bfd2`, pointed at Testnet, because the
site deployed that day (an earlier build, without commit `df52bc7`) failed Sell YT and the liquidity withdrawal with
"Cause: its refundable fee is too low; prepare it again." (on chain: `insufficient_refundable_fee`). The transactions
are from Horizon (`/accounts/<address>/operations`); only successful ones are listed.

Run B″, account [GCXVCVMAHEH64JEVQ66XOIJ3ALACXSHFGDSOCZMNSRDLSHLUJMPQISMI](https://stellar.expert/explorer/testnet/account/GCXVCVMAHEH64JEVQ66XOIJ3ALACXSHFGDSOCZMNSRDLSHLUJMPQISMI),
every step of the page:

| Time (UTC) | Step | Function | Transaction |
|---|---|---|---|
| 17:04:14 | Get test tokens: trustline | `change_trust` | [03dd13ec…5d22](https://stellar.expert/explorer/testnet/tx/03dd13ec96c39fe9e22f298ef7dcd703869d2bf2caf51c8bc04a874654bb5d22) |
| 17:05:49 | 4. Deposit | `deposit` | [936b66f6…f7f0](https://stellar.expert/explorer/testnet/tx/936b66f6981ca28000c66cd235ae98e364cafdf715b6030ac7c76e2cff20f7f0) |
| 17:05:59 | 5. Mint PT + YT | `wrap_and_mint` | [6621e768…d849](https://stellar.expert/explorer/testnet/tx/6621e7688d3b7dfe705ea56df5a76e6b531dee76f1292fbce50b621425b0d849) |
| 17:06:09 | 6. Buy PT | `swap_underlying_for_pt` | [12701480…fe91](https://stellar.expert/explorer/testnet/tx/12701480744016eceb3dde633c9e9a9cb40942cbe5d987ee944fd5e613abfe91) |
| 17:06:19 | 6. Sell PT | `swap_pt_for_underlying` | [60cf0482…c405](https://stellar.expert/explorer/testnet/tx/60cf048248856ff14bd842782c0c8488ede14e9210fb7e8a13c4d60ae447c405) |
| 17:06:29 | 7. Buy YT | `flash_mint_yt_from_underlying` | [9843786d…59b1](https://stellar.expert/explorer/testnet/tx/9843786d3a333666b3003304a059258bd9cc96cbf236a3d37b82a8c9063f59b1) |
| 17:06:39 | 7. Sell YT | `swap_yt_for_underlying` | [aeb3791f…103e](https://stellar.expert/explorer/testnet/tx/aeb3791fa530fe976ddca139e943a6b70b121d3f6032f1516dc1ddee1960103e) |
| 17:06:49 | 8. Add liquidity (Keep YT) | `add_liquidity_keep_yt` | [b215a8ac…2215](https://stellar.expert/explorer/testnet/tx/b215a8ac0cb9a8c0e7f48daaa696bf72971946f760d0752d252a12a4a1f72215) |
| 17:06:59 | 8. Withdraw liquidity | `remove_liquidity_to_underlying` | [6eb80dd2…a8a0](https://stellar.expert/explorer/testnet/tx/6eb80dd2a3056cf6f57be718516ca19eebcb43c91da6320653221795b7bea8a0) |
| 17:32:24 | 9. Claim yield | `claim_yield` | [8b7940ac…1781](https://stellar.expert/explorer/testnet/tx/8b7940acb75dba98fae63bdc7936f17d2faf26878d2f7dc96ffb546424bd1781) |

Run A‴, live site, account [GAYMYK6UWUII5SEL7BNS7HETB4U7DP4GBSDF7HXQ7SMK5YGQHU53IIKN](https://stellar.expert/explorer/testnet/account/GAYMYK6UWUII5SEL7BNS7HETB4U7DP4GBSDF7HXQ7SMK5YGQHU53IIKN):

| Time (UTC) | Step | Function | Transaction |
|---|---|---|---|
| 17:33:29 | Get test tokens: trustline | `change_trust` | [cb244b89…09aa](https://stellar.expert/explorer/testnet/tx/cb244b89e7de7256e6ee1bdd1eb9f173c1e878df8c93f0cfff4efa0ed62709aa) |
| 17:34:04 | 4. Deposit | `deposit` | [2d70827e…c51d](https://stellar.expert/explorer/testnet/tx/2d70827ed3c7196f7e20f9f5dcd5e06f3cafd351ac1629983bebe94c321ac51d) |
| 17:34:14 | 5. Mint PT + YT | `wrap_and_mint` | [b3f0b217…b8ee](https://stellar.expert/explorer/testnet/tx/b3f0b217cdda721afa65e31fe090f3cc584f75ce16db92618ca9f995ce26b8ee) |
| 17:34:24 | 6. Buy PT | `swap_underlying_for_pt` | [5f85d0df…6b84](https://stellar.expert/explorer/testnet/tx/5f85d0df4a94ce8ad688258023b5fd2fdfa0f0be17ce0f7bad9dc2b424c46b84) |
| 17:34:34 | 6. Sell PT | `swap_pt_for_underlying` | [4cdb7f31…bdf4](https://stellar.expert/explorer/testnet/tx/4cdb7f3124374738d7df5b0f4e72925a21a29b2520268888dfcb8f852c23bdf4) |
| 17:34:44 | 7. Buy YT | `flash_mint_yt_from_underlying` | [ede4274e…62fb](https://stellar.expert/explorer/testnet/tx/ede4274e7ba6cb48882280a4e0cdcb440ebed16f2a5bc8f92f3025a94d3c62fb) |
| 17:35:04 | 8. Add liquidity (Keep YT) | `add_liquidity_keep_yt` | [a1197cc7…5c33](https://stellar.expert/explorer/testnet/tx/a1197cc7ef526d7a73beee5a96d42eef4a8953e0069b9a649e59117e93f65c33) |
| 18:00:39 | 9. Claim yield | `claim_yield` | [1bdcc4a5…3a46](https://stellar.expert/explorer/testnet/tx/1bdcc4a59b71b5ac23473dba694e2a3ad568f941bb02dd40a3b2623227f03a46) |

In run A‴, Sell YT and the liquidity withdrawal failed on the live site with the fee error above, so they are not in
the table. Branch `testnet` carries the fix, `df52bc7`, which declares headroom on the simulated resource fee.

### 6.3 Screenshots and their source

"Live" is the site <https://testnet.principalmarket.fi> (run A‴); "local" is the production build of branch `testnet`
at `821bfd2` (run B″). Both used the official contracts on Testnet.

| File | Source |
|---|---|
| `02-address-menu.png` | live (run A‴) |
| `02-connect-wallet.png` | live (run A‴) |
| `03-account-ready.png` | live (run A‴) |
| `03-get-test-tokens.png` | live (run A‴) |
| `04-deposit-done.png` | live (run A‴) |
| `04-deposit-review.png` | live (run A‴) |
| `05-split-review.png` | live (run A‴) |
| `05-split.png` | live (run A‴) |
| `06-buy-pt-review.png` | live (run A‴) |
| `06-buy-pt.png` | live (run A‴) |
| `06-sell-pt.png` | live (run A‴) |
| `07-buy-yt-review.png` | live (run A‴) |
| `07-buy-yt.png` | live (run A‴) |
| `07-sell-yt.png` | local `821bfd2` (run B″) |
| `08-add-liquidity-review.png` | live (run A‴) |
| `08-add-liquidity.png` | live (run A‴) |
| `08-withdraw-liquidity.png` | local `821bfd2` (run B″) |
| `09-claim-yield-review.png` | live (run A‴) |
| `09-claim-yield.png` | live (run A‴) |
| `10-history.png` | local `821bfd2` (run B″) |
| `10-portfolio.png` | local `821bfd2` (run B″) |
| `11-held-to-maturity.png` | local `821bfd2` (run B″) |

The two runs used different accounts, so balances differ a little between neighboring images.

### 6.4 Screens not captured

Described in the page's text instead:
1. Step 1: installing Varial, creating or importing an account and switching it to Testnet (the extension's own
   screens).
2. Varial's own pop-ups: the connection approval (step 2), the trustline signature (step 3) and each transaction
   approval (steps 4 to 9).
3. The trade panels' "after" state: "Route complete: 1 of 1 steps confirmed" and the "…: all steps confirmed." notice.
4. Step 11 after maturity (11 February 2027 08:59:04 UTC): the **Redeem at maturity** shortcut, the redeem form, its
   review and its result. To be captured after maturity.
5. LP only (Keep YT off): mentioned in the text with 200 USDY, not shown.

## 7. Oracle safety in the contracts repository

The OracleAdapter extension is contract code at `665bb67`. Its live evidence was produced by the contracts team on a
separate oracle instance, before the official deployment, and on an earlier build: OracleAdapter wasm `c21408bd…`
(PrincipalManager `fd68e764…`), where the official deployment runs `adb87f76…` (PrincipalManager `adcc724a…`). It
shows the mechanism; the proof for the deployed code is the unit tests at `665bb67` below and, for the staleness guard,
Suite B (§4.6):
[docs/ORACLE_SAFETY_EXTENSION.md §4](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/docs/ORACLE_SAFETY_EXTENSION.md#4-live-testnet-evidence).

| What it shows | Transaction |
|---|---|
| A 20% jump against the 10% cap: `set_reference_value` returns `false`, the price stays at 1.0, `last_rejection()` reads reason `deviate` | [25b0710e…1a6a](https://stellar.expert/explorer/testnet/tx/25b0710eb5cd11054653cbc81b3358b8c98f0f89735c71304be1d5e4fe9d1a6a) |
| A 5% move inside the cap is accepted | [f9a64ce5…cf1e](https://stellar.expert/explorer/testnet/tx/f9a64ce5611a5f42534065a72a1627cd1006f094aaa095305c0196f21ba1cf1e) |
| A mint with the oracle fresh succeeds | [cc75cf56…b986](https://stellar.expert/explorer/testnet/tx/cc75cf56795157ee26e0a27b5bf43f3484a393febac3147194b9ef7dd889b986) |
| `set_safety_params` narrows the window to 2 s; the next mint then reverts `OracleStale` (a simulation, so it has no transaction) | [cfd49f60…6a29](https://stellar.expert/explorer/testnet/tx/cfd49f60705948d9a35fce34f4f4f2a6ac3957968bf715f35c4829bb2b926a29) |
| Fresh again, the mint succeeds | [427bf580…b597](https://stellar.expert/explorer/testnet/tx/427bf5800fb11cd3b7c27fb4b9c8cc145e817123543896714845ffa4b25ab597) |

Unit tests at `665bb67`, in [contracts/oracle_adapter/src/test.rs](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/oracle_adapter/src/test.rs):
- deviation guard ([lines 260 to 314](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/oracle_adapter/src/test.rs#L260-L314)): `deviation_within_bound_is_accepted`,
  `deviation_over_bound_is_rejected_gracefully`, `deviation_guard_does_not_apply_to_the_first_ever_value`,
  `deviation_overflow_is_rejected_gracefully_not_panicked`;
- fallback: `fallback_may_refresh_timestamp_only`, `fallback_cannot_move_the_value_even_within_the_deviation_bound`,
  `fallback_never_hides_a_stale_timestamp`;
- availability: `is_available_follows_the_contract_s_own_configured_staleness`,
  `assert_available_panics_oracle_unavailable_when_stale`, `assert_available_is_silent_when_fresh`.

The contracts repository's [CI](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/.github/workflows/ci.yml) runs them with `cargo test --workspace --locked`. The contracts team's own Testnet deployments, including a recovery and a settlement, are in
[docs/TESTNET_DEPLOYMENT_EVIDENCE_2026_11_05.md](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/docs/TESTNET_DEPLOYMENT_EVIDENCE_2026_11_05.md).

## 8. Open items

| Item | Owner | Reason |
|---|---|---|
| First green CI run of "E2E Testnet" on GitHub ([§2](#2-ci)) | app team | The workflow had not run on GitHub when this file was written; the first run is the pull request that publishes it. |
| Deploy pipeline details of Deliverable 1: a single `.env` file, deployment transaction IDs in the manifest, a standalone post-deploy verification script, idempotent re-deploy | app team | Not built; the review's §1.6 maps each one. |
| RiskControl limits on the official market | app team | Deployed with the circuit breaker off (`get_cb_limit` 0). |
| The deviation guard on the official oracle | none needed | It has not fired: no update was rejected (`last_rejection` is `null`). Its live proof is in the contracts repository ([§7](#7-oracle-safety-in-the-contracts-repository)). |
| Redeem in the browser, and its screenshots | app team | Possible only after 11 February 2027 08:59:04 UTC. |
| Nested transfers whose amounts come from the pool's reserves can fail with `Error(Auth, InvalidAction)` when another trade moves the pool between simulation and inclusion | contracts team | A known contract-level limit; only the network fee is lost, and a retry works. |
