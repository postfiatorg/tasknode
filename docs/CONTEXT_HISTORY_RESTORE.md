# Context History Restore

Task Node Official restores historical context documents in two phases:

1. The server discovers encrypted context CIDs from PFTL history.
2. The browser fetches and decrypts a selected CID only after local wallet
   unlock.

This keeps account history discovery server-side while keeping wallet secrets
and plaintext context browser-local.

## Data Flow

- `POST /api/context/history/rpc/import`
  - requires a signed-in account session;
  - uses only the wallet already linked to that account;
  - calls full-history PFTL `account_tx`;
  - decodes `pf.ptr` / `v4` protobuf memos;
  - keeps only `CONTENT_KIND.CONTEXT` pointers;
  - stores CID, tx hash, ledger, memo index, timestamp, schema, flags, and
    direction metadata.
- `GET /api/context/history`
  - returns imported pointer metadata for the signed-in account.
- `GET /api/context/history/ipfs/:cid`
  - fetches encrypted IPFS JSON only if the CID is already present in that
    account's imported context history.
- Browser wallet unlock
  - decrypts the fetched payload with the local seed-derived Task Node key;
  - never sends mnemonic, private key, wallet password, or plaintext context to
    the server.

## RPC Configuration

Historical restore is intentionally separate from the rapid balance path.

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

If `PFTL_HISTORY_WSS_URL` is unset, the server defaults to the canonical
archive WSS endpoint and uses JSON-RPC only as fallback. Local Docker may still
use the machine-local rapid node for current balance reads, but historical
context restore should use the full-history archive endpoint. If the fallback
RPC endpoint requires auth, set `PFTL_HISTORY_RPC_API_KEY`; the balance RPC key
is not reused automatically.

## Pointer Contract

The restore scanner follows the PFTasks/PFDocs v4 pointer contract:

```text
MemoType   = pf.ptr
MemoFormat = v4
MemoData   = protobuf pf.ptr.v4.Pointer
```

The pointer fields used by Task Node Official are:

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

Task and reward pointers are ignored by the context restore import. They may be
indexed by a future task-history surface, but they should not appear as context
document versions.

## Failure Rules

- Signed out: return `context_login_required`.
- No linked wallet: return `context_wallet_required`.
- RPC unavailable: return `context_history_rpc_failed` guidance and do not
  overwrite existing imported history.
- No context pointers found: return success with discovery counts and leave
  existing history intact.
- CID fetch for an unimported CID: return `context_cid_not_imported`.

## Verification

Run deterministic coverage without live RPC:

```bash
npm run context-history-rpc-smoke
```

Run the API smoke suite against a running app:

```bash
SMOKE_BASE_URL=http://127.0.0.1:5174 npm run smoke
```

Live restore requires a signed-in session, a linked wallet with historical
context pointers, and access to a full-history PFTL RPC.
