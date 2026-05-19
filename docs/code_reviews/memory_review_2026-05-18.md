# Code Review: Memory

Source doc: `docs/wiki/surfaces/memory.md`
Branch: `review/memory-code-review`
Review status: complete
Code review complete: yes
Last updated: 2026-05-18

## Scope

Reviewed the memory feature from chat turn persistence through background
summarization, deep-memory compaction, chat-context injection, and the Memory UI:

- `docs/wiki/surfaces/memory.md`
- `prompts/memory/chat_memory_v1.md`
- `prompts/memory/deep_memory_v1.md`
- `prompts/chat/account_memory_context_v1.md`
- `server/chat-memory-worker.js`
- `server/chat-memory-context.js`
- `server/repositories/chat-memory.js`
- `server/db/migrations/004_chat_memory.sql`
- `server/db/migrations/005_deep_chat_memory.sql`
- `server/chat-router.js`
- `server/product-contracts.js`
- `server/index.js`
- `src/features/memory/MemoryView.jsx`
- `src/features/memory/memory.css`
- `scripts/chat-memory-postgres-smoke.mjs`
- `scripts/memory-backfill.mjs`

## Summary

No P0 was found in this pass.

The memory feature is directionally coherent: chat responses enqueue async memory
jobs, the worker summarizes with a private OpenRouter path, rows are
account-scoped, and chat context injection is bounded. The weakest parts are
data-shape durability and operational polish. The deep-memory block model is
derived at processing time instead of being snapshotted, the worker accepts
loosely parsed model JSON, and the inspect/search surface can become expensive
without better indexing or request shaping.

## Useful Review Standard

For this feature, the code should meet these standards:

- Memory jobs must never block chat completion.
- Account ownership must be checked at every source read and list/read API.
- Retry behavior must be idempotent and must not create duplicate memory rows.
- Deep memory must be stable: a block job should summarize the same source rows
  regardless of later inserts, backfills, or retries.
- Memory context should be bounded, clearly lower authority than the current
  request, and included in cost estimates.
- Provider output should be parsed with strict shape validation, not best-effort
  string extraction.
- Search and inspection endpoints should have bounded query cost.
- Maintenance scripts should be production-safe by default and free of local
  hard-coded defaults.

## Findings

### P1 - Deep-memory block jobs do not snapshot their source rows

Surfaces:

- `server/repositories/chat-memory.js` / `maybeEnqueueDeepMemoryJobForAccount`
- `server/repositories/chat-memory.js` / `deepMemoryJobSource`
- `server/repositories/chat-memory.js` / `completeDeepMemoryJob`
- `server/db/migrations/005_deep_chat_memory.sql`

Current behavior:

- A deep-memory job stores `account_id` and `block_index`.
- When the worker later processes the job, `deepMemoryJobSource` recomputes the
  block by `row_number() OVER (ORDER BY created_at ASC, id ASC)`.
- The final deep-memory entry is upserted through a synthetic
  `assistant_message_id`, not through a unique `(account_id, block_index)` entry
  constraint.

Why this matters:

- Backfills, imports, corrected timestamps, or manual replays can change which
  36 turn-memory rows belong to a block between enqueue and processing.
- A deleted/recreated deep-memory job can produce duplicate deep-memory entries
  because the entries table does not enforce one deep-memory row per account and
  block.
- The memory page and chat context can then show duplicate or inconsistent deep
  memory.

Proposed fix:

1. Store the source memory entry IDs on `chat_deep_memory_jobs`, either as a
   `source_entry_ids jsonb` array or a join table.
2. Have `deepMemoryJobSource` read exactly those IDs in the stored order.
3. Add a partial unique index on `chat_memory_entries(account_id,
   deep_memory_block_index)` for `kind = 'deep_memory'`.
4. Change `completeDeepMemoryJob` to upsert on the account/block identity rather
   than synthetic message IDs.
5. Extend `scripts/chat-memory-postgres-smoke.mjs` with a retry/recreated-job
   case proving a block cannot duplicate or drift.

### P2 - Memory provider output parsing is too loose for persisted product data

Surfaces:

- `server/chat-memory-worker.js` / `parseSummaryJson`
- `server/chat-memory-worker.js` / `parsedSummaryObject`
- `prompts/memory/chat_memory_v1.md`
- `prompts/memory/deep_memory_v1.md`

Current behavior:

- The worker strips a markdown fence, extracts from the first `{` to the last
  `}`, parses that slice, and then accepts fallback key names.
- Field presence is checked, but field types and maximum semantic shape are not
  validated before persistence.

Why this matters:

- A malformed provider response can be partially accepted and persisted as a
  memory row.
- Future model or prompt changes can silently alter the shape and still pass
  because fallback keys hide the contract break.
- Debugging bad memory becomes harder because the parser normalizes too much.

Proposed fix:

1. Use strict JSON-only parsing for the current prompt version.
2. Validate field types, max lengths, and bullet array lengths before
   persistence.
3. Keep fallback key support only behind an explicit legacy parser path.
4. Add unit smoke coverage for fenced JSON, prose-wrapped JSON, wrong field
   types, missing fields, and overlong values.

### P2 - Memory search is a linear text scan triggered on every UI keystroke

Surfaces:

- `server/repositories/chat-memory.js` / `listChatMemory`
- `server/index.js` / `/api/memory`
- `src/features/memory/MemoryView.jsx` / `loadMemory`
- `server/db/migrations/004_chat_memory.sql`
- `server/db/migrations/005_deep_chat_memory.sql`

