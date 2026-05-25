# PR-08 Review: Chat, Context Refine, Jobs, And Memory Packets

Date: 2026-05-25
Branch: `review/08-chat-context-memory`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed the shared chat instruction boundary (`taskNodeInstructions`), Jobs XML +
pgvector retrieval, Context Refine inside chat, markdown rendering, memory/task
context packets, network task profile source assembly, and account-scoped chat
history. The four chat modes share one prompt assembly path; stream and non-stream
execution both load context/memory/tasks and Jobs retrieval before provider calls;
Context Refine uses a dedicated structured prompt but the same chat send/history
persistence boundary. Two maintainability gaps remain: stale Context Refine cards
are not detected until apply is attempted, and the apply path is not atomic against
concurrent accepts.

## Findings

### P0

None.

### P1

1. **Context Refine apply is not atomic; concurrent accepts can write duplicate revisions**
   - **File/line:** `server/context-edit-chat.js:173-218`, `server/repositories/context-edit.js:246-268`
   - **Severity:** P1
   - **Impact:** `applyContextEditProposal` reads `state === "pending"`, patches the
     document, calls `saveContextDocument`, then marks the proposal applied. The
     Postgres update does not include `AND state = 'pending'`, and save is outside a
     transaction with the state transition. Two concurrent apply requests (double
     click, two tabs) can both pass the pending check and persist two context
     revisions from one proposal.
   - **Verification:** Read apply flow; `markContextEditProposalApplied` UPDATE has
     no pending guard; no transaction wraps save + mark.
   - **Fix:** Use a single transaction: `UPDATE ... SET state = 'applied' WHERE id =
     $1 AND state = 'pending' RETURNING *`; abort if zero rows; save context only
     after winning the row lock.

### P2

1. **Stale Context Refine proposals stay actionable in history until apply fails**
   - **File/line:** `src/features/context/ContextEditProposalCard.jsx:90-151`, `server/context-edit-proposals.js:120-130`
   - **Severity:** P2
   - **Impact:** Staleness is enforced on apply via `base_context_revision` /
     `base_body_sha256`, but proposal metadata loaded from chat history stays
     `pending` when the user edits context elsewhere and returns. Accept/Discard
     buttons remain visible until apply returns `context_edit_stale`.
   - **Verification:** No server-side `state = 'stale'` transition on context save;
     card only hides actions when `state` is already `applied`, `rejected`, or
     `stale`.
   - **Fix:** Reconcile proposal state when loading history or before rendering the
     card (compare base revision/hash to current document).

2. **Postgres persistence for `contextStatus` was not exercised in this environment**
   - **File/line:** `scripts/chat-context-status-smoke.mjs:18-20`, `server/chat-router.js:838`
   - **Severity:** P2 (evidence gap)
   - **Impact:** Smoke passed unit checks and JSON runtime dry-run only;
     `DATABASE_URL` was unset so the script logged
     `skipped Postgres persistence (DATABASE_URL unset)`.
   - **Verification:** `node scripts/chat-context-status-smoke.mjs` output.
   - **Fix:** Integration owner should re-run with Docker Postgres on port 5436
     before merge.

3. **Live Jobs pgvector retrieval was not exercised in this review pass**
   - **File/line:** `scripts/jobs-corpus-pgvector-smoke.mjs`, `server/jobs-corpus.js:447-472`
   - **Severity:** P2 (evidence gap)
   - **Impact:** Required checks disable Jobs retrieval in
     `chat-context-status-smoke`; corpus ingestion + cosine query path was not run
     against a populated `jobs_corpus_chunks` table during review.
   - **Verification:** `npm run chat-spirit-prompt-smoke` proves injection format;
     `jobs-corpus-pgvector-smoke` requires `DATABASE_URL` and embeddings.
   - **Fix:** Run `node scripts/jobs-corpus-pgvector-smoke.mjs` against local
     Docker Postgres before claiming Phase 2 retrieval is verified in prod-like
     data.

4. **Manual chat/Context Refine screenshots were not captured**
   - **Severity:** P2 (evidence gap per spec)
   - **Impact:** Static/smoke coverage proves prompt assembly, markdown ordered
     lists, and context-status metadata shape, but the spec also asks for chat
     screenshots showing Jobs retrieval status and Context Refine accept-after-
     navigation evidence.
   - **Verification:** Review environment had no signed-in session with ingested Jobs
     corpus or a completed Context Refine accept flow.
   - **Fix:** Integration owner attaches screenshots when merging if Fly dev or
     seeded local Docker has representative data.

5. **OpenAI Frontier history is still flattened differently from OpenRouter**
   - **File/line:** `server/chat-provider-message-builders.js`, `docs/review_burndown/reviews/surface-chat.md:113-117`
   - **Severity:** P2 (maintainability; carry-over from surface-chat review)
   - **Impact:** Private modes use role-labeled OpenRouter messages; Frontier uses
     a single transcript blob for OpenAI. Behavior is intentional today but increases
     drift risk for memory/context packet parity across providers.
   - **Verification:** Prior surface-chat finding; still present on main.
   - **Fix:** Deferred — shared history helper + fixture tests (`chat-provider-history-fixtures`).

### P3

