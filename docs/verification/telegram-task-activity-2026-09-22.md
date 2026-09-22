# Telegram task activity — 2026-09-22

## Failed boundary and identity

The quoted Telegram question belongs to `acct_oauth_3c70e69ab7b8ef1fad3df508` (goodalexander), conversation `account_acct_oauth_3c70e69ab7b8ef1fad3df508_telegram_1453613128`, user message `msg_6ecd5d7f-50e6-4276-8c26-d6f34e2cfe43_user`, 18:39:55 UTC. The linked Telegram identity was correct. Saved model-run context status recorded task and memory timeouts, while the context document supplied a generated rewarded-work summary. This was not evidence of contributor inactivity or of an allocator failure.

CorbanuAI resolves to account `acct_oauth_5a444ce5ffce464708e51335`, hive handle `corbanuai`, linked GitHub `corbanuAI`, wallet `rfr5GiCyCbMYJtHbrZwBKBKhc3pL3qwBdJ`. Its active incoming task-history grant permits the viewer to read task records, not private context documents, memories or chats.

## Changed boundary

- `server/repositories/chat-task-activity.js`: one read-only SQL snapshot rechecks incoming active `task_history_v1` grants and personal Team-context opt-in. It supplies self plus at most 19 collaborators, 20 current/recent tasks per account, and 40 lifecycle events per account over 48 hours, with counts and UTC timestamps. Events must join the correct account, task and subject wallet. Scalar state/time filtering is materialized before inspecting potentially large historical fixture metadata.
- `server/chat-task-activity.js` and `prompts/chat/task_activity_context_v1.md`: bounded loader and structured, untrusted reference data; distinguish submissions from verification/reward and absence of rewards from absence of work.
- `server/chat-context-load.js`: load Context, Memory and the bounded snapshot before generated Team-report fan-out. On success, avoid the expensive Tasks UI eligibility/forensics aggregation entirely; use the older reader only as a fallback.
- `server/chat-task-context.js`: render the activity snapshot without inventing empty legacy task groups.
- `server/chat-memory-context.js`, `server/chat-account-context.js`: five-second default read budgets; activity has a ten-second bound. All have explicit unavailable/timeout status rather than fabricated data.
- `scripts/chat-task-activity-smoke.mjs`: real PostgreSQL temporary-table ACL/SQL tests and loader/prompt regression coverage.
- Updated `docs/wiki/surfaces/chat.md`, `docs/wiki/architecture/telegram-bot-chat.md`, and `src/features/docs/docs-content.js`.

No keyword routing or example-specific runtime rule was introduced. The shared chat path covers web and Telegram.

## Verification

Passed:

```sh
TASKNODE_TEST_POSTGRES_CONTAINER=tasknodeofficial-db-1 node scripts/chat-task-activity-smoke.mjs
npm run lint
node scripts/chat-context-status-smoke.mjs
node scripts/telegram-bot-webhook-smoke.mjs
npm run public-help-check
git diff --check
```

The SQL smoke uses only temporary tables and rolls back. It covers self/incoming vs reverse/unrelated grants, immediate revocation, unsupported scope, opt-out, team disabled, anonymous access, wrong-wallet/old events, unrewarded submissions, event limits, read timeout/failure, phased context loading, legacy fallback, and Telegram prompt parity for multiple phrasings. The context-status smoke skipped its optional persistent-DB portion because `DATABASE_URL` was unset; the new SQL fixture executed against the local Postgres container. Telegram smoke sends through fake adapters only.

Two early production probes exposed timeouts rather than being treated as success. The revised phased loader successfully included Context revision 2038, 3 deep memories, 36 turn memories, own tasks, and permitted collaborators in 4,791 ms. A direct production `executeAmbient` inference using the Telegram delivery contract and the earlier misleading assistant reply corrected the answer using actual current records. It used `zai/glm-5.3`, 38,801 total tokens; returned provider-cost field $0.05526. This inference bypassed chat persistence and Telegram delivery: **zero Telegram messages and zero chat turns written**. The model's additional description of prior inactivity was not supported by the records and is not a finding of this audit.

At the 19:34 UTC snapshot, CorbanuAI records included:

- JTX report `task_a8fa83558c30b91d2961a05e7ddb2b6c`: submitted 16:54:59 (`task_evt_087884e1-844d-4d21-a329-7837a78ddc6c`), verification response 19:26:18, reward event 19:27:26 (`evt_5bbe2cf8bbafbfedb66d997f`).
- StakeHub login command `task_133b5552040e95f36eb0ba3095dfa02b`: accepted 19:14:59 (`task_evt_ad5a4caf-ef74-4bb6-a301-9f1e84434d64`).
- Felix/JTX coverage catalogue `task_1746f8ec4e852955bd353879d82cda89`: offered 19:32:37 (`evt_8462609daa87d7711391b8c2`).

These are UTC activity records, not a claim about the user's local morning or unrecorded work. Subsequent task state may change.

The final query optimization was also exercised read-only against production using `EXPLAIN (ANALYZE, BUFFERS)`: 354.568 ms SQL execution, 676 ms including connection/read overhead, seven authorized members. This is a single observation, not a latency guarantee.

## Release

Targeted API image overlay preserves the previously deployed long-evidence-report fix and avoids releasing unrelated local edits. Only Fly API machine `8d4930ae156638` is updated; workers are untouched.

Image: `registry.fly.io/tasknodeofficial-dev:telegram-task-activity-20260922-v3@sha256:30a8b80f57232cf66b9ed445bde6f884f5e5f02598687c2b22b32e809a53305f`.

Final-image verification passed: Fly machine update completed with health check 1/1; `/api/health` returned `ok:true`. Two fresh calls through the deployed context loader completed in 1,808 ms and 5,500 ms. Both included Context, Memory, 51 own/permitted collaborator task rows, seven members, and CorbanuAI's 14 tasks and 12 recent events. Assertions verified the recorded JTX submission reached the Telegram-formatted model prompt. The separate generated Team report showed `team_context_response_truncated`/pending during these probes; current task activity remained included independently. That existing report-generation error is not claimed fixed.

No Git commit or push was performed. Documentation and frontend Help source changes remain local; the API-only overlay does not rebuild the public Help bundle. No actual Telegram message was sent, so actual delivery on a new user turn is not claimed as tested.
