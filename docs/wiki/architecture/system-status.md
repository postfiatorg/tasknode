# System Status

This page is the live audit view for scheduled and background Task Node systems.
It groups the queues, workers, and RPC dependencies that can make the app look
healthy while work is not actually moving.

The status rows are read-only. They do not resume workers, repair queues,
advance tasks, or change Board Manager scheduler state.

The top of the live status page also renders Chat Model Pricing. That section is
not a worker health row. It is an audit snapshot of the current chat-mode
provider contracts from `server/chat-router.js`, plus cached live OpenRouter
model metadata from `https://openrouter.ai/api/v1/models`.

Each status row links to the functional Help page that owns that system. Several
rows may share the same page when they are part of one product boundary. For
example, Task Generation owns offer generation, review, verification, and reward
workers; PFTL owns hot sync, archive sync, WSS, reducer, retention, and RPC
checks; Hive and Board Operations owns the Board Manager, secretary packets,
Hive Secretary reports, and active projects.

## Categories And Monitored Items

`server/system-status.js` emits four categories. Each row id below is the exact
`item.id` returned by `/api/system/status`, so the doc and the live response use
the same names.

### Hive And Board Agents

Board Manager decisions, secretary packets, Hive Secretary reports, and active
project planning.

- `board_manager`: leased Board Manager scheduler for `global_hive`.
- `board_manager_secretary_packets`: DeepSeek compression packet used before the
  Board Manager decision.
- `hive_secretary`: Hive Secretary report worker.
- `hive_active_projects`: active project registry helper.

### Task Systems

Network Task generation, user task generation, and task review/reward.

- `network_task_generation`: turns Board Manager allocations into task request
  bundles.
- `task_generation`: turns signed task request rows into PFTL task offers.
- `task_review`: publishes verification requests and terminal reward outcomes.

### PFTL And RPCs

Current and archive RPC paths, websocket watcher, wallet sync, reducer, and
retention.

- `pftl_hot_sync`: hot wallet transaction polling.
- `pftl_archive_sync`: archive `account_tx` backfill.
- `pftl_wss_watcher`: websocket ledger-event subscription.
- `pftl_cache_reducer`: projects cached pointer events into read models.
- `pftl_cache_retention`: prunes completed reducer events and optional raw rows.
- `pftl_current_rpc`: hot path for balance reads, submission, and hot sync. Its
  status mirrors `pftl_hot_sync` once endpoints are configured.
- `pftl_history_rpc`: archive-capable history/backfill path. Its status mirrors
  `pftl_archive_sync` once endpoints are configured.
- `ethereum_deposit_rpc`: route-triggered top-up sync path, not a background
  scheduler. It reports `ok` when enabled and RPC-configured, otherwise `disabled`.

### Memory, Retrieval, Profiles, And Airdrops

Jobs pgvector retrieval, chat memory, routing profiles, and daily airdrop
scoring/issuance.

- `jobs_pgvector_corpus`: Postgres pgvector corpus for Jobs-style retrieval.
- `chat_turn_memory`: turn memory summarization worker.
- `deep_memory`: deep memory compression worker.
- `network_task_profile`: compact routing profiles for future Network Tasks.
- `daily_airdrop_worker`: daily airdrop scoring and optional PFT issuance, plus
  unresolved airdrop debt tracking.

The current monitored set is 20 items across these four categories. The summary
block at the top of the response counts each row by status
(`ok`/`warning`/`critical`/`unknown`/`disabled`). Transient `warning` rows are
normal for sync-lag conditions and do not imply a permanent state.

## Chat Model Pricing

The status page pricing block separates three values that are easy to confuse:

- Configured estimate: the per-million-token estimate in `chatModePrices`. This
  is used for preflight estimates and confirmation thresholds.
- Live OpenRouter model price: public model metadata returned by OpenRouter for
  the selected model id. This is useful audit context, but it can describe the
  cheapest model endpoint rather than the exact endpoint Task Node will use.
- Live OpenRouter endpoint prices: provider-level endpoint metadata for the
  current model. For private modes the UI marks endpoints in the Task Node
  `provider.only` allowlist as allowed, and labels non-allowlisted DeepSeek
  endpoints as reference prices only.
- DeepSeek API Direct price: the configured direct DeepSeek V4 Pro price for
  Discount Thinking and Help, including the lower cache-hit input token price when
  DeepSeek reports cache-hit tokens.

Actual chat billing prefers provider-returned usage. For OpenRouter this means
`usage.cost` from the response wins over the configured estimate whenever it is
present. For DeepSeek API Direct, DeepSeek returns token usage rather than a USD
cost field, so Task Node computes the debit from `prompt_tokens`,
`completion_tokens`, `prompt_cache_hit_tokens`, and `prompt_cache_miss_tokens`
using the configured direct prices. The pricing block is therefore an audit and
preflight aid, not a debit source of truth.

Private modes also send `provider.zdr=true` and
`provider.data_collection="deny"`. A cheap endpoint shown by OpenRouter is not
automatically a Task Node private route unless it is compatible with that request
policy. The direct DeepSeek V4 Pro reference price is shown because it explains
the public `$0.87/M output` headline and backs Discount Thinking and Help. It is
not a Task Node private/ZDR chat route.

## Status Rules

Red means the row is paused, stale beyond its expected cadence, has recent failed
work, has a stale active queue, or has no required configuration. Amber means it
is lagging, has recent failed records that need review, or has stale partial
work. Grey means disabled or no durable status source is available. Green means
the latest observed state is current. Historical terminal failures can remain in
the counts for audit without keeping the row amber forever.