1. **Chat credit estimate reserves Jobs retrieval tokens even when runtime retrieval is empty**
   - **File/line:** `server/chat-estimate.js:73`, `server/jobs-corpus.js:416-427`
   - **Severity:** P3
   - **Impact:** Estimates use `jobsRetrievalEstimateText()` (top-3 max-size chunks)
     when spirit is enabled, even if the corpus is empty and runtime retrieval
     returns `skipped`. Estimates are conservative, not wrong-side for billing.
   - **Fix:** Optional — fold retrieval availability/corpus row count into estimate.

## Spec Question Checklist

| Question | Result |
| --- | --- |
| Single prompt assembly for context, memory, tasks, Jobs XML across chat modes? | Yes — `taskNodeInstructions` → `formatChatSpiritContext`; `chat-spirit-prompt-smoke` covers all four modes. Context Refine uses separate `renderContextEditPrompt` by design. |
| Jobs pgvector injects chunks and exposes status in run metadata? | Yes — `jobsRetrievalForChat` → `buildChatContextStatus.jobsRetrieval`; persisted in `runMetadata.contextStatus`. Live corpus not exercised here. |
| Markdown ordered lists render correctly? | Yes — `chat-markdown-smoke` covers compact, sectioned, and loose ordered lists. |
| Context Refine inside chat; accepted edit persisted once? | Yes for normal path — apply checks pending + revision/hash; stream route blocked for context edit. Concurrent apply race remains (P1). |
| Navigating away clears invalid accepted edit actions? | Partial — `contextEditMode` resets on chat switch/reset; applied/rejected cards hide actions from persisted metadata. Stale pending cards stay actionable until apply (P2). |
| Context history uses cached readable previews? | Yes — `hydratedPreviewByCid` cache in Context editor skips re-fetch for decrypted CIDs (`src/main.jsx:3566-3602`). |
| Network Task Profile combines live tasks + diagnostic report without unknown-task spam? | Yes — `getLiveTaskRoutingContext` filters `status <> 'unknown'`; packet caps refused/rewarded slices. |
| Chat history ownership and signed-out behavior account-scoped? | Yes — `/api/chat/history` returns 401 without session; `assertConversationIdAccountBoundary` enforces `account_*` prefix. |

## What Looks Correct

- `server/chat-memory-context.js::taskNodeInstructions` is the sole assembly boundary
  for normal chat; Jobs XML slots receive context, memory, tasks, and retrieval text.
- Stream and non-stream paths both call `jobsRetrievalForChat` and persist
  `contextStatus` in `runMetadata` (`server/chat-router.js:775-838`, `880-927`).
- Context Refine runs through `/api/chat/send` only; `/api/chat/stream` returns
  `context_edit_requires_send` (`server/product-contracts.js:736-747`).
- Task context packet caps refused/rewarded lists and labels cache advisory
  (`server/chat-task-context.js`, `prompts/chat/account_tasks_context_v1.md`).
- Network task profile source excludes `unknown` projections and combines profile
  snapshot with compact live task groups (`server/repositories/network-task-profile.js:463-470`).

## Checks Run

```bash
npm ci
npm run chat-markdown-smoke
node scripts/chat-context-status-smoke.mjs
npm run chat-attachment-smoke
npm run security-smoke
npm run chat-spirit-prompt-smoke
npm run context-edit-smoke
npm run network-task-profile-smoke
git diff --check
```

Manual evidence:

- Code review of chat router, context edit, jobs corpus, network task profile,
  Context history preview cache, and chat history auth boundaries.
- `chat-context-status-smoke` skipped Postgres persistence (`DATABASE_URL` unset).

## Residual Risks

- Concurrent Context Refine apply can duplicate context revisions until transactional
  guard lands (P1).
- Jobs pgvector Phase 2 behavior depends on operator corpus ingestion and pgvector
  extension availability (`014_jobs_corpus_pgvector.sql`).
- Live UX evidence (Jobs retrieval status visible in metadata/UI, Context Refine
  accept-after-navigation screenshot) not captured in this pass.

## Merge Recommendation

**Do not merge from this review branch alone** — it is review documentation only.
Integration owner should re-run required checks (including Postgres-backed
`chat-context-status-smoke` and optionally `jobs-corpus-pgvector-smoke`), track the
Context Refine apply atomicity fix, then merge `origin/main` behavior separately.
This review PR records findings only; it does not change application code.

---

```text
Review PR: PR-08
Boundary: Chat, context refine, Jobs pgvector, memory/task packets
Branch: review/08-chat-context-memory
Changed files:
  docs/review_burndown/reviews/pr-08-chat-context-memory.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: concurrent Context Refine apply can write duplicate context revisions (non-atomic pending→applied + save)
- P2: stale proposal cards stay actionable until apply; Postgres contextStatus persistence not exercised; live pgvector not exercised; manual screenshots missing; OpenAI/OpenRouter history divergence (carry-over)
- P3: Jobs retrieval estimate always reserves top-3 chunk tokens when spirit enabled
Fixes included: none (review-only)
Checks run: chat-markdown-smoke, chat-context-status-smoke, chat-attachment-smoke, security-smoke, chat-spirit-prompt-smoke, context-edit-smoke, network-task-profile-smoke, git diff --check
Manual app evidence: code-path review only; DATABASE_URL unset for Postgres smokes
Residual risks: apply race; corpus/pgvector ops dependency; missing live UX screenshots
Merge recommendation: review-only PR — fix apply atomicity before treating Context Refine as hardened; re-run Postgres smokes before merging main behavior
```
