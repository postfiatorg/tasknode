# Review Plan: Chat

Source doc: `docs/wiki/surfaces/chat.md`
App doc group: Surfaces
App doc slug: `chat`
Review status: complete
Code review complete: yes
Owner: agent
Last updated: 2026-05-23
Worktree branch: `review/chat-code-review`

## Important App Surfaces

- `src/main.jsx` / `ChatSurface`
- `src/features/chat/chat-turns.js`, `src/features/chat/chat-markdown.js`
- `server/product-contracts.js` / chat preflight and estimate
- `server/chat-router.js`, `server/chat-context-load.js`, `server/chat-context-status.js`
- `server/chat-memory-context.js`, `server/chat-task-context.js`, `server/chat-account-context.js`
- `server/repositories/chat-billing.js`, `server/repositories/chat-memory.js`, `server/repositories/tasks.js`
- `server/jobs-corpus.js` / Jobs pgvector retrieval
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
- Memory/task/context loaders fail open without any response metadata.

## Best Practices To Check

- One server-side preflight owns auth, credit, mode, provider readiness, body
  limits, and estimate inputs.
- Streaming and non-streaming execution share request construction and
  persistence rules.
- Provider usage is the billing source of truth, and estimates clearly describe
  included/excluded context.
- User-visible errors are explicit for provider, billing, attachment, and
  persistence failures.
- Context inclusion/skips/timeouts are auditable in API responses and model-run metadata.

## Code Review Plan

1. Trace `/api/chat/send` and `/api/chat/stream` from route policy to response.
2. Compare `chatEstimate` inputs to provider request builders.
3. Verify history, memory, task context, and attachments are account scoped.
4. Review OpenAI/OpenRouter request bodies for mode, tools, attachments, and
   usage settings.
5. Check persistence and ledger writes for both stream and non-stream success.
6. Verify Reviewer To Do List items in `docs/wiki/surfaces/chat.md`.
7. Review smoke coverage and add missing edge cases.

## Evidence To Capture

- `npm run runtime-smoke`
- `npm run chat-attachment-smoke`
- `npm run chat-context-status-smoke`
- `npm run security-smoke`
- A request-body fixture for each provider/mode family (still open).

## Completion Checklist

- [x] Source doc claims mapped to implementation.
- [x] User-visible workflow reviewed.
- [x] Persistence and ownership boundaries reviewed.
- [x] Billing, provider, wallet, or chain effects reviewed where applicable.
- [x] Tests or smoke evidence recorded.
- [x] Findings written with realistic severity.

## Review Findings

### Summary — 2026-05-23 pass

No P0 findings.

Prior P1 history-ownership and P2 attachment-validation fixes are present on
`main` at review time: `/api/chat/history` requires login, `getChatMessages`
requires `accountId`, and `validateChatAttachments` rejects bad payloads before
estimate/execution.

This pass closed the remaining P2 **context visibility** gap and recorded
checklist verification results.

### Fixed in `review/chat-code-review`

**P2 — Memory/task/context fail-open behavior was not visible in responses**

- Added `server/chat-context-status.js` and `server/chat-context-load.js`.
- Loaders now distinguish `included`, `empty`, `timeout`, `error`, `disabled`,
  and `skipped` states for context document, memory, and task context.
- Preflight, dry-run, credit-denied, send, and stream responses now include
  `contextStatus`.
- Jobs retrieval status merged at execution time and persisted in
  `chat_model_runs.metadata_json.contextStatus`.
- Regression: `npm run chat-context-status-smoke`.

### Verified — no code change required

| Checklist area | Result |
| --- | --- |
| Memory efficiency | History capped at 200 messages (`maxMessageLimit`); default load 30; Jobs retrieval top-3 with timeout; task refused/reward caps 10/12; context doc clip via `TASKNODE_CHAT_CONTEXT_DOCUMENT_MAX_CHARS`; memory worker queued post-turn. |
| Code quality | Mode matrix matches `chatModePrices`; unknown modes reject; Context Refine staleness enforced in context-edit route; billing preflight shares estimate path. |
| Coherence | Private OpenRouter ZDR + deny collection; Frontier OpenAI `store=false`; web search Frontier-only; task request requires wallet; Context Refine does not. |
| Security | Account-scoped history reads; attachment validation before send; seeds stay client-side for wallet actions. |

### Still open — P3 backlog

**OpenAI history is flattened differently than OpenRouter history**

- `server/chat-provider-message-builders.js` still uses role-labeled messages for
  OpenRouter and a single transcript blob for OpenAI Frontier.
- Proposed: shared history helper + request-body fixture tests (`chat-provider-history-fixtures` bundle).

**Live Docker UX verification not re-run in this pass**

- Smokes run in-process against JSON runtime store (no second Docker stack).
- Running stack on ports 5174/8080/5436 was left untouched to avoid conflicting
  with other agents on this machine.

## Proposed Fix Bundles

1. ~~`chat-history-ownership`~~ — shipped on main before this branch.
2. ~~`chat-attachment-validation`~~ — shipped on main before this branch.
3. ~~`chat-context-status`~~ — implemented on `review/chat-code-review`.
4. `chat-provider-history-fixtures` — still open (P3).

## Evidence Captured — 2026-05-23

Worktree: `/home/pfrpc/repos/worktrees/tasknodeofficial/chat-code-review`

Commands:

```bash
npm ci --ignore-scripts
node scripts/chat-context-status-smoke.mjs   # passed
node scripts/security-smoke.mjs              # passed
node scripts/chat-attachment-smoke.mjs       # passed
```

Code paths reviewed:

- `docs/wiki/surfaces/chat.md` Reviewer To Do List
- `server/product-contracts.js` / `chatExecutionPreflight`, `chatSend`, `chatStreamStart`
- `server/chat-router.js` / `executeChat`, `executeChatStream`
- `server/chat-context-load.js`, `server/chat-context-status.js`
- `server/chat-attachment-utils.js`
- `server/chat-memory-context.js`, `server/chat-task-context.js`, `server/chat-account-context.js`
- `server/jobs-corpus.js`
- `server/repositories/chat-billing.js`
- `scripts/security-smoke.mjs`, `scripts/chat-attachment-smoke.mjs`
