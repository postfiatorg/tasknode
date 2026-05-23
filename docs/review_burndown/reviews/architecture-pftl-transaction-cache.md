# Review Plan: PFTL Transaction Cache

Source doc: `docs/wiki/architecture/pftl-transaction-cache.md`
App doc group: Architecture
App doc slug: `pftl-transaction-cache`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/pftl-transaction-cache` (Phase 1 fixes implemented)

## Important App Surfaces

- `server/db/migrations/007_pftl_transaction_cache.sql`
- `server/repositories/pftl-cache.js`
- `server/pftl-cache-sync.js`, `server/pftl-transactions.js`
- `server/task-generation-worker.js`
- `src/features/wallet/WalletView.jsx`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (wallet tx feed sync state).
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Stale `decode_error` blocked pointer recovery on re-upsert

**Files:** `server/repositories/pftl-cache.js` (`insertPointer` upsert)

**What happens:** Pointer memo upsert used `COALESCE(EXCLUDED.decode_error, existing)`, preserving a prior `pointer_decode_failed` even when a later idempotent ingest decoded the memo successfully.

**Impact:** Reducer enqueue and task/context replay permanently skipped recovered pointers (`decode_error IS NULL` required).

**Fix:** **Fixed** — upsert now writes `EXCLUDED.decode_error` so successful re-ingest clears the error. Postgres smoke covers fail → recover on same `(tx_hash, memo_index)`.

---

### 2. P1 — Wallet feed hid `archive_incomplete` partial cache state

**Files:** `server/pftl-cache-sync.js`, `server/pftl-transactions.js`, `src/features/wallet/WalletView.jsx`

**What happens:** `readCachedAccountTx` mapped any non-error checkpoint with cached rows to `sync.status: "ready"`. API `complete` came from hot-sync page metadata (often null), and UI treated null as fully complete.

**Impact:** Partial hot-cache history displayed as finished while archive checkpoint was still open — violates architecture sync semantics.

**Fix:** **Fixed** — shared `publicPftlCacheSyncState()` exposes `archive_incomplete` / `archiveComplete`; wallet API and UI use archive checkpoint for `complete`.

---

### 3. P1 — Task offer sync skipped allocation wallet registration

**Files:** `server/task-generation-worker.js` (`syncOfferProjection`)

**What happens:** After offer publish, only subject + authority wallets were hot-synced. Allocation wallet (from offer payload) deferred until review worker — missing live watcher coverage for reward-side txs.

**Fix:** **Fixed** — register/sync allocation wallet when `allocation_wallet` is present on the offer.

---

### 4. P2 — Multi-wallet observation backfill timing (deferred)

**Files:** `server/repositories/pftl-cache.js`, task submission paths

**What happens:** Single-wallet hot sync on some task actions; observation bridge depends on per-wallet ingest order.

**Fix:** Open — extend submission/action sync to all receipt wallets (pattern exists in `task-review-worker.js`).

---

## Evidence

- `npm run quality` (includes `pftl-cache-sync-state-smoke`)
- `npm run pftl-cache-smoke`
- `npm run db:pftl-cache-smoke` when Postgres available (decode recovery + archive_incomplete read path)

## Overlap

Touches `pftl-cache-sync.js` / reducer enqueue paths also edited in open PR #6; changes are compatible (decode recovery + sync metadata only).
