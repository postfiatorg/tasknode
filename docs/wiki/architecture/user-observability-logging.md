# User Observability Logging

Status: runtime instrumentation and rollup base live  
Last updated: 2026-06-08

Task Node needs a user-centered observability layer that can answer product,
support, allocation, and trust questions from the same identity vector:

```text
public handle -> account_id -> linked provider identities -> active and historical wallets
```

The event log is not a replacement for canonical state. PFTL/IPFS remains the
canonical task and reward protocol. Postgres task, profile, memory, Hive,
billing, and wallet tables remain the fast read models. User observability adds
a normalized trail of meaningful decisions and actions so operators can explain
what happened to a specific person without piecing it together from memory,
browser screenshots, and ad hoc SQL.

Implemented base:

- `server/db/migrations/055_user_observability_events.sql` creates
  `user_observability_events` plus rebuildable daily usage, task behavior, and
  reward rollup views.
- `server/db/migrations/056_user_identity_vectors.sql` creates
  `user_identity_vectors` from wallet sync, task projection, Telegram, and
  observability event sources.
- `server/repositories/user-observability.js` resolves identity vectors, records
  best-effort events, lists observability events, standardizes Network Task
  capacity decisions, and records chat/billing helper events.
- `scripts/user-observability.mjs` produces an operator packet from current
  canonical rows plus stored observability events. It is read-only by default
  and can emit `user.identity.resolved` with `--record-resolution` when a support
  lookup itself needs an audit trail. It can also emit
  `user.network_task.capacity_checked` for its eligibility probes with
  `--record-capacity-checks`.
- `/api/user-observability/event` accepts a strict allowlist of authenticated
  client UI events for blockers, sync warnings, disabled actions, recovered
  actions, and active-wallet selection.
- Runtime instrumentation records auth/session/provider/Telegram link events,
  wallet link/delink/selected/sync changes, chat turns/failures, memory jobs,
  billing top-up/deposit/credit failures and successes, profile identity/public
  profile/NFT generation/mint/import/daily-airdrop/recommendation events, Task
  detail/action/request/submission/visibility events, Network Task capacity/
  allocation/generation/completion events, Hive Context/Board Manager/follow-up
  events, and Telegram bot inbound/outbound/failure events.
- The Task Detail modal emits deduped `user.ui.blocker_shown`,
  `user.ui.action_disabled`, and `user.ui.action_recovered` events for the task
  acceptance control.
- The Tasks screen emits deduped `user.ui.sync_warning_shown` events when task
  sync notices or task-request attention warnings are visible.
- `scripts/user-observability-smoke.mjs` covers handle/provider resolution,
  two-wallet identity vectors, unresolved handles, and wallet-bound capacity
  decisions, best-effort helper writes, and the client UI event allowlist.

## Current Boundaries From Existing Docs

- Auth and provider handles are account-scoped. Provider aliases are private
  unless the user explicitly makes them public. The public routing namespace is
  the Hive handle from the profile identity surface.
- Tasks are wallet-backed work objects. Personal and Network Task lifecycle
  truth comes from PFTL task pointers projected into `task_projections`.
- Network Task capacity is wallet-aware when a candidate wallet is known.
  Account-only pending work consumes account capacity until the wallet is known.
- Profile is account-scoped. Profile NFT reads are scoped to the active linked
  wallet plus walletless generated drafts.
- Daily Airdrop is one score per account identity cloud. Historical wallets in
  `pftl_sync_wallets` can contribute attribution, but issuance selects one
  recipient wallet per run.
- Memory is account-scoped. Network Diagnostic Reports are generated from
  bounded account, context, memory, profile, and task packets.
- Hive Context is account-scoped and marks whether the sender had a validated
  linked wallet when they contributed.
- Billing top-up is account-scoped and separate from the PFT wallet.
- Runtime store still owns some account/session/wallet-link state. Worker-visible
  identity should prefer Postgres where available, especially `pftl_sync_wallets`
  for wallet clouds.

## Identity Vector

Every user-specific investigation starts by resolving this vector:

```json
{
  "accountId": "acct_...",
  "publicHandle": "goodalexander",
  "displayName": "Good Alexander",
  "providers": [
    {
      "provider": "telegram",
      "username": "example",
      "providerUserIdHash": "sha256:...",
      "linkedAt": "2026-06-08T00:00:00.000Z",
      "public": false
    }
  ],
  "wallets": [
    {
      "walletAddress": "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
      "role": "user",
      "status": "active",
      "source": "pftl_sync_wallets",
      "lastHotSyncAt": "2026-06-08T00:00:00.000Z"
    },
    {
      "walletAddress": "rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE",
      "role": "user",
      "status": "historical",
      "source": "pftl_sync_wallets"
    }
  ]
}
```