Current behavior:

- Search uses `%query%` `ILIKE` across conversation title, user summary,
  assistant summary, and memory text.
- The Memory UI reloads whenever `query` changes.
- The route is authenticated and bounded by `limit`, but there is no search
  index, debounce, or route-specific rate limit.

Why this matters:

- As accounts accumulate memory rows, ordinary typing can issue repeated text
  scans.
- This is not a correctness bug today, but it is an avoidable performance and
  operations problem.

Proposed fix:

1. Debounce memory search in the UI.
2. Add a modest route rate limit for `/api/memory`.
3. Add a Postgres full-text search vector or trigram index for the searched
   columns.
4. Keep the existing `limit` clamp.
5. Add a smoke or repository test that verifies search still scopes by
   `account_id`.

### P2 - Environment parsing can produce invalid worker settings

Surfaces:

- `server/chat-memory-worker.js` / `providerTimeoutMs`
- `server/chat-memory-worker.js` / `fetchDeepMemorySummary`
- `server/chat-memory-context.js` / memory context limit constants
- `server/repositories/chat-memory.js` / `getChatMemoryContext`

Current behavior:

- `TASKNODE_MEMORY_PROVIDER_TIMEOUT_MS=bad` produces `NaN` for the provider
  timeout.
- `TASKNODE_DEEP_MEMORY_MAX_TOKENS=bad` can serialize an invalid `max_tokens`
  value.
- Several limit parsers use `Number(value) || default`, which means `0` cannot
  intentionally disable deep or recent memory context even though the clamp code
  appears to allow zero.

Why this matters:

- Bad environment values can make the worker fail in confusing ways.
- Operators cannot cleanly set context limits to zero during debugging or staged
  rollout.

Proposed fix:

1. Add a shared positive-integer env parser with explicit min, max, and default.
2. Preserve `0` where a limit intentionally allows disabling a section.
3. Log the normalized memory worker configuration at startup without secrets.
4. Add small tests around invalid env values and zero-limit behavior.

### P2 - Memory API returns internal/source fields the current UI does not use

Surfaces:

- `server/repositories/chat-memory.js` / `publicEntry`
- `server/repositories/chat-memory.js` / `listChatMemory`
- `src/features/memory/MemoryView.jsx`

Current behavior:

- `publicEntry` returns `accountId`, provider/model/prompt metadata, and source
  excerpts.
- The Memory UI renders only date, deep-memory title, summaries, and memory
  text.

Why this matters:

- Returning unused fields increases the response shape and makes the API
  contract blurrier.
- Source excerpts are not displayed in the current UX, so they should be a
  deliberate detail endpoint or debug view, not default list payload.

Proposed fix:

1. Split memory row serialization into list, detail, and internal/debug shapes.
2. Keep `/api/memory` list responses limited to fields the UI actually renders.
3. Add an explicit detail route before exposing source excerpts or provider
   metadata in the product UI.

### P3 - Memory worker module has too many responsibilities in one file

Surfaces:

- `server/chat-memory-worker.js`

Current behavior:

- One module owns provider config, provider HTTP calls, redaction, source
  compaction, JSON parsing, summary normalization, queue processing, retry
  handling, and timer startup.

Why this matters:

- The important logic is harder to test in isolation.
- Parser/redaction/provider behavior is locked behind private helpers.
- Future changes to prompts or providers will be riskier than necessary.

Proposed fix:

1. Split provider calls into `chat-memory-provider.js`.
2. Split parsing and validation into `chat-memory-summary.js`.
3. Keep queue orchestration in `chat-memory-worker.js`.
4. Add focused tests for parsing/redaction without needing a database or network.

### P3 - Backfill script has an unprofessional local default

Surfaces:

- `scripts/memory-backfill.mjs`

Current behavior:

- `--title` defaults to `whatwork`.

Why this matters:

- This reads like a local scratch value in a production maintenance script.
- Running the script without flags silently targets a specific conversation
  title instead of making the operator choose a scope.

Proposed fix:

1. Remove the hard-coded default title.
2. Require `--title`, `--account`, or an explicit `--all` flag.
3. Print the selected scope before queueing jobs.

## Fix Order

1. Deep-memory source snapshot and account/block uniqueness.
2. Strict provider output parser and validation tests.
3. Environment parsing cleanup.
4. Memory search debounce, indexing, and rate limiting.
5. API response shape split for list versus detail/debug.
6. Worker module split.
7. Backfill script scope cleanup.

## Evidence Captured

Code paths reviewed:

- `docs/wiki/surfaces/memory.md`
- `prompts/memory/chat_memory_v1.md`
- `prompts/memory/deep_memory_v1.md`
- `prompts/chat/account_memory_context_v1.md`
- `server/chat-memory-worker.js`
- `server/chat-memory-context.js`
- `server/repositories/chat-memory.js`
- `server/db/migrations/004_chat_memory.sql`
- `server/db/migrations/005_deep_chat_memory.sql`
- `server/chat-router.js`
- `server/product-contracts.js`
- `server/index.js`
- `src/features/memory/MemoryView.jsx`
- `src/features/memory/memory.css`
- `scripts/chat-memory-postgres-smoke.mjs`
- `scripts/memory-backfill.mjs`

Verification run on 2026-05-18:

- Review-only branch; no application code was changed.
- `git diff --check` - passed
