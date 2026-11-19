DONE

The Phantom vault deposit implementation was tested at `47c08b9` on `wallet/solana-trustless-20261119`, using Node v24.22.1 and npm 11.19.1. [Pull request 416](https://github.com/postfiatorg/tasknode/pull/416) targets `main`.

The browser used mock wallets and a mock job service. A separate loopback check used the Solana worker’s actual HTTP and job implementation with a synthetic failed Solana transaction. The credited browser scenario used a synthetic accepted Post Fiat receipt. Live Phantom signing and funded on-chain credit remain unverified. Spend was $0.

The relay host reads the worker configuration and its completed epoch handoff cursor. Until the first handoff, readiness uses the worker’s configured initial epoch. It checks that epoch against finalized Solana RPC before preparing a deposit.

## L1 test suite

```sh
npm run test:l1
```

```text
> tasknode@0.1.0 test:l1
> node --test server/l1/*.test.mjs server/l1/profile/*.test.mjs src/features/wallet/l1/lib/*.test.js src/features/wallet/l1/format.test.mjs src/features/wallet/l1/bridge/bridge.test.mjs src/features/wallet/l1/gallery/model.test.mjs src/features/wallet/l1/gallery/market.test.mjs src/features/wallet/l1/market/config.test.mjs src/features/wallet/l1/market/model.test.mjs src/features/wallet/l1/market/offer-setup.test.mjs src/features/wallet/l1/primary/model.test.mjs

✔ bridge converts WebSocket RPC origin to HTTP without changing the configured RPC URL (1.611271ms)
✔ dedicated bridge upstream uses only server credentials and preserves honest readiness (0.524107ms)
✔ invalid dedicated upstream and logged-out requests cannot reach upstream (0.36619ms)
✔ gateway reaches dedicated HTTP bridge with server auth, and blocks credential echoes (41.402793ms)
✔ gateway recovers only connection-failed writes, sends once and rechecks session after recovery (30.609604ms)
✔ duplicate identical receipts recover direct credits, cash-ins and offers with literal acceptance (1.248896ms)
✔ conflicting and absent receipts remain unverified (0.234433ms)
✔ foreign addresses are excluded; duplicate row ids in separate blocks remain distinct (0.277306ms)
✔ missing archive or misbound batch fails closed (0.481944ms)
✔ history recovery only connects to explicitly configured loopback reads (0.32577ms)
✔ archived B24 PFNAV001 decodes attested amount, source policy and block heights without inventing a timestamp (3.493639ms)
✔ trust percentages preserve small reported amounts and a total of 100 percent (0.473211ms)
✔ depth excludes expired, closed and unrelated offers and preserves quote amounts (0.28535ms)
✔ bid depth reverses quote and coin sides (0.147461ms)
✔ archive refuses missing batches and mismatched transaction counts (0.327663ms)
✔ v4 principal covers both sides of a position and verifies complete tick coverage (0.387241ms)
✔ zero active liquidity can still have off-price principal (0.211699ms)
✔ canonical proof ID reproduces the known live B24 profile (0.766231ms)
✔ snapshot verification requires literal accepted receipts, not merely commitment (2.843021ms)
✔ snapshot refuses a mismatched receipt and unknown epochs (1.006832ms)
✔ archive refuses payload substitution against the committed certificate (0.227191ms)
✔ Ethereum publication requires exact asset, epoch, reserve packet and route bindings (12.396497ms)
✔ temporary Ethereum history failures do not poison immutable native snapshot caching (0.926172ms)
✔ actual B24 V2 Ethereum publication binds its native epoch and reserve packet (2.09605ms)
✔ old snapshot resolves a shared registered profile by canonical ID without scanning old blocks (0.960552ms)
✔ Ethereum history retries an incomplete receipt read instead of caching absence (104.242616ms)
✔ Ethereum publication rejects missing receipts and mismatched requested transaction identities (0.482656ms)
✔ production defaults dark and rejects HTTP/profile/bridge/WebSocket access before authentication (37.945266ms)
✔ relay configuration requires TLS, a separate credential, and a fixed origin (0.6787ms)
✔ two-hop relay authenticates reads, bridge and signed submissions; rejects custody/governance and strips credentials (64.780029ms)
✔ unsigned Phantom message matches the vault ABI, account order, privileges and caps (35.665762ms)
✔ readiness refuses mismatched program, mint, binding, epoch, config owner, cap and initialization slot (6.610322ms)
✔ lost Phantom reply recovers only a finalized successful vault deposit for the nonce (3.297774ms)
✔ Solana write endpoints enforce session, same origin, exact field shapes and decoded lengths (2.248228ms)
✔ Solana proxy forwards job create and status to configured endpoints and guards relay credentials (25.547938ms)
✔ readiness and intent use the same current route through the Solana JSON-RPC transport (14.265997ms)
✔ exact signed envelope and confirmed bound literal receipt recover with reads only (2.565684ms)
✔ any changed signature, key, sequence, source or operation cannot recover (0.747233ms)
✔ domain, tip, block, receipt identity and confirmation must match (1.385913ms)
✔ multi-transaction batches and absent matches remain uncertain (0.418128ms)
✔ literal rejection remains rejection, never converted into acceptance (0.387542ms)
✔ native selected-block mode preserves its explicit lack of full historical replay (1.463379ms)
✔ recovery requires explicit loopback read configuration and a signed finality request (0.737229ms)
✔ B7 connect shows the unlocked pf recipient and mainnet USDC balance/allowance (20.992203ms)
✔ B10 missing anchor and unreachable readiness prevent ALL sends, even invoked directly (25.70189ms)
✔ stale readiness and account switch are rechecked before signing (9.881088ms)
✔ amount input rejects overflow, negative, exponent, zero and precision loss (0.300582ms)
✔ gateway rejects unauthenticated, cross-origin and custody fields; upstream failure is closed (27.626942ms)
✔ B8 reload resumes identical job and displays seven persisted stages (15.773312ms)
✔ B9 exact child asset read, zero truth, unavailable/missing/malformed balance stays unverified (10.421831ms)
✔ B7 gateway forwards only the fixed bridge paths and public request, without browser credentials (43.321105ms)
✔ reload with tx: null can be discarded, which re-enables a new deposit (67.923492ms)
✔ a wrong recovery hash is refused and not stored (7.802014ms)
✔ a matching recovery hash is accepted, and replaces a stored hash that has no job (5.86278ms)
✔ a record with a bridge job is never discarded (12.72479ms)
✔ recovery area stays hidden while a valid hash waits, and appears once the deposit is stuck (46.450907ms)
✔ amount trims to the requested decimals without rounding (1.142147ms)
✔ identifiers shorten only when long hex (0.299801ms)
✔ user-facing errors avoid redemption wording (4.193541ms)
✔ portfolio groups PFUSDC family and bridged series, B23 by configured id (0.401873ms)
✔ peer market reads its own asset without a B23 reserve and binds precision and issuer (2.194818ms)
✔ peer fills verify exact balances and unchanged supply with no cash-in reserve (0.908656ms)
✔ registry is authenticated, read-only and requires explicit selection (0.47203ms)
✔ split credits only proven and attested value; controlled stays reported (1.706084ms)
✔ split rounding totals 100%, exact above safe integer range, invalid totals fail closed (0.238898ms)
✔ freshness uses stricter positive block limit, inclusive boundary, zero means disabled (0.318729ms)
✔ finalized epochs are ordered; pending readings cannot change price or TVL (0.30674ms)
✔ depth excludes closed, expired and wrong-pair offers and discloses truncation (0.368034ms)
✔ wallet values each NAVCoin using its own NAV, including zero holdings without NAV (0.337297ms)
✔ live re-read updates finalized NAV and trust; a failed book does not hide NAV (0.707533ms)
✔ gallery TVL ordering compares dollars across valuation scales (0.212009ms)
✔ custody fields, nested serialized fields and registered secrets cannot leave browser (3.077233ms)
✔ tab RPC contract permits reads and quotes while locked, signed submits only while unlocked (1.075515ms)
✔ certified round, confirmed flag, absent or mismatched receipt are not success (1.298771ms)
✔ accepted receipt returns; handle is single-use (1.123969ms)
✔ certified rejected transaction throws and missing receipt stays unverified (9.343941ms)
✔ changed quote, intent, chain domain and unreviewed quote cannot sign (0.56537ms)
✔ exact PFT conversion rejects precision loss, zero, negatives and unsafe amounts (0.341594ms)
✔ asset signer cannot silently discard new policy fields (0.540282ms)
✔ flattened signed operation preserves complete reviewed fields and detects omissions (0.77167ms)
✔ offers submit only through release-2 finality with exact signed parameter and accepted receipt (0.387482ms)
✔ registry discovers each identity and chain terms; metadata cannot override route or capabilities (5.153634ms)
✔ cross-coin route and quote responses fail closed (0.5458ms)
✔ selected config has no default; response must match selected asset (25.303051ms)
✔ portfolio and activity label all coins by asset and route; retired NAV excluded (7.286379ms)
✔ a newly finalized reading disables primary actions until route pricing catches up (0.841504ms)
✔ a view-only coin without a quote market has no price comparison (0.220471ms)
✔ six-decimal amounts remain exact and reject unsafe or ambiguous input (1.420886ms)
✔ configuration permits pending management but never accepts malformed asset IDs (0.461464ms)
✔ buy pays PFUSDC, sell pays B23, issuer and pre-G1 trading reject (0.692681ms)
✔ order book Unfilled: receipts, spendable debit, locked funds and remainder reconcile (0.690417ms)
✔ order book Partially filled: receipts, spendable debit, locked funds and remainder reconcile (0.385089ms)
✔ order book Filled: receipts, spendable debit, locked funds and remainder reconcile (0.218438ms)
✔ cancel verifies refunded locked remainder, not a reversed fill (0.389526ms)
✔ fund raises reserve without minting and fails when supply changes (0.39915ms)
✔ redemption quote splits full NAV into holder and manager, caps at reserve (3.575251ms)
✔ redeem requires both receipt credits, both actual credits, supply and reserve deltas (0.651478ms)
✔ redemption rejects changed policy or stale height before signing (0.509035ms)
✔ opening plan counts existing supply once and rejects unretired PFDEP / wrong scale (0.943417ms)
✔ fee intent binds next epochs, current NAV and management; verify actual route update (0.338789ms)
✔ mock client follows read→quote→read→sign→submit→read and verifies effects (1.109808ms)
✔ 6/6 finality or rejected receipt cannot pass; failed balance read is not success (13.069458ms)
✔ account switch and stale review block signing/submission (0.436906ms)
✔ public equity projection strips private and unrecognized fields (0.380882ms)
✔ server route rejects unauthenticated, writes and malformed fee without remote calls (0.349776ms)
✔ snapshot rejects an account mismatch instead of treating other-account data as zero (0.38563ms)
✔ cash-in rejects a source-series payout when family reserve was reviewed (0.226991ms)
✔ opening packet rejects stale or fabricated cutoff times (0.211788ms)
✔ review snapshot bounds simultaneous RPC reads and retries only transient read failures (507.335747ms)
✔ quote identity must be explicit; a source list alone never selects a market (1.887177ms)
✔ both sides of book and account offers use exact B23/source pair, excluding reserve and unrelated books (1.25141ms)
✔ missing B23 and source lines are planned as separate reviewed holder trust_set operations (1.992655ms)
✔ usable lines skip setup; limited receiving line grows for reviewed amount plus open offer reservations (0.769376ms)
✔ reserve-only buy explains Add funds before any setup or signature; source is required for payment (0.825341ms)
✔ truncated, frozen, wrong family/issuer, changed setup and unfunded snapshots fail closed (2.311663ms)
✔ source offer verification never mistakes a family credit for Alice receiving the source asset (0.755345ms)
✔ creation rounds NAV principal and fee upward, respects exact bounds and source (3.158365ms)
✔ default switches only beyond a complete book; explicit choice remains UI-owned (0.178007ms)
✔ reservation, subscription, release and cash-in have exact source-aware deltas (10.234639ms)
✔ book holdings and mismatched reserve cannot cash in; changed policy fails before signing (0.83895ms)
✔ accepted execution without confirmation never verifies (0.888976ms)
✔ insufficient receiving limit offers only setup; funded creation cannot run early (0.564228ms)
ℹ tests 122
ℹ suites 0
ℹ pass 122
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 667.653593
```

## Vite dev server

```sh
npx vite --host 127.0.0.1 --port 5188 --strictPort
```

```text
1:27:18 AM [vite] (client) Re-optimizing dependencies because vite config has changed

  VITE v8.3.5  ready in 899 ms

  ➜  Local:   http://127.0.0.1:5188/
1:27:20 AM [vite] (client) [optimizer] bundling dependencies...
```

## Browser gate

```sh
BRIDGE_EVIDENCE=/tmp/solbridge-task-f/screens python3 -u src/features/wallet/l1/bridge/browser-test.py
```

```text
PASS B10 blocked: Approve/Deposit disabled; zero provider sends
PASS B10 offline: Approve/Deposit disabled; zero provider sends
PASS B7/B8 connect, approval/deposit ABI, seven stages, reload same job; no repeat send
PASS B11 credited earlier deposit leaves the amount box usable; typing survives background checks
PASS B9 accepted receipt + exact child balance 2.000000; family 99.000000 ignored; failed read never complete
PASS Solana: one Phantom send, seven measured stages to credited, live clock, measured stage times, reload in flight and after credit
PASS Solana: lost Phantom reply recovered by nonce, failed proof shown, reload without resending
```

## Production build

```sh
npx vite build
```

```text
vite v8.3.5 building client environment for production...
transforming...
✓ 2218 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                                          1.14 kB │ gzip:   0.47 kB
dist/assets/postfiat_wallet_wasm_bg-D4yGhKff.wasm    2,433.46 kB │ gzip: 707.70 kB
dist/assets/FinanceHubView-BYnkdurv.css                  1.02 kB │ gzip:   0.46 kB
dist/assets/L1WalletView-beCumw6x.css                    1.56 kB │ gzip:   0.65 kB
dist/assets/AppDialogs-C-9IAheq.css                      1.98 kB │ gzip:   0.72 kB
dist/assets/ethereum-top-up-modal-CSFdHMwX.css           6.96 kB │ gzip:   1.71 kB
dist/assets/directory-D7EcCuPO.css                       8.47 kB │ gzip:   2.06 kB
dist/assets/HiveGroupChat-D8bdY2SF.css                   9.19 kB │ gzip:   2.43 kB
dist/assets/MemoryView-DVfFL2Q8.css                     10.90 kB │ gzip:   2.26 kB
dist/assets/ProfileView-Dnq-Q8Cx.css                    12.23 kB │ gzip:   2.86 kB
dist/assets/MessagesView-Cl1Kf81C.css                   12.92 kB │ gzip:   2.82 kB
dist/assets/DocsView-C_l2ZHJj.css                       17.39 kB │ gzip:   3.20 kB
dist/assets/ethereum-top-up-Bik0MllW.css                18.53 kB │ gzip:   3.52 kB
dist/assets/DocsLibraryView-GMGh8j2_.css                32.90 kB │ gzip:   6.44 kB
dist/assets/ui-RnjX9HpG.css                             42.05 kB │ gzip:   8.48 kB
dist/assets/TeamView-Cftuk9mp.css                       53.10 kB │ gzip:   9.75 kB
dist/assets/hive-SAa3Ep0G.css                           93.68 kB │ gzip:  13.90 kB
dist/assets/index-DyyXnHan.css                         198.66 kB │ gzip:  32.43 kB
dist/assets/rolldown-runtime-BWaJ3C7D.js                 0.91 kB │ gzip:   0.51 kB
dist/assets/pricing-E1EgFOoh.js                          0.98 kB │ gzip:   0.53 kB
dist/assets/collaboration-client-FrdBPym8.js             1.00 kB │ gzip:   0.56 kB
dist/assets/ethereum-top-up-CGm4gPZO.js                  2.18 kB │ gzip:   1.00 kB
dist/assets/defect-repair-rule-DSbTbELw.js               2.24 kB │ gzip:   1.12 kB
dist/assets/FinanceHubView-Mz5LmUKX.js                   3.11 kB │ gzip:   1.33 kB
dist/assets/search-DJtweN0N.js                           3.42 kB │ gzip:   1.54 kB
dist/assets/refine-context-CAsJLEuc.js                   3.47 kB │ gzip:   1.50 kB
dist/assets/privacy-CkHiJAzf.js                          3.94 kB │ gzip:   1.80 kB
dist/assets/messages-C9h8HECH.js                         4.46 kB │ gzip:   2.05 kB
dist/assets/ValidatorRewards-BoSK90Qv.js                 4.50 kB │ gzip:   1.77 kB
dist/assets/BlacklistView-Cz-O_B_I.js                    4.83 kB │ gzip:   1.95 kB
dist/assets/encryption-BOuf7_b3.js                       5.01 kB │ gzip:   2.02 kB
dist/assets/agents-r7oaK0pf.js                           5.40 kB │ gzip:   2.47 kB
dist/assets/bootup-IAs326Xo.js                           5.57 kB │ gzip:   2.62 kB
dist/assets/context-DLoGecnu.js                          6.42 kB │ gzip:   2.68 kB
dist/assets/ui-CeziWoOA.js                               6.42 kB │ gzip:   2.39 kB
dist/assets/wiki--vXmcuK4.js                             6.42 kB │ gzip:   2.92 kB
dist/assets/model-pFgxtoz7.js                            6.49 kB │ gzip:   2.33 kB
dist/assets/HiveBrainView-DLCVh0Ak.js                    6.83 kB │ gzip:   2.50 kB
dist/assets/style-guide-B4T05OD7.js                      7.22 kB │ gzip:   3.29 kB
dist/assets/team-_OELeeMj.js                             7.23 kB │ gzip:   3.19 kB
dist/assets/directory-DNkEmkDK.js                        7.59 kB │ gzip:   3.41 kB
dist/assets/ai-providers-DhiF-C15.js                     7.74 kB │ gzip:   3.52 kB
dist/assets/DirectoryView-Dy8Hhuqo.js                    8.01 kB │ gzip:   2.75 kB
dist/assets/validator-research-BO7B64U7.js               9.87 kB │ gzip:   4.04 kB
dist/assets/current-system-BeOwQSGc.js                  11.66 kB │ gzip:   4.88 kB
dist/assets/docs-g1u8oECk.js                            11.70 kB │ gzip:   4.84 kB
dist/assets/wallet-core-_uPIVq25.js                     12.38 kB │ gzip:   4.20 kB
dist/assets/auth-wallet-boundary-CTRrpWFQ.js            13.09 kB │ gzip:   5.25 kB
dist/assets/wallet-BCXpCxx0.js                          13.75 kB │ gzip:   5.33 kB
dist/assets/memory-Da6yCZ18.js                          14.02 kB │ gzip:   5.08 kB
dist/assets/MemoryView-BVicRZNK.js                      15.00 kB │ gzip:   4.57 kB
dist/assets/redeem-BhG0Z9gk.js                          15.20 kB │ gzip:   4.98 kB
dist/assets/HiveGroupChat-DqWNavid.js                   15.70 kB │ gzip:   5.69 kB
dist/assets/ethereum-top-up-modal-SxqdLBBU.js           16.02 kB │ gzip:   6.01 kB
dist/assets/context-rewrite-CFiEOZsn.js                 16.24 kB │ gzip:   6.20 kB
dist/assets/MessagesView-Ch9D6wDt.js                    16.50 kB │ gzip:   5.28 kB
dist/assets/gallery-DGiKAoaQ.js                         17.77 kB │ gzip:   5.48 kB
dist/assets/auth-and-connected-accounts-BWogPvpV.js     17.78 kB │ gzip:   6.58 kB
dist/assets/daily-airdrop-rytg4Q0z.js                   19.20 kB │ gzip:   7.38 kB
dist/assets/TeamView-CKNqINQB.js                        21.41 kB │ gzip:   6.10 kB
dist/assets/market-BYr_aeKx.js                          22.95 kB │ gzip:   7.84 kB
dist/assets/model-DZj5-gWm.js                           23.72 kB │ gzip:   7.70 kB
dist/assets/ContextView-CjbH5Q8t.js                     24.90 kB │ gzip:   7.73 kB
dist/assets/icon-runtime-DBrrzHQt.js                    27.96 kB │ gzip:   9.34 kB
dist/assets/nostr-messages-Dzna7t4e.js                  30.86 kB │ gzip:   9.70 kB
dist/assets/AppDialogs-DE_labdX.js                      35.47 kB │ gzip:  10.18 kB
dist/assets/DocsView-ClpWLr7k.js                        39.01 kB │ gzip:  11.98 kB
dist/assets/chat-B_Tx4Yj-.js                            42.37 kB │ gzip:  15.43 kB
dist/assets/WalletView-81JuErtN.js                      42.82 kB │ gzip:  11.63 kB
dist/assets/user-guide-Bq1DopWj.js                      43.38 kB │ gzip:  14.82 kB
dist/assets/profile-1iIT56Zo.js                         52.38 kB │ gzip:  19.13 kB
dist/assets/bridge-BJuxBLEk.js                          64.24 kB │ gzip:  18.37 kB
dist/assets/hive-bVoWrE2W.js                            64.98 kB │ gzip:  22.51 kB
dist/assets/tasks-CJF0JnUD.js                           67.37 kB │ gzip:  22.85 kB
dist/assets/DocsLibraryView-BZf4dmuK.js                 68.59 kB │ gzip:  19.38 kB
dist/assets/HiveView-B1MJRmrU.js                        70.24 kB │ gzip:  18.77 kB
dist/assets/ProfileView-Be-hWDNz.js                     79.61 kB │ gzip:  22.52 kB
dist/assets/key-cryptography-GocBfGc5.js                82.99 kB │ gzip:  33.42 kB
dist/assets/L1WalletView-De_Rzzkr.js                    94.81 kB │ gzip:  29.11 kB
dist/assets/react-runtime-Ctaik3bb.js                  189.52 kB │ gzip:  59.60 kB
dist/assets/index-CsJiYuIg.js                          321.08 kB │ gzip:  94.97 kB
dist/assets/libsodium-wrappers-DpwLqkzb.js             432.65 kB │ gzip: 152.87 kB
dist/assets/wallet-encoding-Dk8dyxJL.js                449.20 kB │ gzip: 129.48 kB

✓ built in 531ms
```

## Solana relay HTTP integration

```sh
python3 /tmp/solbridge-task-f/relay-contract.py
```

```text
PASS real sol/relay HTTP contract with synthetic Solana RPC: readiness, unsigned intent, authenticated idempotent create, failed status and measured finality stage
```

## Dependency audit

```sh
npm audit --audit-level=high
```

```text
found 0 vulnerabilities
```

## Dependency licenses

```sh
node scripts/dependency-license-check.mjs
```

```text
dependency license check ok: 477 packages; reviewed reciprocal/content licenses: LGPL-3.0-or-later=10, Apache-2.0 AND LGPL-3.0-or-later AND MIT=1, Apache-2.0 AND LGPL-3.0-or-later=3, MPL-2.0=13, CC-BY-4.0=1
```

## Pushed implementation

```sh
git ls-remote --heads origin wallet/solana-trustless-20261119
```

```text
47c08b98f9503d4928fd60cd9fc9d5a9976063dd	refs/heads/wallet/solana-trustless-20261119
```

## Pull request

```sh
gh pr view 416 --repo postfiatorg/tasknode --json baseRefName,headRefName,state,url --jq '[.state, .headRefName, .baseRefName, .url] | @tsv'
```

```text
OPEN	wallet/solana-trustless-20261119	main	https://github.com/postfiatorg/tasknode/pull/416
```
