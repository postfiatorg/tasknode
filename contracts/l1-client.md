# L1 wallet client contract (TN-WALLET)

Shell interface v1. Shell is registered at `#l1-wallet`. Components are default exports in `src/features/wallet/l1/{bridge,market,issuer,redeem}/index.jsx`.

Import `useL1Wallet` from `../client.jsx` inside each tab, or consume the identical `client` prop. The hook is inside `L1WalletContext` supplied by the shell.

- `client.accountId: string`: signed-in Task Node account id.
- `client.address: string | null`: unlocked pf address; null when locked.
- `client.unlocked: boolean`; `client.chainId: 'devnet-2'`.
- `client.getBalances(): Promise<{address: string, pft: object, assets: object}>`: `pft` is the raw account result, `assets` is the raw account_lines result.
- `client.call(method: string, params?: object): Promise<object>`: allowlisted wallet read/quote/signed-submit RPC; direct submits require an unlocked wallet and do not interpret acceptance; returns the original `{ok,result,error}` RPC envelope. Transport is same-origin `/api/l1/rpc`, no browser proxy URL configuration.
- `client.quote(intent): Promise<object>`: intent `{kind:'transfer',to:string,amount:string}` (PFT atomic units), `{kind:'asset',operation:object}`, or `{kind:'offer',operation:object}`. Source is the unlocked address.
- `client.sign(intent, quote): Promise<Signed>`: local WASM signing only; Signed is opaque, passed unchanged to submit. No seed/passphrase/backup access exposed.
- `client.submit(signed: Signed): Promise<{txId:string,receipt:object,finality:object}>`: returns only with an explicit accepted receipt; rejection or missing receipt throws. A certified round alone is never success. Call getBalances before/after to verify effects.
- `client.subscribe(handler: (event: object) => void): Promise<() => void>`: wallet updates, returns unsubscribe.

The client is implemented. quote/sign/submit/getBalances/subscribe require an unlocked wallet; call supports public reads while locked. Account switches/logout invalidate handles and pending signing work. Never persist a client reference across accounts. Call quote/sign only after the user reviews exact intent. Use separate creation/redemption and market controls.

Server routers: named exports `handleBridgeRoutes(context)` and `handleNavcoinRoutes(context)` in `server/l1/bridge-routes.js` and `navcoin-routes.js`. Return `true` when handled and `false` otherwise. Context `{req,res,url,session,json,readJson,proxyUrl}`. `json(res,status,body)`; `readJson(req,maxBytes)`; proxyUrl comes only from server env `L1_WALLET_PROXY_URL`. Gateway authenticates the session and enforces same-origin writes before routers. Use paths `/api/l1/bridge/*` and `/api/l1/navcoin/*`. The single registration in server/index.js mounts both; downstream lanes must not edit that file.

Source port provenance: Post Fiat L1 wallet source from `postfiatl1v2-navcoin-proof-b2.2/wallet-web` (source baseline 7e9c251fc). The orchestrator authorized the wallet WASM as the sole binary exception (answers 1/3/6e); the current qualified package is bundled for clean checkouts.

Build artifact preparation (answer 6e): with Node 24, a clean checkout builds using:
`npm ci && node src/features/wallet/l1/prepare-wasm.mjs && npm run build`

Selection priority: CLI directory argument, then `B23_WALLET_WASM_DIR`, then `/home/postfiat/repos/b23-coord/artifacts/wallet-wasm-r2/` if its SHA256SUMS exists, otherwise the bundled `src/features/wallet/l1/wasm/` package. Explicit sources never silently fall back. Example: `node src/features/wallet/l1/prepare-wasm.mjs /home/postfiat/repos/b23-coord/artifacts/wallet-wasm-r2/`.

Each source directory must contain SHA256SUMS with standard sha256sum entries for all five package files: postfiat_wallet_wasm.js, postfiat_wallet_wasm.d.ts, postfiat_wallet_wasm_bg.wasm, postfiat_wallet_wasm_bg.wasm.d.ts, package.json. Filenames can be at the directory root or prefixed with pkg/. All bytes are checked before any destination file changes; missing, duplicate or mismatched checksums fail closed. The script copies matched glue, declarations, WASM and package metadata together and writes normalized SHA256SUMS. It has no hard-coded artifact hash. Checksums verify package consistency; they do not replace the orchestrator's release/signing qualification.

Development Vite forwards WebSockets for `/api` (`ws: true`), preserving the browser Origin. Production built Task Node serves `/api/l1/rpc` directly.

Final transaction behavior: quote objects are bound to the exact intent and wallet; pass the returned object unchanged to sign. A quote is consumed by signing. Signed handles are opaque, account-scoped and single-use. Neither handles nor quotes may be cloned or persisted. A submit transport failure is uncertain, never retried automatically. `client.submit` requires matching tx_id and accepted=true, including for certified rounds. Offer submissions use `mempool_submit_signed_offer_transaction_finality` with `signed_offer_transaction_json` and require an accepted transaction-bound receipt; transfer and asset submissions use their finality variants. `client.subscribe` delivers the wallet_update snapshot and returns a local cleanup function. No seed or passphrase leaves the browser.

