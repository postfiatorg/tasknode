# Ambient to Vercel AI Gateway: catalogue and migration plan

> September 5, 2026 retirement: Kimi K3 is the production task manager. The GLM Hive selector, legacy Board Manager launchers, experimental project planner, and disabled accounting harvester described below have been deleted. This inventory records earlier states; use [board management](board-manager.md) for current ownership.

> Implementation update, September 5, 2026: the user requested Vercel as the
> default with Ambient retained as backup. This supersedes this audit's original
> Ambient-retirement proposal. The current contract is [AI Providers](ai-providers.md).
> Ambient's current catalogue requires GLM 5.2 for text backup and lists no ready
> vision model. The catalogue JSON remains the historical inventory from before
> implementation; source line numbers and hashes are not current implementation references.


Audited 2026-09-05 in `/home/pfrpc/repos/tasknode`, at HEAD
`571d7833ed016165de32bd305ed765e62da066c7` plus the existing working-tree edits.
This is a source inventory and implementation proposal. Runtime code,
credentials, database rows, and deployed services have not been changed.
The accompanying [catalogue](../../verification/vercel-inference-migration/catalogue.json)
records matching files, source line numbers, file digests, and selected public
Vercel model metadata. Counts describe references, not the number of files that
must be edited. Historical documentation and fixtures are included separately.

## Requested result

Move every Task Node inference call currently dispatched to Ambient through
Vercel AI Gateway. Upgrade current GLM 5.2 workloads to GLM 5.3. Set Instant
to GLM 5.3 Flash.

The implementation should keep the existing Node server, React/Vite frontend,
Fly process groups, Postgres queues, PFTL/IPFS workflows, and authentication.
Vercel AI Gateway is an external inference endpoint that the current server can
call. Moving the application hosting to Vercel would be a separate project.

Use `https://ai-gateway.vercel.sh/v1/chat/completions` and the existing
`VERCEL_AI_GATEWAY_API_KEY` convention, with `AI_GATEWAY_API_KEY` as its
documented alias. No AI SDK or Next.js conversion is needed for this port.
[Vercel Chat Completions documentation](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions)

## Model routing contract

Vercel's GLM namespace is `zai/`; Ambient's current namespace is `z-ai/`.
These are exact provider model IDs, not labels to construct by replacing a
version substring.

| Workload | Current default in source | Proposed Vercel target | Basis |
| --- | --- | --- | --- |
| Instant, including historical Instant mode aliases | `deepseek/deepseek-v4-flash-0731` | `zai/glm-5.3-flash` | Requested |
| Thinking, including historical Thinking mode aliases | `z-ai/glm-5.2` | `zai/glm-5.3` | Requested |
| Existing GLM structured/reasoning/research workers | `z-ai/glm-5.2` | `zai/glm-5.3` | Requested |
| Team Context | Vercel `zai/glm-5.3-flash` | Same exact model | Already ported in current source |
| Help, memory, Hive immediate replies, BM narration, connection reranking | `deepseek/deepseek-v4-flash-0731` | Same exact model through Vercel | Preserve their model choices; only Instant was directed to Flash |
| Public profile snapshots | Explicit DeepSeek Flash model with `strict_json` capability | Same DeepSeek model through Vercel | Explicit model currently survives the capability resolver |
| Evidence vision and NFT pixel review | `moonshotai/kimi-k2.7-code` | Same exact model through Vercel | Preserve the existing vision model |
| Chat images | Selects a vision capability but can retain a text model | Instant can use GLM Flash image input; Thinking/Help require an explicit image-capable route, initially Kimi | Capability validation required; see below |