Resolution rules:

1. Accept `--handle`, `--account-id`, `--wallet`, or private provider identity
   as lookup inputs.
2. Resolve the account first, then expand to active and historical wallets.
3. Return the source of every identity fact. Current sources include runtime
   store account identity rows, `pftl_sync_wallets`, `task_projections`,
   `profile_public_snapshots`, `recommended_connection_profiles`, and provider
   event tables such as `telegram_bot_events`.
4. If a handle cannot be resolved, say that explicitly and continue only with
   wallet-scoped evidence. Do not infer that two unresolved handles are the same
   user because they share symptoms.
5. Never expose private provider ids, emails, OAuth tokens, auth cookies, wallet
   seeds, private keys, local vault ciphertext, or wallet passwords in a user
   observability packet.

## Questions The System Must Answer

| Question | Primary source today | Observability addition |
| --- | --- | --- |
| How many rewards are they getting? | `task_projections.reward_actual_pft`, `task_events`, `profile_daily_airdrop_issuances`, `wallet_initiation_grants` | Daily reward rollup by account and wallet, with task reward vs airdrop vs initiation grant separated. |
| What does memory say about chat? | `chat_memory_entries`, `chat_deep_memory_jobs`, `network_task_profiles` | Last memory job status, source row ids, prompt version, and reset/delete events. |
| What is their Network Diagnostic Report? | `network_task_profiles`, `network_task_profile_jobs` | Profile generated, refreshed, failed, reset, and stale events. |
| Is their profile page updated? | `profile_public_snapshots`, `profile_nfts`, `recommended_connection_profiles`, profile identity runtime rows | Public profile regeneration, NFT cache/import, identity visibility, and recommendation refresh events. |
| What types of tasks are they getting? | `task_projections.task_kind`, `task_projections.metadata_json`, `network_task_allocations`, `network_task_generation_jobs` | Task offer exposure and task generation events grouped by personal, network, alpha, project, prompt version, and wallet. |
| What is their task refusal rate? | `task_projections.status`, `task_events.payload_json`, refusal/cancel transitions | Proposed count, accepted count, refused count, expired count, refusal reason presence, and refusal rate by task kind and wallet. |
| How many times a day are they using the app? | `chat_messages`, `chat_model_runs`, existing route-specific rows | Low-volume `app_session_started`, `surface_opened`, and meaningful-action events rolled up per UTC day. |
| Have they ever refilled the app? | `billing_ledger_entries`, Ethereum deposit runtime records, top-up sync paths | Top-up start, top-up sync, deposit observed, credit ledger applied, and failed top-up sync events. |
| Did they link Telegram? | account identity runtime rows, `telegram_bot_events` | Provider link/unlink event plus Telegram bot inbound/outbound activity counts. |
| Did they complete a Network Task? | `task_projections`, `task_events`, `network_task_allocations`, `network_project_task_refs` | Network Task accepted, submitted, rewarded, refused, and allocation-completed events by candidate wallet. |
| Did they interact with Hive? | `hive_context_entries`, `board_manager_user_messages`, `board_manager_followups`, `board_manager_runs` | Hive chat/context submissions, Board Manager messages delivered/read, follow-up opened/answered, and project views. |

## Additional Things To Log Per User

The highest-value additional logs are the decision points that currently create
trust issues when a user reports a blocker:

- active wallet selected or changed;
- wallet link, delink, relink, proof failure, and local-vault missing state;
- Network Task capacity checks, including account and wallet blocker counts;
- Network Task candidate selected, skipped, or blocked, including exact reason;
- task offer first visible to user, task detail opened, accept/refuse clicked,
  accept/refuse publish result, and first visible UI blocker;
- task request created, PFTL request published, worker claimed, offer published,
  projection visible, and handoff timeout;
- task evidence submit clicked, signed transaction returned, projection caught
  up, verification requested, verification response submitted, reward decided,
  and reward projected;
- profile identity edits, alias visibility changes, profile snapshot
  regeneration, profile NFT generation/mint/import, and public/private switch;
- recommended connection refreshes, impressions, accepts, hides, and clicks;
- chat session started, message sent, model run completed, model run failed,
  billing debit applied, and memory job queued/completed/failed;
- top-up started, deposit address allocated, deposit observed, usage credit
  applied, refill sync failed, and initiation grant state changed;
- Telegram linked, bot message received, bot response delivered, webhook failed,
  and bot preference changed;
