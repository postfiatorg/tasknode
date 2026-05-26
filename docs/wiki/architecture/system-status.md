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

Each status row links to the corresponding Architecture page for that system.
Those pages define how green, amber, red, disabled, and unknown are derived and
what the operator should inspect or run next. If a row appears here, it must have
a matching Architecture page.

## Categories

- Hive and Board Agents: Board Manager, Hive Secretary, active project planning,
  and Board Manager secretary packets.
- Task Systems: Network Task generation, task offer generation, and task review
  or reward work.
- PFTL and RPCs: hot wallet sync, archive sync, websocket watcher, reducer,
  retention, current PFTL RPC/WSS, history RPC/WSS, and Ethereum deposit RPC.
- Memory, Retrieval, Profiles, and Airdrops: Jobs pgvector retrieval, turn
  memory, deep memory, Network Task routing profiles, and daily airdrop scoring
  or issuance.

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
  Discount Thinking, including the lower cache-hit input token price when
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
the public `$0.87/M output` headline and backs Discount Thinking. It is not a
Task Node private/ZDR chat route.

## Status Rules

Red means the row is paused, stale beyond its expected cadence, has recent failed
work, has a stale active queue, or has no required configuration. Amber means it
is lagging, has recent failed records that need review, or has stale partial
work. Grey means disabled or no durable status source is available. Green means
the latest observed state is current. Historical terminal failures can remain in
the counts for audit without keeping the row amber forever.
