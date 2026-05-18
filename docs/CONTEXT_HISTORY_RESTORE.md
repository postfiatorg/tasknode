# Context History Restore

Task Node Official restores historical context documents from the PFTL cache.
There is no user-triggered history import endpoint. Wallet sync stores PFTL
transactions in Postgres, reducer events project context pointers, and the UI
reads the projection.

## Data Flow

- PFTL cache workers sync `account_tx` for linked wallets into
  `pftl_transactions`, `pftl_wallet_transactions`, and `pftl_pointer_memos`.
- Reducer events turn `pf.ptr` / `v4` `CONTENT_KIND.CONTEXT` memos into
  `context_history_pointers`.
- `GET /api/context/history` returns cached pointer metadata for the signed-in
  account and currently linked wallet.
- `GET /api/context/history/ipfs/:cid` fetches encrypted IPFS JSON only if the
  CID is already present in that cached projection.
- Browser wallet unlock decrypts the fetched payload locally. Mnemonic, private
  key, wallet password, and plaintext context never cross the API boundary.

## RPC Configuration

The cache uses the archive-capable history path for transaction backfill and
the rapid path only for current-state polling.

```text
PFTL_HISTORY_WSS_URL=wss://ws-archive.testnet.postfiat.org
PFTL_HISTORY_WSS_URL_FALLBACKS=
PFTL_HISTORY_RPC_URL=https://rpc.testnet.postfiat.org:5006/
PFTL_HISTORY_RPC_URL_FALLBACKS=
PFTL_HISTORY_RPC_API_KEY=
PFTL_HISTORY_RPC_TIMEOUT_MS=12000
PFTL_HISTORY_ACCOUNT_TX_LIMIT=200
PFTL_HISTORY_ACCOUNT_TX_MAX_PAGES=8
```

## Pointer Contract

```text
MemoType   = pf.ptr
MemoFormat = v4
MemoData   = protobuf pf.ptr.v4.Pointer
```

Context restore uses these pointer fields:

```text
cid        field 1
target     field 2
kind       field 3, must be CONTENT_KIND.CONTEXT (5)
schema     field 4
task_id    field 5
thread_id  field 6
context_id field 7
flags      field 8
```

Task and reward pointers are projected into task surfaces, not context document
versions.

## Failure Rules

- Signed out: return `context_login_required`.
- No linked wallet: context history returns an empty account context boundary.
- CID missing from cache: return `context_cid_not_cached`.
- Sync error: expose `history.sync.status = "error"` and `lastError`; do not
  invent document versions.

## Verification

```bash
npm run context-history-rpc-smoke
TASKNODE_DATABASE_ENABLED=true DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial npm run db:pftl-cache-reducer-smoke
SMOKE_BASE_URL=http://127.0.0.1:5174 npm run smoke
```