- Hive Context submitted, Board Manager message delivered/read, follow-up opened
  or closed, project page viewed, and Network Task allocation created from Hive;
- app-level sync warnings shown to a user, including task projection lag,
  reducer attention, stale RPC, and disabled worker notices.

Avoid high-volume logs for every app-state poll, health check, balance poll, or
background refresh. Log meaningful state transitions and user-visible decisions.

## Event Schema

Add a Postgres append-only table:

```sql
CREATE TABLE user_observability_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  account_id text NOT NULL DEFAULT '',
  public_handle text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  wallet_scope text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  provider_user_id_hash text NOT NULL DEFAULT '',
  session_id_hash text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  allocation_id text NOT NULL DEFAULT '',
  generation_job_id text NOT NULL DEFAULT '',
  model_run_id text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  source_surface text NOT NULL DEFAULT '',
  source_route text NOT NULL DEFAULT '',
  result_status text NOT NULL DEFAULT '',
  reason_code text NOT NULL DEFAULT '',
  identity_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  privacy_class text NOT NULL DEFAULT 'internal',
  retention_until timestamptz
);

CREATE INDEX user_observability_events_account_recent_idx
  ON user_observability_events (account_id, occurred_at DESC, id);

CREATE INDEX user_observability_events_wallet_recent_idx
  ON user_observability_events (wallet_address, occurred_at DESC, id)
  WHERE wallet_address <> '';

CREATE INDEX user_observability_events_type_recent_idx
  ON user_observability_events (event_type, occurred_at DESC, id);

CREATE INDEX user_observability_events_task_recent_idx
  ON user_observability_events (task_id, occurred_at DESC, id)
  WHERE task_id <> '';
```

Field rules:

- `account_id` is required for account-scoped events.
- `wallet_address` is required for wallet-scoped task, PFTL, capacity, wallet,
  and reward events whenever known.
- `wallet_scope` is one of `active`, `historical`, `subject_wallet`,
  `candidate_wallet`, `recipient_wallet`, `unknown`, or empty when not relevant.
- `identity_snapshot_json` stores public handle, display-name snapshot, provider
  presence flags, and wallet cloud summary. It should not store raw provider ids
  or emails.
- `decision_json` stores the structured decision or blocker, such as capacity
  scope, eligible flag, and blocker task IDs.
- `metrics_json` stores counts, PFT amounts, token usage, latency, or event
  totals.
- `metadata_json` stores non-secret references and implementation version data.
- `privacy_class` is `public`, `internal`, `sensitive_reference`, or `security`.
  Normal operator query output should omit `security` rows unless explicitly
  requested by an admin path.

## Required Event Types

Identity and access:

```text
user.identity.resolved
user.session.started
user.provider.linked
user.provider.unlinked
user.profile_handle.changed
user.alias_visibility.changed
user.wallet.linked
user.wallet.delinked
user.wallet.selected
user.wallet.sync_status_changed
```

Chat, memory, and billing:

```text
user.chat.message_sent
user.chat.model_run_completed
user.chat.model_run_failed
user.memory.turn_completed
user.memory.deep_completed
user.memory.network_profile_queued
user.memory.network_profile_completed
user.memory.network_profile_failed
user.billing.top_up_started
user.billing.deposit_observed
user.billing.credit_applied
user.billing.refill_sync_failed
```

Profile and discovery:

```text
user.profile.public_snapshot_completed
user.profile.nft_generated
user.profile.nft_minted
user.profile.nft_imported
user.profile.daily_airdrop_scored
user.profile.daily_airdrop_issued
user.profile.recommended_connections_refreshed
user.profile.recommended_connection_interacted
```

Tasks and Network Task capacity:

```text
user.task.request_published
user.task.offer_visible
user.task.detail_opened
user.task.accept_clicked
user.task.refuse_clicked
user.task.action_published
user.task.action_failed
user.task.submission_published
user.task.verification_requested
user.task.reward_projected
user.network_task.capacity_checked
user.network_task.candidate_selected
user.network_task.candidate_blocked
user.network_task.allocation_created
user.network_task.generation_job_changed
user.network_task.completed
```

Hive and Telegram:

```text
user.hive.context_submitted
user.hive.project_viewed
user.hive.board_message_delivered
user.hive.board_message_read
user.hive.followup_opened
user.hive.followup_closed
user.telegram.linked
user.telegram.bot_message_received
user.telegram.bot_response_sent
user.telegram.webhook_failed
```

User-visible failures:

```text
user.ui.blocker_shown
user.ui.sync_warning_shown
user.ui.action_disabled
user.ui.action_recovered
```

