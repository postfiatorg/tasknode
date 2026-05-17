# WIP: Lightweight Chat Memory

Status: planned
Owner: Task Node Official
Created: 2026-05-17

## Current Task

Implement an extremely light, user-visible memory system that summarizes each
completed chat exchange into durable Postgres memory without blocking the user's
chat response.

This is not product documentation. This file is the active work tracker for the
current milestone.

## Objective

Every time a model responds to a signed-in user, Task Node should persist a
memory item derived from:

- the original chat name;
- the user query;
- the system/model response;
- the date and source conversation.

The memory generation must be asynchronous and best-effort. Chat should not wait
for the memory provider, and users should not be billed for memory generation in
this milestone.

## Why This Matters

Task Node needs a trustable memory layer before deeper task automation. Users
should be able to inspect what the system remembers about their work instead of
having hidden profile state.

This also creates a compact account memory surface that can later support:

- task generation;
- context retrieval;
- portable agent workflows;
- chain-verifiable task replay;
- user-controlled memory export and deletion.

## Product Boundary

Memory is not the canonical source for chat history. Chat messages remain the
source records. Memory is a compressed derivative optimized for retrieval and
profile construction.

Memory is not billing. It should not create user-visible debits or reduce chat
credit during this milestone.

Memory is not task state. It may later help task generation, but it should not
mutate task lifecycle records.

## Provider Plan

Use OpenRouter with DeepSeek V4 Flash for memory summarization:

- model: `deepseek/deepseek-v4-flash`
- provider: `openrouter`
- route policy:
  - `zdr: true`
  - `data_collection: "deny"`
  - pinned provider `order`
  - pinned provider `only`

The route should mirror the existing private chat ZDR design. Do not let
OpenRouter route this workload to arbitrary providers.

Suggested initial allowlist:

```json
["parasail", "siliconflow", "atlas-cloud", "deepinfra", "akashml", "novita"]
```

This should be configurable with env vars, but the default must be conservative.

Relevant OpenRouter behavior:

- `provider.zdr=true` restricts routing to Zero Data Retention endpoints.
- `provider.data_collection="deny"` restricts routing to providers that do not
  collect user data.
- `provider.only` allows only specific provider slugs.
- `provider.order` controls provider priority.

## Prompt Contract

The memory prompt should treat the chat content as data, not instructions.

Input:

- conversation title;
- user query;
- assistant response.

Output:

- `user_request_summary`: 2-3 sentences describing what the user asked for;
- `system_response_summary`: 2-3 sentences describing what the system answered;
- `memory_text`: compact durable memory containing the facts, decisions,
  preferences, goals, constraints, follow-ups, and useful context worth
  remembering.

Instruction intent:

> This is system memory. Preserve durable user intent, preferences, goals,
> facts, decisions, constraints, and follow-up state. Remove filler. Do not
> invent. Prefer effective compression over generic summaries.

## Database Plan

Add a migration, likely `004_chat_memory.sql`.

### `chat_memory_jobs`

Queue table for async processing.

Expected fields:

- `id`
- `account_id`
- `conversation_id`
- `user_message_id`
- `assistant_message_id`
- `status`: `pending`, `processing`, `completed`, `failed`
- `attempt_count`
- `next_attempt_at`
- `last_error`
- timestamps

Important constraints:

- unique `assistant_message_id`
- indexes on `(status, next_attempt_at)`
- indexes on `account_id`

### `chat_memory_entries`

Visible memory rows.

Expected fields:

- `id`
- `account_id`
- `conversation_id`
- `conversation_title`
- `user_message_id`
- `assistant_message_id`
- `user_request_summary`
- `system_response_summary`
- `memory_text`
- `source_user_excerpt`
- `source_assistant_excerpt`
- `provider`
- `model`
- `prompt_version`
- `usage_json`
- timestamps

Important constraints:

- unique `assistant_message_id`
- indexes on `(account_id, created_at DESC)`
- search should initially use simple `ILIKE`, with pgvector deferred.

## Server Design

Add `server/repositories/chat-memory.js` for:

- enqueueing memory jobs;
- claiming pending jobs with `FOR UPDATE SKIP LOCKED`;
- inserting idempotent memory entries;
- listing memory for the signed-in account;
- marking jobs completed or failed.

Add `server/memory-worker.js` or `server/memory-service.js` for:

- prompt construction;
- OpenRouter request construction;
- ZDR provider policy;
- polling and processing jobs;
- backoff and retry.

The worker can run in-process for now. It must never block the chat request.

## Chat Hook

Preferred implementation:

1. `appendChatTurn` persists the user and assistant messages.
2. The same transaction enqueues a memory job using the persisted message IDs.
3. The chat API returns immediately after chat persistence.
4. A background worker picks up the memory job later.