The [GLM 5.3 page](https://vercel.com/ai-gateway/models/glm-5.3) and
[GLM 5.3 Flash page](https://vercel.com/ai-gateway/models/glm-5.3-flash) confirm
the requested IDs. The public [models endpoint](https://ai-gateway.vercel.sh/v1/models)
also returned the existing DeepSeek and Kimi IDs during this audit. Its current
modality metadata lists GLM 5.3 as text input, Flash as text/image input, and
Kimi as text/image/PDF/video input. A catalogue listing proves availability in
the public catalogue, not successful inference under our gateway credentials.

Do not make `fast_text = GLM Flash` globally as a shortcut: that would also
change Help, memory, narration, reranking, and Hive immediate replies. Use an
explicit Instant route. Consolidating those other workloads onto Flash can be
considered as a separate model change.

## Runtime catalogue

Source links below are relative to this document. The JSON catalogue supplies
snapshot line references for the complete literal inventory.

| Boundary / feature | Primary source files | Work needed |
| --- | --- | --- |
| Shared inference transport | [ambient-inference.js](../../../server/ambient-inference.js), [vercel-inference.js](../../../server/vercel-inference.js) | Generalize the existing Vercel adapter to cover completion, raw-response compatibility, streaming, catalogue access, usage, cancellation, and errors; retire Ambient dispatch. |
| Chat modes and readiness | [chat-mode-runtime.js](../../../server/chat-mode-runtime.js), [chat-mode-defaults.js](../../../server/chat-mode-defaults.js) | Explicit route table, provider readiness/enabled checks, model IDs, timeout configuration, provider labels. Keep canonical Instant/Thinking/Help and old mode aliases. |
| Chat execution | [chat-router.js](../../../server/chat-router.js) | Both streaming and non-streaming paths, structured response formats, usage normalization, returned provider/model, and error metadata. Compatibility symbols such as `executeOpenAi` currently call Ambient. |
| Chat attachments | [ambient-attachments.js](../../../server/ambient-attachments.js), [evidence-file-extraction.js](../../../server/evidence-file-extraction.js), [chat-attachment-utils.js](../../../server/chat-attachment-utils.js) | Give the preparation helper a provider-neutral name; retain bounded local file extraction and image preservation; validate the effective model against actual content modalities. |
| Browser, agent, terminal and Telegram chat | [product-chat-contracts.js](../../../server/product-chat-contracts.js), [product-contracts.js](../../../server/product-contracts.js), [tasknode-terminal-routes.js](../../../server/tasknode-terminal-routes.js), [telegram-bot.js](../../../server/telegram-bot.js) | Shared chat routing covers their calls. Telegram's Thinking retry currently requires `provider === "ambient"`; update that gate and user-facing route descriptions. Verify fallback mode and charge behavior. |
| Usage and billing | [chat-provider-usage.js](../../../server/chat-provider-usage.js), [chat-billing.js](../../../server/repositories/chat-billing.js), [chat-billing-projections.js](../../../server/repositories/chat-billing-projections.js) | Normalize Vercel token/cache/tool/wholesale-cost fields while preserving configured user tariffs, durable charges and replay semantics. These shared callers also matter even without literal Ambient references. |
| Personal and network task generation | [task-generation-contract.js](../../../server/task-generation-contract.js), [task-generation-worker.js](../../../server/task-generation-worker.js) | GLM 5.3 for structured generation; preserve personal/network model override precedence, schema validation, prompt digests, queue claims, retry policy, and idempotency. |
| Task review, verification and rewards | [task-review-publication.js](../../../server/task-review-publication.js), [task-review-worker.js](../../../server/task-review-worker.js), [task-review-submission.js](../../../server/task-review-submission.js), [task-review-reward.js](../../../server/task-review-reward.js) | `callOpenAiJson` actually uses Ambient. Switch it to GLM 5.3, record the resolved/returned model, and update timeout error handling. Preserve review schemas and reward/publication semantics. |
| Evidence image understanding | [task-evidence-processing.js](../../../server/task-evidence-processing.js) | Move Kimi vision calls to Vercel and preserve retryable failure behavior and bounded extracted text/images. |
| Context Rewrite | [context-rewrite-provider.js](../../../server/context-rewrite-provider.js), [context-rewrite-worker.js](../../../server/context-rewrite-worker.js), [context-rewrite-actions.js](../../../server/context-rewrite-actions.js) | Port all score/final/polish/research stages and their environment overrides, citations, tool usage/cost, provider-call records, timeout mapping, and readiness instructions. The property called `deepseek` currently defaults to GLM structured inference. |
| Chat, deep and network memory | [chat-memory-worker.js](../../../server/chat-memory-worker.js) | Move all four provider calls and readiness checks; preserve current DeepSeek model and per-stage prompts/records. |
| Hive immediate replies | [hive-immediate-response.js](../../../server/hive-immediate-response.js) | Replace raw-response compatibility transport and metadata; preserve its explicit fast model and current structured semantic routing. |
| Hive Secretary and Project planning | [hive-secretary-worker.js](../../../server/hive-secretary-worker.js), [hive-project-worker.js](../../../server/hive-project-worker.js) | GLM 5.3, Vercel configuration checks, and provider validators. Both currently reject non-Ambient providers. |
| Hive report writer | [hive-report-provider.js](../../../server/hive-report-provider.js) | GLM 5.3 across report types; replace compatibility fetch; validate existing high/xhigh effort and output budgets. |
| Hive task manager | [hive-task-manager-provider.js](../../../server/hive-task-manager-provider.js) | GLM 5.3 and Vercel readiness/metadata; retain action schemas, limits, and active/enabled gates. |
| Hive board secretary | [hive-board-secretary-provider.js](../../../server/hive-board-secretary-provider.js) | GLM 5.3 and Vercel configuration/metadata; update launcher and status descriptions. |
| Legacy Board Manager decision and secretary packets | [board-manager-decision-provider.js](../../../server/board-manager-decision-provider.js), [board-manager-secretary-packets.js](../../../server/board-manager-secretary-packets.js) | Port both completion and streaming, provider validators, schema-guided repair, and durable provider fields. Legacy execution remains disabled where it is disabled today. |
| Board Manager narration | [bm-narrator-worker.js](../../../server/bm-narrator-worker.js) | Same DeepSeek model via Vercel; also inspect the explicit Fly model pin. |
| Task accounting harvester | [task-accounting-harvester-provider.js](../../../server/task-accounting-harvester-provider.js) | GLM 5.3, compatibility fetch, readiness, usage and metadata. Preserve the current disabled Fly setting. |
| Docs ODV | [docs-odv.js](../../../server/docs-odv.js) | GLM 5.3 and provider metadata; update hard-coded frontend response/model fallbacks. |
| Daily airdrop scoring | [profile-daily-airdrop.js](../../../server/profile-daily-airdrop.js), [profile-daily-airdrop-worker.js](../../../server/profile-daily-airdrop-worker.js) | GLM 5.3, including the worker's separate literal default; preserve deterministic issuance/reward logic. |
| Public profile summaries | [profile-public-snapshot.js](../../../server/profile-public-snapshot.js), [public-profile-snapshot-worker.js](../../../server/public-profile-snapshot-worker.js) | Move explicit DeepSeek JSON requests and the Ambient-key worker gate. |
| Recommended connections | [recommended-connections-ranking.js](../../../server/repositories/recommended-connections-ranking.js) | Move the DeepSeek reranking request and readiness gate; preserve deterministic fallback and embeddings. |
| Expert badge evaluation | [expert-badge.js](../../../server/expert-badge.js), [network-badges.js](../../../server/repositories/network-badges.js), [network-badge-verifier-jobs.js](../../../server/repositories/network-badge-verifier-jobs.js) | GLM 5.3; record new evaluations accurately. `glm52_last_20_personal_tasks` is also a persisted proof-method identifier, not just a display label. |
| Profile NFT abstraction/privacy and pixel review | [profile-nft-privacy-gateway.js](../../../server/profile-nft-privacy-gateway.js), [profile-nft-image-review.js](../../../server/profile-nft-image-review.js) | GLM 5.3 for abstraction/privacy review; Kimi via Vercel for image review. Preserve the sanitized renderer queue and fail-closed publication policy. |
| Team Context | [team-context-worker.js](../../../server/team-context-worker.js), [vercel-inference.js](../../../server/vercel-inference.js) | Already uses exact GLM 5.3 Flash. Keep its response schema, account visibility rules and caller contract working when generalizing the adapter. |
| Operator automation | [deathmarch.mjs](../../../scripts/deathmarch.mjs), [run-deathmarch-supervised.sh](../../../scripts/run-deathmarch-supervised.sh), Board Manager launchers | Port semantic classification and response calls, key loading, environment names, provider validation, and metadata. Keep conservative classifier fallback; no literal/regex routing. |

## Integration differences that require implementation

### Shared adapter and model policy

The existing Vercel adapter only accepts `messages`, `model`, and `maxTokens`
plus transport options. It forces JSON-object output, temperature 0.1, and a
minimum token budget. It returns a raw provider body. It cannot directly replace
Ambient's richer caller contract or streaming implementation.

Introduce a provider-neutral entry point, for example `server/inference.js`,
with a single Vercel transport behind it and a typed workload/model registry.
Keep raw-body versus normalized-result contracts explicit while migrating the
legacy compatibility-fetch callers. Feature modules should receive a normalized
result with provider, requested/resolved/returned model, request ID, text, usage,
finish reason, and tool metadata. They should not construct gateway URLs.

Replace regex-based model matching with explicit aliases, enums and modality
checks. Unknown configured IDs must produce a configuration error rather than
silently selecting GLM. The current resolver silently falls back on unfamiliar
IDs, and capability environment overrides take precedence even over an explicit
feature model. Define and test the new precedence: explicit workload override,
applicable capability override, then workload default, all capability-validated.
Document this intentional precedence correction for operators.

The current attachment path selects `vision_text`, then still passes the
chat text model. `resolveAmbientModel` accepts a recognized explicit text ID
before considering the capability default. Thus source inspection identifies a
route that can send images to a text-only model. Validate modalities after model
resolution, and select an explicit vision model when the chosen chat model
cannot accept images. Regression tests must cover both Instant and Thinking,
plus images extracted from PDFs/DOCX. This is a source finding, not a reproduced
production incident.

### Reasoning and structured output

Keep Thinking's intended deep reasoning and Instant's intended fast response.
Vercel documents the Chat Completions `reasoning` object, including
`effort: "none"`, `high`, `xhigh`, and `exclude`. The model catalogue separately
advertises GLM 5.3/Flash effort options `low`, `high`, `max`. Verify the actual
GLM routes with the app's existing high/xhigh/none settings; do not assume that
the catalogue's native `max` is a valid replacement wire value. `exclude: true`
only hides reasoning output and does not disable computation.
[Reasoning documentation](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning)

Use `response_format: { type: "json_schema", json_schema: ... }` where feature
schemas exist, and validate results locally before any state change. Gateway
API-level structured-output support does not prove every selected backend
accepts every existing schema. Probe representative task, review, Context
Rewrite, Hive and Team Context schemas before rollout.
[Structured-output documentation](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs)

### Search and tool results

Ambient's adapter translates `web_search` into `enabled_tools: ["websearch"]`,
posts returned tool calls to `/tools`, and loops over completions. Replace that
provider-specific protocol. Context Rewrite is the concrete search consumer;
ordinary chat mode defaults currently do not enable web search.

Vercel documents server tools in Chat Completions. For the existing default Exa
research intent, use `type: "vercel:exa_search"`, with the explicit research
query and bounded result settings in `config`, plus `tool_choice: "required"`
for a mandatory search stage. Gateway executes the tool internally; successful
search counts are reported under
`choices[0].message.provider_metadata.gateway.gatewayToolCalls`. It does not
return raw search results or client-facing search tool calls. Adapt citations
and usage deliberately; the current annotation parser and a hard-coded search
count are insufficient evidence that search ran. Verify provenance behavior
with a live synthetic query before declaring research migrated. Preserve any
supported configured search-engine choice through an explicit mapping, and
reject unsupported choices instead of silently ignoring them.
[Vercel web-search documentation](https://vercel.com/docs/ai-gateway/models-and-providers/web-search.md)

### Streaming, timeouts and fallback

Retain incremental text, a usage-only final event, finish reasons, split UTF-8
chunks, LF/CRLF SSE framing, cancellation, and empty/error response handling.
Use a parser without regex. Apply the request deadline from before connection
through body consumption. The current Ambient stream starts its timeout only
after receiving headers; its non-streaming fetch clears its timeout before
reading the response body. These behaviors should not be copied into the port.

Remove the Ambient-specific `no workers` message match and fast-to-GLM retry.
Use gateway provider failover for the selected model, with structured error
handling for 401/402/429/5xx. Do not introduce automatic cross-model fallback
that defeats the requested model mapping. Preserve and test the existing
Telegram mode fallback separately. Vercel routing preferences use
`providerOptions.gateway`; an ordered preference is not a provider allowlist.
[Advanced gateway configuration](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/advanced)

### No regex on LLM paths

The workspace instruction applies to the whole migrated call path, not just
the new HTTP client. Current examples include model routing, key/base-URL
cleanup, tool detection, error classification and SSE parsing in
`ambient-inference.js`; JSON fence repair in `context-rewrite-provider.js`; and
prompt/response validation helpers used by features.

Audit reachable prompt construction, retrieval, attachment parsing, model
dispatch, tool handling, response parsing, privacy validation and retry logic.
Replace regex with structured JSON/schema validation, explicit string/protocol
parsers and existing structured semantic classifiers. Retain schema-guided
model repair only where the feature already requires it. Add an AST-based
regression gate over the audited call-path modules that rejects regex literals
and `RegExp` construction, with tests for indirect regex helpers. Merely
rewriting `resolveAmbientModel` would leave the instruction unmet.

### Billing, catalogue and observability

`chat-mode-runtime.js` defines the user tariff. `model-pricing-status.js` explicitly
distinguishes that tariff from provider wholesale cost. Preserve that distinction
and existing debit/idempotency rules; the provider migration does not authorize
a user price change. Update wholesale cost/cache extraction and report unknown
cost as unknown rather than manufacturing zero.

The current catalogue parser reads Ambient/OpenRouter-shaped fields such as
`pricing.prompt`, `pricing.completion`, `context_length`, and
`top_provider.max_completion_tokens`. Vercel currently returns `pricing.input`,
`pricing.output`, `context_window`, and `max_tokens`. Add a separate schema
adapter and preserve cache/stale behavior. `chatCacheEfficiencyStatus` currently
filters SQL to `provider = 'ambient'`; add Vercel records without relabeling old
runs. Update `system-status-readers.js` wholesale estimates, readiness in
`product-contracts.js`, and model/provider labels returned to all clients.

Do not hard-code promotional website prices as the application's tariff or a
guaranteed wholesale price. At audit time the Flash page showed a lower
starting price than `/v1/models`, and GLM 5.3's page described a promotion ending
September 8, 2026. Prices and provider selection need a timestamped source and
actual usage metadata. Gateway catalogue privacy flags are provider-dependent;
validate the intended account-data routing policy and update the existing
privacy descriptions to match the effective configuration.

## Persistence, configuration and product copy

| Surface | Migration action |
| --- | --- |
| Capability environment | Replace `AMBIENT_MODEL_FAST_TEXT`, `AMBIENT_MODEL_REASONING`, `AMBIENT_MODEL_STRUCTURED`, `AMBIENT_MODEL_RESEARCH`, `AMBIENT_MODEL_VISION` with clearly documented provider-neutral equivalents. Preserve independent Instant and background-fast defaults. Detect stale Ambient variables at startup; do not silently ignore them. |
| Transport environment | Vercel key/base URL; replace `AMBIENT_CHAT_ENABLED`, `CHAT_PROVIDER_AMBIENT_THINKING_TIMEOUT_MS`, catalogue TTL, metrics and tool-loop variables with their applicable equivalents. Retire `AMBIENT_TOOL_ATTEMPTS`/`AMBIENT_MAX_TOOL_ROUNDS` after server-tool migration. |
| Feature model overrides | Audit every `*_MODEL` used by the rows above: task generation/review, Hive/Board Manager, accounting, Context Rewrite stages, memory, profiles/airdrop, expert evaluation, recommendations, evidence/NFT vision, and Deathmarch. Explicitly migrate old GLM IDs and legacy `chat-latest` defaults; do not let them resolve accidentally. |
| Fly | Update all six GLM 5.2 model pins and Secretary/Project provider pins in `fly.toml`. Preserve the DeepSeek narrator pin, process flags, cadence and disabled workers. Stage gateway configuration for every process that calls inference. Verify actual deployed env/secret names during implementation; this audit inspected source configuration only. |
| Local Docker | `docker-compose.dev.yml` currently blanks Ambient and Vercel credentials and disables workers. Keep that behavior and also blank the accepted `AI_GATEWAY_API_KEY` alias so an `env_file` cannot bypass it. Update latent model/provider defaults without enabling workers. |
| Reward-test Docker | Replace Ambient key/base URL wiring and GLM defaults in `docker-compose.reward-test.yml` and `scripts/docker-reward-env.mjs`; preserve explicit opt-in execution. |
| Operator launchers | Update `scripts/board-manager-{worker,loop,model-exec}.mjs`, `hive-board-secretary-worker.mjs`, profile launchers, `deathmarch.mjs`, and the supervised Deathmarch key-loading script. Their provider validators and stored engine/session labels also require review. |
| Database defaults | Add a new migration after the current migration head to change Ambient provider defaults introduced in migration 105 for `board_manager_secretary_packets` and `hive_decision_runs` where still applicable. Update active repository insertion defaults in Context Rewrite, Hive task manager and secretary packets. Never edit migration 105 or rewrite historical provider/model facts. |
| Expert proof methods | Replace hard-coded `glm52_last_20_personal_tasks` for new evaluations with a versioned, model-neutral proof method carrying explicit evaluator model metadata. Retain interpretation of historical identifiers and migration 072. Preserve the last-20 selection and score threshold. |
| Frontend | Update `ChatSurface.jsx`, `AppChatDialogs.jsx`, `DocsLibraryView.jsx`, `DocsView.jsx`, `ProfileIdentityPanels.jsx`, and `profile-view-shared.jsx`; derive display models from the API where practical. Also update Context Rewrite projection and worker status copy. |
| Documentation | At implementation cutover, revise `docs/wiki/architecture/ai-providers.md`, deployment/operations/system-status pages, affected chat/context/tasks/Hive/profile/memory surfaces, README and diagrams. Review the docs registry in `src/features/docs/docs-content.js` when registering or changing docs. Keep dated audit/migration pages historical. |

## Boundaries outside Ambient inference

The current NFT renderer in `server/profile-nft-image-provider.js` calls OpenAI
Images using its isolated renderer credential. It receives a sanitized prompt
from a durable queue. Porting the Ambient abstraction and review calls does not
require changing this renderer or its credential isolation.

Embeddings are local `deterministic-bag-of-words-v1` at 1536 dimensions in
`server/embedding-provider.js`. Preserve vector identity and dimensions; this
port needs no corpus re-embedding. Any regex in prompt retrieval remains subject
to the call-path audit above, independently of keeping the embedding algorithm.

`server/corbanu-deep-research.js` uses the separate authenticated Corbanu
research service. It is not the Context Rewrite Ambient search path. Preserve
its account scoping and integration. The external Board Manager terminal
harness defaults to `kimi-code` / `kimi-k3` in `ops/bm-runtime/bm-env.sh`; its
comment mentions an Ambient outage fallback. Replace that stale fallback
guidance when retiring Ambient, while preserving the independent Kimi mandate.

## Implementation sequence and proof

1. **Freeze and verify the route contract.** Reconcile current working-tree
   edits, record effective model/provider environment overrides without secrets,
   and validate gateway credential readiness in each executing process. Use the
   target table above. Probe both GLM models, Kimi images and required DeepSeek
   structured responses with synthetic payloads; confirm reasoning and schema
   compatibility. Public catalogue checks performed here do not replace these.
2. **Build the shared Vercel boundary.** Add explicit model/alias/modality policy,
   generalized completion and streaming APIs, structured errors, usage/catalogue
   adapters and server search tools. Cover failure, timeout and cancellation
   behavior with injected fetch fixtures. Keep Team Context's existing exact
   model contract working. Complete the no-regex audit on migrated paths.
3. **Migrate chat and all callers.** Change shared chat modes plus every worker,
   readiness gate, legacy raw-response caller, operator launcher, metadata writer
   and Telegram retry gate in the catalogue. Update UI model descriptions and
   preserve browser/agent/terminal/Telegram mode aliases. Resolve vision by
   capabilities, not message wording.
4. **Migrate state defaults and deployment configuration.** Add the forward DB
   migration, update repository defaults, Fly/Docker pins, environment docs,
   catalogue/status SQL and wholesale cost accounting. Keep historical data and
   user tariffs. Update the egress gate to reject Ambient hosts/credentials in
   active code/config and permit gateway dispatch only in the shared boundary;
   include `ops/` and shell launchers, which its current scan misses.
5. **Verify the changed boundaries, then cut over.** Run focused fixtures below,
   followed by synthetic live completion/stream/schema/search/image probes.
   Verify queued workers write `provider=vercel` and actual model IDs, and that
   chat estimates/debits/replays remain correct. Restart the affected process
   groups only at actual cutover. Confirm no new Ambient egress before retiring
   its credentials and active compatibility code.

The rollback unit is the prior application/configuration release. Preserve
historical rows and keep the forward migration compatible with old explicit
provider writes. Do not use a runtime Ambient fallback as the rollback plan.
Retain the old operational credential until the cutover observation completes,
then remove it from executing environments. Retrying a failed worker must reuse
its existing task/reward/publication idempotency boundary.

Focused regression work should extend the existing tests rather than run the
whole product suite by default:

| Boundary | Existing tests / required additional cases |
| --- | --- |
| Gateway | Replace/extend `ambient-inference-smoke`; add Vercel completion/SSE/catalogue/error/search fixtures, schema rejection, abort before headers and during body read, missing key, stale env, and unknown model checks. Add no-regex AST enforcement. |
| Chat | `chat-mode-deprecation-smoke`, `chat-spirit-prompt-smoke`, `chat-stream-reliability-smoke`, `chat-persona-routing-smoke`, `chat-attachment-smoke`, `agent-chat-origin-smoke`, `agent-hive-chat-smoke`, `telegram-bot-webhook-smoke`. Cover aliases, plain text/images/PDF images, all delivery sources, cache and final-usage events, fallback, empty responses, and disconnects. |
| Billing/status | `chat-billing-postgres-smoke`, `system-status-smoke`; fixture both provider eras, cache fields, unknown wholesale cost and completed/replayed/failed requests. User tariff must remain stable. |
| Task lifecycle | `taskgen-replay-smoke`, `taskgen-network-v2-smoke`, `task-generation-reliability-smoke`, `task-evidence-file-processing-smoke`, `task-review-idempotency-smoke`. Validate schemas and actual provider/model metadata without duplicate offers/rewards. |
| Other workers | Focused Context Rewrite, Hive/Board Manager, expert badge, memory, profile/NFT and Team Context smokes from the catalogue. `team-context-smoke` must continue to assert exact `zai/glm-5.3-flash`. Use synthetic/fixture packets for economic paths. |
| Egress/config/UI | `provider-egress-check`, local Docker environment fixture, launcher help/dry-run, `npm run lint`, and `npm run build` when JS/UI changes. Inspect rendered model labels when implementing them. |

The port is complete when every active Ambient caller in the catalogue uses
the Vercel boundary, new runs record the intended model/provider, mandatory
search and images work, schema/timeout/usage/idempotency tests pass, and no
executing process requires Ambient. This audit has established the source map
and public API contracts; authenticated inference, deployed settings, database
migration execution and production behavior remain unverified.
