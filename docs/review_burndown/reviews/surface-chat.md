# Review Plan: Chat

Source doc: `docs/wiki/surfaces/chat.md`
App doc group: Surfaces
App doc slug: `chat`
Review status: complete
Code review complete: yes
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` / `ChatSurface`
- `src/features/chat/chat-turns.js`, `src/features/chat/chat-markdown.js`
- `server/product-contracts.js` / chat preflight and estimate
- `server/chat-router.js`, `server/chat-search-tools.js`
- `server/chat-memory-context.js`, `server/chat-task-context.js`
- `server/repositories/chat-billing.js`, `server/repositories/chat-memory.js`, `server/repositories/tasks.js`
- `server/db/migrations/001_chat_billing.sql`, `002_chat_attachments.sql`

## What Could Go Wrong

- Estimate, credit check, and actual provider input diverge when memory, tasks,
  attachments, or web search are included.
- Conversation IDs or account IDs allow history, memory, task context, or billing
  to cross account boundaries.
- Streaming and non-streaming paths produce different persistence, billing, or
  task/memory context behavior.
- Attachments appear accepted in the UI but fail silently or are not represented
  in provider input/persistence.

## Best Practices To Check

- One server-side preflight owns auth, credit, mode, provider readiness, body
  limits, and estimate inputs.
- Streaming and non-streaming execution share request construction and
  persistence rules.
- Provider usage is the billing source of truth, and estimates clearly describe
  included/excluded context.
- User-visible errors are explicit for provider, billing, attachment, and
  persistence failures.

## Code Review Plan

1. Trace `/api/chat/send` and `/api/chat/stream` from route policy to response.
2. Compare `chatEstimate` inputs to `openAiResponseRequest` and `openRouterChatRequest`.
3. Verify history, memory, task context, and attachments are account scoped.
4. Review OpenAI/OpenRouter request bodies for mode, tools, attachments, and
   usage settings.
5. Check persistence and ledger writes for both stream and non-stream success.
6. Review smoke coverage and add missing edge cases.

## Evidence To Capture

- `npm run runtime-smoke`
- `npm run chat-attachment-smoke`
- A request-body fixture for each provider/mode family.
- A failure case for provider timeout or provider error.

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed.
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Tests or smoke evidence recorded.
- [x] Findings written with realistic severity.

## Review Findings

### Summary

No P0 was found in this pass.

The main issue is not model behavior. It is basic conversation ownership:
history reads are not consistently account-scoped below the route layer. That
should be the first fix bundle because it protects UI history, provider context,
and future internal callers at the same boundary.

### P1 - Chat history reads are not account-owned at the repository boundary

Surfaces:

- `server/index.js` / `/api/chat/history`
- `server/runtime-store.js` / `conversationIdForSession`
- `server/repositories/chat-billing.js` / `getChatMessages`
- `server/chat-router.js` / `executeChat`, `executeChatStream`
- `server/app-state.js` / signed-in seed messages

Current behavior:

- `/api/chat/history` is an optional-auth route and calls
  `conversationIdForSession(session, requestedConversationId)` before
  `getChatMessages(conversationId)`.
- `conversationIdForSession` scopes requested IDs for signed-in users, but for
  no session it returns the requested ID. That means a signed-out request can ask
  for a known `account_...` conversation ID and reach `getChatMessages`.
- `getChatMessages` only filters by `conversation_id`. It does not accept or
  enforce `accountId`.
- `executeChat` and `executeChatStream` load history by conversation ID before
  `appendChatTurn` performs its owner check. Normal public send/stream routes
  currently scope the ID first, but the lower-level execution path is still
  fragile.

Why this matters:

- A predictable or leaked conversation ID is enough for an unauthenticated caller
  to attempt a history read.
- A future internal caller can accidentally pass a mismatched account and
  conversation ID, causing another account's history to be sent to a provider
  before persistence rejects the append.

Proposed fix:

1. Change `getChatMessages` to require account context for account-owned
   conversations. Suggested shape:
   `getChatMessages({ accountId, conversationId, limit })`.
2. In Postgres, join or check `chat_conversations` with
   `chat_conversations.account_id = $accountId` and `status = 'active'`.
3. In runtime store, route reads through the same ownership helper already used
   by rename/delete.
4. Make `/api/chat/history` return `401` for no session instead of returning a
   requested conversation. Signed-out app state should return an empty chat seed.
5. Update `appState`, `executeChat`, and `executeChatStream` to call the
   account-scoped history API.
6. Add regression coverage:
   - signed-out `/api/chat/history?conversationId=account_someone_default`
     returns `401`;
   - account A cannot read account B history;
   - account A cannot execute chat with account B history in provider input;
   - signed-out `/api/app-state` has no shared `dev` seed messages in production
     mode.

### P2 - Invalid or oversized attachments are silently dropped server-side

Surfaces:

- `src/main.jsx` / `ChatSurface.attachFiles`, paste/drop handling
- `src/chat-attachments.js`
- `server/product-contracts.js` / `chatPayload`, `chatExecutionPreflight`
- `server/chat-attachment-utils.js` / `normalizeChatAttachments`
- `server/chat-router.js` / provider request builders
- `server/repositories/chat-billing.js` / attachment persistence

Current behavior:

- The UI enforces max count and file size for normal upload/drop flows.
- The server slices attachments to four and uses `normalizeChatAttachments`.
- `normalizeChatAttachments` returns `null` for malformed data URLs or data URLs
  over the server byte limit, then filters them out.
- Preflight, estimate, provider request construction, and persistence continue
  with the reduced attachment list and no explicit user-visible error.

Why this matters:

- A client can believe an attachment was submitted while the provider and
  persisted transcript silently omit it.
- The Help doc says attachment parsing failures should be visible before the
  request; the server path does not currently enforce that contract.

Proposed fix:

1. Add a server validator that returns structured attachment errors before
   estimate/provider execution. Keep normalization as a pure transform after
   validation.
2. Reject too many attachments, malformed data URLs, oversized data URLs,
   unsupported/empty MIME where relevant, and decode failures for text
   attachments with `400` or `413`.
3. Return attachment names and reason codes in the response body so the composer
   can show the exact failed item.
4. Add smoke coverage for malformed data URL, too many attachments, oversized
   attachment, and text decode failure.

### P2 - Memory/task context fail-open behavior is not visible in responses

Surfaces:

- `server/product-contracts.js` / chat preflight
- `server/chat-memory-context.js`
- `server/chat-task-context.js`
- `server/chat-estimate.js`
- `server/chat-router.js`

Current behavior:

- Memory and task context are fetched before credit check and then passed into
  execution, which keeps estimate and actual provider input aligned when the
  fetch succeeds.
- The context fetchers intentionally fail open on timeout or failure.
- The response estimate shows memory/task token counts when context is present,
  but the response does not explicitly say whether memory/task context was
  included, skipped because empty, or skipped because the context loader failed.

Why this matters:

- Users and support cannot tell why a response ignored known memory or task
  state.
- Debugging provider output becomes guesswork even though the app has enough
  information to report context inclusion status.

Proposed fix:

1. Return a `contextStatus` block from preflight and final responses:
   memory included/skipped/error, task context included/skipped/error,
   character counts, and timeout flags.
2. Persist the same status in model run metadata for later audit.
3. Keep chat execution fail-open for memory failures, but make task context
   failure policy explicit in code and docs.
4. Add a timeout/failure smoke that proves chat still runs and reports skipped
   context accurately.

### P3 - OpenAI history is flattened differently than OpenRouter history

Surfaces:

- `server/chat-router.js` / `openAiInput`, `openRouterMessages`

Current behavior:

- OpenRouter receives a system message plus recent history as separate
  role-labeled messages.
- OpenAI receives recent history as a single `input_text` transcript inside the
  current user input.

Why this matters:

- The two provider families get materially different conversation structure.
- This makes cross-mode behavior harder to reason about and can degrade reply
  quality on longer conversations.

Proposed fix:

1. Introduce one shared history-to-provider-input helper that preserves role
   boundaries for both provider families.
2. Keep attachment handling provider-specific, but keep history ordering,
   truncation, and transcript text shared.
3. Add request-body fixture tests for OpenAI Frontier and OpenRouter Private
   modes so future edits do not drift.

## Proposed Fix Bundles

1. `chat-history-ownership`
   - Scope history reads by `accountId`.
   - Require session for `/api/chat/history`.
   - Update app-state, send, stream, runtime store, and Postgres repository
     call sites.
   - Add account A/account B regression coverage.

2. `chat-attachment-validation`
   - Add server-side validation before estimate and execution.
   - Return explicit user-visible attachment errors.
   - Add attachment failure smokes.

3. `chat-context-status`
   - Add context inclusion/error status to estimate, responses, and run
     metadata.
   - Add failure-open visibility tests.

4. `chat-provider-history-fixtures`
   - Normalize provider history construction.
   - Add request fixture tests for Frontier and Private modes.

## Evidence Captured

Code paths reviewed:

- `docs/wiki/surfaces/chat.md`
- `src/main.jsx` / `ChatSurface`
- `src/chat-attachments.js`
- `server/index.js`
- `server/product-contracts.js`
- `server/runtime-store.js`
- `server/chat-estimate.js`
- `server/chat-router.js`
- `server/chat-attachment-utils.js`
- `server/chat-memory-context.js`
- `server/chat-task-context.js`
- `server/repositories/chat-billing.js`
- `server/repositories/chat-memory.js`
- `scripts/security-smoke.mjs`
- `scripts/chat-attachment-smoke.mjs`

Verification run on 2026-05-18:

- `npm run runtime-smoke` - passed
- `npm run chat-attachment-smoke` - passed
- `npm run security-smoke` - passed