If enqueueing inside the transaction is too invasive, enqueue immediately after
`appendChatTurn`, but it must be idempotent and must not block provider response
delivery.

## API Plan

Add:

- `GET /api/memory?limit=50&q=...`

Behavior:

- signed-in users only;
- scoped to `session.accountId`;
- returns newest memory first;
- supports simple search over chat title, user summary, response summary, and
  memory text.

Possible later additions:

- `DELETE /api/memory/:id`;
- hide/archive;
- export.

## UI Plan

Add a `memory` route and view, reachable from `More`.

For now, do not overload the existing profile mock surface. Create a clean page
under More called `Memory`, with only the memory list underneath Messages.

Memory page should show:

- search input;
- scrollable list;
- date;
- chat title;
- user request summary;
- system response summary;
- memory text.

States:

- signed out: prompt to sign in;
- no rows: memory appears after chats complete;
- load error: clear retryable error state.

The purpose is user trust: users can see what is being remembered.

## Initial Real Data Verification

Use the real persisted `whatwork` chat as the first backfill target.

Known local Postgres row:

- title: `whatwork`
- status: `active`
- message count: `2`
- user message: `thinking about what I hsould be working on`

Add a script:

```bash
npm run memory-backfill -- --title whatwork
```

Expected behavior:

1. Find the `whatwork` conversation in Postgres.
2. Enqueue or directly process its latest user/assistant pair.
3. Insert one `chat_memory_entries` row.
4. Confirm `/api/memory?q=whatwork` returns it.
5. Confirm the UI renders it on `#memory`.

## Testing Plan

Add:

- repository smoke for enqueue, claim, complete, retry, and idempotency;
- provider request builder smoke proving ZDR, `data_collection: "deny"`, and
  provider allowlist are present;
- API auth smoke proving signed-out users cannot read memory;
- API account scope smoke proving users only see their own memory;
- route smoke for `#memory`;
- non-blocking regression proving chat persistence does not await the memory
  provider.

## Acceptance Criteria

- A completed signed-in chat creates a memory job.
- Chat responses are not delayed by memory summarization.
- Memory generation uses OpenRouter DeepSeek V4 Flash with ZDR and
  data-collection denial.
- Memory generation does not debit user billing credit.
- Memory rows are visible in a clean searchable UI.
- The user can inspect date, chat title, user request summary, system response
  summary, and compressed memory text.
- The `whatwork` chat can be backfilled into memory from real local Postgres
  data.

## Implementation Checklist

- [x] Add `004_chat_memory.sql`.
- [x] Add `server/repositories/chat-memory.js`.
- [x] Add memory OpenRouter request builder.
- [x] Add memory prompt contract and parser.
- [x] Add in-process async worker.
- [x] Enqueue memory jobs from completed chat persistence.
- [x] Add `GET /api/memory`.
- [x] Add `#memory` route and More menu entry.
- [x] Replace or bypass profile memory mocks for this surface.
- [x] Add `memory-backfill` script for `whatwork`.
- [x] Add smoke tests.
- [x] Run `npm run check`.
- [x] Run memory backfill against local Docker Postgres.

## Implementation Notes

Implemented on May 17, 2026.

- Chat persistence now enqueues memory jobs after a completed assistant turn
  without awaiting summary generation.
- The in-process worker uses `deepseek/deepseek-v4-flash` through OpenRouter
  with ZDR, `data_collection: "deny"`, and the private-model provider allowlist.
- Memory generation writes no billing ledger rows.
- The Memory page is available at `#memory` from the More menu.
- The `whatwork` local Postgres conversation was backfilled and processed:
  2 matched pairs, 2 queued, 2 processed, 0 failed.

## Deep Memory Extension

Added on May 17, 2026.

Every 36 per-turn memory entries for an account now enqueue one account-level
`deep_memory` job. This job is not attached to a specific chat conversation;
it is keyed by account and numeric block index.

Deep memory uses the same OpenRouter DeepSeek V4 Flash ZDR route and produces:

- up to 5 bullet points summarizing user requests;
- up to 5 bullet points summarizing system responses;
- a 3-sentence memory summary of what the user is exploring and how the system
  responded.

Deep memory entries are inserted back into `chat_memory_entries` with
`kind = 'deep_memory'`, `conversation_title = 'Deep memory #N'`, and a synthetic
conversation id. They are excluded from the next 36-entry count, so deep memory
does not recursively trigger itself.

The memory tab renders deep memory rows with a small `Deep memory` badge and
preserves the bullet formatting.

## Open Decisions

- Whether to store full source excerpts or only bounded excerpts. Initial plan:
  bounded excerpts only.
- Whether failed memory jobs should be user-visible. Initial plan: no.
- Whether memory summaries should later be inked to PFTL/IPFS. Initial plan:
  not in this milestone.
- Whether pgvector embeddings should be generated now. Initial plan: defer.
