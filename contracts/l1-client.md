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

Selection priority: CLI directory argument, then `B23_WALLET_WASM_DIR`, then `/home/postfiat/repos/b23-coord/artifacts/wallet-wasm/` if its SHA256SUMS exists, otherwise the bundled `src/features/wallet/l1/wasm/` package. Explicit sources never silently fall back. Example: `node src/features/wallet/l1/prepare-wasm.mjs /home/postfiat/repos/b23-coord/artifacts/wallet-wasm/`.

Each source directory must contain SHA256SUMS with standard sha256sum entries for all five package files: postfiat_wallet_wasm.js, postfiat_wallet_wasm.d.ts, postfiat_wallet_wasm_bg.wasm, postfiat_wallet_wasm_bg.wasm.d.ts, package.json. Filenames can be at the directory root or prefixed with pkg/. All bytes are checked before any destination file changes; missing, duplicate or mismatched checksums fail closed. The script copies matched glue, declarations, WASM and package metadata together and writes normalized SHA256SUMS. It has no hard-coded artifact hash. Checksums verify package consistency; they do not replace the orchestrator's release/signing qualification.

Development Vite forwards WebSockets for `/api` (`ws: true`), preserving the browser Origin. Production built Task Node serves `/api/l1/rpc` directly.

Final transaction behavior: quote objects are bound to the exact intent and wallet; pass the returned object unchanged to sign. A quote is consumed by signing. Signed handles are opaque, account-scoped and single-use. Neither handles nor quotes may be cloned or persisted. A submit transport failure is uncertain, never retried automatically. `client.submit` requires matching tx_id and accepted=true, including for certified rounds. Offer submissions use `mempool_submit_signed_offer_transaction`, then receipt polling; transfer and asset submissions use their finality variants. `client.subscribe` delivers the wallet_update snapshot and returns a local cleanup function. No seed or passphrase leaves the browser.

Gateway deployment: `L1_WALLET_PROXY_URL` accepts ws/wss or http/https (converted to ws/wss for RPC). `L1_WALLET_PROXY_TOKEN_FILE` names a raw UTF-8 token file (trailing newline allowed). It takes precedence over `L1_WALLET_PROXY_TOKEN`, which is the fallback when no file is configured. A configured unreadable/empty/invalid file fails closed with a generic error, never its contents. The credential is read per WebSocket connection and stays server-side, forwarded as bearer header and proxy_auth_token. Rotate by replacing the file and reconnecting. Allowed RPC methods are the exact sets in `src/features/wallet/l1/lib/rpc-methods.js`. Native browser WebSocket Origin must match the configured Task Node request origin. Each message and response revalidates the session/account. SQL sessions (`authenticated:true`) and runtime sessions (`status:'signed_in'`) are supported.

Bundled default WASM SHA256: `affd340817788d45a313e60ec512493c6c56c3acbf81a4d4159636279ea0c882`. Preparation verifies SHA256SUMS for the selected package. Tests exercise actual browser keygen and ML-DSA transfer signing against a local stub; live funded-backup and payment acceptance remain OPS/founder acceptance gates.

Compatibility gate: `facility-ops.md` adds `spread_recipient` to policy. The supplied pre-release WASM predates that field. The signer compares the signed asset/offer operation with the reviewed quote and rejects silently dropped fields. Issuer policy updates require a rebuilt compatible WASM/glue from the merged facility release and release qualification against its SHA256SUMS. Custody and PFT signing are qualified with the current artifact.

Upstream gateway requests preserve the validated browser Origin and set X-Forwarded-Host from the validated Task Node origin. This matches the existing wallet-proxy same-origin reverse-proxy rule and satisfies its mutation Origin requirement. OPS must provision L1_WALLET_PROXY_TOKEN_FILE (preferred) or L1_WALLET_PROXY_TOKEN in the Task Node server environment; this lane does not copy credentials. Live read-only browser/gateway verification against the OPS proxy succeeded with the public holder address; authentication used a synthetic session adapter.

Answer 6a: both the gateway and client.call use `lib/rpc-methods.js`. Bridge/NAVCoin reads include vault_bridge_route, vault_bridge_status, account_assets, book_offers, account_offers, offer_info, navcoin_bridge_routes, navcoin_bridge_supply_status, nav_reserve_proof_status, asset_info, issuer_assets, and pftl_uniswap_receipt. Asset/offer quotes and signed submissions are allowed, including asset mempool and finality variants. For acceptance checking prefer client.submit; a raw client.call submission response is not evidence of execution success. POST and WebSocket upgrade reject missing or foreign Origin.

Tab navigation (answer 6b): every tab receives `onNavigate(tabId: string): boolean` alongside `client`. Canonical IDs are `home`, `send`, `activity`, `bridge`, `market`, `issuer`, `redeem` (case-insensitive). Valid IDs switch the shell tab and return true; unknown IDs leave the current tab unchanged and return false. The shell header offers Bob: 1 Connect -> bridge, 2 Convert -> bridge, 3 Buy -> market. These are navigation controls, not completion claims; Bridge and Market remain separate screens.
