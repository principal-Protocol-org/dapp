# Tranche 3 (Mainnet): evidence

The facts behind [TRANCHE_3_REVIEW.md](TRANCHE_3_REVIEW.md): deployed addresses, wasm hashes, transaction hashes, live
reads, CI runs, screenshots and dates. Each section says where its data comes from. Written on 21 November 2026, the
day the dApp went live on Stellar Mainnet, and updated on 22 November 2026: the contracts team widened the oracles'
freshness window ([§6.4](#64-the-window-widened-22-november-2026)) and pinned their build toolchain
([§3.2](#32-the-reproducible-build)). The readings of 21 November are kept as they were taken. All times are UTC.
Unless a row says otherwise, the live reads were made between 20:16 and 20:40 UTC on 21 November.

Every address here is public. No secret key, no name of a key in a keystore and no RPC key appears in this file. The
Mainnet RPC is named by its host only.

**The five Mainnet markets use mock assets.** MOCKUSDY, MOCKUSTRY, MOCKGILTS, MOCKCETES and MOCKXAUM are classic
Stellar assets issued by Principal for testing. They are not USDY or the other real assets. Each market's
OracleAdapter reads the price of the real asset it tracks (USDY, USTRY, GILTS, CETES, XAUM) from RedStone's SEP-40
price feed on Mainnet. The contracts are the production contracts. Principal cannot create a market on the real USDY,
because market creation must be signed by the asset's own issuer authority (the contracts repository's
[MAINNET_DEPLOYMENT_EVIDENCE.md §1](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md#1-why-mock-assets)).

Links:
- transactions, contracts and accounts on stellar.expert: `https://stellar.expert/explorer/public/tx/<hash>`,
  `…/contract/<address>`, `…/account/<address>`; the same transactions on Horizon, as JSON:
  `https://horizon.stellar.org/transactions/<hash>`;
- the dApp at the Production commit
  [`783d51c`](https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd);
- the contracts repository at branch `mainnet`,
  [`ae6ccd9`](https://github.com/principal-Protocol-org/principal/tree/ae6ccd96e5929ff8cbb36f889afd89875647fec2)
  (the contracts team's Mainnet documents and manifests), and at the deployed source,
  [`3af9388`](https://github.com/principal-Protocol-org/principal/tree/3af938853e5818aa8d56bd35670b9a19cfa55a78).

## 1. Production

### 1.1 The site and its deployment

| Item | Value |
|---|---|
| Site | <https://principalmarket.fi>: the app at `/app`, the dashboard at `/dashboard`, the docs at `/docs`. The Testnet app stays at <https://testnet.principalmarket.fi>. |
| What it reads | [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json) ([§2.1](#21-the-manifest)). `/app` shows the banner "Stellar Mainnet · These markets use mock assets issued by Principal for testing." and lists the five markets, each with "Mock asset issued by Principal for testing. It follows the price of USDY and is not USDY." (or USTRY, GILTS, CETES, XAUM). |
| Go-live | `main` fast-forwarded to `2645215` at 12:38 UTC; Production live at 12:39 UTC. |
| Fixes the same afternoon | [`b15d83d`](https://github.com/principal-Protocol-org/dapp/commit/b15d83de5bbed9629c6ccbd72a9137b42e01bbda) (inclusion fee) and `d3733ca` (rate recorder), in [pull request #8](https://github.com/principal-Protocol-org/dapp/pull/8) (`fix/mainnet-go-live` → `testnet`), merged at 15:24:32 UTC as `3cffbdd`; then [pull request #9](https://github.com/principal-Protocol-org/dapp/pull/9) (`testnet` → `main`), merged at 15:48:59 UTC as `783d51c`. [§1.3](#13-what-the-first-scheduled-runs-found) |
| Production deployment | Vercel deployment `dpl_9sWg9ZDDxDHGY1KgJKVhAvmUEKT4`, ready at about 15:53 UTC, serving `783d51c` (same tree as `3cffbdd`). |
| CI on pull request #8 (head `d3733ca`) | [CI run 44916939847](https://github.com/principal-Protocol-org/dapp/actions/runs/44916939847): green (lint, typecheck, unit tests, builds). [E2E Testnet run 44916939793](https://github.com/principal-Protocol-org/dapp/actions/runs/44916939793): Suite A 13 of 13 tests, Suite B 10 of 10. |
| CI on pull request #9 (head `3cffbdd`) | [CI run 44919042817](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042817): green. [E2E Testnet run 44919042837](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042837): Suite A 13 of 13 (15:24:50 to 15:28:42 UTC), Suite B 10 of 10 (15:24:50 to 15:47:46 UTC), its run keys removed. |

The end-to-end suites run on **Stellar Testnet**, never on Mainnet: Suite A is the live journey on the official Testnet
market (contracts `665bb67`); Suite B deploys a throwaway market on Testnet built from the **Mainnet source commit**
`3af9388`, so the Mainnet contract interfaces are exercised end to end without signing anything on Mainnet.

### 1.2 Scheduled jobs

Upstash QStash calls four routes of the Production deployment. Each refuses any other caller (a plain request to
`https://principalmarket.fi/api/cron/alerts` answers 401).

| Route | Schedule | What it does | Seen running |
|---|---|---|---|
| `/api/cron/record` | every 15 minutes | stores each market's rates (the app's charts) | the rate history of MOCKGILTS and MOCKXAUM has points every 15 minutes from 16:00:11 to 20:30 UTC (19 each), MOCKUSDY's from 14:30:01 (25); `stale: false` |
| `/api/cron/index` | every 5 minutes | indexes the contracts' events into the database | `/api/health`, 20:25 UTC: indexed through ledger 65601331, lag 11 s, no gaps |
| `/api/cron/oracle` | minutes 2 to 57, every 5 | the oracle keeper ([§6](#6-the-oracle-keeper)) | one recorded run per oracle every 5 minutes; last before this read: 20:22:01 UTC, all five healthy |
| `/api/cron/alerts` | every 5 minutes | the alert check ([§8](#8-alerts)) | the alerts of 15:00:03 and 20:15:01 UTC |

### 1.3 What the first scheduled runs found

The first runs at 14:00 UTC showed two bugs. Both were fixed and deployed the same afternoon.

1. **Inclusion fee.** The app built every contract call with the network's minimum inclusion fee, 100 stroops. During
   a Soroban fee surge the network refused them: at 14:02:03 UTC the keeper's four syncs came back
   `txInsufficientFee`, and at 14:07:46 UTC one was not confirmed and three were not sent (none of these reached a
   ledger: Horizon answers 404 for their hashes). The same calls landed at 14:12 UTC. Since
   [`b15d83d`](https://github.com/principal-Protocol-org/dapp/commit/b15d83de5bbed9629c6ccbd72a9137b42e01bbda), every
   contract call bids 10,000 stroops
   ([`INCLUSION_FEE_STROOPS`, lib/protocol/stellar.ts line 156](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/lib/protocol/stellar.ts#L156)).
   The bid is a ceiling: the fee charged stays the market rate. The keeper's sync of 20:12:06 UTC is the first at the
   new bid: its `max_fee` is 126,522 stroops, about 9,600 to 9,700 more than the 14:12 syncs of the other v2
   oracles, and its `fee_charged` is 97,885, as before ([§6.2](#62-its-transactions)).
2. **Rate recorder.** The primary RPC answered HTTP 400 "Unknown block" when asked for the newest ledger's close time.
   Since `d3733ca` the recorder reads it from `getLatestLedger`, with retries and a deadline. The 16:00 UTC run stored
   a point for all five markets.

## 2. The Mainnet deployment

### 2.1 The manifest

Source: [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json).
It is the contracts team's
[deployments/mainnet-dapp-manifest.json](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-dapp-manifest.json)
(the "v2" file, committed on 20 November 2026 at 22:12 UTC) with the dApp's own fields added. Checked on 21 November 2026, and again on 22 November against `ae6ccd9`: the shared
contracts, every market's contracts, the maturities, the wasm hashes and the source commit are equal in both files.

| Field | Value |
|---|---|
| Network | Stellar Mainnet, `Public Global Stellar Network ; September 2015`; Horizon `https://horizon.stellar.org` |
| RPC | primary host `lb.drpc.live` (a keyed URL, not reproduced here); fallback and the dashboard's "How to verify" commands: `https://soroban-rpc.mainnet.stellar.gateway.fm` (`verifyRpcUrl`) |
| `sourceCommit` | [`3af938853e5818aa8d56bd35670b9a19cfa55a78`](https://github.com/principal-Protocol-org/principal/commit/3af938853e5818aa8d56bd35670b9a19cfa55a78). The contract sources are identical at `4b5bc2b` (the commit the contracts team's build section names) and at `mainnet` `ae6ccd9`: `git diff` shows no change under `contracts/`, nor in `Cargo.toml` or `Cargo.lock`. |
| `protocolAbi` | `2` (the `3af9388` contract interfaces) |
| `deployLedger` | `65525735`; `createdLedgers` gives the first ledger of the 20 contracts added later (the v2 markets) |
| `generatedAt` | `2026-11-21T00:00:00Z` |
| `accessContact` | `hello@principalmarket.fi`, the address the app shows for a Mainnet access request |
| Markets | the five below, all 90-day markets |

### 2.2 Contracts

Source: the manifest. "On chain" is the read-only check of [§2.3](#23-the-read-only-deployment-check): each address's
code hash, read from the chain, equals the manifest's `wasmHashes`, 44 of 44.

Shared contracts (one instance each, used by every market):

| Contract | Address | Wasm SHA-256 |
|---|---|---|
| Router | [CCM4QQ…7QF5](https://stellar.expert/explorer/public/contract/CCM4QQUKTD2CUTRSNNI6OO4JHYEF7MHKBMKSM5JYJNFLKSTAZBQD7QF5) | `2a0997317651edb0f7e2bd753570b03a88462aa6d216c14b06ebec246bb3c1c2` |
| Permissioning | [CBCWU5…RTXJ](https://stellar.expert/explorer/public/contract/CBCWU57AILKFDOYQAESFRPH57Q6UK66E7RBYV4ICZHNNGWIWFAHVRTXJ) | `4437468dbbda6d86a115f188de877135b0b5a400b69ad7e9444cf269c54f969c` |
| RiskControl | [CBHCRR…WQ5G](https://stellar.expert/explorer/public/contract/CBHCRRLWHS7KRQNAXYY3OMNDTSXDNJKCDK6KPUUJPFGDBSN76JEWWQ5G) | `ac75508d24c5457de7db1106bf8b5e9b62ea436f3dfd1a309fda5138110c2526` |
| MarketFactory | [CDYH7U…S65T](https://stellar.expert/explorer/public/contract/CDYH7UV24XS7G7MDRTBJUS4PJNKKUXTLUUTL67MR5CYJAXSPPHNWS65T) | `6c21fc0e78f3064f67ae30924b8f9ca0223fbb61a20ac640cceca7b152456759` |

The five markets (MOCKUSDY's OracleAdapter is also the manifest's `shared.oracle`):

| | MOCKUSDY | MOCKUSTRY | MOCKGILTS | MOCKCETES | MOCKXAUM |
|---|---|---|---|---|---|
| Market id | `mainnet-CDQYZU-CCY5P6CC` | `mainnet-CDHQ4B-CAFCV4KB` | `mainnet-CBBF4H-CBYNXSR3` | `mainnet-CBVSL3-CBAUFMQH` | `mainnet-CBAJVV-CDG77CSN` |
| Tracks the price of | USDY | USTRY | GILTS | CETES | XAUM |
| Maturity (UTC) | 15 Feb 2027 19:27:49 (`1802719669`) | 18 Feb 2027 21:03:39 (`1802984619`) | 18 Feb 2027 21:28:53 (`1802986133`) | 18 Feb 2027 21:41:13 (`1802986873`) | 18 Feb 2027 21:51:49 (`1802987509`) |
| Issuer (SAC admin) | [GB3SOE…LE4P](https://stellar.expert/explorer/public/account/GB3SOEMQVYBLMHPV3AK64PV4FJTOMQ2XUJLOZSVDJLP2LT42EU3XLE4P) | [GDM2Q2…RK4K](https://stellar.expert/explorer/public/account/GDM2Q2F5KC2ECQZ5C3TIPTM7UTZJ775G4UZCLLGYULZUMBI6VEQERK4K) | [GA5KXE…OR3G](https://stellar.expert/explorer/public/account/GA5KXEPU7FLWKNG255WKYSYQ5U3G7WHFKD7HTTK2DR37KYJJ7V6GOR3G) | [GBB6TI…VSCZ](https://stellar.expert/explorer/public/account/GBB6TITJASKDTNBA6XEU7IM3VVMM3JLSQRTPQBBHZM4KJELPQGECVSCZ) | [GC6VP3…7AMN](https://stellar.expert/explorer/public/account/GC6VP3LK7JWQRRLZVTHMPYYNN3ZRUJ7KSZGMV4AJTYETICNISI4I7AMN) |
| Asset contract (SAC) | [CDQYZU…OBGF](https://stellar.expert/explorer/public/contract/CDQYZUYQF7TRQ7BX6YBSCU3HLWBDS3E2VSP7AUE7C3E2D2U2IBBQOBGF) | [CDHQ4B…YBA5](https://stellar.expert/explorer/public/contract/CDHQ4B6U3D5O6PGAWAO22K45ASD2BAGD25IHITRIIUHXA3GBABZTYBA5) | [CBBF4H…JG4O](https://stellar.expert/explorer/public/contract/CBBF4H2ZNMJKULJEOMZDMVQP27LD7HRTHEHETD647P3SCBTAWRGVJG4O) | [CBVSL3…IATP](https://stellar.expert/explorer/public/contract/CBVSL37VLX4Z362AETPZVM65EZGETM2ROT7K56MIURXJU4LZDIJ4IATP) | [CBAJVV…AVVD](https://stellar.expert/explorer/public/contract/CBAJVVTBBR6XXAK4N32WHVOALDRMQ27YMQNS6PBLGNWJIBFWOYS6AVVD) |
| OracleAdapter | [CCKXG4…K7IT](https://stellar.expert/explorer/public/contract/CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT) | [CBTW7C…PFR7](https://stellar.expert/explorer/public/contract/CBTW7CU46PMCPKZQ3VX6OBELOEC7HHQXJSAX535VW3EK34MVS7UWPFR7) | [CD22HN…J6X7](https://stellar.expert/explorer/public/contract/CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7) | [CBK2GO…MUZK](https://stellar.expert/explorer/public/contract/CBK2GO7UPMES2B7LZYZXNO3JP5JPNIIE74E4PUUJGSZZKD4FZ47QMUZK) | [CDFI7I…OPFD](https://stellar.expert/explorer/public/contract/CDFI7IXUTGLV2EQE3VCHPCYOEBX2LSLXDKNU7ELJFZH726VDF73SOPFD) |
| SYWrapper | [CCY5P6…GJ7Q](https://stellar.expert/explorer/public/contract/CCY5P6CCHIPX7ND3HSIHFLD57756WWILI4UQLSZ2UIF5CVGYN6XJGJ7Q) | [CAFCV4…BUXN](https://stellar.expert/explorer/public/contract/CAFCV4KBWI74XJ3TG5YVVMIQLDI7QTZ24UPRQEQWZXJ4L6WBWKJKBUXN) | [CBYNXS…JMP4](https://stellar.expert/explorer/public/contract/CBYNXSR3C76RF77HM6M25X3XZMYQAVCU5BHZCU2LLQIP2XLKUU5TJMP4) | [CBAUFM…SYSD](https://stellar.expert/explorer/public/contract/CBAUFMQHTVPY7ULLODKY6UZ3TFOMLKUNCK5PSFWFEIBLJOSO3JKBSYSD) | [CDG77C…JJ7M](https://stellar.expert/explorer/public/contract/CDG77CSNUVEOM3WKWNIBH2XWMUPZ256Y6B6SYUKQVCR7K5PQWTA4JJ7M) |
| PTToken | [CASF4U…LEFE](https://stellar.expert/explorer/public/contract/CASF4U23SQ6XPCKPVNQ273OM3ILZRJFNHTHW6KGZRXQD4QK65PWWLEFE) | [CDR6MI…56DS](https://stellar.expert/explorer/public/contract/CDR6MISANKZFOXO5IRUUPHPVPSPFADT5CC7V5SMP25WYOGG7ONQ456DS) | [CBI74V…PHUY](https://stellar.expert/explorer/public/contract/CBI74V5Q4HHRAKQW7KEER4GCSANPYRDWKIBO3ALZMMSVIMW3DW3NPHUY) | [CCHMJE…SH3O](https://stellar.expert/explorer/public/contract/CCHMJET5QKXLXXALPIY2EDB2KNOCHPHKCYKD5PBEXUQAKO6GSZLLSH3O) | [CAHQ4W…UPYQ](https://stellar.expert/explorer/public/contract/CAHQ4WIQWGHMKIVDTZIVU43XIBP3ATR3KAEZUMKRXU4S23LK56CDUPYQ) |
| YTToken | [CCQ2VU…KPGC](https://stellar.expert/explorer/public/contract/CCQ2VU23X5GY7ZBTYNKWGLXRQVODSNSCNJVOLXG7NHLEXT37FDAKKPGC) | [CDWZRK…M3WT](https://stellar.expert/explorer/public/contract/CDWZRKGO5LOMKHO2S6O52QI6H2NAJVZ2OKZ5SEUXMHHNETGOJ6RJM3WT) | [CBHMXX…BP32](https://stellar.expert/explorer/public/contract/CBHMXXPLQHP2FSHMEJVKHBKECB755WVQFYWG5ZBBCLMNHGLTIGAPBP32) | [CAYGW7…DLQZ](https://stellar.expert/explorer/public/contract/CAYGW7C26RXAF3XQOOY6NZWSMBJ4MQVTOVO5MUQMKXDSQUBRG4HODLQZ) | [CCNTUK…K5VQ](https://stellar.expert/explorer/public/contract/CCNTUKCIFGHUUSBKKK37UT2E4APDNLZWDMAKBTSX5IRPNXHLNAA6K5VQ) |
| MarketConfig | [CAV62P…WAQL](https://stellar.expert/explorer/public/contract/CAV62P3JRTBVBOCCZ4GW3X7AAW4NJ35LP7KVM5TY6Q6OXROMOKI4WAQL) | [CAY7P5…TPC5](https://stellar.expert/explorer/public/contract/CAY7P5UZDQNREOMIUWOO4BWSJLYICWIXLT77TUMTGUY5BHH3LJDETPC5) | [CA4ZQ7…HOON](https://stellar.expert/explorer/public/contract/CA4ZQ7DEC73AGG2UTCCM4TXLGOUZPN3QCJZ6QMV677CYT54C67ZEHOON) | [CA4WPF…VZ37](https://stellar.expert/explorer/public/contract/CA4WPFXEG6SZPRAGBZHSPICTPZXE44AL3OUS4ITLXA36DFD7NOR2VZ37) | [CCWR66…ZAHS](https://stellar.expert/explorer/public/contract/CCWR66XFL4FOAJOSV4GEKYQQ4BJADTMDFDPZA55LBQMGN2OTBFZVZAHS) |
| PrincipalManager | [CBBKUZ…UKCC](https://stellar.expert/explorer/public/contract/CBBKUZJWZDA7YLA6GHSXVLV62QJ6DLKCO4GXUWF43FXLPN5S3XVNUKCC) | [CCAW4D…OHNY](https://stellar.expert/explorer/public/contract/CCAW4DZO24VVFL5SYMKHDMAWHX6GMGYZEMSL2VW7RF4GHHIUW7GJOHNY) | [CCDSON…7GBS](https://stellar.expert/explorer/public/contract/CCDSONMQBNS4LNKKUBLG5XLNDNNDU4PQPWKJK2KQCVQHJ3AW5GNN7GBS) | [CAL22Q…HO6B](https://stellar.expert/explorer/public/contract/CAL22QZTOUTCGIKMMJBGIQDPX4BOHUUCRWLUDCD7LCMTLTIZAEDDHO6B) | [CBBEH4…2CEF](https://stellar.expert/explorer/public/contract/CBBEH4YDZCTIB222VXBSXCECCVUQYU7XQXAR5J4BKCVVZSN6FLQS2CEF) |
| MarketPool | [CAON3F…GW4I](https://stellar.expert/explorer/public/contract/CAON3FAQU5W6SGZFWOM22GONNKZEIN4AGVTKMCWCC6PI43QWB27MGW4I) | [CABAS7…7A5S](https://stellar.expert/explorer/public/contract/CABAS76ZTOAKMQEBNC6TJNF4XINX7H7AH4EFVXTR4ACZNJR7NHT27A5S) | [CD5ADN…QILK](https://stellar.expert/explorer/public/contract/CD5ADNE76FY2D722LMQJFD7AG74UU3OYQVXSNQNI33EYPSEEUZY4QILK) | [CARSHE…YNZG](https://stellar.expert/explorer/public/contract/CARSHEWMUGH4LINSO3ST4QFJSCDD47A7OCXV55QLLCHMEZULV6CUYNZG) | [CDXOBS…5RKL](https://stellar.expert/explorer/public/contract/CDXOBSBR6FX5M6OJQEPMQJTVJ2K7OZRWBVGYAMR2ZNUUSZX63OOS5RKL) |
| RecoveryEscrow | [CBHHRT…67SJ](https://stellar.expert/explorer/public/contract/CBHHRTTRTXQM3OFDOBL6QORP6JS5RVIRXSF5B3C4TMOVSIQBDKKA67SJ) | [CCDGIH…J7U5](https://stellar.expert/explorer/public/contract/CCDGIH52RBTLF3REZGQVVOUL7Z3LZT7OKUE4YBBJWTHF5SGU4QVBJ7U5) | [CAI25Q…KL7N](https://stellar.expert/explorer/public/contract/CAI25QPLB7KYSRNXJHCXAZVHI36PAEZJET5PJJKC326KVDDGUURUKL7N) | [CBHVXY…OLIM](https://stellar.expert/explorer/public/contract/CBHVXY5WUDYATTB4GAT44U2BBBAPTYFL73HER7QI5PRQI4VUM3S7OLIM) | [CAC77K…XLOO](https://stellar.expert/explorer/public/contract/CAC77KCD7QG4CCOBOM3XXDD43256O2CIEN6L4EECPKT5RBAKDZJJXLOO) |

Every market uses the same eight per-market wasm hashes, those of the contracts team's build ([§3.2](#32-the-reproducible-build)):
OracleAdapter `8581bbba…0c1b0`, SYWrapper `be4b12cf…27c9a`, PTToken `db025340…578b2`, YTToken `c83a2a8d…02654`,
MarketConfig `11b0cbdf…c79a8`, PrincipalManager `e2d04b45…86115`, MarketPool `52285a25…aa112`, RecoveryEscrow
`dadea71f…441e8`. The full hashes are in the manifest's `wasmHashes`.

MOCKUSTRY, MOCKGILTS, MOCKCETES and MOCKXAUM are the contracts team's "v2" markets, deployed on 20 November 2026
around 21:00 UTC (their doc dates the redeploy 21 November). Their first
markets ("v1", now in each `deployment-manifest-v1-broken.json`) had oracles set ten times too high by a manual push,
and the oracle's value can never go down, so the contracts team redeployed them
([MAINNET_DEPLOYMENT_EVIDENCE.md §12](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md)).
The v1 contracts are abandoned; nothing here refers to them.

### 2.3 The read-only deployment check

Source: [scripts/smoke.mjs](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/scripts/smoke.mjs),
run with `pnpm smoke:mainnet` from a checkout of the dApp at `3cffbdd` (the same tree as `783d51c`), on 21 November
2026 at 20:24:36 UTC. It needs no key and signs nothing. It reads, from the RPC the manifest names (it prints the host
only): each market's topology against the manifest, each oracle's state and feed, the pauses, and the on-chain code
hash of every manifest contract. It exits 1 on a topology or code mismatch or an unreadable contract; a stale oracle
is reported and does not fail it.

```text
Principal deployment check: mainnet, ledger 65601326 (2026-11-21T20:24:36.000Z), RPC lb.drpc.live, contracts at 3af9388

Market                             Topology  Oracle              Feed                                Value against feed       Paused
---------------------------------  --------  ------------------  ----------------------------------  -----------------------  ------
MOCKUSDY mainnet-CDQYZU-CCY5P6CC   match     stale, 8h 48m old   1.1539439 (CBMG…WYRF, 8h 48m old)   1.1539439 stored: Equal  no
MOCKUSTRY mainnet-CDHQ4B-CAFCV4KB  match     stale, 8h 48m old   1.081102 (CBMG…WYRF, 8h 48m old)    1.081102 stored: Equal   no
MOCKGILTS mainnet-CBBF4H-CBYNXSR3  match     fresh, 14m 6s old   1.406808 (CBMG…WYRF, 14m 6s old)    1.406808 stored: Equal   no
MOCKCETES mainnet-CBVSL3-CBAUFMQH  match     stale, 10h 20m old  0.062253 (CBMG…WYRF, 10h 20m old)   0.062253 stored: Equal   no
MOCKXAUM mainnet-CBAJVV-CDG77CSN   match     stale, 10h 26m old  3558.4610 (CBMG…WYRF, 10h 26m old)  3558.4610 stored: Equal  no
shared contracts                   -         -                   -                                   -                        no

warning: oracle CCKX…K7IT (MOCKUSDY) is stale: its value is 8h 48m old, 1h 0m allowed; operations that need its price are blocked (reported; does not fail the check)
warning: oracle CBTW…PFR7 (MOCKUSTRY) is stale: its value is 8h 48m old, 1h 0m allowed; operations that need its price are blocked (reported; does not fail the check)
warning: oracle CBK2…MUZK (MOCKCETES) is stale: its value is 10h 20m old, 1h 0m allowed; operations that need its price are blocked (reported; does not fail the check)
warning: oracle CDFI…OPFD (MOCKXAUM) is stale: its value is 10h 26m old, 1h 0m allowed; operations that need its price are blocked (reported; does not fail the check)
PASS: 5 of 5 topologies match, 44 of 44 code hashes match (12 pinned hashes), 0 failed reads; 5 oracles: 1 fresh, 4 stale; nothing paused
```

The 44 code hashes are the 4 shared contracts and 8 contracts per market (its OracleAdapter and its seven market
contracts). `pnpm smoke:mainnet --json`, run right after (ledger 65601329), gives the same result with every contract's
expected and actual hash, and `exitCode` 0 with no retried read. The developer's run right after the deploy also
passed: 5 of 5, 44 of 44, 0 failed reads.

### 2.4 How long the contracts live

Soroban contract instances expire unless their time to live is extended. Read with one `getLedgerEntries` call on the
public gateway (`https://soroban-rpc.mainnet.stellar.gateway.fm`) at 20:37 UTC, ledger 65601474, for the instance of all
44 manifest contracts:

| | Ledger | About (UTC, at 5.0 s per ledger) |
|---|---|---|
| Earliest `liveUntilLedgerSeq` (Permissioning, then MOCKUSDY's OracleAdapter and RiskControl) | 67599335 | 17 March 2027 |
| Latest | 67658712 | 21 March 2027 |

The markets mature on 15 and 18 February 2027. Someone must extend the instances before mid-March 2027
([§10](#10-open-items), item 4). The contract code entries and the contracts' stored data have their own lifetimes,
not read here.

### 2.5 Roles

Public addresses only. No Mainnet key of the contracts team is on the app's servers: the README's
[Mainnet go-live](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/README.md#mainnet-go-live)
sets "never a faucet or admin secret" on Production. By that checklist, the app's server holds one Mainnet signing key,
the keeper's.

| Role | Address | Source |
|---|---|---|
| Protocol admin (contracts team): admin of the five OracleAdapters, a pauser by RiskControl's rule, the protocol admin of the markets' fees | [GDZN5W…5NCB](https://stellar.expert/explorer/public/account/GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB) | `get_admin` on each OracleAdapter (20:39 UTC); the risk page; the market pages; [MAINNET_ADDRESSES.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_ADDRESSES.md) |
| Issuers (contracts team): one per mock asset, the SAC admin of its asset and the market's creator | [§2.2](#22-contracts) | the compliance page (`admin()` on each SAC); the market pages |
| Treasury: receives the protocol's fee share | [GBUVAH…VSXW](https://stellar.expert/explorer/public/account/GBUVAHYJNCXZWUK3NIOVJ6EYQRSXMVT2XOUEASS3VAG4EWIXXWYSVSXW) | the market pages |
| The contracts team's test account, which signed their deposits and mints ([§3.1](#31-deposit-and-mint-on-every-market)) | [GCOMBI…R5BM](https://stellar.expert/explorer/public/account/GCOMBIYWZ3HIMAS7FLFERQMVZIDVIMFZAAV7A2KMCDV3RAKP5NL5R5BM) | Horizon |
| The app's oracle keeper: no role in any contract; it only pays the fees of `sync_from_feed`, which anyone may call | [GBLY3F…MZXS](https://stellar.expert/explorer/public/account/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS) | the oracle page's keeper runs; Horizon ([§6](#6-the-oracle-keeper)) |

Only the Permissioning admin (the contracts team) can grant an account access to the markets. The app's Mainnet
access flow therefore shows what is missing, offers the trustline, and points to `hello@principalmarket.fi`.

## 3. The contracts team's Mainnet evidence

Source: the contracts repository, branch `mainnet` at `ae6ccd9`:
[docs/MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md),
[docs/MAINNET_ADDRESSES.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_ADDRESSES.md),
[docs/MAINNET_TRANSACTION_LEDGER.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_TRANSACTION_LEDGER.md)
(complete through 18 November 2026, as its header says) and the five v2 manifests
[mainnet-mockusdy](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-mockusdy/deployment-manifest.json),
[mainnet-ustry](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-ustry/deployment-manifest.json),
[mainnet-gilts](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-gilts/deployment-manifest.json),
[mainnet-cetes](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-cetes/deployment-manifest.json),
[mainnet-xaum](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-xaum/deployment-manifest.json).

### 3.1 Deposit and mint on every market

The contracts team deposited a mock asset and minted PT and YT on each of the five markets, from the command line,
with their test account GCOMBI…R5BM. For MOCKUSDY the doc's §5 "Real transaction testing" lists them; for the four v2
markets, §12's table "Real testing proof on every v2 market". We read every hash below on Horizon on 21 November
2026: each is successful, signed by GCOMBI…R5BM, and invokes the function named on the market's own contract from
[§2.2](#22-contracts).

| Market | Deposit (`deposit` on its SYWrapper) | Mint PT + YT (`mint` on its PrincipalManager) |
|---|---|---|
| MOCKUSDY | 17 Nov 2026 19:56:57, ledger 65531875, [972727f7…0776](https://stellar.expert/explorer/public/tx/972727f72064f9acd6955339a84c544157bcb5ebc113c19ee3cd25a325ef0776) (200 MOCKUSDY) | 17 Nov 2026 19:57:12, ledger 65531878, [ddbdd136…4906](https://stellar.expert/explorer/public/tx/ddbdd13683ffd9b93509d9c223556aaa04d57c2d0870195db304580b8e2b4906) (100 SY) |
| MOCKUSTRY | 20 Nov 2026 21:25:09, ledger 65584773, [c6ad5969…9ac0](https://stellar.expert/explorer/public/tx/c6ad5969682b72ac523cb5b87bdf892d7649510b0b5456de6ce801b1b1919ac0) | 20 Nov 2026 21:25:24, ledger 65584776, [1255f5b7…66e3](https://stellar.expert/explorer/public/tx/1255f5b7651caa4f21355ff5cf7ec9574126f5768dae417361b209d2488266e3) |
| MOCKGILTS | 20 Nov 2026 21:38:04, ledger 65584928, [09467f11…0c23](https://stellar.expert/explorer/public/tx/09467f11b8d2003202e13018c8b49e0be5351dcc1e84c710fb5d5da067940c23) | 20 Nov 2026 21:38:09, ledger 65584929, [3e45a960…6c14](https://stellar.expert/explorer/public/tx/3e45a960cd22871bae106573ea455e2adae3ef6d576c1dd244ea21d8b2cd6c14) |
| MOCKCETES | 20 Nov 2026 21:49:14, ledger 65585062, [9f71d18b…36f3](https://stellar.expert/explorer/public/tx/9f71d18bcfbd21902c6f283128450401e0180780439bd2746981eb633a9236f3) | 20 Nov 2026 21:49:19, ledger 65585063, [4240d062…45be](https://stellar.expert/explorer/public/tx/4240d062f34ff6f10b39c7784006f8a5b9ad18d148483e578b912471ea0a45be) |
| MOCKXAUM | 20 Nov 2026 21:59:24, ledger 65585184, [2c1d8e23…25f5](https://stellar.expert/explorer/public/tx/2c1d8e23e329e0208a7095c7842e0b6e616712cb572fb682d50a82b1678025f5) | 20 Nov 2026 21:59:34, ledger 65585186, [83b5529b…ebc1](https://stellar.expert/explorer/public/tx/83b5529b6203b39348c0568dbebb4531a6f4b7dbdc56c4db491ec2da1553ebc1) |

The same doc records seed liquidity and a swap on each market. It also records, on a separate 30-minute MOCKUSDY market
(`mainnet-CDQYZU-CA74VH`, matured, not listed by the app), a full lifecycle on Mainnet: deposit, mint, settlement and
redemption at maturity.

These are the contracts team's command-line runs. The dApp's own signed smoke test, a small deposit and mint through
principalmarket.fi, has not been run yet ([§10](#10-open-items), item 2).

### 3.2 The reproducible build

What the contracts repository publishes
([MAINNET_DEPLOYMENT_EVIDENCE.md §8](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md#8-reproducible-build-evidence)):
- the source commit `4b5bc2b` (the contract sources are identical at `3af9388`, [§2.1](#21-the-manifest));
- the build command `cargo build --workspace --release --target wasm32v1-none`;
- the toolchain `rustc 1.94.1 (e408947bf 2026-03-25)`, `cargo 1.94.1`, `stellar 26.0.0`; the manifests add
  `soroban-sdk 26.0.1`;
- a table of the 12 wasm files with their sizes and SHA-256. The 12 hashes equal the manifest's `wasmHashes`, and the
  code on chain matches them, 44 of 44 ([§2.3](#23-the-read-only-deployment-check)).

It gives no step that compares a rebuild with the chain. At `3af9388` the repository has no `rust-toolchain.toml` and no path
remapping (both were added on 22 November, below). Each v2 manifest records `"git_tree_dirty": true`: the working tree had uncommitted changes when the deploy
script ran; whether they touched the contract sources is not recorded.

What we found when we rebuilt it, on 21 November 2026 (the source from `git archive 3af9388`, then the command above with
`--locked`):

| Build | Result |
|---|---|
| macOS, arm64, `cargo +1.94.1` | 0 of 12 SHA-256 match. 11 of 12 files have exactly the size in §8 (YTToken is 3 bytes shorter). Permissioning, whose wasm carries no file path, differs from the on-chain bytes in 12 bytes. |
| Linux container (`rust:1.94.1-slim`, arm64), with `CARGO_HOME` at the cargo registry path that the on-chain wasm embeds, and the source in the same home directory (our guess of the original layout) | 0 of 12 match. All 12 sizes equal §8's; the embedded registry path is now identical; Permissioning still differs from the on-chain bytes in 12 bytes. |
| CI, Suite B of [E2E run 44919042837](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042837) and [44916939793](https://github.com/principal-Protocol-org/dapp/actions/runs/44916939793) (Linux x86_64, rustc 1.95.0, step "Compare the wasm with the Mainnet deployment's (informational)", [workflow lines 197 to 219](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/.github/workflows/e2e-testnet.yml#L197-L219)) | "0 of 12 wasm files are byte-identical to the Mainnet deployment's (expected to differ with another toolchain)" |

Our two rebuilds also differ from each other: Permissioning, which embeds no path, came out `93afc34f…` on macOS and
`c563cb99…` in the container. So the same source and the same rustc give different bytes in different build
environments, and the published instructions do not yet let a reviewer rebuild the deployed bytes. This is open with
the contracts team ([§10](#10-open-items), item 3).

Where the bytes differ, for Permissioning (11,308 bytes on chain, SHA-256 `4437468d…`, fetched with `stellar contract
fetch`; our macOS rebuild `93afc34f…`, the same with or without `--locked`): both files carry the same contract meta
(`rsver` 1.94.1, `rssdkver` 26.0.1#f52b6aad…), and `cmp -l` finds 12 differing bytes, all `call` operands that read 222
in one file and 223 in the other. Two functions sit in the opposite order in the module; the code is otherwise the
same byte for byte. Function order is set by the build, not by the source, so this points at a difference in the build
environment (for example the build directory, which can change the hashes that order the functions), not at different
contract source. We did not confirm which setting causes it.

**What changed on 22 November 2026.** The contracts team pinned the toolchain (`rust-toolchain.toml`, rustc 1.94.1),
added `scripts/deploy/reproducible_build.sh` (the build with `--remap-path-prefix` on the cargo and checkout paths) and
a recipe, [deployments/mainnet/reproducible-build.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet/reproducible-build.md),
and wrote up the cause in
[MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md)
§14. The contract sources, `Cargo.toml` and `Cargo.lock` are the same at `ae6ccd9` as at `3af9388`. We ran their recipe
and read their CI that day:

| Build of `ae6ccd9`, rustc 1.94.1 (`e408947bf`), the script's flags | Permissioning (embeds no machine path) | Result |
|---|---|---|
| The contracts team's CI, [run 44974232705](https://github.com/principal-Protocol-org/principal/actions/runs/44974232705), job "wasm build (all contracts)", Linux x86_64, `CARGO_HOME` `/home/runner/.cargo` | `4437468d…`, the on-chain bytes | Permissioning and RiskControl (`ac75508d…`) equal the on-chain hashes; the 10 others differ |
| Ours, macOS arm64 | `93afc34f…` | 0 of 12 equal to that CI run |
| Ours, Linux arm64 container (`rust:1.94.1-slim`) | `c563cb99…` | 0 of 12 equal to that CI run |

So the two contracts that embed no machine path rebuild to the deployed bytes on Linux x86_64, on a machine other than
the original one, and the result depends on the host system: macOS and Linux arm64 give other bytes.

The ten others embed a path. We read all 12 on-chain files in full: the only absolute paths are under one cargo
directory, `/home/<user>/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/soroban-sdk-26.0.1/src/…` (`<user>` is the
original builder's home directory, masked here), in 10 files; the workspace's own sources appear as relative paths
(`contracts/market_pool/src/lib.rs`). The contracts team's §14 says that changing `CARGO_HOME` alone changes exactly
these ten. A rebuild of `3af9388` on Linux x86_64 with rustc 1.94.1 and the cargo directory at that path is therefore
expected to give 12 of 12. It has not been run yet: we have no Linux x86_64 machine, and under emulation on Apple
silicon rustc crashes at start-up. It belongs in the contracts repository's CI ([§10](#10-open-items), item 3).

### 3.3 The deployment manifests

Each v2 `deployment-manifest.json` records the network, the source commit, the toolchain, every contract's address
and wasm SHA-256, its admin, and a `transactions[]` list (deploys, inits, factory calls, wiring, grants and the test
transactions). The shared contracts have `deploy_tx` and `init_tx`; the market contracts are created by the factory,
whose `create_tokens`, `create_engine` and `create_pool_and_escrow` hashes are in `transactions[]`.

Two caveats:
- In the MOCKUSDY manifest, `transactions[]` repeats two hashes under steps they do not belong to, left by a first, interrupted run:
  `d92625d1…` is listed as `init:permissioning`, `deploy:risk_control` and `init:risk_control`, and `48092ae3…` as
  `risk_control:set_asset_limit`, `deploy:router` and `init:router`. The per-contract `deploy_tx` and `init_tx` fields
  give other hashes for RiskControl and the Router; use those. (The dashboard's risk page indexes `48092a…f372` as the
  MOCKUSDY asset limit.)
- `git_tree_dirty: true` in all five ([§3.2](#32-the-reproducible-build)). Four record `source_commit` `3af9388`; MOCKUSTRY's
  records `2c88915`, a later commit of the same branch with the same contract sources.

The contracts team's own check, `scripts/deploy/verify-deployment.sh`, reports 78 of 79 checks passing per market, the
failing one being `git_tree_dirty` (the doc's status paragraph).

## 4. The configuration, read live

| Setting | Value | Read from |
|---|---|---|
| RiskControl, protocol-wide limit | 5,000.00 in underlying units, per sliding window of 17,280 ledgers (about 24 hours); counted now 2,250.75, remaining 2,749.25; wrap-and-mint room 1,374.62 (a wrap-and-mint counts twice) | `/dashboard/risk`, ledger 65601411 |
| RiskControl, per-asset limits | MOCKUSDY 5,000.00 (set 17 Nov 2026 15:55:32, `48092a…f372`), MOCKUSTRY 5,000.00 (set 17 Nov 2026 20:52:32, `946d7e…2c14`); MOCKGILTS, MOCKCETES, MOCKXAUM: no limit | `/dashboard/risk` |
| Pauses | RiskControl, and each market's SYWrapper, PrincipalManager and MarketPool: not paused. Pause history: none recorded. | `/dashboard/risk` |
| Oracles | each market's own OracleAdapter; `max_stale_seconds` 3600 on 21 November (all five, [§2.3](#23-the-read-only-deployment-check)), 86400 since 22 November 2026 00:20 UTC (all five, [§6.4](#64-the-window-widened-22-november-2026)); `max_deviation_bps` 1000, that is 10% (all five, read at 20:39 UTC); admin GDZN5W…5NCB (all five); on MOCKGILTS's detail: value bounds none, fallback source none, last rejection none | `stellar contract invoke … --send=no`; `/dashboard/oracle` |
| Oracle feed source | all five: RedStone's SEP-40 feed [CBMGLK…WYRF](https://stellar.expert/explorer/public/contract/CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF) (`decimals()` 8, `resolution()` 43200), keyed by the real asset's contract: USDY [CB3YA6…GAGP](https://stellar.expert/explorer/public/contract/CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP), USTRY [CBLV4A…PNUR](https://stellar.expert/explorer/public/contract/CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR), GILTS [CCQNEB…6XCE](https://stellar.expert/explorer/public/contract/CCQNEBGX5RJQGNLQ25C67DZLOSNM4NFQBANUS3ASALF2X552BSIQ6XCE), CETES [CAL6ER…6VXV](https://stellar.expert/explorer/public/contract/CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV), XAUM [CC2RBG…VAGO](https://stellar.expert/explorer/public/contract/CC2RBGYNCFBCVENIDL5BFBWPH4OUZM2UA3OD2K2N54GLMWCC4KWPVAGO) | `feed_source()` on each OracleAdapter (20:39 UTC) |
| Maturities | 90-day markets: 15 February 2027 (MOCKUSDY), 18 February 2027 (the four others) | manifest; market pages |
| Fees, MOCKUSDY market | tokenization fee 0.05%, YT fee 10.00%, swap fee tier 0.10%, protocol share 20.00% | `/dashboard/markets/mainnet-CDQYZU-CCY5P6CC` |
| Compliance of the underlying | each mock asset's issuer is its SAC admin; issuer flags: authorization required **no**, revocable **yes**, clawback **yes**, the flags real USDY has (contracts doc §3) | `/dashboard/compliance` (Horizon flags, `admin()`) |
| Permissioning | 58 account grants, 80 asset grants, 0 revokes (indexed) | `/dashboard/compliance` |

The protocol-wide limit counts underlying units of five different assets together (one MOCKXAUM follows about 3,558 USD,
one MOCKCETES about 0.06 USD), so it caps volume per asset unit, not value. It was set by the contracts team for a
testing deployment on mock assets.

## 5. The dashboard

### 5.1 Views

| View | URL |
|---|---|
| Overview | <https://principalmarket.fi/dashboard> |
| Markets, and one market | <https://principalmarket.fi/dashboard/markets>, <https://principalmarket.fi/dashboard/markets/mainnet-CDQYZU-CCY5P6CC> |
| Oracle (one per market; `?oracle=<id>` for the detail) | <https://principalmarket.fi/dashboard/oracle> |
| Risk | <https://principalmarket.fi/dashboard/risk> |
| Compliance | <https://principalmarket.fi/dashboard/compliance> |
| Activity | <https://principalmarket.fi/dashboard/activity> |
| Public JSON | <https://principalmarket.fi/api/health>, <https://principalmarket.fi/api/dashboard/alerts>, <https://principalmarket.fi/api/dashboard/oracle-ticks?oracle=CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7&limit=100>, <https://principalmarket.fi/api/dashboard/events?group=oracle>, `https://principalmarket.fi/api/markets/<pool>/history` |
| End-user docs | <https://principalmarket.fi/docs/using-the-app/dashboard> |

No wallet is needed. Each view says its ledger and the age of its reads, and has **Copy evidence table**, which copies
every figure on the page as a Markdown table (dashboard metric, contract, function and parameters, raw value, display
value, ledger, RPC or indexer coverage, cache status, and a blank "Verified" column;
[`evidenceRows`](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/lib/protocol/dashboard/verify.ts#L241-L251)).
Each figure
has an info button, **How to verify**, that names the contract, the function and its arguments, the raw value, the
ledger, the RPC host, and gives one `stellar contract invoke … --send=no` command per read
([verifyCommand, lib/protocol/dashboard/verify.ts](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/lib/protocol/dashboard/verify.ts#L144-L156)).
On Mainnet the command names the public gateway and the passphrase, never the keyed RPC, and uses the null account
`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF` as source.

### 5.2 What the views showed

The overview, read at 20:31 UTC (ledger 65601413), the same as in the screenshot of 20:16 UTC (ledger 65601232):

| Figure | Value |
|---|---|
| Markets | 5 |
| TVL; Pool liquidity | Unavailable, by design: the five markets hold different underlying assets, so their amounts do not add up ([protocol-state.ts lines 125 to 128](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/lib/protocol/dashboard/protocol-state.ts#L125-L128)). Per-market figures are on the markets pages. |
| TVL in USD | 3,285.10 USD (oracle units): each market's TVL times its oracle value |
| RiskControl capacity | 2,749.25 left of 5,000.00 (underlying units) |
| Pauses | None paused |
| Oracles | 1 of 5 fresh (MOCKGILTS); "On a stale oracle's markets, mint, trade, single-sided liquidity and redemption are blocked" |
| Open alerts | 4 open, 4 critical ("Oracle stale (4)") |
| Latest compliance events | Permissioning "Account allowed for an asset", 20 November 2026 around 21:57 UTC |
| Event index | lag about 2 minutes, no gaps; "RecoveryEscrow records match the index (0 of 0)" on all five markets |

The markets page, 20:32 UTC (ledger 65601423):

| Market | PT / YT supply | Pool reserves | Pool liquidity | TVL | TVL in USD |
|---|---|---|---|---|---|
| MOCKUSDY | 115.28 / 115.28 | 65.00 PT, 45.69 SY | 101.33 MOCKUSDY | 200.00 MOCKUSDY | 230.78 |
| MOCKUSTRY | 270.11 / 270.11 | 151.00 PT, 124.08 SY | 261.75 MOCKUSTRY | 500.00 MOCKUSTRY | 540.55 |
| MOCKGILTS | 351.46 / 351.46 | 181.00 PT, 124.29 SY | 252.41 MOCKGILTS | 500.00 MOCKGILTS | 703.40 |
| MOCKCETES | 15.54 / 15.54 | 11.00 PT, 134.26 SY | 305.14 MOCKCETES | 500.00 MOCKCETES | 31.12 |
| MOCKXAUM | 886.12 / 886.12 | 805.00 PT, 0.19 SY | 0.42 MOCKXAUM | 0.50 MOCKXAUM | 1,779.23 |

Each market's page adds its settlement state, unclaimed fees, fee recipients and a **Pending yield** lookup: any
account or contract address, answered with what it would be paid by claiming its YT yield now. On MOCKUSDY's page at
20:58 UTC, the contracts team's test account GCOMBI…R5BM gave "0.0366073 MOCKUSDY", net of the YT fee (10.00%).

### 5.3 One "How to verify" command, run as copied

On `/dashboard/oracle?oracle=CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7`, the drawer of **Time until
operations block · MOCKGILTS** showed, at 20:31 UTC: value 39m 2s; raw value `get_reference_timestamp=1795291830;
max_stale_seconds=3600; is_available=true`; ledger 65601404; RPC endpoint `lb.drpc.live`, fallback
`soroban-rpc.mainnet.stellar.gateway.fm`; and three commands. We copied them and ran them at 20:31:38 UTC with the
Stellar CLI 30.0.1:

```bash
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7 --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- get_reference_timestamp
# 1795291830   (= 2026-11-21 20:10:30 UTC)
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7 --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- max_stale_seconds
# 3600
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7 --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- is_available
# true
```

The chain gave the drawer's values. 1795291830 + 3600 − ledger time = the countdown the page showed. Since 22 November,
`max_stale_seconds` answers `86400` ([§6.4](#64-the-window-widened-22-november-2026)).

### 5.4 Screenshots

In [tranche-3/](tranche-3/), taken on 21 November 2026 between 20:16 and 20:18 UTC on <https://principalmarket.fi>
(the deployment of [§1.1](#11-the-site-and-its-deployment)) by
`pnpm dashboard:layout --base https://principalmarket.fi --theme light|dark --shots <dir>`:

| File | What |
|---|---|
| `01-overview.png` | the overview, desktop, light |
| `02-markets.png` | the markets list |
| `03-market-mockusdy.png` | the MOCKUSDY market |
| `04-oracle.png` | the oracle page |
| `05-risk.png` | the risk page |
| `06-compliance.png` | the compliance page |
| `07-activity.png` | the activity page |
| `08-overview-dark.png` | the overview, dark theme |
| `09-oracle-375px.png` | the oracle page at 375 px wide |
| `10-oracle-how-to-verify-375px.png` | a "How to verify" drawer at 375 px (Time until operations block · MOCKUSDY: `is_available=false`) |

The same run checks the layout at 375 px. It passed 23 of 24 checks in each theme. The one failure: on
`/dashboard/activity` a table scrolls 5 px inside its card (scrollWidth 348, clientWidth 343). A known minor layout
issue ([§10](#10-open-items), item 5).

## 6. The oracle keeper

### 6.1 How it runs

`/api/cron/oracle` runs every 5 minutes (minutes 2 to 57). In each run it reads every OracleAdapter of the manifest and
its feed. When the feed has a newer price than the oracle holds, it calls `sync_from_feed` from the keeper account
GBLY3F…MZXS; otherwise it records "Skipped: the feed had nothing newer" and sends nothing. `sync_from_feed` is
permissionless: the oracle reads its own configured feed, and the keeper only pays the fee. Its runs are public:
`/api/dashboard/oracle-ticks` and the **Keeper** section of the oracle page. Between 14:02 and 20:22 UTC the API lists
372 skipped runs (reason `stale_ts`), 5 syncs and 8 failed runs (all before the fee fix, [§1.3](#13-what-the-first-scheduled-runs-found)).

### 6.2 Its transactions

From Horizon, `https://horizon.stellar.org/accounts/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS/transactions`,
read at 20:26 UTC. All successful. The target oracle is decoded from each transaction's operation (Horizon
`/transactions/<hash>/operations`, the first parameter, an `ScAddress`) and agrees with the oracle-ticks API.

| UTC | Ledger | Oracle (asset) | Value set | `max_fee` | `fee_charged` | Transaction |
|---|---|---|---|---|---|---|
| 21 Nov 2026 20:12:06 | 65601176 | CD22HN…J6X7 (MOCKGILTS) | 1.4068080 | 126,522 | 97,885 | [ce93f473…9508](https://stellar.expert/explorer/public/tx/ce93f473351cb9d024860f403e9e4f87a07a42dc7c0568e84ce36f7d28399508) |
| 21 Nov 2026 14:12:21 | 65596859 | CDFI7I…OPFD (MOCKXAUM) | 3558.4610000 | 116,912 | 98,144 | [d4f68989…932d](https://stellar.expert/explorer/public/tx/d4f6898957af7fbc5d9d370e2573c465cdb308e3eeeb6891efeb1f1e77f6932d) |
| 21 Nov 2026 14:12:16 | 65596858 | CBK2GO…MUZK (MOCKCETES) | 0.0622530 | 116,854 | 98,087 | [7e13f19a…d721](https://stellar.expert/explorer/public/tx/7e13f19a36d5954c018382ebeb7b4ebbf2453c09a5dffa3a5c1962168048d721) |
| 21 Nov 2026 14:12:11 | 65596857 | CBTW7C…PFR7 (MOCKUSTRY) | 1.0811020 | 116,830 | 98,066 | [7e761ff5…8876](https://stellar.expert/explorer/public/tx/7e761ff50206d837f9d7eaa7205a97fb63e5e1e805bc51a189fab64be4b18876) |
| 21 Nov 2026 14:12:06 | 65596856 | CCKXG4…K7IT (MOCKUSDY) | 1.1539439 | 10,222 | 5,375 | [2f2c155e…c9a1](https://stellar.expert/explorer/public/tx/2f2c155eafd75ed1279d82090ce9563c8fe7fe308655d8340e47bd1a133bc9a1) |

Fees are in stroops (1 XLM = 10,000,000 stroops). A sync cost about 98,000 stroops (0.0098 XLM) on the four v2 oracles
and 5,375 on MOCKUSDY's. The 14:12 syncs were built with the old 100-stroop bid; the 20:12 sync is the first with the
10,000-stroop bid.

The account has two more transactions, neither of them a keeper sync:
- 12:27:26 UTC, ledger 65595600, [370aa9de…96bb](https://stellar.expert/explorer/public/tx/370aa9de31add795f934d0ac9b57ab10aa95aca035767a47a8423a1b3b6e96bb):
  the account's creation, with 20 XLM;
- 12:27:36 UTC, ledger 65595602, [5f67d96f…ce4b](https://stellar.expert/explorer/public/tx/5f67d96f5adaec4bc7091d8e03e92ee3b382d3eedeb2bb623a5de811b2ebce4b):
  an unsolicited payment of 0.0001 XLM from an unknown account whose address begins and ends like the funding
  account's (an address-poisoning pattern seen on new Mainnet accounts).

Balance at 20:26 UTC: 19.9603443 XLM, which is 20 + 0.0001 − the five fees (0.0397557). The account has no trustline
and one signer.

### 6.3 Freshness, and why most oracles are stale

`sync_from_feed` stores the feed tick's own timestamp, not the ledger time
([oracle_adapter/src/lib.rs line 501](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L501);
a tick no newer than the stored one is refused `stale_ts`,
[line 572](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L572)).
RedStone's feed on Stellar publishes each price every few hours or less often (`resolution()` 43,200 s). With
`max_stale_seconds` 3600, an oracle is therefore fresh only during the hour after each RedStone tick, however often
the keeper runs. At 20:24 UTC the stored values were 8h 48m (MOCKUSDY, MOCKUSTRY), 10h 20m (MOCKCETES), 10h 26m
(MOCKXAUM) and 14m (MOCKGILTS) old, each equal to the feed's latest price ([§2.3](#23-the-read-only-deployment-check)).

Only the oracle admin, the contracts team, can widen the window, with
[`set_safety_params(caller, max_stale_seconds, max_deviation_bps)`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L292).
They did so on 22 November ([§6.4](#64-the-window-widened-22-november-2026)).

### 6.4 The window widened, 22 November 2026

The oracle admin GDZN5W…5NCB called `set_safety_params(caller, 86400, 1000)` on the five OracleAdapters: the window
went from 3,600 s (1 hour) to 86,400 s (24 hours), and the deviation cap stayed at 1,000 bps. From Horizon, all
successful:

| UTC, 22 Nov 2026 | Ledger | Oracle (asset) | Transaction |
|---|---|---|---|
| 00:19:26 | 65604144 | CCKXG4…K7IT (MOCKUSDY) | [73f87169…2c6c](https://stellar.expert/explorer/public/tx/73f87169f0a6adf4af3fe73695bce0ef087fbae2d7d168f1a90a381ebd202c6c) |
| 00:19:36 | 65604146 | CBTW7C…PFR7 (MOCKUSTRY) | [96cf75a8…e199](https://stellar.expert/explorer/public/tx/96cf75a8cca49b8370131c41c7ecb983d96ee17ffb1144d0a2fc7b90c722e199) |
| 00:19:46 | 65604148 | CD22HN…J6X7 (MOCKGILTS) | [cf539412…d30a](https://stellar.expert/explorer/public/tx/cf5394127d52a399e81b69dbb24f180829c60f6d76f24881c7164ca39af5d30a) |
| 00:19:56 | 65604150 | CBK2GO…MUZK (MOCKCETES) | [5028e019…830e](https://stellar.expert/explorer/public/tx/5028e019162bb022aa9ac5c0300c6f0f8d97b63e91f20a356ee26a16df9a830e) |
| 00:20:06 | 65604152 | CDFI7I…OPFD (MOCKXAUM) | [9d59d0b4…7f52](https://stellar.expert/explorer/public/tx/9d59d0b4fb028f5f0ece56b155814af251bf6c72a7f68cc97eba0dcd24e67f52) |

The contracts team records them in
[MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md)
§13 (which dates our report 22 November; it was 21 November).

Read live on 22 November around 16:35 UTC (`stellar contract invoke … --send=no` on the public gateway):

| Oracle | `max_stale_seconds` | `max_deviation_bps` | `is_available` | Age of the stored value |
|---|---|---|---|---|
| MOCKUSDY | 86400 | 1000 | true | 4 h 57 m |
| MOCKUSTRY | 86400 | 1000 | true | 4 h 57 m |
| MOCKGILTS | 86400 | 1000 | true | 20 h 23 m (tick of 21 Nov 20:10:30) |
| MOCKCETES | 86400 | 1000 | true | 6 h 29 m |
| MOCKXAUM | 86400 | 1000 | true | 6 h 35 m |

The last critical `oracle_stale` alerts (MOCKGILTS, MOCKCETES, MOCKXAUM) resolved at 00:20 and 00:25 UTC, right after
the change; MOCKUSDY's and MOCKUSTRY's had resolved at 23:40 UTC on 21 November, after a feed tick. At 16:32 UTC
`/api/health` reported 1 open alert, 0 critical, and a healthy keeper for all five oracles. At 17:42 UTC the `mint`
simulation of [§7](#7-a-stale-oracle-blocks-operations) gave error 11 on both MOCKUSDY and MOCKGILTS: both oracles
fresh, the compliance check refusing an account without a trustline.

**MOCKGILTS.** The feed keeps the last 10 prices of each asset (`prices(asset, 10)`). In those records, USDY, USTRY,
CETES and XAUM tick at least every 43,220 s (12 hours). GILTS once went 86,410 s without a tick, from 20 November
20:10:20 to 21 November 20:10:30 UTC: 10 s more than the new window. On such a day the MOCKGILTS oracle turns stale
for a few minutes, until the next tick and the keeper's next sync. The app sees it coming: an `oracle_warning` on
MOCKGILTS opened at 14:15 UTC on 22 November. Only the oracle admin can widen this oracle's window
([§10](#10-open-items), item 1).

## 7. A stale oracle blocks operations

Two simulations of the same call, `mint(from, sy_shares = 1)` on a market's PrincipalManager, on 21 November 2026 at
20:30:21 UTC (ledger 65601398), through the public gateway, with `--send=no`: nothing was signed or sent. The source
and `from` account is the oracle admin's public address, GDZN5W…5NCB; any funded public account gives the same
result.

| Market | Its oracle's `is_available()` | `mint` simulation |
|---|---|---|
| MOCKUSDY (manager CBBKUZ…UKCC) | `false` | `HostError: Error(Contract, #7)` |
| MOCKGILTS (manager CCDSON…7GBS) | `true` | `HostError: Error(Contract, #11)` |

Repeated with `-v`, MOCKUSDY's at 20:30:58 UTC and MOCKGILTS's at 20:48:35 UTC, they gave the same two errors.

The diagnostic events (`stellar contract invoke -v …`, or the RPC's `simulateTransaction`) show who raised each error:
- MOCKUSDY: the manager calls `is_available` on CCKXG4…K7IT, which returns `false`; the manager then fails with its own
  error 7.
- MOCKGILTS: the manager calls `is_available` on CD22HN…J6X7, which returns `true`; it then calls `authorized` on the
  MOCKGILTS asset contract, which fails ("trustline entry is missing for account"); the manager then fails with its
  own error 11.

In PrincipalManager at `3af9388`, error 7 is
[`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L221)
and error 11 is
[`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L224).
[`mint`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L362-L374)
checks the oracle
([`assert_oracle_fresh`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L914-L923))
before the compliance checks
([`assert_sac_authorized`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L945-L950)).
So error 7 is the stale oracle blocking the mint; error 11 means the oracle check passed and the compliance check
refused an account that holds no trustline to the asset.

The other contracts check the same way: MarketPool
([line 1457](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/market_pool/src/lib.rs#L1457),
error 13 `OracleStale`) and YTToken
([lines 248](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/yt_token/src/lib.rs#L248)
and [679](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/yt_token/src/lib.rs#L679),
error 10 `OracleStale`). The OracleAdapter's own `assert_available()` raises error 8, `OracleUnavailable`.

The app refuses the same actions before asking for a signature. On <https://principalmarket.fi/app/markets/mainnet-CDQYZU-CCY5P6CC>, with no wallet, at 20:51 UTC, the trade panel's
**Signing is off** box listed "The oracle price is stale: it has not been updated in the last 1 hour. Wait for the
next oracle update, then try again."

Freshness moves with RedStone's ticks: a later run can find any market fresh or stale. Read `is_available()` first; it
tells which of the two results to expect. Since the window was widened on 22 November, a stale oracle is rare: at
17:42 UTC that day both simulations gave error 11 ([§6.4](#64-the-window-widened-22-november-2026)). The stale case
above is the record of 21 November.

## 8. Alerts

Source: <https://principalmarket.fi/api/dashboard/alerts> (public, read-only), read at 20:25 UTC, and
[app/api/cron/alerts/route.ts](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/app/api/cron/alerts/route.ts#L4-L14).

| Item | Value |
|---|---|
| Test alert | `lastTest`: opened 2026-11-21 13:59:49 UTC, `delivered: true` (the webhook took it) |
| Stale-oracle alerts | five critical `oracle_stale` alerts opened at 15:00:03 UTC, one per oracle, each with `asset`, `ageSeconds`, `secondsToBlock` and `maxStaleSeconds` in its payload. The developer's record of that run's answer: 5 posted, 0 post failures. |
| Still open at 20:25 UTC | four: MOCKUSDY, MOCKUSTRY, MOCKCETES, MOCKXAUM (`open`); `/api/health` says 4 open, 4 critical |
| Resolved | MOCKGILTS at 20:15:01 UTC (`recent`, `resolvedAt`), three minutes after the keeper's 20:12:06 sync made its oracle fresh. It opens again when that oracle goes stale, about an hour after its tick of 20:10:30 UTC. |
| 22 November 2026, 16:32 UTC | after the window was widened ([§6.4](#64-the-window-widened-22-november-2026)): no critical alert open; one `oracle_warning` on MOCKGILTS, opened at 14:15 UTC, with `maxStaleSeconds` 86400 in its payload |
| Delivery | each opening and close is posted to the team's alert channel, a Telegram group. Its address is not public. The public endpoint shows whether the last test was delivered; it does not show the delivery of each alert. |
| Other kinds checked every 5 minutes | per oracle: `oracle_warning`, `oracle_unavailable`, `oracle_rejection`, `feed_broken`, `keeper_unhealthy`; also `seed_invalid`, `risk_warning`, `risk_exhausted`, `indexer_gap` and `signer_low` (the keeper's XLM) ([README "Alerts"](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/README.md#alerts)) |
| The scheduler sees red | the scheduled route `/api/cron/alerts` answers HTTP 500 while any critical alert is open, by design, so the scheduler's own failure alert fires too ([line 69](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/app/api/cron/alerts/route.ts#L69)). The public read endpoint above answers 200. |

## 9. RecoveryEscrow and the safety feeds, exercised on Testnet

On Mainnet no seizure has happened: all five RecoveryEscrows read `record_count` 0, and the index holds 0 records
(`/dashboard/compliance`). To show that the dashboard surfaces a seizure, a rejected oracle update and a pause, a drill
ran on **Stellar Testnet**, on the official Testnet market `testnet-usdy-1802336344` (contracts `665bb67`), on
21 November 2026. Its events, from <https://testnet.principalmarket.fi/api/dashboard/events>:

| UTC | Ledger | Contract | Event | Transaction (Testnet) |
|---|---|---|---|---|
| 01:47:26 | 5840401 | RecoveryEscrow CAMOWB…N24Q | `recovery`, record 0: account GAQTES…4GKG, 5 SY, 5.0024795 PT, 5.0024795 YT | [0221e7ca…50e3](https://stellar.expert/explorer/testnet/tx/0221e7caa4e4041a59ecbe7d1b5f941f47d7a35937bc96a5a9701178367d50e3) |
| 01:47:26 | 5840401 | SYWrapper CA62AC…7F2I | `seize`, 5 SY, same transaction | [0221e7ca…50e3](https://stellar.expert/explorer/testnet/tx/0221e7caa4e4041a59ecbe7d1b5f941f47d7a35937bc96a5a9701178367d50e3) |
| 01:47:31 | 5840402 | OracleAdapter CDYGBF…YIPS | `ref_rej`, reason `deviate`: 1.1511459 refused against 1.0009964 (+15%) | [f5ec58b7…49e1](https://stellar.expert/explorer/testnet/tx/f5ec58b734a690f256615f6d9ff453b11248a01e717971a4adbc1e9f32e049e1) |
| 01:47:41 | 5840404 | OracleAdapter CDYGBF…YIPS | `ref_set`, 1.0009980 | [400ca990…00df](https://stellar.expert/explorer/testnet/tx/400ca9902dad9ee092df2b65eada838b736eae56cdd19c4055eeb52a13f100df) |
| 01:47:51 | 5840406 | RiskControl CCRZ55…MHJC | `paused` true | [17fa81b3…0eed](https://stellar.expert/explorer/testnet/tx/17fa81b3175c0c12a6e613d8f1be0892d539e9b3c665f5aaccbb6cbe6fa80eed) |
| 01:48:11 | 5840410 | RiskControl CCRZ55…MHJC | `paused` false | [5250db2c…99bd](https://stellar.expert/explorer/testnet/tx/5250db2cd2d60b89e623afdd7823600f70c9a3b45818c1ac1998d51baa6999bd) |

Seen at 20:58 UTC on 21 November 2026: <https://testnet.principalmarket.fi/dashboard/compliance> shows "record_count 1,
indexed 1: they match", record 0 (5.00 SY, 5.00 PT, 5.00 YT held, seized at ledger 5840401) and the seizure in
**Seizure history**; `/dashboard/oracle` shows **Last rejection** "Moved more than the cap · value 1.1511459 … reason
deviate" and the same row in **Rejection history**; `/dashboard/risk` shows the pause and the unpause in **Pause
history**. The Mainnet dashboard runs the same code on the same views.

## 10. Open items

| # | Item | Owner | Reason |
|---|---|---|---|
| 1 | **MOCKGILTS's staleness window.** On 21 November the window was 3,600 s on all five oracles, and each was fresh only in the hour after a RedStone tick ([§6.3](#63-freshness-and-why-most-oracles-are-stale)). Since 22 November it is 86,400 s, and the four other feeds tick every 12 hours. GILTS once went 86,410 s without a tick, so the MOCKGILTS oracle can turn stale for a few minutes on a day without a GILTS tick ([§6.4](#64-the-window-widened-22-november-2026)). | contracts team | Only the oracle admin can widen this oracle's window (`set_safety_params`, for example to 172,800 s). |
| 2 | **The dApp's own signed smoke test on Mainnet**: a small deposit and mint through principalmarket.fi, with their two hashes. | developer, after the contracts team | Needs a test wallet granted on the markets (only the contracts team's Permissioning admin can). It is signed by the developer, never by an agent or a test. The contracts team's command-line deposits and mints are in [§3.1](#31-deposit-and-mint-on-every-market). |
| 3 | **Reproducing the build.** On Linux x86_64 with rustc 1.94.1, a rebuild reproduces the two contracts that embed no machine path (Permissioning, RiskControl); the ten others embed the original builder's cargo path ([§3.2](#32-the-reproducible-build)). | contracts team | A rebuild of `3af9388` on Linux x86_64 with rustc 1.94.1 and that cargo path, in the contracts repository's CI, is expected to give 12 of 12; not run yet. On other hosts (macOS, Linux arm64) the bytes differ, so the recipe must name the host. |
| 4 | **Contract lifetimes.** The Mainnet contract instances live until about 17 to 21 March 2027 ([§2.4](#24-how-long-the-contracts-live)). | contracts team, operations | Someone must extend them (and the code entries) before mid-March 2027. |
| 5 | **Layout:** a table on `/dashboard/activity` scrolls 5 px inside its card at 375 px. | app team | Minor; found by the layout check of [§5.4](#54-screenshots). |
| 6 | **The contracts team's manifest caveats:** duplicate hashes in MOCKUSDY's `transactions[]` and `git_tree_dirty: true` ([§3.3](#33-the-deployment-manifests)). | contracts team | Stated so that no hash is cited under the wrong step. |