Coverage notes as of 2026-06-08:

- Implemented runtime event families include `user.session.started`,
  `user.provider.linked`, `user.provider.unlinked`, `user.telegram.linked`,
  wallet link/delink/selected and sync status changes, chat/model-run events,
  memory/network-profile jobs, billing top-up/deposit/credit events, profile
  handle/alias/snapshot/NFT mint/generation/import/daily-airdrop/recommendation
  events, task detail/offer/action/submission/verification/reward visibility
  events, Network Task capacity and allocation/generation/completion events,
  Hive Context/Board Manager events, Telegram bot events, and allowlisted client
  UI blocker and sync-warning events.
- `user.provider.unlinked` is emitted by account deletion, which is the current
  route that removes linked provider identities.
- `user.profile.nft_imported` is emitted by
  `scripts/import-pftasks-profile-nfts.mjs` for historical PFTasks profile NFT
  cache imports.
- `user.identity.resolved` is emitted by `scripts/user-observability.mjs` only
  when `--record-resolution` is passed; support lookups remain read-only by
  default.

## Network Task Capacity Log Contract

Every Network Task eligibility or routing check should emit
`user.network_task.capacity_checked` with this decision shape:

The operator packet is read-only by default. Its diagnostic eligibility probes
emit this event only when `--record-capacity-checks` is passed.

```json
{
  "event_type": "user.network_task.capacity_checked",
  "account_id": "acct_...",
  "wallet_address": "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
  "wallet_scope": "candidate_wallet",
  "decision_json": {
    "schema": "pf.task_node.network_task_eligibility.v1",
    "capacity_scope_used": "wallet",
    "eligible": false,
    "status": "capacity_blocked",
    "block_reason": "wallet_has_outstanding_network_task",
    "wallet_outstanding_count": 1,
    "wallet_pending_generation_count": 0,
    "account_outstanding_count": 2,
    "account_pending_generation_count": 0,
    "blockers": [
      {
        "task_id": "task_...",
        "allocation_id": "netalloc_...",
        "state": "accepted",
        "project_id": "task_node"
      }
    ]
  }
}
```

This is the log that answers whether wallet
`rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx` blocks wallet
`rhwiJxkiTkxTC65MrmLG7WiUkbiCyw2TaE`. The answer should come from two events
with the same account id and different `wallet_address` values.

## Derived Rollups

The base query views now exist in migrations `055` and `056`:

```text
user_identity_vectors
  account_id, public_handle, display_name, providers_json, wallets_json,
  active_wallet_count, historical_wallet_count, telegram_linked,
  updated_at

user_daily_usage_rollups
  account_id, day, session_count, active_surface_count, chat_message_count,
  model_run_count, task_action_count, hive_action_count, telegram_event_count,
  top_up_event_count, first_seen_at, last_seen_at

user_task_behavior_rollups
  account_id, wallet_address, task_kind, window_start, window_end,
  offered_count, accepted_count, refused_count, expired_count,
  submitted_count, rewarded_count, reward_pft, refusal_rate

user_reward_rollups
  account_id, wallet_address, day, task_reward_pft, daily_airdrop_pft,
  initiation_grant_pft, top_up_credit_usd
```

These views are derived from source tables plus observability events. They are
not canonical state and can be rebuilt.

## Operator Workflow

Operator tooling now provides:

```bash
npm run user-observability -- --handle goodalexander --since 2026-06-01 --pretty
npm run user-observability -- --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx --since 7d --pretty
npm run user-observability -- --account-id acct_oauth_... --include-events --pretty
npm run user-observability -- --account-id acct_oauth_... --record-resolution --pretty
npm run user-observability -- --account-id acct_oauth_... --record-capacity-checks --pretty
```

The output packet should include:

1. resolved identity vector;
2. active and historical wallets;
3. reward totals split by task reward, daily airdrop, initiation grant, and
   billing credit;
4. task counts and refusal rate by task kind and wallet;
5. Network Task eligibility/capacity for each active wallet;
6. Network Diagnostic Report status and latest digest;
7. memory counts and latest deep-memory block;
8. profile snapshot/NFT/recommended-connection status;
9. Telegram link and bot activity status;
10. Hive activity and Board Manager follow-up status;
11. recent user-visible blockers and failed actions;
12. exact source rows or event IDs used for the conclusion.

Task Node Official skill rule for user-specific work:

- when a task names a user handle, provider username, account id, or wallet,
  resolve the identity vector first;
- state the exact account id, wallet address, and time window used;
- distinguish account-scoped facts from wallet-scoped facts;
- cite source rows, task ids, tx hashes, CIDs, or event ids;
- if identity resolution fails, say so and avoid claims about that user's other
  handles or wallets.

