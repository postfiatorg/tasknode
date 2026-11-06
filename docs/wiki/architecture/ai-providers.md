# AI Providers

Task Node routes all model inference through **Vercel AI Gateway**. Thinking and
existing GLM workers use GLM 5.3; Instant and Team Context use GLM 5.3 Flash;
task generation uses Kimi K3.1 Pro. The model layer is shared by chat, Docs
assistants, context, memory, tasks, Hive, profiles, and operator scripts.

Ambient was deprecated on 2026-10-27. Nothing falls back to it; the route remains
in code only behind `INFERENCE_AMBIENT_BACKUP_ENABLED=true` for an emergency
re-enable, and historical completions keep their recorded `ambient` provider.

## Models

| Workload | Model on Vercel AI Gateway |
| --- | --- |
| Instant, Team Context | `zai/glm-5.3-flash` |
| Thinking, structured work, research, GLM workers | `zai/glm-5.3` |
| Task generation (personal and network) | `moonshotai/kimi-k3.1-pro`, `high` effort |
| Task readiness review | `zai/glm-5.3-flash` |
| Help, memory, short narration | `deepseek/deepseek-v4-flash-0731` |
| Evidence images | `moonshotai/kimi-k2.7-code` |

GLM 5.3 Flash accepts text and images and produces text. It does not generate
images. Instant can retain Flash for image input; text-only models switch to the
vision model when images are present. Files are extracted locally with byte,
page, archive-entry, and expansion limits before inference.

## Shared Routing

`server/inference.js` owns dispatch, with policy, protocol, transport, text, and
usage helpers beside it. Feature modules use this boundary. The legacy
`ambient-inference.js` exports and Team Context's `vercel-inference.js` wrapper
also dispatch through it. Old function names are compatibility names, not
provider selectors.

Each request has a bounded attempt deadline covering headers and body reads.
A stream that produced no first byte is retried once. Invalid input, rejected
schemas, truncated output, and caller cancellation are returned as errors.
A configured key is not proof of successful authentication or available model
capacity.

## Gateway Credits And Task Generation

The gateway answers `402` when the team balance or a budget is exhausted
(2026-11-06 incident: every task request failed for ~6.5 hours). Task Node now:

- reports each task-generation credential's balance from `GET /v1/credits` in
  `/api/readiness` under `llm.gatewayCredits` (cached, bounded wait, never the
  key itself), with `lowBalance` and a `llm.warnings` entry below
  `TASKNODE_GATEWAY_CREDIT_LOW_BALANCE_USD` (default 25);
- shows users "task generation is temporarily unavailable" instead of the raw
  `inference_http_402`, which stays in `task_requests.last_error` and logs;
- parks 402-failed task requests and network generation jobs instead of failing
  them, stops sending task generation to the provider while the balance is $0,
  re-checks the balance on a backoff, and releases everything parked as soon as
  credits return. Requests that failed with a 402 within
  `TASKNODE_TASKGEN_CREDIT_REQUEUE_LOOKBACK_HOURS` (default 72) are re-queued
  once. Parked work fails after `TASKNODE_TASKGEN_CREDIT_WAIT_MAX_HOURS`
  (default 48);
- records each task-generation completion against the account it served as a
  zero-amount `taskgen_inference` billing ledger entry carrying provider, model,
  tokens and the gateway-reported cost. Users are not debited and the entries
  are omitted from the user billing ledger.

Fallback providers for task generation are a separate, unshipped proposal:
[taskgen-fallback-provider.md](../../proposals/taskgen-fallback-provider.md).

## Configuration

- `VERCEL_AI_GATEWAY_API_KEY`, or alias `AI_GATEWAY_API_KEY`, configures inference. `VERCEL_KIMI_API_KEY` and `VERCEL_ASTRA_API_KEY` are dedicated keys for those models.
- `VERCEL_AI_GATEWAY_BASE_URL` defaults to `https://ai-gateway.vercel.sh/v1`.
- `INFERENCE_CHAT_ENABLED=false` disables chat inference.
- Capability overrides: `INFERENCE_MODEL_INSTANT`, `INFERENCE_MODEL_FAST_TEXT`, `INFERENCE_MODEL_REASONING`, `INFERENCE_MODEL_STRUCTURED`, `INFERENCE_MODEL_RESEARCH`, and `INFERENCE_MODEL_VISION`.
- Task generation: `TASKNODE_TASKGEN_MODEL` and `TASKNODE_NETWORK_TASKGEN_MODEL` (default Kimi K3.1 Pro), `TASKNODE_TASKGEN_REASONING_EFFORT` and `TASKNODE_NETWORK_TASKGEN_REASONING_EFFORT`.
- Deprecated: `AMBIENT_API_KEY`, `AMBIENT_BASE_URL` and `AMBIENT_BACKUP_MODEL_*` take effect only with `INFERENCE_AMBIENT_BACKUP_ENABLED=true`; `AMBIENT_MODEL_*` aliases are no longer read.

Known GLM 5.2 pins resolve to GLM 5.3. Unknown model IDs are rejected; add a
reviewed registry entry before introducing a new model.

## Search, Usage, And Persistence

Context Rewrite uses Vercel's server-executed search tools. Search counts and provider costs come from
provider metadata when reported; missing wholesale costs remain unknown.
The [Vercel model catalogue](https://ai-gateway.vercel.sh/v1/models) supplies live
pricing and capability information with a short cache and last-known-good data.

User chat tariffs remain separate from wholesale provider costs. This migration
does not change user tariffs. Existing provider/model history is retained;
new database defaults use Vercel. The shared completion carries actual provider
and model metadata, and Team Context stores per-member inference metadata.
Feature adapters must preserve actual provider/model metadata during fallback.
The obsolete Hive Task Manager adapter and accounting-harvester inference
path have been removed. NFT privacy retains its independent structured
reviewer and mechanical literal checks.

The shared inference modules use typed JSON/XML parsing and ordinary text
parsers. Regex is prohibited throughout LLM call paths by workspace policy.
`npm run inference-no-regex-check` covers direct inference callers and an
explicit helper inventory; it does not yet prove transitive JS, Rust or shell
call-path coverage. Passing that check must not be described as whole-system
compliance.

## Separate Services

Retrieval retains local `deterministic-bag-of-words-v1` embeddings at 1536
dimensions; existing vectors remain compatible. Corbanu research and the
independent Kimi board terminal runtime retain their own service contracts.

Profile NFT preparation and image review are pinned to `moonshotai/kimi-k3.1-pro` on Vercel with `providerOptions.gateway.zeroDataRetention=true`, using the account's existing ZDR setup. Ambient fallback is prohibited for this pipeline, even when Vercel is unavailable. Kimi reads bounded canonical task history and produces an independently reviewed anonymous Techno Mordor art spec. Only that anonymous spec reaches the isolated `gpt-image-2.5-sunburst` OpenAI Images renderer; raw history, evidence refs and account identity do not. `PROFILE_NFT_OPENAI_API_KEY` belongs only to the renderer. The separate OpenAI account's retention controls are independent of Vercel ZDR. See [Profile](../surfaces/profile.md#techno-mordor-art-and-privacy).

## Verification

Run `npm run inference-failover-smoke`, `npm run inference-no-regex-check`, and
`npm run provider-egress-check` for the shared boundary. Feature smoke tests
cover chat, attachment extraction, task evidence, Hive, profiles, and Team
Context persistence. Synthetic live calls require valid provider credentials;
fixture success alone does not prove production availability.
