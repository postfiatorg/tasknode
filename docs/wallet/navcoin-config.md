# Wallet NAVCoin configuration

`NAVCOIN_CONFIG_JSON` supplies the active Schwab coin to the authenticated config endpoint, gallery registry, and history recovery. `B23_NAVCOIN_CONFIG_JSON` remains a compatibility fallback. With neither set, the wallet retains its B23 configuration. Prices, supply, trust coverage and route capacity still come from chain reads.

Public fields are projected and validated in `src/features/wallet/l1/market/constants.js`. Use `nav_asset_id`, `symbol`, `slug`, `route_id`, `proof_profile`, `issuer_address`, `alice_holder_address`, `pfusdc_asset_id`, `market_quote_asset_id`, and `pfusdc_source_asset_ids`. The historical `b23_asset_id` response field is an internal adapter alias for `nav_asset_id`; it does not determine display names. Do not pass private handover material into this environment variable.

- `g1_passed: true` records that the operator has verified deployment. It does not prove a receipt or balance change.
- `redemption_mode: "two-credit"` preserves B23's verified holder/manager settlement path and requires the matching management recipient on the live route.
- `redemption_mode: "unsupported"` permits deployed native order-book trading without a manager policy. The Cash in screen explains that native redemption is unavailable in this wallet and links to the market. A market sale needs a buyer and is not a NAV redemption.
- `cash_in_note` explains any asset-specific redemption restriction on Home, the buy ticket, the coin page and Cash in. The B24 handover qualifies book trading but says market-bought coins lack redeemable route inventory; only qualifying subscriptions can cash in.
- `issue_multiplier_bps` and `redeem_multiplier_bps` describe creation/cash-in terms. B24 uses 10050 and 9995. Coin-page terms prefer current route values. They are not an extra fee on an order-book fill.
- `retired_assets` is a list of `{asset_id, symbol, slug, route_id}`. Retired coins remain in the gallery and any held balance remains on Home. Their historical NAV is excluded from current portfolio value, and their detail page has no trade ticket or cash-in action.
- `ethereum` accepts `{available, wrapped_token, pool}`. Both nonzero addresses and explicit `available: true` are required to display them. Predicted addresses or a token without a pool leave the panel at **Not available yet**. This setting is an operator publication decision, not on-chain deployment verification.

For the coordinated B24 migration, keep the served B23 build and environment until `/home/postfiat/repos/b23-coord/status/b24-cutover-done` exists. The Phase 5 handover may appear while still marked PREPARING; that is not a deployment gate. Review its final consumer-action qualifications and actual chain state before selecting the redemption mode. Retain B23 in `retired_assets` even when a test wallet has no remaining B23. Build previews into a separate directory so Vite does not replace the served `dist` before cutover.

Verification:

```sh
node --test src/features/wallet/l1/market/{config,model,offer-setup}.test.mjs src/features/wallet/l1/gallery/{model,market}.test.mjs server/l1/history.test.mjs
node src/features/wallet/l1/gallery/config-browser.test.mjs
node src/features/wallet/l1/gallery/browser.test.mjs
node src/features/wallet/l1/market/browser.test.mjs
```

Browser fixtures are synthetic. A deployment requires separate real served-page verification and accepted receipts with before/after chain balances.

The published B24 devnet-2 configuration is [b24-devnet-2.json](b24-devnet-2.json). TRADE independently read the asset, fresh profile, 10050/9995 route and 100-unit ask on all six validators after the Phase 5c cutover marker: height 1331, state root `887c0af9b6b0ce4b0bd9c41b6035f5b8472393f1f400fe5274d380e43ddc7a69f6555f2fc1820f75b29bc3c5e950bda2`. The earlier frozen Phase 5 handover's stopped status is historical; the matching Phase 5c marker and live reads establish activation. The finalized reading is $420,302.38 at NAV 1.000000, fully Attested in that packet. Current supply includes a later 20-unit subscription and the route has a 20-PFUSDC reserve. That reserve does not make market-bought holdings redeemable. Ethereum availability remains false.
