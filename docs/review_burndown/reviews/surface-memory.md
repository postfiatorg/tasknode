# Review Plan: Memory

Source doc: `docs/wiki/surfaces/memory.md`
App doc group: Surfaces
App doc slug: `memory`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Branch: `review/memory-worker-billing` (Phase 1 fixes implemented)

## Important App Surfaces

- `src/features/memory/MemoryView.jsx`, `src/features/memory/memory.css`
- `server/chat-memory-worker.js`
- `server/chat-memory-context.js`
- `server/repositories/chat-memory.js`
- `server/chat-router.js`
- `server/db/migrations/004_chat_memory.sql`, `005_deep_chat_memory.sql`, `013_deep_memory_snapshots.sql`
- `scripts/chat-memory-postgres-smoke.mjs`, `scripts/memory-backfill.mjs`

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed (static + API read paths).
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Targeted smoke evidence recorded.
- [x] Findings written with realistic severity.

---

## Findings

### 1. P1 — Deep Memory could disappear from Memory page while still injected into chat

**Files:** `server/repositories/chat-memory.js:648-684` (prior), `src/features/memory/MemoryView.jsx:22-23` (prior)

**What happens:** `/api/memory` returned one mixed list (`ORDER BY created_at DESC LIMIT 100`). The UI took the first 3 `deep_memory` rows from that window. Chat loads deep memories via kind-filtered queries in `getChatMemoryContext`. After ~100 newer turn memories, deep blocks fell out of the list window but remained in chat context.

**Impact:** Users auditing Memory see incomplete deep history while chat still uses those blocks — split-brain between audit UI and provider input.

**Fix:** **Fixed** — default `listChatMemory` now uses the same kind-aware caps as `getChatMemoryContext` (deep 3, turn 36). Search mode still uses unified ILIKE query with per-kind slices. Postgres smoke asserts deep memory survives >100 newer turn rows.

---

### 2. P1 — Terminal failed memory jobs are invisible on Memory page

**Files:** `server/repositories/chat-memory.js:590-645`, `server/chat-memory-worker.js`, `src/features/memory/MemoryView.jsx`

**What happens:** After `attempt_count >= TASKNODE_MEMORY_MAX_ATTEMPTS` (default 5), jobs become `failed` with no user-visible signal.

**Impact:** Chat succeeds but memory compression silently stops; operators only discover via DB inspection.

**Fix:** **Fixed (partial)** — `/api/memory` now returns `queue` health (`turnJobs` / `deepJobs` pending/processing/failed counts). Memory page shows a banner when `failed > 0`. Requeue/admin path still open (P2).

---

### 3. P2 — Provider retries re-spend tokens; enqueue is fire-and-forget

**Files:** `server/chat-memory-worker.js:183-327`, `server/chat-router.js:493-502`, `880`, `989`

**What happens:** Row writes are idempotent, but failed jobs after a successful OpenRouter call retry the provider call. Enqueue failures are caught and logged without surfacing to chat responses.

**Impact:** Operational cost on retries; rare silent skip of memory queue.

**Fix:** Open — add provider idempotency key or skip re-call when entry row already exists; surface enqueue failure in `contextStatus` or ops metrics.

---

### 4. P2 — Memory UI vs chat prompt truncation not labeled

**Files:** `server/chat-memory-context.js:31-35`, `64-66`, `src/features/memory/MemoryView.jsx`

**What happens:** Chat truncates memory text to env char limits; Memory page shows full stored text.

**Impact:** Users over-trust Memory page length vs what the model receives.

**Fix:** Open — UI note (“chat truncates to N chars”) or link to env limits.

---

### 5. P2 — Estimate vs send can diverge when memory load times out

**Files:** `server/chat-memory-context.js:129-157`, `server/product-contracts.js:601`, `667`, `721-729`

**What happens:** Standalone `/api/chat/estimate` and send preflight both load memory, but timeout (default 250ms) can drop memory on one request and not another. Within a single send/stream, preflight loads once and credit gate reuses it (consistent).

**Impact:** Rare credit surprise on slow DB; not a same-request split-brain.

**Fix:** Open — shared request-scoped cache or document timeout behavior in wiki.

---

### 6. P2 — `safeConversationId` buckets empty IDs to `"dev"`

**Files:** `server/repositories/chat-memory.js:23-25`

**What happens:** Missing conversation IDs become `"dev"` within an account.

**Impact:** Low-severity grouping oddity for malformed enqueue paths.

**Fix:** Open — reject enqueue without conversation ID instead of synthetic bucket.

---

### 7. P2 — Loose JSON extraction in memory worker

**Files:** `server/chat-memory-worker.js:120-146`, `239-241`

**What happens:** Parser accepts first `{`…`}` slice and fallback keys.

**Impact:** Partially malformed provider output can persist.

**Fix:** Open — strict schema validation smoke + reject on parse failure (retry path exists).

---

### 8. P2 — `db:memory-smoke` not in `npm run quality`

**Files:** `package.json`

**What happens:** Postgres memory regressions can ship without CI running memory smoke.

**Fix:** Open — add to quality chain or document required pre-merge command.

---

## What looks correct (verified statically)

| Area | Assessment |
|------|------------|
| Account scoping | Job source join requires matching account/conversation on user+assistant messages; negative fixture in postgres smoke |
| Deep snapshot design | Post-`013` snapshots + block upsert; drift/retry covered in smoke |
| Chat prompt contract | Deep: User/Assistant/Memory; recent: date + memory only — matches wiki and `MemoryView` rendering |
| Billing gate | Send/stream credit check re-estimates with loaded memory before 402 |
| Worker reclaim | Stale `processing` jobs reclaimed to `pending` at 5 minutes with backoff |
| Chat non-blocking | Memory enqueue/worker async; chat returns before compression completes |

---

## Fix bundles

1. **`bundle-memory-audit-parity`** — **Fixed** (kind-aware list + overflow smoke).
2. **`bundle-memory-worker-ops`** — **Partial** (queue health on API + UI banner; requeue still open).
3. **`bundle-memory-parser-hardening`** — Open (P2).
4. **`bundle-memory-billing-parity`** — Open (document timeout / shared load).
5. **`bundle-memory-backfill-safety`** — Open (backfill `--title` default, snapshot reconcile).
6. **`bundle-memory-ui-perf`** — **Partial** (search debounce 300ms; truncation note still open).

---

## Verification

**Base:** `origin/main` @ `4e34fa8`

**Commands run** (exit 0 unless noted):

```bash
npm run quality
node scripts/chat-memory-postgres-smoke.mjs   # requires DATABASE_URL
npm run runtime-smoke
npm run chat-spirit-prompt-smoke
```

**Not verified this pass:**

- Live Docker Memory page screenshot with failed-job banner.
- End-to-end OpenRouter memory worker with real provider call.
- Manual requeue of failed jobs (no admin API yet).

---

## Review Findings (legacy 2026-05-18 plan — superseded)

Prior P1 “deep-memory block jobs do not snapshot source rows” is **resolved** on current `main` via migration `013` and repository snapshot enqueue. Remaining parser/backfill items from that doc are tracked above as P2.
