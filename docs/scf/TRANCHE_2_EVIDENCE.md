# Tranche 2 (Testnet): evidence

The facts behind [TRANCHE_2_REVIEW.md](TRANCHE_2_REVIEW.md): deployed addresses, wasm hashes, transaction hashes, CI
runs, screenshots and dates. Each section says where its data comes from. Written on 13 November 2026 and updated the
same evening with the first green CI run and the live walkthrough run; all times are UTC.

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
with Rust 1.95.0 (`cargo build --workspace --release --target wasm32v1-none`) on the developer's machine also gives
the same 12 hashes. A build on another machine does not: see [§2.1](#21-the-linux-wasm-comparison).

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
| Triggers | every pull request to `testnet`; nightly at 03:17 UTC; `workflow_dispatch`. `main`, the production landing site, holds no app code: it carries only a copy of this workflow file ([pull request #2](https://github.com/principal-Protocol-org/dapp/pull/2), `main` at `f6bf73c`), so pull requests to `main` do not run the suites. The nightly run and a manual run started from `main` check out and test branch `testnet`. |
| Secrets | none: no repository secret is used and no key is set in the environment |
| Run records | artifacts `e2e-journey-<attempt>` and `e2e-lifecycle-<attempt>`, kept 30 days |
| All runs | <https://github.com/principal-Protocol-org/dapp/actions/workflows/e2e-testnet.yml> |
| First green CI run (pull request) | [E2E Testnet run 43503140770](https://github.com/principal-Protocol-org/dapp/actions/runs/43503140770) on [pull request #1](https://github.com/principal-Protocol-org/dapp/pull/1), commit `a965753`, `ubuntu-24.04`, 13 November 2026 20:36:58 to 20:59:05 UTC. Suite A: 13 of 13 tests in 168 s, 12 transactions. Suite B: 10 of 10 tests in 1,294 s, 14 transactions, its four run keys removed. Details in [§3](#3-suite-a-the-live-journey-on-the-official-market) and [§4](#4-suite-b-the-ephemeral-lifecycle). |
| The regular CI on the same pull request | [CI run 43503140838](https://github.com/principal-Protocol-org/dapp/actions/runs/43503140838): lint, typecheck, unit tests, build and the server-secret bundle check, green |
| Merge | pull request #1 was fast-forwarded into `testnet` at `a965753` on 13 November 2026 at 21:01:03 UTC (no merge commit) |
| First manual run from `main` | [E2E Testnet run 43511581261](https://github.com/principal-Protocol-org/dapp/actions/runs/43511581261), started at 21:32:23 UTC from `main` (`f6bf73c`), testing `testnet`: running |

### 2.1 The Linux wasm comparison

The workflow's informational step "Compare the wasm with the official deployment's" builds the contracts at `665bb67` with Rust 1.95.0 on the runner and compares each file's SHA-256 with the manifest's `wasmHashes`. In run 43503140770, **0 of 12** were byte-identical.

The bytes depend on the machine that builds them. In the developer's build, ten of the twelve wasm files embed the builder's home directory, through the absolute path of the cargo registry (three times in `principal_recovery_escrow.wasm`); a build on the runner carries the runner's home directory instead. Permissioning and RiskControl carry no such path in the developer's build; why their Linux bytes differ too was not established. So the same source and the same Rust 1.95.0 do not give the same bytes on another machine.

The official hashes still reproduce 12 of 12 on the developer's machine, and the code on chain matches them 12 of 12 ([§1.2](#12-contracts)). Suite B's CI run deployed its throwaway market from the runner's build, so its wasm hashes differ from the official ones; its local run deployed byte-identical wasm ([§4.1](#41-the-deploy)).

## 3. Suite A: the live journey on the official market

Two runs of [tests/e2e-testnet/journey.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/journey.test.ts), both on the official market `testnet-usdy-1802336344` (contracts at `665bb67`), each with its own fresh accounts. Every hash below is on the public ledger, and each table says which run it comes from.

| Run | Record | Started, finished | Result | Transactions |
|---|---|---|---|---|
| CI: [run 43503140770](https://github.com/principal-Protocol-org/dapp/actions/runs/43503140770), job "Suite A: live journey" | artifact `e2e-journey-1` (kept until 13 December 2026) | 20:37:13 UTC, 20:40:01 UTC (168 s) | 13 of 13 tests passed | 12, all successful |
| Local: `pnpm test:e2e:testnet tests/e2e-testnet/journey.test.ts` | `e2e-artifacts/journey.json`, not committed | 15:04:33 UTC, 15:08:51 UTC (258 s) | 13 of 13 tests passed | 12, all successful |

### 3.1 Accounts and onboarding

Three fresh keypairs per run. Each was funded by Friendbot and opened a USDY trustline; the trader and the recipient were then onboarded by the public faucet (`POST https://testnet.principalmarket.fi/api/faucet`), which performed `authorize`, `grant_account`, `grant_pt`, `grant_yt` and `pay`. The outsider was never onboarded, on purpose ([§3.3](#33-compliance-refusal-of-an-account-that-was-not-onboarded)).

| Account | CI run: address, trustline | Local run: address, trustline |
|---|---|---|
| trader | [GC2DXS…RWHP](https://stellar.expert/explorer/testnet/account/GC2DXSYZUBCRT6CJDWMNUMEISJR6KNNHQ7RPYV33CDVHNIDM6FSPRWHP), [6952f412…774e](https://stellar.expert/explorer/testnet/tx/6952f412335a497a3802bdb5acaa5665213554e4a127a2fc912cae82dc61774e) | [GAFAES…2N54](https://stellar.expert/explorer/testnet/account/GAFAESJGN22CQAWGZCQZYVMBJT5EUYCFQAAT37RY6NTFIHEPFKFC2N54), [8e6c07f7…8511](https://stellar.expert/explorer/testnet/tx/8e6c07f73b251eb9d578c082280ca8473cba6b830bdaa1b6c5b17121ead88511) |
| recipient | [GDFQKT…GMZL](https://stellar.expert/explorer/testnet/account/GDFQKT4AC33AREP6XLKEJANO2BEQOT2B4UQOUOIICWOGQB2A6DEPGMZL), [e4632436…1773](https://stellar.expert/explorer/testnet/tx/e4632436744f4f4554ccf4567ba493000be8d0ab64dfd6e8e361e4cac7b51773) | [GB6MAE…AXA6](https://stellar.expert/explorer/testnet/account/GB6MAEDJYAO2CWPPOZ6HGIIVSMZQ7QOJEV7AOXF4W4ZGA2GXPKNWAXA6), [17cbd415…c40d](https://stellar.expert/explorer/testnet/tx/17cbd41573512ea823b03e99fbd7f9e44b7984d27ea65f0767304d6d3420c40d) |
| outsider | [GCHGFR…7QOB](https://stellar.expert/explorer/testnet/account/GCHGFRVDSVVQOXAUQQOVANTSYXPC2MZQZWHVXPBPVOHBQOQXFKTK7QOB), [5811bdca…c393](https://stellar.expert/explorer/testnet/tx/5811bdca5b3efab4531a7ee9c7286e3d7ce7dde9f2c8ea92a74e38b06c38c393) | [GB4EYJ…UUF7](https://stellar.expert/explorer/testnet/account/GB4EYJG7HFIUJG57AJBWIMW5NOYV52T2DVAYG2HIKTLBNYUG2PB5UUF7), [4d327d64…abfc](https://stellar.expert/explorer/testnet/tx/4d327d64573e541862804beb9eff8eb46ad23f143bfaae68d0470e2ab166abfc) |

In the CI run every faucet call succeeded at the first attempt. In the local run, the recipient's first answer was `rate_limited` (retry after 60 s), then the same five steps. After the faucet, the trader and the recipient each held 100,000 USDY and nothing else, in both runs.

### 3.2 Transactions

Signed by the trader, except the last row, which the outsider signed. Amounts in USDY unless stated.

| Step | Contract function | Amount | CI run: ledger, transaction | Local run: ledger, transaction |
|---|---|---|---|---|
| Deposit USDY → SY | `deposit` | 500 | 5715738, [9c8ec7c2…c161](https://stellar.expert/explorer/testnet/tx/9c8ec7c23359eb553eabe57bf495e4b09fdd526ac05eba2c9abc1a150150c161) | 5711759, [e18a15ba…4615](https://stellar.expert/explorer/testnet/tx/e18a15ba84e81d05c663a0d9af09a41a8c70a333372e863f1531713cf8b14615) |
| Split USDY → PT + YT | `wrap_and_mint` | 300 | 5715739, [361a1f3f…fdb4](https://stellar.expert/explorer/testnet/tx/361a1f3fe0750b02593b8210e9e134b0226dab2118af2609dff0fe580f0dfdb4) | 5711760, [3739b751…3858](https://stellar.expert/explorer/testnet/tx/3739b75147f477a50e80ca56ca9436c3c0607a20a6ff9641151828b0cb413858) |
| Buy PT with USDY | `swap_underlying_for_pt` | 200 | 5715740, [a03ef640…2ee1](https://stellar.expert/explorer/testnet/tx/a03ef6409d69baf3c8663ec9233bc83869173c9b25e7f3a0b80130797d802ee1) | 5711762, [57f6cafa…14af](https://stellar.expert/explorer/testnet/tx/57f6cafabe85c196f86c880abece3fa30c002664179a0e3dd2e0519fe55014af) |
| Sell PT for USDY | `swap_pt_for_underlying` | 100 PT | 5715741, [eb98b501…5ab5](https://stellar.expert/explorer/testnet/tx/eb98b5011dbba7189362103b295b6399a56ec8ecf7a541ce59729f90f1a15ab5) | 5711764, [2111ac79…5dc7](https://stellar.expert/explorer/testnet/tx/2111ac796885b00ad836ff7874e1956d019241c312a9210abf1e176aa4c45dc7) |
| Buy YT with USDY (flash) | `flash_mint_yt_from_underlying` | budget 0.5 | 5715742, [d774fe37…bfd5](https://stellar.expert/explorer/testnet/tx/d774fe374706a5f8ce8d12cba5143fd7f5f0e236ddcf47ad1dc9b30b638cbfd5) | 5711765, [40bff3d3…b0c5](https://stellar.expert/explorer/testnet/tx/40bff3d33deb55cd2e5617188ba077cafa9522eded926afc38e5cec07a7eb0c5) |
| Sell YT for USDY | `swap_yt_for_underlying` | half the YT | 5715743, [c01a1e98…9137](https://stellar.expert/explorer/testnet/tx/c01a1e985aa99fd797ecdedc001f62d8934a9e61cb5a725b88c7ca27624d9137) | 5711767, [857b877d…3882](https://stellar.expert/explorer/testnet/tx/857b877d5a10aa082de40b7cb65e3283b04af68e2a23897934820d0ff0423882) |
| Add liquidity, USDY only | `add_liquidity_single_underlying` | 200 | 5715744, [9513256c…58fa](https://stellar.expert/explorer/testnet/tx/9513256c6982a0222dc89034271da34e0a91a1cc58b89994ffd5fb72c50458fa) | 5711769, [067e6d9f…d546](https://stellar.expert/explorer/testnet/tx/067e6d9fee7cdf5afdcf924e3bd836717faef7905276e5dca7309ac6eba7d546) |
| Add liquidity, Keep YT | `add_liquidity_keep_yt` | 300 | 5715745, [4c2b3e17…0cef](https://stellar.expert/explorer/testnet/tx/4c2b3e174ee23574aedd07f9c7a3bf5bbe59faaba97b3303fa6e185ebbae0cef) | 5711770, [cdfa378b…17fd](https://stellar.expert/explorer/testnet/tx/cdfa378b45d9cbc6f9ea017418f6205480983acbf55e986b9e83b462530717fd) |
| Withdraw liquidity to USDY | `remove_liquidity_to_underlying` | half the LP | 5715746, [ce40c25c…e9c7](https://stellar.expert/explorer/testnet/tx/ce40c25c43fb0fa689efed01fa534fe6214bd260d38c7c9ae06acf16cc20e9c7) | 5711772, [8c087c2b…0b6a](https://stellar.expert/explorer/testnet/tx/8c087c2b6f13993310931cdb0c48c801d84a296ed5eff4124cbac7b84b3f0b6a) |
| PT transfer to the recipient | PTToken `transfer` | 10 PT | 5715747, [d09f9083…193a](https://stellar.expert/explorer/testnet/tx/d09f908344302da81c9e555ae60b55e989d097dd293688dd613a25a7a109193a) | 5711773, [4a3f0fd4…442d](https://stellar.expert/explorer/testnet/tx/4a3f0fd4f06fb61ebd1c8a60d546383945299d5d5bca8f56aeda9c235829442d) |
| YT transfer to the recipient | YTToken `transfer` | 10 YT | 5715748, [ba047313…6d82](https://stellar.expert/explorer/testnet/tx/ba0473134e14f0b08928098002245228b3d111c2c263e7064ebcc5a51cb16d82) | 5711774, [675bf7b2…1ce4](https://stellar.expert/explorer/testnet/tx/675bf7b21d4d206c52a484b8762530c81e9f65a2858920dfd647c8f7f7b61ce4) |
| The outsider's trustline | `change_trust` |  | 5715751 (Horizon), [5811bdca…c393](https://stellar.expert/explorer/testnet/tx/5811bdca5b3efab4531a7ee9c7286e3d7ce7dde9f2c8ea92a74e38b06c38c393) | 5711777 (Horizon), [4d327d64…abfc](https://stellar.expert/explorer/testnet/tx/4d327d64573e541862804beb9eff8eb46ad23f143bfaae68d0470e2ab166abfc) |

Each step checks the account's balances before and after against the simulated result, exactly.

**History.** In both runs the suite then read the History page's sources for both accounts. The trader's history lists the 11 transactions above, once each, with their kinds (deposit, mint, buy_pt, sell_pt, buy_yt, sell_yt, add_liquidity ×2, remove_liquidity, transfer ×2); the recipient's lists the two transfers.

### 3.3 Compliance refusal of an account that was not onboarded

The outsider, on the official market, simulating a 100 USDY deposit. These refusals are simulations, so they have no transaction hash, and the records hold no ledger number for them: the first ran before the outsider's trustline landed, the second after it (trustline ledgers, from Horizon: 5715751 in the CI run, 5711777 in the local run). Both runs recorded the same blockers and the same contract errors.

| State | The app's blockers (verbatim) | The contracts |
|---|---|---|
| Funded by Friendbot, no trustline | "You have no trustline to the underlying asset. Add one before you can hold it." / "The issuer cannot authorize you until you add a trustline." / "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet." | SYWrapper (CA62AC…7F2I) error #9, [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/sy_wrapper/src/lib.rs#L103) |
| Trustline added, no Get test tokens | "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it." / "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet." | SYWrapper error #9, `NotAuthorizedOnSac` |
| A PT transfer from the trader to the outsider | | PTToken (CCQPYQ…SPA5) error #10, [`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/pt_token/src/lib.rs#L73) |

## 4. Suite B: the ephemeral lifecycle

Two runs of [tests/e2e-testnet/lifecycle.test.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/lifecycle.test.ts). Each deployed its own throwaway market with `scripts/dev-stack/deploy.sh` (`EPHEMERAL=1`) from the contracts at `665bb67`, with four run-unique keys (admin, treasury, issuer, oracle) generated in the run and removed at the end. The manifest is written outside the repository; nothing points the app at these markets.

| Run | Record | Started, finished | Result | Transactions | Keys |
|---|---|---|---|---|---|
| CI: [run 43503140770](https://github.com/principal-Protocol-org/dapp/actions/runs/43503140770), job "Suite B: ephemeral lifecycle" | artifact `e2e-lifecycle-1` (kept until 13 December 2026) | 20:37:27 UTC, 20:59:01 UTC (1,294 s) | 10 of 10 tests passed | 14, all successful | all four removed (`keysNotRemoved: []`) |
| Local: `pnpm test:e2e:testnet tests/e2e-testnet/lifecycle.test.ts` | `e2e-artifacts/lifecycle.json`, not committed | 15:29:54 UTC, 15:51:35 UTC (1,301 s) | 10 of 10 tests passed | 14, all successful | all four removed (`keysNotRemoved: []`) |

### 4.1 The deploy

| Item | CI run | Local run |
|---|---|---|
| Market id | `testnet-usdy-1794603499` | `testnet-usdy-1794585049` |
| Deploy time | 333 s | 376 s |
| Maturity | `1794603499` = 20:58:19 UTC, 20 minutes after the deploy's ledger time | `1794585049` = 15:50:49 UTC, 20 minutes after the deploy's ledger time |
| `generatedAt` | 2026-11-13T20:43:00Z | 2026-11-13T15:36:11Z |
| Oracle window | 3,600 s at deploy, shortened to 300 s by the run ([§4.3](#43-transactions)) | the same |
| Wasm | built on the Linux runner: 0 of 12 byte-identical to the official ([§2.1](#21-the-linux-wasm-comparison)) | built on the developer's machine: 12 of 12 byte-identical to the official ([§1.2](#12-contracts)) |

| Contract | CI run | Local run |
|---|---|---|
| Router | [CCE2HH…YKCE](https://stellar.expert/explorer/testnet/contract/CCE2HHJ7LOVMVGRMY2K2M5FNJPCQPTZMT2MGOOOFTKCI7JDRS4NVYKCE) | [CDF6V5…ZANK](https://stellar.expert/explorer/testnet/contract/CDF6V52RZPBGSB4ELNPSTTHWFGHEZXRLRDBJH54PN7EMFBZ4BVHPZANK) |
| OracleAdapter | [CDB43T…QCQQ](https://stellar.expert/explorer/testnet/contract/CDB43TVVY2QVQ75ZSMLFVDYVELBURKOZXUFAYBH5HDQJEP4JEPIUQCQQ) | [CCPZPG…INVI](https://stellar.expert/explorer/testnet/contract/CCPZPGYJWJSXA32WVZ2CZDIBQDZGZB7XMGT4USHWSYATJFZPZD7AINVI) |
| Permissioning | [CCH2HW…L5MG](https://stellar.expert/explorer/testnet/contract/CCH2HWBIS3VGTSEQ7K55DSCZKA6OGYDOHVHVTC3DA7OHRCT25MGGL5MG) | [CCUKBH…DSHO](https://stellar.expert/explorer/testnet/contract/CCUKBHHYT3BENMLSKYTXKEPWNE2DZB4TR2QORCZXVL2GWN2COEONDSHO) |
| RiskControl | [CDLFLS…6CUL](https://stellar.expert/explorer/testnet/contract/CDLFLSWZRPJD3WHNPXTLEWX5JPQAIHRT6UDDMRXFUZO32TTNZWFK6CUL) | [CCEWKH…BN2Y](https://stellar.expert/explorer/testnet/contract/CCEWKHCDFHTHPUTJQCIE53XYTH33MCZF3YSOAQ4X52AWZHGQBKSKBN2Y) |
| MarketFactory | [CDH35K…FRZP](https://stellar.expert/explorer/testnet/contract/CDH35KUTUQJIJBAXVIHVXCQUZ5Y5CUQZJ73JM447AP6ZAWN7VRZCFRZP) | [CBIMYD…JW6C](https://stellar.expert/explorer/testnet/contract/CBIMYD5JPJ223RY6CPWASQEYMX5ZLSZLZXJEB4JBWVCYP5ZA4ANMJW6C) |
| SYWrapper | [CDMZKU…2PRU](https://stellar.expert/explorer/testnet/contract/CDMZKUTSDYXU6I4JGRP46D5YAP53U3YGXPCBPN4RKLIBDXIBNBAF2PRU) | [CD52KR…TATM](https://stellar.expert/explorer/testnet/contract/CD52KRIM34NIRK6F4GFQ2FNP5MDCR54J65TDMSLJG65IHDPQ52WHTATM) |
| PTToken | [CDNNIL…YYSZ](https://stellar.expert/explorer/testnet/contract/CDNNILANOAPPJNHD3QEOBMWHRFE2LJ5OFKNVPWWQA7IYX2TEI6SHYYSZ) | [CCNDCL…PC2K](https://stellar.expert/explorer/testnet/contract/CCNDCLGAO2EMQEU6S5RI2HJFQIWSSBXVCQLW6ILGU2SKJAWTIL4XPC2K) |
| YTToken | [CDADKE…IRCB](https://stellar.expert/explorer/testnet/contract/CDADKEIGMFQRLK65ONTBWFMLDLYJHJIAZTTPN5E5RS5D4KPSHOOYIRCB) | [CCNKN7…GXAP](https://stellar.expert/explorer/testnet/contract/CCNKN7TTSAT6EZHW7NANJ4LHTV54K4Q5SQEJLK77HGNKFVA3QTNRGXAP) |
| MarketConfig | [CBOS6E…5Q6T](https://stellar.expert/explorer/testnet/contract/CBOS6EMDRBNGIEP3QGNFQRO5KS6KSVBFL34VXSDFZOU5XMTMWWHZ5Q6T) | [CC7ZZM…TYYV](https://stellar.expert/explorer/testnet/contract/CC7ZZMQ4H3DTP3ZEIIBS75OXCEOG6BFCEOZ3WZX7EOOOJ7HEXDZOTYYV) |
| PrincipalManager | [CBS5CU…V2ER](https://stellar.expert/explorer/testnet/contract/CBS5CUQES6G6EKGJB6XKD2BB2TCJL2IDYHLJOUAI2CRCRQFK7LPOV2ER) | [CCNCWV…3XCI](https://stellar.expert/explorer/testnet/contract/CCNCWVZ4XUPQ6Q3ZIRHFKYALPU6VT4UGOOZTKM4HEK2EBEV5EGYA3XCI) |
| MarketPool | [CAUMX3…CSGR](https://stellar.expert/explorer/testnet/contract/CAUMX3U7IJIB2FWAHAUSD7SFKGSHNWUDGV5UZ3LYK3UAQTDDRJWOCSGR) | [CC7TBG…DVQ7](https://stellar.expert/explorer/testnet/contract/CC7TBGNHMADSFPTEICG3YNXXL4YUBERMB7BIQQ35BMBXIYK3GFTVDVQ7) |
| RecoveryEscrow | [CBRG67…PP5P](https://stellar.expert/explorer/testnet/contract/CBRG67NM3SYJ3ULWNPRCAPBHSQNHYUY2FYCFU4ETEN3HZH7VUIQHPP5P) | [CBEZSB…A2QQ](https://stellar.expert/explorer/testnet/contract/CBEZSBJCXRNBTNX26SNCQ6OBA2V7I2CZJ5BAQ2LIJ5T5ZDROFKZTA2QQ) |
| USDY SAC (the run's own issuer) | [CCD6OO…4IDK](https://stellar.expert/explorer/testnet/contract/CCD6OONWHNNUFI6TFP53BT4LZUNFBMFMJ3TZ2A4OIICGF4FGZH434IDK) | [CAC2OZ…YFTP](https://stellar.expert/explorer/testnet/contract/CAC2OZ6PDBU3HGYJBQIQLSPMQWMDBXBF24V2NETJOIXT6X6LHOSAYFTP) |

Right after each deploy the suite asserted the market's initial state: manifest valid, Router functions listed, the issuer key issues the asset, the admin key is the SAC admin, the oracle key is the oracle admin, contracts wired as the manifest says, pool seeded, oracle fresh.

### 4.2 Roles and accounts

| Who | CI run | Local run |
|---|---|---|
| admin (SAC admin, market admin) | [GAEX3S…QINZ](https://stellar.expert/explorer/testnet/account/GAEX3SAGREAFZ6TBXQM5SP7HQ5XG6L3S4DD2Y6DFLAPODIB2RE5GQINZ) | [GDINNA…WJMO](https://stellar.expert/explorer/testnet/account/GDINNAGRUUJIM7PPDACRDZXTERF2REJ2B5NDKEMGIRAZALV262VPWJMO) |
| treasury | [GBSZE5…TLC6](https://stellar.expert/explorer/testnet/account/GBSZE5GFBQXUGRMWX3RICKFE2HQPEOEZVW3QVJB6GAOH4QMHC536TLC6) | [GCGRKG…ZFYV](https://stellar.expert/explorer/testnet/account/GCGRKGRINRRKE5TDM7DNGHHPGITJS2XRQB5SNKWKTYZQ2VQPYLJIZFYV) |
| issuer (the run's USDY, Permissioning admin) | [GC3OSQ…KFAO](https://stellar.expert/explorer/testnet/account/GC3OSQGU6345LIB75SVZDBQFZITJA7NMJBPO7IDPUHM42CI5CEACKFAO) | [GAJMGH…57PJ](https://stellar.expert/explorer/testnet/account/GAJMGHQ6OL3IQFTXUB64FKLXBQ6NLMQLEK5RB6NETVR5UCXX7GMN57PJ) |
| oracle admin | [GATL2Q…4FCJ](https://stellar.expert/explorer/testnet/account/GATL2QDIY6AJKBRSSX6DQJE2HZSVYNSN3LVAIIII7RBNNYSNMS2K4FCJ) | [GCJGIT…ZPMZ](https://stellar.expert/explorer/testnet/account/GCJGITUCGYUHZEELFUQFSZL2AN5WZAMN7LNFOZ4WHIWB4QE3P42TZPMZ) |
| trader | [GBH7MO…GD2H](https://stellar.expert/explorer/testnet/account/GBH7MORSRRQORT3RTBJDMMRP2MTNRNURUMCFLQHLKUIVOYMULXLCGD2H) | [GAZZJ7…5MQD](https://stellar.expert/explorer/testnet/account/GAZZJ7AEWBDG5JWWQ7RCJP3SMS3BJTOX5L7J6HWBOL6MV5WDAOBF5MQD) |
| holder | [GAFZOB…HAYE](https://stellar.expert/explorer/testnet/account/GAFZOBWFZDC6QY4H5SXZQU4D5FRC5JQR473DQBZNRXFJIM2JCYRIHAYE) | [GDUPXU…O3CG](https://stellar.expert/explorer/testnet/account/GDUPXULMY3Z75P5GKLVEEDRZHSCD3L5WQPHM2OWHSBFD6JSRN2SBO3CG) |

The trader and the holder were funded by Friendbot, opened a trustline and were onboarded by the run's own issuer.

### 4.3 Transactions

| Step | Signer | Call | CI run: ledger, transaction | Local run: ledger, transaction |
|---|---|---|---|---|
| Deposit 500 USDY | trader | `deposit` | 5715802, [e63731fe…bd71](https://stellar.expert/explorer/testnet/tx/e63731fe1cb5da6a345d323a9c2e5871c4b5aeb8f15d42125d7652558fabbd71) | 5712120, [abb4631d…cde3](https://stellar.expert/explorer/testnet/tx/abb4631d7698eb035e69aa1236728329c7e2911456880d1985087a05fac6cde3) |
| Split 300 USDY | trader | `wrap_and_mint` | 5715803, [45d01ebe…7988](https://stellar.expert/explorer/testnet/tx/45d01ebe04615789c51d64a10bb1430da14263ebebc5a64ecd8e5387711c7988) | 5712121, [e98afd53…e9c6](https://stellar.expert/explorer/testnet/tx/e98afd53532e33e7f15090612505b0077accfb4743fb8e9609cba80e75a4e9c6) |
| Deposit 100 USDY | holder | `deposit` | 5715804, [5de51f45…19a9](https://stellar.expert/explorer/testnet/tx/5de51f45473b042af62e609efe38c73c6d8d593e03db63060890aa89607819a9) | 5712122, [cb835a75…b399](https://stellar.expert/explorer/testnet/tx/cb835a758d1e89479fc6ae95b1018425e0d6155a7be953218e56ff2a979ab399) |
| Split 300 USDY | holder | `wrap_and_mint` | 5715805, [ca849d3a…d447](https://stellar.expert/explorer/testnet/tx/ca849d3a283ac9bd0d614f7f0f86896f0328df34eef3871d9c014ab8b06fd447) | 5712123, [a085a5e1…34ee](https://stellar.expert/explorer/testnet/tx/a085a5e1a0cff0c1b116d0a1e23d5ad7021510e4549d08c5c346d82a635134ee) |
| Buy PT, 200 USDY | trader | `swap_underlying_for_pt` | 5715806, [bd439d70…e38c](https://stellar.expert/explorer/testnet/tx/bd439d701b36fe04efc2584cfb20ff08376fe2a472106b951a9577b98fe1e38c) | 5712125, [b4f7d326…ff15](https://stellar.expert/explorer/testnet/tx/b4f7d3262ca3b07c8572754f278651455aa85cf5126d6aa235123625b743ff15) |
| Add liquidity, 200 USDY | trader | `add_liquidity_single_underlying` | 5715807, [f195c449…4f00](https://stellar.expert/explorer/testnet/tx/f195c44995677b2140f3e92268a9d022f09e1c6a5c2bfeb86170ccb2d69e4f00) | 5712127, [d886aee4…4205](https://stellar.expert/explorer/testnet/tx/d886aee4ed51adac84b5ea9242530d4411cdf7d19584c37d6356fe7873f34205) |
| Oracle tick to 1.05 | oracle | OracleAdapter `set_reference_value` | 5715808, [a60a4bfa…f912](https://stellar.expert/explorer/testnet/tx/a60a4bfa59b78beb027119103cae9cbd2f82c414d2f5252f94e7d6db85daf912) | 5712128, [c97cf151…6a11](https://stellar.expert/explorer/testnet/tx/c97cf1515bca16ed0da4953073b2465227adf92b55b90b193b9369d8fd166a11) |
| Claim yield | trader | `claim_yield` | 5715809, [044e6c93…e080](https://stellar.expert/explorer/testnet/tx/044e6c93f15636d527b58f61fe0a7881a63241ce2e233e455ba9effd4f94e080) | 5712131, [04c2e257…775f](https://stellar.expert/explorer/testnet/tx/04c2e2575ad918eaefd12e9fd3b685516983e487f778964dfb4b53274b78775f) |
| Deauthorize the trader | admin | USDY SAC `set_authorized(false)` | 5715810, [e972a2b6…da8f](https://stellar.expert/explorer/testnet/tx/e972a2b669a84f4f2408bcf143e95fbab291102564aa7d22e92e494f29d2da8f) | 5712132, [6bafb0bc…8401](https://stellar.expert/explorer/testnet/tx/6bafb0bc989d38cae83ee3205405e200b3bbad07bb536696a276f7ec5fef8401) |
| Seize all positions | admin | RecoveryEscrow `seize_all_positions` | 5715811, [2fe86f1b…a146](https://stellar.expert/explorer/testnet/tx/2fe86f1b1d0bf392618b58b8119780377bab39a205284b6c9f27261143f5a146) | 5712133, [3633c94d…32c7](https://stellar.expert/explorer/testnet/tx/3633c94da5f7892bf4985e1aaca0114b67cd883ab7bb7f2f04cc154efec432c7) |
| Shorten the oracle window to 300 s | oracle | OracleAdapter `set_safety_params` | 5715812, [62a565ba…ae9e](https://stellar.expert/explorer/testnet/tx/62a565baf07aa28e0e87943f3c461e9c41fb5fccf88b41663b4b62315660ae9e) | 5712134, [21395887…fe7f](https://stellar.expert/explorer/testnet/tx/2139588767be03c3dc5ace03419d05b53e3baa8591cb8cafff33837eac9bfe7f) |
| Oracle tick after maturity | oracle | OracleAdapter `set_reference_value` | 5715977, [f9aa8a49…958f](https://stellar.expert/explorer/testnet/tx/f9aa8a49937e5bd03392064264d20e6b8065ac6ee027635f10b43a93a39a958f) | 5712287, [c5e49a0d…9460](https://stellar.expert/explorer/testnet/tx/c5e49a0daa8ad8ac91e760b5ab57cadb6c4c9ff7b83ce519fa397736cb499460) |
| Redeem at maturity | holder | `redeem_at_maturity` | 5715978, [173c4278…b7a1](https://stellar.expert/explorer/testnet/tx/173c4278ccf80772b21ab731892629a46bfe737a69bc62d28e3a376aaccbb7a1) | 5712289, [96da70dc…4344](https://stellar.expert/explorer/testnet/tx/96da70dc096292522538912b7a8f15a4316922b43df426c52ee43052c6d44344) |
| Finalize the recovery record | admin | RecoveryEscrow `finalize_record` | 5715979, [d90c0ec0…5fe0](https://stellar.expert/explorer/testnet/tx/d90c0ec056c5bb022dd559f2c9ab9656c02b35574d191da9cec254a8bee75fe0) | 5712290, [090d80a0…af35](https://stellar.expert/explorer/testnet/tx/090d80a03a69b2e885d01833a27b6010fba82602bab2ece3bf54350d9860af35) |

### 4.4 Yield claim

In both runs the oracle moved from 1.0000000 to 1.0500000, and the claim paid exactly the pending yield computed before it: 12.8507142 USDY in the CI run, 12.8507142 USDY in the local run.

### 4.5 Compliance recovery

The sequence of the contracts' recovery design: the issuer authority (the SAC admin, here the run's market admin key) deauthorizes the account on the SAC, the escrow seizes every position, and after maturity the record is settled into the underlying. The figures below are the local run's; the CI run's follow.

1. **Deauthorize** the trader (GAZZJ7…5MQD) on the USDY SAC, ledger 5712132. The app's gate logic then returns, for that account, "Blocked by the issuer: your trustline exists but is not authorized. …". Its own USDY balance (98,812.8507142) stays on its trustline, now deauthorized (Horizon, 13 November 2026: `balance` 98812.8507142, `is_authorized` false).
2. **Seize** with `seize_all_positions([trader])`, ledger 5712133 (15:38:29 UTC). Record `0`, read back with `get_record`:

   | Field | Value |
   |---|---|
   | `sy_shares`, `underlying_from_sy` | 500.0004065, 500.0004065 USDY |
   | `lp_amount` → `lp_pt`, `lp_sy_shares`, `underlying_from_lp` | 99.9669314 LP → 102.2537491 PT, 97.7458704 SY, 97.7458704 USDY |
   | `pt_amount`, `yt_amount` | 499.8500558 PT, 299.8500000 YT |
   | `finalized` | `false` |

   Escrow holdings: before, all zero; after, 597.7462769 USDY, 602.1038049 PT, 299.8500000 YT.
3. **Finalize** with `finalize_record(0)` after maturity, ledger 5712290. The record reads back `finalized: true`, `underlying_from_pt` 573.4315397 USDY and `underlying_from_yt` 0.0002936 USDY. Escrow holdings: 1,171.1781102 USDY, 0 PT, 0 YT.

The CI run did the same on its own trader (GBH7MO…GD2H): deauthorized at ledger 5715810, seized at ledger 5715811 (record `0`: 500.0004048 SY, 99.9669331 LP, 499.8500591 PT, 299.8500000 YT; escrow then 597.7462769 USDY, 602.1038099 PT, 299.8500000 YT), finalized at ledger 5715979 (`underlying_from_pt` 573.4314899 USDY, `underlying_from_yt` 0.0003181 USDY; escrow then 1,171.1780849 USDY, 0 PT, 0 YT).

### 4.6 Refusals at maturity

Simulations, so no transaction hash; the ledger is the one the suite read the state from. Both runs recorded the same blockers, quoted below the table.

| Refusal | Run | Account | Ledger (time) | The contracts |
|---|---|---|---|---|
| The first `redeem_at_maturity` (which settles the market) with a stale oracle: its value was stamped 20:44:39 UTC, so 840 s old against a 300 s window, 20 s past maturity | CI | holder | 5715975 (20:58:39 UTC) | PrincipalManager ([CBS5CU…V2ER](https://stellar.expert/explorer/testnet/contract/CBS5CUQES6G6EKGJB6XKD2BB2TCJL2IDYHLJOUAI2CRCRQFK7LPOV2ER)) error #7, [`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/principal_manager/src/lib.rs#L199) |
| Buy PT after maturity, with the oracle fresh again | CI | holder | 5715977 (20:58:49 UTC) | MarketPool ([CAUMX3…CSGR](https://stellar.expert/explorer/testnet/contract/CAUMX3U7IJIB2FWAHAUSD7SFKGSHNWUDGV5UZ3LYK3UAQTDDRJWOCSGR)) error #6, [`Expired`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/market_pool/src/lib.rs#L162) |
| The first `redeem_at_maturity` (which settles the market) with a stale oracle: its value was stamped 15:37:59 UTC, so 790 s old against a 300 s window, 20 s past maturity | local | holder | 5712285 (15:51:09 UTC) | PrincipalManager ([CCNCWV…3XCI](https://stellar.expert/explorer/testnet/contract/CCNCWVZ4XUPQ6Q3ZIRHFKYALPU6VT4UGOOZTKM4HEK2EBEV5EGYA3XCI)) error #7, [`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/principal_manager/src/lib.rs#L199) |
| Buy PT after maturity, with the oracle fresh again | local | holder | 5712287 (15:51:19 UTC) | MarketPool ([CC7TBG…DVQ7](https://stellar.expert/explorer/testnet/contract/CC7TBGNHMADSFPTEICG3YNXXL4YUBERMB7BIQQ35BMBXIYK3GFTVDVQ7)) error #6, [`Expired`](https://github.com/principal-Protocol-org/principal/blob/665bb6760372d30307a1a035da24e51776f727e8/contracts/market_pool/src/lib.rs#L162) |

The app's gate logic returned, verbatim:
- stale oracle: "The oracle price is stale: it has not been updated in the last 5 minutes. The first redemption settles the market at the current oracle price, so that price must be fresh. Wait for the next oracle update, then try again." / "The simulation was refused with contract error #7, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again.";
- after maturity: "Trading closed at maturity: this market has matured, so PT and YT can no longer be bought or sold in the pool. You can still redeem, claim yield, remove liquidity and withdraw SY." / "The simulation was refused with contract error #6, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again.".

### 4.7 Redemption at maturity

- CI run, ledger 5715978: the holder redeemed all its 299.8500000 PT and 299.8500000 YT in one call, for 285.5710750 USDY from PT and 12.8510324 USDY from YT. The call settled the market at the rate 1.0500013.
- local run, ledger 5712289: the holder redeemed all its 299.8500000 PT and 299.8500000 YT in one call, for 285.5711022 USDY from PT and 12.8510079 USDY from YT. The call settled the market at the rate 1.0500012.

Balances checked exactly in both runs.

## 5. Gate refusals

Every gate the plan names, with where it was shown.

| Gate | Where | Evidence |
|---|---|---|
| Compliance: an account that was not onboarded | Suite A, official market, both runs | [§3.3](#33-compliance-refusal-of-an-account-that-was-not-onboarded): the app's gate logic, SY #9 and PT #10 |
| Stale oracle | Suite B, its market, ledger 5715975 (CI run) and 5712285 (local run) | [§4.6](#46-refusals-at-maturity): the app's gate logic, PrincipalManager #7 |
| Post-maturity trade | Suite B, its market, ledger 5715977 (CI run) and 5712287 (local run) | [§4.6](#46-refusals-at-maturity): the app's gate logic, MarketPool #6 |
| Wrong network | the app's unit tests (`pnpm test`) | below |

Wrong network, the unit tests:
- [lib/protocol/\_\_tests\_\_/gates.test.ts, rule "a wrong network blocks every write"](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/lib/protocol/__tests__/gates.test.ts#L264-L271):
  every action is blocked with "Your wallet is on a different network from this market. Switch it to the network …";
  also [the wallet states table](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/lib/protocol/__tests__/gates.test.ts#L889-L907)
  (`wrong_network` and `unverified_network` block every action).
- lib/protocol/\_\_tests\_\_/wallet.test.ts, [restore](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/lib/protocol/__tests__/wallet.test.ts#L133-L157)
  and [connect](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/lib/protocol/__tests__/wallet.test.ts#L184-L194):
  restore and connect report `wrong_network` when the wallet's passphrase differs from the manifest, and
  `unverified_network` when it cannot be read.
- [components/app/\_\_tests\_\_/shell.test.tsx](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/components/app/__tests__/shell.test.tsx#L131-L141):
  the wallet button shows "Wrong network" and names Testnet.
- [components/app/\_\_tests\_\_/action-panel.test.tsx](https://github.com/principal-Protocol-org/dapp/blob/a96575305678948b66146eef7e968149006f3cf9/components/app/__tests__/action-panel.test.tsx#L558-L566):
  an open review is discarded when the wallet changes network.

## 6. Walkthrough

### 6.1 The page

| Item | Value |
|---|---|
| Published at | <https://principalmarket.fi/docs/using-the-app/testnet-walkthrough> |
| Source | [using-the-app/testnet-walkthrough.md](https://github.com/principal-Protocol-org/docs/blob/main/using-the-app/testnet-walkthrough.md) in the docs repository |
| Screenshots | 22 PNG files in [public/images/walkthrough/](https://github.com/principal-Protocol-org/docs/tree/main/public/images/walkthrough), all taken on the live site in the run of §6.2 ([docs commit 7e5db31](https://github.com/principal-Protocol-org/docs/commit/7e5db31d8e37765e883d7b40b61b5a9912b64c76)) |
| The live site at that time | Vercel deployment `dpl_HZhpg6UfJY98m6vPigSiVrHoseDS`, commit `a965753` of branch `testnet`, aliased to `testnet.principalmarket.fi` |
| How they were taken | [tests/e2e-testnet/walkthrough-shots.ts](https://github.com/principal-Protocol-org/dapp/blob/testnet/tests/e2e-testnet/walkthrough-shots.ts) (`pnpm walkthrough:shots`): Playwright drives the app in Chromium. A test-only wallet, injected into the page in place of Varial, answers the app's wallet requests and signs with a throwaway Testnet keypair. Nothing is added to the app. |

### 6.2 The browser run on the live site

One run on <https://testnet.principalmarket.fi> and the official contracts, 13 November 2026, 21:12 to 21:31 UTC, with
one fresh throwaway account, [GCOFW5…7X5D](https://stellar.expert/explorer/testnet/account/GCOFW5J33PSGIMS6ZXGOD32FUSD2OEOGXWSTRSIO25EYI7QQHC5J7X5D). Every step of the page landed. The transactions come
from Horizon (`/accounts/<address>/operations` with failed ones included: there are none), and the faucet's three
Permissioning grants from the issuer's operations (each names this account). The faucet's steps are signed by the
app's server with the issuer key, not by the account.

| Time (UTC) | Step | Function | Signed by | Ledger | Transaction |
|---|---|---|---|---|---|
| 21:12:24 | 3. Get test tokens: fund the account (10,000 XLM) | `create_account` | Friendbot | 5716140 | [5cda6ab9…8f95](https://stellar.expert/explorer/testnet/tx/5cda6ab93f273d9e578288fc42a75d647a28624158c2049e295b69f592418f95) |
| 21:12:29 | 3. Get test tokens: trustline to USDY | `change_trust` | the account (test wallet) | 5716141 | [5ec33e79…8ed2](https://stellar.expert/explorer/testnet/tx/5ec33e79a6a93f27661c5dfb1ec868472e54a1d0445145f780659588e7788ed2) |
| 21:12:34 | 3. Get test tokens: authorize the trustline | `set_trust_line_flags` | the server's issuer key (faucet) | 5716142 | [adc6d2f0…4929](https://stellar.expert/explorer/testnet/tx/adc6d2f010ab244d4af879d92d9bb9d124a82e1287528ca21ee80be454084929) |
| 21:12:39 | 3. Get test tokens: Permissioning grant, account | Permissioning `grant_account` | the server's issuer key (faucet) | 5716143 | [60439782…0042](https://stellar.expert/explorer/testnet/tx/6043978225a857c11ff56f07596d046b965f54e6ead707ccefb78ef337b70042) |
| 21:12:44 | 3. Get test tokens: Permissioning grant, PT | Permissioning `grant_asset` | the server's issuer key (faucet) | 5716144 | [c4582af6…0ce4](https://stellar.expert/explorer/testnet/tx/c4582af67c1f631248aa5ffa8ec827ece94e3317aa1e4c4d84554c7719aa0ce4) |
| 21:12:49 | 3. Get test tokens: Permissioning grant, YT | Permissioning `grant_asset` | the server's issuer key (faucet) | 5716145 | [7c856b46…f060](https://stellar.expert/explorer/testnet/tx/7c856b463456ac63993c4f493f10a5e6efd1add4dde044800be451a06f79f060) |
| 21:12:54 | 3. Get test tokens: 100,000 USDY | `payment` | the server's issuer key (faucet) | 5716146 | [c528ec19…28af](https://stellar.expert/explorer/testnet/tx/c528ec195a447532d8656cf4361124ea705ae8933ffad2bebf567182db7828af) |
| 21:13:04 | 4. Deposit | `deposit` | the account | 5716148 | [c8114f6e…db36](https://stellar.expert/explorer/testnet/tx/c8114f6e4e0fac28f8dacb4ada17efc09b9dcfe67fb0740ae3cded34336edb36) |
| 21:13:14 | 5. Mint PT + YT | `wrap_and_mint` | the account | 5716150 | [cd1b8fc4…a452](https://stellar.expert/explorer/testnet/tx/cd1b8fc44ad508d5868c82e0ed3794c10a06ed56cb345f8bc0065af3bdcca452) |
| 21:13:24 | 6. Buy PT | `swap_underlying_for_pt` | the account | 5716152 | [d7fc115d…16bb](https://stellar.expert/explorer/testnet/tx/d7fc115d11e96fa7eb91c056930b29a76fa09b0263c295a011dab0941ffd16bb) |
| 21:13:34 | 6. Sell PT | `swap_pt_for_underlying` | the account | 5716154 | [f491403f…10fb](https://stellar.expert/explorer/testnet/tx/f491403fd4143b77581a2ada2730cd915cadcac04a2bdd34260a4a1effe910fb) |
| 21:13:44 | 7. Buy YT | `flash_mint_yt_from_underlying` | the account | 5716156 | [5b7036f6…c206](https://stellar.expert/explorer/testnet/tx/5b7036f6a1f3a78853527a752fc316c6bac5e7593ba411a7647c6efa1d38c206) |
| 21:13:54 | 7. Sell YT | `swap_yt_for_underlying` | the account | 5716158 | [e82615e2…8c85](https://stellar.expert/explorer/testnet/tx/e82615e2b492a86506a5dd6c42f945131d58a5952f56e3b74d70f6373ef98c85) |
| 21:14:04 | 8. Add liquidity (Keep YT) | `add_liquidity_keep_yt` | the account | 5716160 | [903ed1ee…ae46](https://stellar.expert/explorer/testnet/tx/903ed1ee7938dc144220a76eeab08ebf999272d0f676606a66d59754a22cae46) |
| 21:14:14 | 8. Withdraw liquidity | `remove_liquidity_to_underlying` | the account | 5716162 | [bd6b34ef…f3f0](https://stellar.expert/explorer/testnet/tx/bd6b34ef5dc7a5a95e71c5484655005d580473c8b680e45efd050fe23206f3f0) |
| 21:30:19 | 9. Claim yield | `claim_yield` | the account | 5716355 | [429aceb8…d53c](https://stellar.expert/explorer/testnet/tx/429aceb84b856364a4a8f97fd0270b4a9d83dbb545d0444d623461c5c850d53c) |

### 6.3 Screenshots and their source

All 22 files come from the run above, on the live site, with its one account: `02-address-menu.png`, `02-connect-wallet.png`, `03-account-ready.png`, `03-get-test-tokens.png`, `04-deposit-done.png`, `04-deposit-review.png`, `05-split-review.png`, `05-split.png`, `06-buy-pt-review.png`, `06-buy-pt.png`, `06-sell-pt.png`, `07-buy-yt-review.png`, `07-buy-yt.png`, `07-sell-yt.png`, `08-add-liquidity-review.png`, `08-add-liquidity.png`, `08-withdraw-liquidity.png`, `09-claim-yield-review.png`, `09-claim-yield.png`, `10-history.png`, `10-portfolio.png`, `11-held-to-maturity.png`. (`02-connect-wallet.png`,
which shows no account, is unchanged by that commit.)

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
| Deploy pipeline details of Deliverable 1: a single `.env` file, deployment transaction IDs in the manifest, a standalone post-deploy verification script, idempotent re-deploy | app team | Not built; the review's §1.6 maps each one. |
| RiskControl limits on the official market | app team | Deployed with the circuit breaker off (`get_cb_limit` 0). |
| The deviation guard on the official oracle | none needed | It has not fired: no update was rejected (`last_rejection` is `null`). Its live proof is in the contracts repository ([§7](#7-oracle-safety-in-the-contracts-repository)). |
| Redeem in the browser, and its screenshots | app team | Possible only after 11 February 2027 08:59:04 UTC. |
| Nested transfers whose amounts come from the pool's reserves can fail with `Error(Auth, InvalidAction)` when another trade moves the pool between simulation and inclusion | contracts team | A known contract-level limit; only the network fee is lost, and a retry works. |
