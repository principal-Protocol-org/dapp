# Tranche 3 (Mainnet): evidence

The addresses, hashes, transactions and live reads behind [TRANCHE_3_REVIEW.md](TRANCHE_3_REVIEW.md), as of
23 November 2026. All times are UTC. Every address is public; no key and no keyed RPC URL appears here.

The five markets use mock assets issued by Principal for testing (MOCKUSDY, MOCKUSTRY, MOCKGILTS, MOCKCETES, MOCKXAUM).
Each market's OracleAdapter reads the real asset's price from RedStone's SEP-40 feed on Mainnet.

## 1. The site

| Item | Value |
|---|---|
| Site | <https://principalmarket.fi>: the app at `/app`, the dashboard at `/dashboard`, the docs at `/docs` |
| Go-live | 21 November 2026, 12:39 UTC |
| App code | [`783d51c`](https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd); later commits on `main` change only documentation |
| CI on that code | [CI run 44919042817](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042817): green. [E2E run 44919042837](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042837): Suite A 13 of 13, Suite B 10 of 10, on Stellar Testnet (Suite B deploys the Mainnet source commit `3af9388` there) |
| Scheduled jobs | `/api/cron/index` (the event index), `/api/cron/oracle` (the keeper) and `/api/cron/alerts` every 5 minutes, `/api/cron/record` (rates) every 15; <https://principalmarket.fi/api/health> shows them running |

## 2. Contracts