Gateway deployment (answer 7b): `L1_WALLET_PROXY_URL` accepts ws/wss or http/https. At gateway registration/startup, `L1_WALLET_PROXY_TOKEN_FILE` is read once. It accepts a plain UTF-8 token (trailing newline allowed), a JSON string, or the JSON principal map documented by OPS; for maps the exact key is `local-demo`. `L1_WALLET_PROXY_TOKEN` is used only when no file is configured. Missing/empty/malformed configured files fail closed with generic errors. The startup credential stays exclusively server-side and is added as the top-level `proxy_auth_token` on upstream RPC messages. It is never passed to browser code; a proxy response containing the credential is blocked. Restart/re-register the gateway after credential rotation.

`L1_WALLET_PROXY_ORIGIN` configures the Origin header of the upstream WebSocket, default unset (no upstream Origin header). Per OPS constants v4, set it to `http://127.0.0.1:8080` with the current proxy. Non-public methods, including book_offers/account_offers, require both this header and the message token. Browser requests still independently require the actual Task Node same-origin header; browsers cannot choose the upstream Origin or credentials. The gateway does not forward browser Origin/X-Forwarded-Host or a bearer credential header upstream. The current OPS JSON token file is `/home/postfiat/.local/state/postfiat-a666-wallet/proxy-tokens.json`, key `local-demo`; no token value belongs in configuration sent to clients.

Allowed RPC methods are the exact sets in `src/features/wallet/l1/lib/rpc-methods.js`. Each message and response revalidates session/account. SQL (`authenticated:true`) and runtime (`status:'signed_in'`) sessions are supported.

Bundled default WASM SHA256: `1cf7d15469ee4a627a8587253cf0231765501da940515b2ac2937bb40472be82`. Preparation verifies SHA256SUMS for the selected package. Tests exercise actual browser keygen and ML-DSA transfer signing against a local stub; live funded-backup and payment acceptance remain OPS/founder acceptance gates.

Release-1 WASM qualification (answer 7a): qualification retained in bundled package aba0efb70 matches the orchestrator's SHA256SUMS. Actual ML-DSA signing of route epoch advance preserves spread_recipient; funding preserves funding_sequence. The transaction builder compares every reviewed operation field against the real flattened signed envelope, including the complete nested policy. These are local signing tests, not chain execution evidence.

Live answer-7b verification: real Task Node development login/getSession on an isolated local server, through the gateway to the existing OPS proxy, successfully read the B23/PFUSDC book and Alice holder's account offers. Both returned ok=true with zero offers. Logged-out access was rejected. The token was loaded only in the server process. No chain writes, proxy changes or service restarts occurred.

Answer 6a: both the gateway and client.call use `lib/rpc-methods.js`. Bridge/NAVCoin reads include vault_bridge_route, vault_bridge_status, account_assets, book_offers, account_offers, offer_info, navcoin_bridge_routes, navcoin_bridge_supply_status, nav_reserve_proof_status, asset_info, issuer_assets, and pftl_uniswap_receipt. Asset/offer quotes and signed submissions are allowed, including asset mempool and finality variants. For acceptance checking prefer client.submit; a raw client.call submission response is not evidence of execution success. POST and WebSocket upgrade reject missing or foreign Origin.

Tab navigation (answer 6b): every tab receives `onNavigate(tabId: string): boolean` alongside `client`. Canonical IDs are `home`, `send`, `activity`, `bridge`, `market`, `issuer`, `redeem` (case-insensitive). Valid IDs switch the shell tab and return true; unknown IDs leave the current tab unchanged and return false. The shell header offers Bob: 1 Connect -> bridge, 2 Convert -> bridge, 3 Buy -> market. These are navigation controls, not completion claims; Bridge and Market remain separate screens.

## Market quote asset and buy setup (item 9)

`market_quote_asset_id` is an exact issued asset id, defaulting to `pfusdc_source_asset_ids[0]`. It is separate from `pfusdc_asset_id` (the pooled reserve payout). Both the quote id and source list can be overridden via `B23_NAVCOIN_CONFIG_JSON`; the next activated ingress epoch requires its actual credited asset id. Invalid/missing quote ids and the family id as market quote are rejected. Books, offers, available payment balance and fill/refund verification use the quote id. Home groups family and source balances into one PFUSDC row. Cash-in omits settlement_source_asset_id, requires a family payout receipt and verifies both family credits.

The offer review includes any missing B23/quote trust lines (or required receiving-limit increases). Each setup is an explicit reviewed `trust_set` with its own fresh asset quote, browser signature, accepted receipt and line read-back; the offer is reviewed and quoted only after these checks. Failed/uncertain setup stops the flow. No setup is a purchase or conversion. The final offer rechecks exact-asset payment balance and receiving capacity before signing. Reserve-only PFUSDC holders trying to buy are directed to Add funds; no automatic conversion is implied.

WASM revision aba0efb70 preserves offer_create expiration absent/zero/positive and offer_cancel through the browser TxBuilder review guard without altering signed fields. The design harness signer shim is removed. Offer finality and receipt access through the pinned live proxy are subject to the probe evidence in status/wallet.md; no live offer is authorized by this contract.

Live probe (2026-11-12T22:48:48Z): a signed-in isolated Task Node gateway passed both methods through :8080. An intentionally invalid offer payload reached the validator and returned rpc_finality_wrong_proposer (validator-0 vs validator-4, height 1246); an all-zero nonexistent receipt id returned rpc_error / transaction receipt unavailable. Thus neither is refused by the proxy allowlist at that observation. This does not qualify a valid offer or automatic proposer rerouting. Evidence: evidence/wallet/9c-live-proxy.log. The pinned proxy and served b23-serve instance were not modified or restarted.
