# Review Plan: Task Lifecycle Replay

Source doc: `docs/wiki/architecture/task-lifecycle.md`
App doc group: Architecture
App doc slug: `task-lifecycle`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/task-lifecycle-replay` (Phase 1 fixes implemented)

## Important App Surfaces

- `shared/task-lifecycle.js`
- `server/pftl-cache-reducer.js`
- `server/task-receipt-projection.js`
- `reference_clients/python/tasknode_pftl/reducer.py`
- `server/repositories/tasks.js`
- `server/db/migrations/006_task_projections.sql`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (refresh loop / reward states).
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Positive reward decisions collapsed to terminal `rewarded` before payment indexed

**Files:** `server/pftl-cache-reducer.js`, `server/task-receipt-projection.js`, `reference_clients/python/tasknode_pftl/reducer.py` (prior)

**What happens:** `pf.task.reward_decision.v1` mapped directly to `rewarded` at replay and import layers. Wiki/shared contract defines `reward_decided` as a review-loop state with `requiresRefresh: true` until `pf.reward.v1` lands.

**Impact:** Task list stops polling while payment is still outstanding; detail forensics can show “payment not indexed” while list shows terminal Rewarded.

**Fix:** **Fixed** — shared `statusFromRewardAmount()` maps positive decisions to `reward_decided`, zero to `rewarded`; applied in JS reducer, Python reducer, and `canonicalReceiptProjection` (payment schema still finalizes to `rewarded`).

---

### 2. P1 — Import canonicalizer overrode reducer status for all reward schemas

**Files:** `server/task-receipt-projection.js`, `server/repositories/tasks.js:704-715`

**What happens:** `canonicalReceiptProjection` treated both `pf.task.reward_decision.v1` and `pf.reward.v1` as terminal reward schemas and forced `rewarded` on DB import.

**Impact:** Even a corrected reducer could be undone at persistence, preserving split-brain list/detail behavior.

**Fix:** **Fixed** — only `pf.reward.v1` forces terminal `rewarded`; decision-only receipts derive status from reward amount.

---

### 3. P1 — JS replay lacked Python ordering/dedupe and terminal guards

**Files:** `server/pftl-cache-reducer.js` vs `reference_clients/python/tasknode_pftl/reducer.py:12-19,137-141`

**What happens:** JS reducer iterated hydrated events in arrival order with no `(tx_hash, memo_index, cid)` dedupe and no protection against late non-terminal updates after terminal status.

**Impact:** Duplicate pointer rows or out-of-order incremental sync could produce wrong final status on rebuild.

**Fix:** **Fixed** — ledger sort + dedupe before reduce; `applyProjectionStatus` ignores non-terminal transitions once status is terminal.

---

### 4. P2 — Import uses array index as memo_index in some replay paths (deferred)

**Files:** `server/repositories/tasks.js:789-846`

**What happens:** Re-imports with different event order may create extra rows instead of upserting on canonical `(tx_hash, memo_index, cid)`.

**Fix:** Open — persist real `pointer.memo_index` during import and add monotonic merge on UPSERT.

---

## Evidence

- `npm run quality` (includes `task-lifecycle-smoke`, `task-receipt-projection-smoke`, `pftl-cache-reducer-replay-smoke`)
- `reference_clients/python/tests/test_reducer.py` (zero + positive decision cases)
- `npm run pftl-cache-reducer-postgres-smoke` when DB available (zero-reward decision path unchanged)

## Overlap with open PR #2 (tasks)

PR #2 partially fixed JS reducer mapping but left `task-receipt-projection.js` and Python reducer unchanged. This branch completes the cross-layer contract.