## Implementation Plan

Phase 1: read-only packet from existing data

Status: implemented.

- Add `scripts/user-observability.mjs`.
- Resolve handles and wallets from runtime store plus Postgres.
- Query existing tables only; do not create new events yet.
- Use it for P0 support and capacity QA.

Phase 2: event table and repository

Status: implemented.

- Add migration for `user_observability_events`.
- Add `server/repositories/user-observability.js` with
  `recordUserObservabilityEvent`, `listUserObservabilityEvents`, and
  `resolveUserIdentityVector`.
- Keep all writes best-effort and non-blocking unless the event is the only
  audit trail for a user-visible decision.

Phase 3: high-value instrumentation

Status: implemented for the current product surfaces. High-value server-side
transitions are instrumented across auth, wallet, chat, memory, billing,
profile, tasks, Network Tasks, Hive, Telegram, and Task Detail acceptance
blockers plus Tasks screen sync warnings.

- Network Task eligibility in `server/repositories/network-tasks.js`.
- Task list/detail action boundaries in task routes and task action handlers.
- Profile identity, Network Diagnostic Report, public profile, daily airdrop,
  top-up, Telegram, Hive Context, and Board Manager message routes.
- Auth/session/provider and wallet link/delink/selected/sync status boundaries.
- Provider unlink audit from account deletion, the current route that removes
  linked provider identities.
- Chat/model-run/memory/billing helper writes from durable server commits.
- Historical PFTasks profile NFT cache import events from
  `scripts/import-pftasks-profile-nfts.mjs`.
- Optional `user.identity.resolved` support lookup audit with
  `scripts/user-observability.mjs --record-resolution`.
- Allowlisted client UI events through `/api/user-observability/event`; Task
  Detail acceptance blockers/recoveries and Tasks screen sync warnings are
  currently wired.
- Future frontend `user.ui.*` events should be added only when a control is
  shown blocked to the user.

Phase 4: rollups and status

Status: implemented for query views. Rebuildable SQL views exist for identity
vectors, daily usage, task behavior, and rewards. No worker-driven rollup job or
System Status row is needed yet.

- Maintain the SQL views for identity vectors, daily usage, task behavior, and
  rewards as new source tables or event families are added.
- Add a Help/System Status link for user observability ingestion freshness if a
  worker or rollup job is introduced.
- Add an operator-only packet view or script output for support.

## Verification

Minimum checks for the first implementation:

- `npm run user-observability -- --help`
- `npm run user-observability-smoke`
- temp-store fixture resolving one account with two wallets;
- fixture proving Network Task capacity builds two wallet-specific capacity
  decision payloads for the same account;
- fixture proving a wallet 1 outstanding Network Task does not create a wallet 2
  blocker when the decision uses `capacity_scope_used = "wallet"`;
- fixture proving unresolved handles return `identity_not_resolved` instead of
  guessing;
- local Postgres insert/list check proving `recordUserObservabilityEvent` writes
  `user_observability_events`;
- local Postgres migration check proving `user_identity_vectors` exists;
- client event contract check proving `/api/user-observability/event` accepts
  only allowlisted `user.ui.*` and `user.wallet.selected` events;
- helper smoke proving chat, billing, and UI event writes skip cleanly when the
  database is disabled;
- operator packet check with `--record-resolution` proving
  `user.identity.resolved` can be persisted intentionally;
- operator packet check with `--record-capacity-checks` proving diagnostic
  capacity probes can intentionally persist `user.network_task.capacity_checked`;
- PFTasks NFT import execute check proving `user.profile.nft_imported` is
  written with a deterministic event id;
- account deletion route or fixture proving provider identities emit
  `user.provider.unlinked` after successful deletion/archive;
- `npm run format-check`;
- `npm run lint`;
- `npm run build`;
- `git diff --check`.

## Privacy And Retention

- Do not log secrets, seeds, private keys, wallet passwords, auth cookies,
  OAuth tokens, email verification codes, Telegram bot tokens, or raw signing
  payloads.
- Prefer references to existing rows over duplicating raw chat bodies, raw
  memory source packets, uploaded evidence, or private context text.
- Hash provider ids and emails unless a table already stores a reviewed
  provider id for operational use.
- Respect account deletion by deleting or anonymizing account-scoped
  observability events that are not required for abuse, payment, faucet, or
  protocol audit.
- Keep public outputs limited to public handle, public display name, public
  aliases, public profile facts, task title/status/reward facts, and wallet
  addresses already used by PFTL.
