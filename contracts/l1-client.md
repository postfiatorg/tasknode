# L1 wallet client contract (TN-WALLET)

Shell interface v1. Shell is registered at `#l1-wallet`. Components are default exports in `src/features/wallet/l1/{bridge,market,issuer,redeem}/index.jsx`.

Import `useL1Wallet` from `../client.jsx` inside each tab, or consume the identical `client` prop. The hook is inside `L1WalletContext` supplied by the shell.

- `client.accountId: string`: signed-in Task Node account id.
- `client.address: string | null`: unlocked pf address; null when locked.
- `client.unlocked: boolean`; `client.chainId: 'devnet-2'`.
- `client.getBalances(): Promise<{address: string, pft: object, assets: object}>`: account_info and account_lines raw RPC results.
- `client.call(method: string, params?: object): Promise<object>`: allowlisted wallet read/quote RPC only. Transport is same-origin `/api/l1/rpc`, no browser proxy URL configuration.
- `client.quote(intent): Promise<object>`: intent `{kind:'transfer',to:string,amount:string}` (PFT atomic units), `{kind:'asset',operation:object}`, or `{kind:'offer',operation:object}`. Source is the unlocked address.
- `client.sign(intent, quote): Promise<Signed>`: local WASM signing only; Signed is opaque, passed unchanged to submit. No seed/passphrase/backup access exposed.
- `client.submit(signed: Signed): Promise<{txId:string,receipt:object,finality:object}>`: returns only with an explicit accepted receipt; rejection or missing receipt throws. A certified round alone is never success. Call getBalances before/after to verify effects.
- `client.subscribe(handler: (event: object) => void): Promise<() => void>`: wallet updates, returns unsubscribe.

Shell implementation initially throws until unlocked. Account switches/logout invalidate handles and pending signing work. Never persist a client reference across accounts. Call quote/sign only after the user reviews exact intent. Use separate creation/redemption and market controls.

Server routers: named exports `handleBridgeRoutes(context)` and `handleNavcoinRoutes(context)` in `server/l1/bridge-routes.js` and `navcoin-routes.js`. Return `true` when handled and `false` otherwise. Context `{req,res,url,session,json,readJson,proxyUrl}`. `json(res,status,body)`; `readJson(req,maxBytes)`; proxyUrl comes only from server env `L1_WALLET_PROXY_URL`. Gateway authenticates the session and enforces same-origin writes before routers. Use paths `/api/l1/bridge/*` and `/api/l1/navcoin/*`. The single registration in server/index.js mounts both; downstream lanes must not edit that file.

Source port provenance: Post Fiat L1 wallet source from `postfiatl1v2-navcoin-proof-b2.2/wallet-web` (source baseline 7e9c251fc). Binary artifacts are not committed; packaging of WASM must be coordinated with orchestrator under the no-binaries rule.
