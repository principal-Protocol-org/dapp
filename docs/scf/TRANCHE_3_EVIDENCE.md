# Tranche 3 (Mainnet): evidence

The facts behind [TRANCHE_3_REVIEW.md](TRANCHE_3_REVIEW.md): deployed addresses, wasm hashes, transaction hashes, live
reads, CI runs and screenshots. Each section says where its data comes from and when it was read. The dApp went live on
Stellar Mainnet on 21 November 2026. All times are UTC.

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
- the dApp's app code at
  [`783d51c`](https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd) (later
  commits on `main` change only documentation);
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
| Go-live | 21 November 2026, 12:39 UTC |
| App code | [`783d51c`](https://github.com/principal-Protocol-org/dapp/tree/783d51c51003376884ccec1d9eab6d44d27d59fd) (the tree of `3cffbdd`); later commits on `main` change only documentation |
| CI on that code (pull request [#9](https://github.com/principal-Protocol-org/dapp/pull/9), head `3cffbdd`) | [CI run 44919042817](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042817): green (lint, typecheck, unit tests, builds). [E2E Testnet run 44919042837](https://github.com/principal-Protocol-org/dapp/actions/runs/44919042837): Suite A 13 of 13 tests, Suite B 10 of 10. |

The end-to-end suites run on **Stellar Testnet**, never on Mainnet: Suite A is the live journey on the official Testnet
market (contracts `665bb67`); Suite B deploys a throwaway market on Testnet built from the **Mainnet source commit**
`3af9388`, so the Mainnet contract interfaces are exercised end to end without signing anything on Mainnet.

### 1.2 Scheduled jobs

Upstash QStash calls four routes of the Production deployment. Each refuses any other caller (a plain request to
`https://principalmarket.fi/api/cron/alerts` answers 401).

| Route | Schedule | What it does |
|---|---|---|
| `/api/cron/record` | every 15 minutes | stores each market's rates (the app's charts; `/api/markets/<pool>/history`) |
| `/api/cron/index` | every 5 minutes | indexes the contracts' events into the database |
| `/api/cron/oracle` | minutes 2 to 57, every 5 | the oracle keeper ([§6](#6-the-oracle-keeper)) |
| `/api/cron/alerts` | every 5 minutes | the alert check ([§8](#8-alerts)) |

<https://principalmarket.fi/api/health> shows that they run: the event index's lag and gaps, each oracle's keeper
health and last run, and the open alerts.

## 2. The Mainnet deployment

### 2.1 The manifest

Source: [config/manifests/mainnet.json](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/config/manifests/mainnet.json).
It is the contracts team's
[deployments/mainnet-dapp-manifest.json](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-dapp-manifest.json)
with the dApp's own fields added. The shared contracts, every market's contracts, the maturities, the wasm hashes and
the source commit are equal in both files (checked against `ae6ccd9`).

| Field | Value |
|---|---|
| Network | Stellar Mainnet, `Public Global Stellar Network ; September 2015`; Horizon `https://horizon.stellar.org` |
| RPC | primary host `lb.drpc.live` (a keyed URL, not reproduced here); fallback and the dashboard's "How to verify" commands: `https://soroban-rpc.mainnet.stellar.gateway.fm` (`verifyRpcUrl`) |
| `sourceCommit` | [`3af938853e5818aa8d56bd35670b9a19cfa55a78`](https://github.com/principal-Protocol-org/principal/commit/3af938853e5818aa8d56bd35670b9a19cfa55a78). The contract sources are identical at `4b5bc2b` (the commit the contracts team's build section names) and at `mainnet` `ae6ccd9`: `git diff` shows no change under `contracts/`, nor in `Cargo.toml` or `Cargo.lock`. |
| `protocolAbi` | `2` (the `3af9388` contract interfaces) |
| `deployLedger` | `65525735`; `createdLedgers` gives the first ledger of the 20 contracts added later (the four markets deployed on 20 November) |
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

MOCKUSTRY, MOCKGILTS, MOCKCETES and MOCKXAUM were deployed on 20 November 2026. The contracts repository also keeps an
earlier, abandoned set of these four markets (each `deployment-manifest-v1-broken.json`); nothing here refers to it.

### 2.3 The read-only deployment check

Source: [scripts/smoke.mjs](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/scripts/smoke.mjs),
run with `pnpm smoke:mainnet` from a checkout of the dApp at `3cffbdd` (the tree of `783d51c`), on 23 November 2026 at
01:38 UTC. It needs no key and signs nothing. It reads, from the RPC the manifest names (it prints the host
only): each market's topology against the manifest, each oracle's state and feed, the pauses, and the on-chain code
hash of every manifest contract. It exits 1 on a topology or code mismatch or an unreadable contract; a stale oracle
is reported and does not fail it.

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

The 44 code hashes are the 4 shared contracts and 8 contracts per market (its OracleAdapter and its seven market
contracts). `pnpm smoke:mainnet --json` gives the same result with every contract's expected and actual hash.
MOCKXAUM's stored value is above the feed's latest price: the adapter never lowers its value, so it waits for the feed
to rise again ([TRANCHE_3_REVIEW.md, Known limits](TRANCHE_3_REVIEW.md#known-limits)).

### 2.4 How long the contracts live

Soroban contract instances expire unless their time to live is extended. Read with one `getLedgerEntries` call on the
public gateway (`https://soroban-rpc.mainnet.stellar.gateway.fm`) on 21 November 2026 at 20:37 UTC, ledger 65601474, for the instance of all
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
| Protocol admin (contracts team): admin of the five OracleAdapters, a pauser by RiskControl's rule, the protocol admin of the markets' fees | [GDZN5W…5NCB](https://stellar.expert/explorer/public/account/GDZN5WVOUBRTZKADUULRXJOGVGNK4WWXJPSALTVOORLSU5NFOZ2P5NCB) | `get_admin` on each OracleAdapter; the risk page; the market pages; [MAINNET_ADDRESSES.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_ADDRESSES.md) |
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
(complete through 18 November 2026, as its header says) and the five market manifests
[mainnet-mockusdy](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-mockusdy/deployment-manifest.json),
[mainnet-ustry](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-ustry/deployment-manifest.json),
[mainnet-gilts](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-gilts/deployment-manifest.json),
[mainnet-cetes](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-cetes/deployment-manifest.json),
[mainnet-xaum](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet-xaum/deployment-manifest.json).

### 3.1 Deposit and mint on every market

The contracts team deposited a mock asset and minted PT and YT on each of the five markets, from the command line,
with their test account GCOMBI…R5BM. For MOCKUSDY the doc's §5 "Real transaction testing" lists them; for the four
others, §12's table "Real testing proof on every v2 market". We read every hash below on Horizon on 21 November
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

What the contracts repository publishes:
- [MAINNET_DEPLOYMENT_EVIDENCE.md §8](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md#8-reproducible-build-evidence): the source commit `4b5bc2b` (the contract
  sources are identical at `3af9388`, [§2.1](#21-the-manifest)), the build command
  `cargo build --workspace --release --target wasm32v1-none`, the toolchain `rustc 1.94.1 (e408947bf 2026-03-25)`,
  `cargo 1.94.1`, `stellar 26.0.0` (the manifests add `soroban-sdk 26.0.1`), and the size and SHA-256 of the 12 wasm
  files. The 12 hashes equal the manifest's `wasmHashes`, and the code on chain matches them, 44 of 44
  ([§2.3](#23-the-read-only-deployment-check)).
- On branch `mainnet`: `rust-toolchain.toml` (rustc 1.94.1), `scripts/deploy/reproducible_build.sh` (the build with
  `--remap-path-prefix` on the cargo and checkout paths) and the recipe
  [deployments/mainnet/reproducible-build.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/deployments/mainnet/reproducible-build.md).
  §14 of the evidence file explains why the bytes depend on the build machine.

What a rebuild gives (`ae6ccd9`, whose contract sources, `Cargo.toml` and `Cargo.lock` equal `3af9388`'s; rustc 1.94.1
and the script's flags):

| Build | Result |
|---|---|
| The contracts team's CI, [run 44974232705](https://github.com/principal-Protocol-org/principal/actions/runs/44974232705), job "wasm build (all contracts)", Linux x86_64 | Permissioning (`4437468d…`) and RiskControl (`ac75508d…`) equal the on-chain hashes; the 10 others differ |
| macOS arm64, and Linux arm64 (`rust:1.94.1-slim`) | 0 of 12, Permissioning included: the host system changes the bytes |

Why the ten others differ: they embed an absolute path. In the 12 on-chain files the only absolute paths are under one
cargo directory, `/home/<user>/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/soroban-sdk-26.0.1/src/…`
(`<user>` is the original builder's home directory, masked here), in those 10 files; the workspace's own sources appear
as relative paths (`contracts/market_pool/src/lib.rs`). Permissioning and RiskControl contain no such path. A rebuild
of `3af9388` on Linux x86_64 with rustc 1.94.1 and the cargo directory at that path is expected to give 12 of 12. That
run belongs in the contracts repository's CI and has not been made yet ([§10](#10-open-items), item 3).

### 3.3 The deployment manifests

Each `deployment-manifest.json` records the network, the source commit, the toolchain, every contract's address
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

Read on 21 and 22 November 2026 from the dashboard and with `stellar contract invoke … --send=no`. The dashboard pages
give the current values.

| Setting | Value | Read from |
|---|---|---|
| RiskControl, protocol-wide limit | 5,000.00 in underlying units, per sliding window of 17,280 ledgers (about 24 hours); the page shows the volume counted now and the remaining capacity (a wrap-and-mint counts twice) | `/dashboard/risk` |
| RiskControl, per-asset limits | MOCKUSDY 5,000.00 (set 17 Nov 2026 15:55:32, `48092a…f372`), MOCKUSTRY 5,000.00 (set 17 Nov 2026 20:52:32, `946d7e…2c14`); MOCKGILTS, MOCKCETES, MOCKXAUM: no limit | `/dashboard/risk` |
| Pauses | RiskControl, and each market's SYWrapper, PrincipalManager and MarketPool: not paused. Pause history: none recorded. | `/dashboard/risk` |
| Oracles | each market's own OracleAdapter; `max_stale_seconds` 86400, that is 24 hours ([§6.3](#63-freshness)); `max_deviation_bps` 1000, that is 10%; admin GDZN5W…5NCB (all five); on MOCKGILTS's detail: value bounds none, fallback source none | `stellar contract invoke … --send=no`; `/dashboard/oracle` |
| Oracle feed source | all five: RedStone's SEP-40 feed [CBMGLK…WYRF](https://stellar.expert/explorer/public/contract/CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF) (`decimals()` 8, `resolution()` 43200), keyed by the real asset's contract: USDY [CB3YA6…GAGP](https://stellar.expert/explorer/public/contract/CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP), USTRY [CBLV4A…PNUR](https://stellar.expert/explorer/public/contract/CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR), GILTS [CCQNEB…6XCE](https://stellar.expert/explorer/public/contract/CCQNEBGX5RJQGNLQ25C67DZLOSNM4NFQBANUS3ASALF2X552BSIQ6XCE), CETES [CAL6ER…6VXV](https://stellar.expert/explorer/public/contract/CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV), XAUM [CC2RBG…VAGO](https://stellar.expert/explorer/public/contract/CC2RBGYNCFBCVENIDL5BFBWPH4OUZM2UA3OD2K2N54GLMWCC4KWPVAGO) | `feed_source()` on each OracleAdapter |
| Maturities | 90-day markets: 15 February 2027 (MOCKUSDY), 18 February 2027 (the four others) | manifest; market pages |
| Fees, MOCKUSDY market | tokenization fee 0.05%, YT fee 10.00%, swap fee tier 0.10%, protocol share 20.00% | `/dashboard/markets/mainnet-CDQYZU-CCY5P6CC` |
| Compliance of the underlying | each mock asset's issuer is its SAC admin; issuer flags: authorization required **no**, revocable **yes**, clawback **yes**, the flags real USDY has (contracts doc §3) | `/dashboard/compliance` (Horizon flags, `admin()`) |
| Permissioning | account and asset grants and revokes, indexed, with their history | `/dashboard/compliance` |

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

### 5.2 What the views show

The overview's protocol-wide **TVL** and **Pool liquidity** read "Unavailable", by design: the five markets hold
different underlying assets, so their amounts do not add up
([protocol-state.ts lines 125 to 128](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/lib/protocol/dashboard/protocol-state.ts#L125-L128)).
The overview gives **TVL in USD** instead (each market's TVL times its oracle value), and the markets pages give each
market's PT and YT supply, pool reserves, pool liquidity, TVL and TVL in USD. Each market's page adds its settlement
state, unclaimed fees, fee recipients and a **Pending yield** lookup: any account or contract address, answered with
what it would be paid by claiming its YT yield now, net of the YT fee.

### 5.3 One "How to verify" command, run as copied

On `/dashboard/oracle?oracle=CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7`, the drawer of **Time until
operations block · MOCKGILTS** showed, on 21 November 2026 at 20:31 UTC (the window was then 1 hour): value 39m 2s; raw value `get_reference_timestamp=1795291830;
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

The chain gave the drawer's values. 1795291830 + 3600 − ledger time = the countdown the page showed. Today
`max_stale_seconds` answers `86400`.

### 5.4 Screenshots

In [tranche-3/](tranche-3/), taken on 21 November 2026 between 20:16 and 20:18 UTC on <https://principalmarket.fi> by
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

They show the state of that moment: the oracles' window was then 1 hour, so four oracles read stale and four critical
alerts were open. The live pages show today's values.

## 6. The oracle keeper

### 6.1 How it runs

`/api/cron/oracle` runs every 5 minutes (minutes 2 to 57). In each run it reads every OracleAdapter of the manifest and
its feed. When the feed has a newer price than the oracle holds, it calls `sync_from_feed` from the keeper account
GBLY3F…MZXS; otherwise it records "Skipped: the feed had nothing newer" and sends nothing. `sync_from_feed` is
permissionless: the oracle reads its own configured feed, and the keeper only pays the fee. Its runs are public:
`/api/dashboard/oracle-ticks` and the **Keeper** section of the oracle page.

### 6.2 Its transactions

They are on Horizon:
<https://horizon.stellar.org/accounts/GBLY3FDTJFPYGI425TK6C7UUFBXYJ4DHWBXNHKWY7RMNZ43JLGUOMZXS/transactions?order=desc>.
Each sync is one successful `sync_from_feed` call on one oracle, for example
[ce93f473…9508](https://stellar.expert/explorer/public/tx/ce93f473351cb9d024860f403e9e4f87a07a42dc7c0568e84ce36f7d28399508)
(MOCKGILTS, 21 November 2026 20:12:06 UTC, ledger 65601176, value 1.4068080). A sync costs about 0.0098 XLM on the four
markets deployed on 20 November and about 0.0005 XLM on MOCKUSDY's oracle. The account holds XLM only, and the alert
check opens `signer_low` when its balance runs low.

### 6.3 Freshness

`sync_from_feed` stores the feed price's own timestamp, not the ledger time
([oracle_adapter/src/lib.rs line 501](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L501); a price no newer than the stored one is refused `stale_ts`,
[line 572](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L572)). An oracle is fresh while that timestamp is less than `max_stale_seconds` old: 86,400 s (24 hours)
on all five. The oracle admin GDZN5W…5NCB set it with
[`set_safety_params(caller, 86400, 1000)`](https://github.com/principal-Protocol-org/principal/blob/3af938853e5818aa8d56bd35670b9a19cfa55a78/contracts/oracle_adapter/src/lib.rs#L292), recorded in the contracts team's
[MAINNET_DEPLOYMENT_EVIDENCE.md](https://github.com/principal-Protocol-org/principal/blob/ae6ccd96e5929ff8cbb36f889afd89875647fec2/docs/MAINNET_DEPLOYMENT_EVIDENCE.md) §13:

| UTC, 22 Nov 2026 | Ledger | Oracle (asset) | Transaction |
|---|---|---|---|
| 00:19:26 | 65604144 | CCKXG4…K7IT (MOCKUSDY) | [73f87169…2c6c](https://stellar.expert/explorer/public/tx/73f87169f0a6adf4af3fe73695bce0ef087fbae2d7d168f1a90a381ebd202c6c) |
| 00:19:36 | 65604146 | CBTW7C…PFR7 (MOCKUSTRY) | [96cf75a8…e199](https://stellar.expert/explorer/public/tx/96cf75a8cca49b8370131c41c7ecb983d96ee17ffb1144d0a2fc7b90c722e199) |
| 00:19:46 | 65604148 | CD22HN…J6X7 (MOCKGILTS) | [cf539412…d30a](https://stellar.expert/explorer/public/tx/cf5394127d52a399e81b69dbb24f180829c60f6d76f24881c7164ca39af5d30a) |
| 00:19:56 | 65604150 | CBK2GO…MUZK (MOCKCETES) | [5028e019…830e](https://stellar.expert/explorer/public/tx/5028e019162bb022aa9ac5c0300c6f0f8d97b63e91f20a356ee26a16df9a830e) |
| 00:20:06 | 65604152 | CDFI7I…OPFD (MOCKXAUM) | [9d59d0b4…7f52](https://stellar.expert/explorer/public/tx/9d59d0b4fb028f5f0ece56b155814af251bf6c72a7f68cc97eba0dcd24e67f52) |

RedStone's relayer writes a price to the feed when it has moved by the asset's deviation threshold, or when the
asset's heartbeat has run out since the last write
([RedStone's relayer config for this feed](https://github.com/redstone-finance/redstone-oracles-monorepo/blob/main/packages/relayer-remote-config/main/relayer-manifests-non-evm/stellarSep40.json), adapter `CBMGLK…WYRF`, read on 22 November 2026):

| Asset | Deviation threshold | Heartbeat |
|---|---|---|
| USDY | 0.5% | 12 h |
| USTRY | 0.1% | 12 h |
| GILTS | 0.1% | 24 h |
| CETES | 0.1% | 12 h |
| XAUM | 0.5% | 12 h |

With a 12-hour heartbeat, four oracles stay fresh with a full cycle to spare. GILTS's heartbeat equals the window: on
a day GILTS does not move 0.1% (weekends, UK holidays), the MOCKGILTS oracle turns stale about 10 s before the
heartbeat's price lands, and stays stale until the keeper's next sync, within 5 minutes ([§10](#10-open-items),
item 1). The read-only check of [§2.3](#23-the-read-only-deployment-check) found all five fresh.

## 7. A stale oracle blocks operations

Two simulations of the same call, `mint(from, sy_shares = 1)` on a market's PrincipalManager, on 21 November 2026 at
20:30:21 UTC (ledger 65601398), when the oracles' window was 1 hour and MOCKUSDY's oracle was stale, through the public
gateway, with `--send=no`: nothing was signed or sent. The source
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

The app refuses the same actions before asking for a signature. On <https://principalmarket.fi/app/markets/mainnet-CDQYZU-CCY5P6CC>, with no wallet, at 20:51 UTC that day, the trade panel's
**Signing is off** box listed "The oracle price is stale: it has not been updated in the last 1 hour. Wait for the
next oracle update, then try again."

Freshness moves with RedStone's prices: read `is_available()` first; it tells which of the two results to expect. With
the 24-hour window a stale oracle is rare, so a run today most likely gives error 11 on every market.

## 8. Alerts

Source: <https://principalmarket.fi/api/dashboard/alerts> (public, read-only), read on 21 November 2026, and
[app/api/cron/alerts/route.ts](https://github.com/principal-Protocol-org/dapp/blob/783d51c51003376884ccec1d9eab6d44d27d59fd/app/api/cron/alerts/route.ts#L4-L14).

| Item | Value |
|---|---|
| Test alert | `lastTest`: opened 2026-11-21 13:59:49 UTC, `delivered: true` (the webhook took it) |
| Stale-oracle alerts | the first Mainnet ones: five critical `oracle_stale` alerts opened on 21 November 2026 at 15:00:03 UTC, one per oracle, each with `asset`, `ageSeconds`, `secondsToBlock` and `maxStaleSeconds` in its payload (the developer's record of that run's answer: 5 posted, 0 post failures). Each closed once its oracle was fresh again: MOCKGILTS's at 20:15:01 UTC, three minutes after the keeper's sync of 20:12:06. |
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
| 1 | **MOCKGILTS's staleness window.** 86,400 s, equal to RedStone's GILTS heartbeat (24 hours). On a day GILTS does not move 0.1%, the MOCKGILTS oracle turns stale for a few minutes, until the next price and the keeper's sync ([§6.3](#63-freshness)). The four other feeds have a 12-hour heartbeat. | contracts team | Only the oracle admin can widen this oracle's window (`set_safety_params`, for example to 172,800 s, twice the heartbeat); asked. |
| 2 | **The dApp's own signed smoke test on Mainnet**: a small deposit and mint through principalmarket.fi, with their two hashes. | developer, after the contracts team | Needs a test wallet granted on the markets (only the contracts team's Permissioning admin can). It is signed by the developer, never by an agent or a test. The contracts team's command-line deposits and mints are in [§3.1](#31-deposit-and-mint-on-every-market). |
| 3 | **Reproducing the build.** On Linux x86_64 with rustc 1.94.1, a rebuild reproduces the two contracts that embed no machine path (Permissioning, RiskControl); the ten others embed the original builder's cargo path ([§3.2](#32-the-reproducible-build)). | contracts team | A rebuild of `3af9388` on Linux x86_64 with rustc 1.94.1 and that cargo path, in the contracts repository's CI, is expected to give 12 of 12; not run yet. On other hosts (macOS, Linux arm64) the bytes differ, so the recipe must name the host. |
| 4 | **Contract lifetimes.** The Mainnet contract instances live until about 17 to 21 March 2027 ([§2.4](#24-how-long-the-contracts-live)). | contracts team, operations | Someone must extend them (and the code entries) before mid-March 2027. |
| 5 | **The contracts team's manifest caveats:** duplicate hashes in MOCKUSDY's `transactions[]` and `git_tree_dirty: true` ([§3.3](#33-the-deployment-manifests)). | contracts team | Stated so that no hash is cited under the wrong step. |