Source: the app's manifest, [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json), source commit
[`3af9388`](https://github.com/principal-Protocol-org/principal/tree/3af938853e5818aa8d56bd35670b9a19cfa55a78). Its
addresses and hashes equal the contracts team's
[deployments/mainnet-dapp-manifest.json](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-dapp-manifest.json). The contracts team's
deployment record is one manifest per market, with every address, wasm SHA-256 and transaction:
[MOCKUSDY](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-mockusdy/deployment-manifest.json),
[MOCKUSTRY](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-ustry/deployment-manifest.json),
[MOCKGILTS](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-gilts/deployment-manifest.json),
[MOCKCETES](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-cetes/deployment-manifest.json),
[MOCKXAUM](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet-xaum/deployment-manifest.json). All five say `git_tree_dirty: true`, and MOCKUSDY's
`transactions[]` lists two hashes under wrong steps; its per-contract `deploy_tx` and `init_tx` fields are right.

### 2.1 Addresses

Shared contracts:

| Contract | Address |
|---|---|
| Router | [CCM4QQ…7QF5](https://stellar.expert/explorer/public/contract/CCM4QQUKTD2CUTRSNNI6OO4JHYEF7MHKBMKSM5JYJNFLKSTAZBQD7QF5) |
| Permissioning | [CBCWU5…RTXJ](https://stellar.expert/explorer/public/contract/CBCWU57AILKFDOYQAESFRPH57Q6UK66E7RBYV4ICZHNNGWIWFAHVRTXJ) |
| RiskControl | [CBHCRR…WQ5G](https://stellar.expert/explorer/public/contract/CBHCRRLWHS7KRQNAXYY3OMNDTSXDNJKCDK6KPUUJPFGDBSN76JEWWQ5G) |
| MarketFactory | [CDYH7U…S65T](https://stellar.expert/explorer/public/contract/CDYH7UV24XS7G7MDRTBJUS4PJNKKUXTLUUTL67MR5CYJAXSPPHNWS65T) |

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

The contract instances live until about 17 to 21 March 2027 (read on 21 November 2026, ledger 65601474).

### 2.2 Code hashes

The 12 contract codes, as built by the contracts team and pinned in the manifest's `wasmHashes`. Every market uses the
same eight per-market codes.

| Contract | `wasmHashes` key | SHA-256 |
|---|---|---|
| Router | `router` | `2a0997317651edb0f7e2bd753570b03a88462aa6d216c14b06ebec246bb3c1c2` |
| Permissioning | `permissioning` | `4437468dbbda6d86a115f188de877135b0b5a400b69ad7e9444cf269c54f969c` |
| RiskControl | `riskControl` | `ac75508d24c5457de7db1106bf8b5e9b62ea436f3dfd1a309fda5138110c2526` |
| MarketFactory | `factory` | `6c21fc0e78f3064f67ae30924b8f9ca0223fbb61a20ac640cceca7b152456759` |
| OracleAdapter | `oracle` | `8581bbba82bb57f5c5c9c00adf98b1691ad20821840e55a67ad8d7ecace0c1b0` |
| SYWrapper | `sy` | `be4b12cf3c16461b7e71fa225ed2363aba62bdc42c1ea5c08c98d7ede6a27c9a` |
| PTToken | `pt` | `db025340887ef9d92922e2444da24edab5fec125460e9adc373a5f77b26578b2` |
| YTToken | `yt` | `c83a2a8d2a4a79ff5348675581a27d48e52a920d83dc887672840d4a79c02654` |
| MarketConfig | `config` | `11b0cbdf10a8d204fcb568c54529801747feac05208c5bcbfaefd822ad0c79a8` |
| PrincipalManager | `manager` | `e2d04b45b867d0dbc41660ac0d97d3e705005ddfb10350bb030d25b1aff86115` |
| MarketPool | `pool` | `52285a25bbf372d0e5d22ba565b76af6a7e832422df83b6a4809de8adf3aa112` |
| RecoveryEscrow | `recoveryEscrow` | `dadea71fcfb84adcfb4691f472551f490cf440c5aaae5c6b5e5d4bb6f61441e8` |

### 2.3 The read-only deployment check

`pnpm smoke:mainnet` ([scripts/smoke.mjs](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/scripts/smoke.mjs)), run on 23 November 2026 at 01:38 UTC. It needs no
key and signs nothing. It reads each market's topology, each oracle and the pauses, and the code hash of every manifest
contract, which it compares with `wasmHashes`.

```text
Principal deployment check: mainnet, ledger 65622369 (2026-11-23T01:38:11.000Z), RPC lb.drpc.live, contracts at 3af9388

Market                             Topology  Oracle              Feed                               Value against feed                   Paused
---------------------------------  --------  ------------------  ---------------------------------  -----------------------------------  ------
MOCKUSDY mainnet-CDQYZU-CCY5P6CC   match     fresh, 2h 1m old    1.1541186 (CBMG…WYRF, 2h 1m old)   1.1541186 stored: Equal              no
MOCKUSTRY mainnet-CDHQ4B-CAFCV4KB  match     fresh, 2h 1m old    1.081268 (CBMG…WYRF, 2h 1m old)    1.081268 stored: Equal               no
MOCKGILTS mainnet-CBBF4H-CBYNXSR3  match     fresh, 26m 41s old  1.409654 (CBMG…WYRF, 26m 41s old)  1.409654 stored: Equal               no
MOCKCETES mainnet-CBVSL3-CBAUFMQH  match     fresh, 1h 37m old   0.062508 (CBMG…WYRF, 1h 37m old)   0.062508 stored: Equal               no
MOCKXAUM mainnet-CBAJVV-CDG77CSN   match     fresh, 23m 11s old  3621.5940 (CBMG…WYRF, 41s old)     3634.9440 stored: Differs by 0.36 %  no
shared contracts                   -         -                   -                                  -                                    no

PASS: 5 of 5 topologies match, 44 of 44 code hashes match (12 pinned hashes), 0 failed reads; 5 oracles: 5 fresh; nothing paused
```

### 2.4 Roles

| Role | Address | Source |
|---|---|---|
| Protocol admin (contracts team): admin of the five OracleAdapters, a pauser by RiskControl's rule, the protocol admin of the markets' fees | [GDZN5W…5NCB](https://stellar.expert/explorer/public/account/GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB) | `get_admin` on each OracleAdapter; the risk page; the market pages |
| Issuers (contracts team): one per mock asset, the SAC admin of its asset and the market's creator | [§2.1](#21-addresses) | the compliance page |
| Treasury: receives the protocol's fee share | [GBUVAH…VSXW](https://stellar.expert/explorer/public/account/GBUVAHYJNCXZWUK3NIOVJ6EYQRSXMVT2XOUEASS3VAG4EWIXXWYSVSXW) | the market pages |
| The contracts team's test account, which signed their deposits and mints ([§3.1](#31-on-every-market-by-the-contracts-team)) | [GCOMBI…R5BM](https://stellar.expert/explorer/public/account/GCOMBIYWZ3HIMAS7FLFERQMVZIDVIMFZAAV7A2KMCDV3RAKP5NL5R5BM) | Horizon |
| The developer's test wallet, which signed the app's smoke test ([§3.2](#32-through-the-app)); granted on all five markets by the contracts team | [GBQEUZ…7VNH](https://stellar.expert/explorer/public/account/GBQEUZZ6HRC7RFT23LWWQWWZ5RQMGCGE4GUCKYKKI2EXDABJA4NS7VNH) | Horizon; `is_allowed` and `is_allowed_for_asset` on Permissioning |
| The app's oracle keeper: no role in any contract; it only pays the fees of `sync_from_feed`, which anyone may call | [GBLY3F…MZXS](https://stellar.expert/explorer/public/account/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS) | the oracle page's keeper runs; Horizon ([§7](#7-the-oracle-keeper-and-freshness)) |

## 3. Deposit and mint

### 3.1 On every market, by the contracts team

From the command line, with their test account GCOMBI…R5BM. Each is successful on Horizon (read on 21 November 2026).

| Market | Deposit (`deposit` on its SYWrapper) | Mint PT + YT (`mint` on its PrincipalManager) |
|---|---|---|
| MOCKUSDY | 17 Nov 2026 19:56:57, ledger 65531875, [972727f7…0776](https://stellar.expert/explorer/public/tx/972727f72064f9acd6955339a84c544157bcb5ebc113c19ee3cd25a325ef0776) (200 MOCKUSDY) | 17 Nov 2026 19:57:12, ledger 65531878, [ddbdd136…4906](https://stellar.expert/explorer/public/tx/ddbdd13683ffd9b93509d9c223556aaa04d57c2d0870195db304580b8e2b4906) (100 SY) |
| MOCKUSTRY | 20 Nov 2026 21:25:09, ledger 65584773, [c6ad5969…9ac0](https://stellar.expert/explorer/public/tx/c6ad5969682b72ac523cb5b87bdf892d7649510b0b5456de6ce801b1b1919ac0) | 20 Nov 2026 21:25:24, ledger 65584776, [1255f5b7…66e3](https://stellar.expert/explorer/public/tx/1255f5b7651caa4f21355ff5cf7ec9574126f5768dae417361b209d2488266e3) |
| MOCKGILTS | 20 Nov 2026 21:38:04, ledger 65584928, [09467f11…0c23](https://stellar.expert/explorer/public/tx/09467f11b8d2003202e13018c8b49e0be5351dcc1e84c710fb5d5da067940c23) | 20 Nov 2026 21:38:09, ledger 65584929, [3e45a960…6c14](https://stellar.expert/explorer/public/tx/3e45a960cd22871bae106573ea455e2adae3ef6d576c1dd244ea21d8b2cd6c14) |
| MOCKCETES | 20 Nov 2026 21:49:14, ledger 65585062, [9f71d18b…36f3](https://stellar.expert/explorer/public/tx/9f71d18bcfbd21902c6f283128450401e0180780439bd2746981eb633a9236f3) | 20 Nov 2026 21:49:19, ledger 65585063, [4240d062…45be](https://stellar.expert/explorer/public/tx/4240d062f34ff6f10b39c7784006f8a5b9ad18d148483e578b912471ea0a45be) |
| MOCKXAUM | 20 Nov 2026 21:59:24, ledger 65585184, [2c1d8e23…25f5](https://stellar.expert/explorer/public/tx/2c1d8e23e329e0208a7095c7842e0b6e616712cb572fb682d50a82b1678025f5) | 20 Nov 2026 21:59:34, ledger 65585186, [83b5529b…ebc1](https://stellar.expert/explorer/public/tx/83b5529b6203b39348c0568dbebb4531a6f4b7dbdc56c4db491ec2da1553ebc1) |

### 3.2 Through the app

Signed in principalmarket.fi with the developer's test wallet GBQEUZ…7VNH, which the contracts team granted on all five
markets. Both successful on Horizon.

| Step in the app | Call | Transaction |
|---|---|---|
| Quick actions → "Deposit MOCKUSDY → SY", 1 MOCKUSDY | `deposit` on MOCKUSDY's SYWrapper `CCY5P6…GJ7Q` | 23 Nov 2026 18:21:41 UTC, ledger 65634411, [5eb41384…4c67](https://stellar.expert/explorer/public/tx/5eb413846ea858d1ef014afab5c609823099585bb3709019b43f482a3b974c67) |
| Quick actions → "Split MOCKUSDY → PT + YT", 1 MOCKUSDY | `wrap_and_mint` on the Router `CCM4QQ…7QF5`: deposit and mint in one transaction | 23 Nov 2026 18:32:51 UTC, ledger 65634545, [dba674d5…5ee6](https://stellar.expert/explorer/public/tx/dba674d509368d8eae9b00b3a74c7f016da05fd08de9e7ddebfd4a1db3045ee6) |

## 4. The reproducible build

The contracts team's build: `cargo build --workspace --release --target wasm32v1-none` at `3af9388`, rustc 1.94.1
(pinned by `rust-toolchain.toml`); its 12 SHA-256 are in [§2.2](#22-code-hashes). Their recipe:
[deployments/mainnet/reproducible-build.md](https://github.com/principal-Protocol-org/principal/blob/15b1ec5354a722b227085d1211e7120a14ae20e3/deployments/mainnet/reproducible-build.md).

Ten of the twelve files contain the original build's cargo directory (`/home/<user>/.cargo/…`, masked here); Permissioning
and RiskControl contain none. A rebuild matches only if it maps its own cargo directory to that path, as the command
in the reviewer guide, 1.4, does.

| Rebuild (rustc 1.94.1) | Result |
|---|---|
| The contracts team, Linux x86_64, `3af9388`, cargo directory mapped to the recorded path (23 November 2026) | 12 of 12 equal the on-chain hashes; no public log yet |
| The contracts team's CI, [run 45141813086](https://github.com/principal-Protocol-org/principal/actions/runs/45141813086), Linux x86_64, default mapping | Permissioning and RiskControl equal the on-chain hashes; the 10 others carry another path |
| macOS arm64, Linux arm64 | 0 of 12: the host changes the bytes |

## 5. The configuration

Read from the dashboard and with `stellar contract invoke … --send=no` on 21 to 23 November 2026. The dashboard gives
the current values.

| Setting | Value | Read from |
|---|---|---|
| RiskControl, protocol-wide limit | 5,000.00 in underlying units, per sliding window of 17,280 ledgers (about 24 hours); the page shows the volume counted now and the remaining capacity (a wrap-and-mint counts twice) | `/dashboard/risk` |
| RiskControl, per-asset limits | MOCKUSDY 5,000.00 (set 17 Nov 2026 15:55:32, `48092a…f372`), MOCKUSTRY 5,000.00 (set 17 Nov 2026 20:52:32, `946d7e…2c14`); MOCKGILTS, MOCKCETES, MOCKXAUM: no limit | `/dashboard/risk` |
| Pauses | RiskControl, and each market's SYWrapper, PrincipalManager and MarketPool: not paused. Pause history: none recorded. | `/dashboard/risk` |
| Oracles | each market's own OracleAdapter; `max_stale_seconds` 86400, that is 24 hours, and 172800 (48 hours) on MOCKGILTS ([§7](#7-the-oracle-keeper-and-freshness)); `max_deviation_bps` 1000, that is 10%; admin GDZN5W…5NCB (all five); on MOCKGILTS's detail: value bounds none, fallback source none | `stellar contract invoke … --send=no`; `/dashboard/oracle` |
| Oracle feed source | all five: RedStone's SEP-40 feed [CBMGLK…WYRF](https://stellar.expert/explorer/public/contract/CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF) (`decimals()` 8, `resolution()` 43200), keyed by the real asset's contract: USDY [CB3YA6…GAGP](https://stellar.expert/explorer/public/contract/CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP), USTRY [CBLV4A…PNUR](https://stellar.expert/explorer/public/contract/CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR), GILTS [CCQNEB…6XCE](https://stellar.expert/explorer/public/contract/CCQNEBGX5RJQGNLQ25C67DZLOSNM4NFQBANUS3ASALF2X552BSIQ6XCE), CETES [CAL6ER…6VXV](https://stellar.expert/explorer/public/contract/CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV), XAUM [CC2RBG…VAGO](https://stellar.expert/explorer/public/contract/CC2RBGYNCFBCVENIDL5BFBWPH4OUZM2UA3OD2K2N54GLMWCC4KWPVAGO) | `feed_source()` on each OracleAdapter |
| Maturities | 90-day markets: 15 February 2027 (MOCKUSDY), 18 February 2027 (the four others) | manifest; market pages |
| Fees, MOCKUSDY market | tokenization fee 0.05%, YT fee 10.00%, swap fee tier 0.10%, protocol share 20.00% | `/dashboard/markets/mainnet-CDQYZU-CCY5P6CC` |
| Compliance of the underlying | each mock asset's issuer is its SAC admin; issuer flags: authorization required **no**, revocable **yes**, clawback **yes**, the flags real USDY has | `/dashboard/compliance` (Horizon flags, `admin()`) |
| Permissioning | account and asset grants and revokes, indexed, with their history | `/dashboard/compliance` |

The protocol-wide limit adds units of five different assets, so it caps volume per unit, not value. The contracts team
set it for a test deployment on mock assets.

## 6. The dashboard

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

No wallet is needed. Each figure's info button, **How to verify**, gives the contract, the function, the ledger and a
`--send=no` command on the public gateway with the null account as source. A recorded run: the drawer of **Time until
operations block · MOCKUSDY** ([screenshot](tranche-3/10-oracle-how-to-verify-375px.png)) showed, on 23 November 2026
at 01:48 UTC, `get_reference_timestamp=1795390620; max_stale_seconds=86400; is_available=true`. Its commands, run as
copied:

```bash
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- get_reference_timestamp
# 1795390620   (= 2026-11-22 23:37:00 UTC)
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- max_stale_seconds
# 86400
stellar contract invoke --rpc-url https://soroban-rpc.mainnet.stellar.gateway.fm --network-passphrase 'Public Global Stellar Network ; September 2015' --id CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT --source-account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF --send=no -- is_available
# true
```

Screenshots of <https://principalmarket.fi>, 23 November 2026, in [tranche-3/](tranche-3/): `01-overview.png`,
`02-markets.png`, `03-market-mockusdy.png`, `04-oracle.png`, `05-risk.png`, `06-compliance.png`, `07-activity.png`,
`08-overview-dark.png`, `09-oracle-375px.png`, `10-oracle-how-to-verify-375px.png`.

## 7. The oracle keeper and freshness

Every 5 minutes the keeper reads each OracleAdapter and its feed. When the feed has a newer price, it calls
`sync_from_feed` from GBLY3F…MZXS (permissionless: the oracle reads its own feed); otherwise it sends nothing. Its runs
are public (`/api/dashboard/oracle-ticks`, the oracle page's **Keeper** section); a sync, for example:
[ce93f473…9508](https://stellar.expert/explorer/public/tx/ce93f473351cb9d024860f403e9e4f87a07a42dc7c0568e84ce36f7d28399508).

An oracle is fresh while its feed price's timestamp is younger than its window. Each window is twice its feed's
heartbeat ([RedStone's relayer config](https://github.com/redstone-finance/redstone-oracles-monorepo/blob/main/packages/relayer-remote-config/main/relayer-manifests-non-evm/stellarSep40.json)),
set by the oracle admin with `set_safety_params`:

| Oracle (asset) | Window | Set on (UTC), transaction | RedStone heartbeat, deviation threshold |
|---|---|---|---|
| CCKXG4…K7IT (MOCKUSDY) | 86,400 s | 22 Nov 2026 00:19:26, [73f87169…2c6c](https://stellar.expert/explorer/public/tx/73f87169f0a6adf4af3fe73695bce0ef087fbae2d7d168f1a90a381ebd202c6c) | 12 h, 0.5% |
| CBTW7C…PFR7 (MOCKUSTRY) | 86,400 s | 22 Nov 2026 00:19:36, [96cf75a8…e199](https://stellar.expert/explorer/public/tx/96cf75a8cca49b8370131c41c7ecb983d96ee17ffb1144d0a2fc7b90c722e199) | 12 h, 0.1% |
| CD22HN…J6X7 (MOCKGILTS) | 172,800 s | 23 Nov 2026 08:40:41, [efa8efbf…ee95](https://stellar.expert/explorer/public/tx/efa8efbffd1927443ee27a75e8ee237a6e26e9e2c34af3f5fed827e39963ee95) | 24 h, 0.1% |
| CBK2GO…MUZK (MOCKCETES) | 86,400 s | 22 Nov 2026 00:19:56, [5028e019…830e](https://stellar.expert/explorer/public/tx/5028e019162bb022aa9ac5c0300c6f0f8d97b63e91f20a356ee26a16df9a830e) | 12 h, 0.1% |
| CDFI7I…OPFD (MOCKXAUM) | 86,400 s | 22 Nov 2026 00:20:06, [9d59d0b4…7f52](https://stellar.expert/explorer/public/tx/9d59d0b4fb028f5f0ece56b155814af251bf6c72a7f68cc97eba0dcd24e67f52) | 12 h, 0.5% |

## 8. A stale oracle blocks operations

`mint(from, sy_shares = 1)` simulated on two PrincipalManagers on 21 November 2026 at 20:30:21 UTC (ledger 65601398),
while the window was 1 hour and MOCKUSDY's oracle was stale; `--send=no`, nothing signed:

| Market | Its oracle's `is_available()` | `mint` simulation |
|---|---|---|
| MOCKUSDY (manager CBBKUZ…UKCC) | `false` | `HostError: Error(Contract, #7)` |
| MOCKGILTS (manager CCDSON…7GBS) | `true` | `HostError: Error(Contract, #11)` |

In PrincipalManager, error 7 is
[`OracleStale`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L221)
and error 11 is
[`NotAuthorizedOnSac`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L224);
[`mint`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/principal_manager/src/lib.rs#L362-L374)
checks the oracle before compliance. The `-v` events show the manager's `is_available` call and the oracle's answer.
MarketPool ([line 1457](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/market_pool/src/lib.rs#L1457), trades and single-sided liquidity) and YTToken
([lines 248](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/yt_token/src/lib.rs#L248)
and [679](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/yt_token/src/lib.rs#L679), yield) raise their own `OracleStale`. The same day, on
<https://principalmarket.fi/app/markets/mainnet-CDQYZU-CCY5P6CC>, the app's **Signing is off** box read "The oracle price
is stale: it has not been updated in the last 1 hour. Wait for the next oracle update, then try again."

## 9. Alerts

Source: <https://principalmarket.fi/api/dashboard/alerts>, read on 21 November 2026, and
[app/api/cron/alerts/route.ts](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/app/api/cron/alerts/route.ts#L4-L14).

| Item | Value |
|---|---|
| Test alert | `lastTest`: opened 2026-11-21 13:59:49 UTC, `delivered: true` (the webhook took it) |
| Stale-oracle alerts | the first Mainnet ones: five critical `oracle_stale` alerts opened on 21 November 2026 at 15:00:03 UTC, one per oracle, each with `asset`, `ageSeconds`, `secondsToBlock` and `maxStaleSeconds` in its payload (the developer's record of that run's answer: 5 posted, 0 post failures). Each closed once its oracle was fresh again: MOCKGILTS's at 20:15:01 UTC, three minutes after the keeper's sync of 20:12:06. |
| Delivery | each opening and close is posted to the team's alert channel, a Telegram group. Its address is not public. The public endpoint shows whether the last test was delivered; it does not show the delivery of each alert. |
| Other kinds checked every 5 minutes | per oracle: `oracle_warning`, `oracle_unavailable`, `oracle_rejection`, `feed_broken`, `keeper_unhealthy`; also `seed_invalid`, `risk_warning`, `risk_exhausted`, `indexer_gap` and `signer_low` (the keeper's XLM) ([README "Alerts"](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/README.md#alerts)) |
| The scheduler sees red | the scheduled route `/api/cron/alerts` answers HTTP 500 while any critical alert is open, by design, so the scheduler's own failure alert fires too ([line 69](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/app/api/cron/alerts/route.ts#L69)). The public read endpoint above answers 200. |

## 10. On Testnet: a seizure, a rejected update and a pause

No seizure and no deviation rejection have happened on Mainnet. To show that the dashboard surfaces them, a drill ran
on **Stellar Testnet**, on the official Testnet market (contracts `665bb67`), on 21 November 2026. Its events:

| UTC | Ledger | Contract | Event | Transaction (Testnet) |
|---|---|---|---|---|
| 01:47:26 | 5840401 | RecoveryEscrow CAMOWB…N24Q | `recovery`, record 0: account GAQTES…4GKG, 5 SY, 5.0024795 PT, 5.0024795 YT | [0221e7ca…50e3](https://stellar.expert/explorer/testnet/tx/0221e7caa4e4041a59ecbe7d1b5f941f47d7a35937bc96a5a9701178367d50e3) |
| 01:47:26 | 5840401 | SYWrapper CA62AC…7F2I | `seize`, 5 SY, same transaction | [0221e7ca…50e3](https://stellar.expert/explorer/testnet/tx/0221e7caa4e4041a59ecbe7d1b5f941f47d7a35937bc96a5a9701178367d50e3) |
| 01:47:31 | 5840402 | OracleAdapter CDYGBF…YIPS | `ref_rej`, reason `deviate`: 1.1511459 refused against 1.0009964 (+15%) | [f5ec58b7…49e1](https://stellar.expert/explorer/testnet/tx/f5ec58b734a690f256615f6d9ff453b11248a01e717971a4adbc1e9f32e049e1) |
| 01:47:41 | 5840404 | OracleAdapter CDYGBF…YIPS | `ref_set`, 1.0009980 | [400ca990…00df](https://stellar.expert/explorer/testnet/tx/400ca9902dad9ee092df2b65eada838b736eae56cdd19c4055eeb52a13f100df) |
| 01:47:51 | 5840406 | RiskControl CCRZ55…MHJC | `paused` true | [17fa81b3…0eed](https://stellar.expert/explorer/testnet/tx/17fa81b3175c0c12a6e613d8f1be0892d539e9b3c665f5aaccbb6cbe6fa80eed) |
| 01:48:11 | 5840410 | RiskControl CCRZ55…MHJC | `paused` false | [5250db2c…99bd](https://stellar.expert/explorer/testnet/tx/5250db2cd2d60b89e623afdd7823600f70c9a3b45818c1ac1998d51baa6999bd) |

<https://testnet.principalmarket.fi/dashboard/compliance> shows the seizure (record 0, "record_count 1, indexed 1: they
match"); `/dashboard/oracle` shows the `deviate` rejection; `/dashboard/risk` the pause and the unpause. The Mainnet
dashboard runs the same code.
