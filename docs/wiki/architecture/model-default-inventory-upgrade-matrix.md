# Model-default inventory and upgrade matrix

> **Historical baseline — superseded 2026-08-12.** This page records the provider/model state at commit `57f3eac` and must not be used as the current runtime map. The completed system uses Ambient for all inference, exposes only Instant, Thinking, and Help, and retains OpenAI only as the isolated Profile NFT image renderer. See [AI Providers](#docs/ai-providers) and [Ambient Inference Cutover Plan](#docs/ambient-inference-cutover-plan).

**Baseline:** `57f3eace716895b3cdc0e998c20d87375d333cd4` (`57f3eac`).  Every source reference below is against that commit.  This is an inventory and proposal document only; it makes no runtime change and records no credential value.

## Scope and reading rules

The audit covered tracked `server/`, `scripts/`, `src/`, `prompts/`, `docker-compose*.yml`, `fly.toml`, package scripts, and tracked `.env*` files.  There are **no tracked `.env*` files** at the baseline.  Credential-shaped fixture inputs and credential environment values were intentionally excluded.

Status meanings:

| Status | Meaning |
| --- | --- |
| `REQUIRED` | Directed model/effort change. |
| `OBVIOUS-CANDIDATE` | Same-provider straight swap suitable for the checkpoint below; do not implement without approval. |
| `RECOMMEND-ONLY` | Requires a provider switch, affects GLM 5.2, embeddings, scoring/evaluation, image generation, or has ambiguous semantics. |
| `NO-CHANGE` | A display, compatibility, historical, or wiring surface that should not change with an upgrade. |
| `FIXTURE-ONLY` | Deterministic test/fixture value; no production implication. |

Cost deltas are intentionally `unknown/not comparable` unless the cited OpenAI page establishes both sides.  The directed Frontier Thinking comparison uses the current [OpenAI GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol): GPT-5.6 Sol is $5/M input, $0.50/M cached input, and $30/M output; the page lists GPT-5.5 at $5/M input and $30/M output.

## Historical runtime defaults and proposal matrix

| Component / surface | Provider / API path | Current model; effort | Directive / proposal | Status | Rationale | Cost delta | Exact baseline references |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task generation, personal/default | OpenAI Chat Completions (`/v1/chat/completions`) | `chat-latest`; no explicit effort | Keep OpenAI; set `gpt-5.6-sol`, `xhigh` | `REQUIRED` | Directed upgrade; implementation must add the effort field at the request boundary. | unknown/not comparable (current alias is not a priced pinned ID) | `server/task-generation-worker.js:239-257,608-641` |
| Chat, Frontier Thinking | OpenAI Responses | `gpt-5.5`; `high` | Set `gpt-5.6-sol`, `xhigh` | `REQUIRED` | Directed Frontier Thinking upgrade. | **$0/M input, $0/M output** nominal; cached input changes from the page's GPT-5.5 comparison to $0.50/M for Sol, so cached semantics require implementation confirmation. [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | `server/chat-router.js:104-112,218-235` |
| Chat, Frontier Instant | OpenAI Responses | `chat-latest`; `medium` | Keep as configured pending product choice | `RECOMMEND-ONLY` | Alias semantics and instant-mode latency/quality intent are ambiguous. | unknown/not comparable | `server/chat-router.js:85-93,218-235` |
| Chat, Private Instant | OpenRouter Chat Completions | `deepseek/deepseek-v4-flash`; reasoning disabled | Keep provider/model | `NO-CHANGE` | Deliberate low-cost mode, not a directed OpenAI upgrade. | unknown/not comparable | `server/chat-router.js:56-64,218-235` |
| Chat, Private Thinking | OpenRouter Chat Completions | `z-ai/glm-5.2`; `xhigh` | Assess separately | `RECOMMEND-ONLY` | GLM 5.2 change requires provider/model evaluation. | unknown/not comparable | `server/chat-router.js:66-73,218-235` |
| Chat, Discount Thinking | DeepSeek direct Chat Completions | `deepseek-v4-pro`; `high` | Keep provider/model | `NO-CHANGE` | Discount-provider behavior is intentionally distinct. | unknown/not comparable | `server/chat-router.js:75-83,218-235` |
| Chat, Help | DeepSeek direct Chat Completions | `deepseek-v4-pro`; no explicit effort | Keep provider/model | `NO-CHANGE` | Help mode has a separate low-output intent. | unknown/not comparable | `server/chat-router.js:94-103,218-235` |
| Network task generation V2 | Current code default: OpenRouter Chat Completions; Fly overrides provider/model | `deepseek/deepseek-v4-pro`; no explicit effort | Set OpenAI `gpt-5.6-sol`, `xhigh`; update the worker selection and Fly provider/model/effort override | `REQUIRED` | The task-generation directive applies to both worker surfaces; Fly currently overrides the code fallback. | unknown/not comparable | `server/task-generation-worker.js:239-257,608-641`; `fly.toml:63-65` |
| Task review | OpenAI Chat Completions | `chat-latest`; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | This is a scoring/evaluation path. | unknown/not comparable | `server/task-review-worker.js:1147-1172` |
| Evidence vision | OpenAI image/vision request path | `chat-latest` fallback; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | Evaluation/vision semantics are ambiguous. | unknown/not comparable | `server/task-evidence-processing.js:39-44` |
| Chat/deep/network memory | OpenRouter Chat Completions | `deepseek/deepseek-v4-flash`; no explicit effort | Keep provider/model | `NO-CHANGE` | Memory worker is a separate low-cost summarization tier. | unknown/not comparable | `server/chat-memory-worker.js:23-56` |
| Jobs embeddings | OpenAI Embeddings (`/v1/embeddings`) | `text-embedding-3-small`; n/a | Evaluate separately | `RECOMMEND-ONLY` | Embedding changes alter dimensions/index compatibility. | unknown/not comparable | `server/embedding-provider.js:3-29` |
| Context rewrite: GLM/final/polish | OpenRouter Chat Completions | `z-ai/glm-5.2`; final `high`, polish `xhigh` | Evaluate separately | `RECOMMEND-ONLY` | GLM 5.2 plus multi-stage rewrite semantics. | unknown/not comparable | `server/context-rewrite-provider.js:127-138,615-633,648-692` |
| Context rewrite: DeepSeek | OpenRouter Chat Completions | `deepseek/deepseek-v4-pro`; score `none` | Evaluate separately | `RECOMMEND-ONLY` | Provider/model switch and scorer semantics. | unknown/not comparable | `server/context-rewrite-provider.js:127-138,461-479` |
| Context rewrite: research | OpenRouter Chat Completions plus web search | `openai/gpt-5.4-mini`; `none` | Evaluate separately | `RECOMMEND-ONLY` | Provider-routed research and tool behavior are ambiguous. | unknown/not comparable | `server/context-rewrite-provider.js:127-138,523-553` |
| Hive Immediate Response | DeepSeek direct Chat Completions | `deepseek-v4-pro`; configured effort | Keep provider/model | `NO-CHANGE` | Intentional DeepSeek direct route. | unknown/not comparable | `server/hive-immediate-response.js:28-31,288-312` |
| Hive Secretary | OpenRouter Chat Completions | `z-ai/glm-5.2`; `high` | Migrate the live context worker to the established GLM route; reject GPT-5.5-Pro variants before dispatch. | `REQUIRED` | Current Secretary reports use provider data-collection denial and structured JSON; stored historical provider/model values remain readable. | unknown/not comparable | `server/hive-secretary-worker.js:30-65,182-221`; `fly.toml:80-82` |
| Hive Project | OpenRouter Chat Completions | `z-ai/glm-5.2`; `high` | Migrate the live planning worker to the established GLM route; reject GPT-5.5-Pro variants before dispatch. | `REQUIRED` | Chained planning semantics remain intact with provider policy and structured JSON output. | unknown/not comparable | `server/hive-project-worker.js:26-52,168-208`; `fly.toml:83-85` |
| Board Manager decision | OpenRouter Chat Completions only | `z-ai/glm-5.2`; `high` | Keep OpenRouter GLM route; the legacy OpenAI/GPT-5.5-Pro branch was removed | `NO-CHANGE` | GLM 5.2 remains the load-bearing Board Manager route; unsupported providers fail closed. | unknown/not comparable | `server/board-manager-decision-provider.js:26-40,392-403` |
| Hive report writer | OpenRouter Chat Completions | `z-ai/glm-5.2`; `high`/`xhigh` by report type | Evaluate separately | `RECOMMEND-ONLY` | GLM 5.2 and report/evaluation semantics. | unknown/not comparable | `server/hive-report-provider.js:5-7,46-58` |
| Hive decision agent (executor removed) | Historical read model only | No runtime provider/model default | Retired; no executable path remains | `REMOVED` | Former provider, worker, launcher, and scheduler were removed; historical prompt and run/read-model data remain available for audit/display. | n/a | `prompts/hive/hive_decision_agent_v1.md`; `server/repositories/hive-decision-agent.js:10,479` |
| Hive task manager | OpenRouter Chat Completions | `z-ai/glm-5.2`; `high` | Evaluate separately | `RECOMMEND-ONLY` | GLM 5.2 and autonomous-worker semantics. | unknown/not comparable | `server/hive-task-manager-provider.js:24-41` |
| Hive board secretary | OpenRouter Chat Completions | `z-ai/glm-5.2`; provider default; effort is request-specific | Evaluate separately | `RECOMMEND-ONLY` | GLM 5.2 and board-action semantics. | unknown/not comparable | `server/hive-board-secretary-provider.js:20-37` |
| Daily airdrop scoring | OpenRouter Chat Completions | `deepseek/deepseek-v4-pro`; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | Economic scoring/evaluation path. | unknown/not comparable | `server/profile-daily-airdrop.js:15-17,383-386`; `server/profile-daily-airdrop-worker.js:308-318` |
| Public profile snapshot | OpenRouter Chat Completions | `deepseek/deepseek-v4-pro`; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | Profile scoring/summarization semantics. | unknown/not comparable | `server/profile-public-snapshot.js:11-13,189-191` |
| Recommended connection rerank | DeepSeek direct plus embedding ranker | `deepseek-v4-pro`; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | Ranking/evaluation and embedding coupling. | unknown/not comparable | `server/repositories/recommended-connections.js:407-411,815-842` |
| Task-accounting harvester | OpenRouter Chat Completions | `deepseek/deepseek-v4-pro`; no explicit effort | Evaluate separately | `RECOMMEND-ONLY` | Accounting/scoring path. | unknown/not comparable | `server/task-accounting-harvester-provider.js:32-37` |
| Expert badge evaluator | OpenRouter Chat Completions | `z-ai/glm-5.2`; `high` | Evaluate separately | `RECOMMEND-ONLY` | Evaluation path and GLM 5.2. | unknown/not comparable | `server/expert-badge.js:40-45` |
| Profile NFT generation | OpenAI Images | `gpt-image-2`; n/a | Evaluate separately | `RECOMMEND-ONLY` | Image model and minting product semantics. | unknown/not comparable | `prompts/profile/profile_nft_image_v1.md:3`; `server/profile-nft-prompts.js:96-110`; `server/profile-nft-generation.js:200`; `server/profile-nft-mint.js:34` |

## Obvious-candidate checkpoint

There are **zero additional approved/obvious swaps beyond directives 1–2**.  Hive Secretary and Hive Project remain `RECOMMEND-ONLY`; the documented successor mapping is `gpt-5.6-sol` through the Responses API with `reasoning.mode: "pro"` and explicit `reasoning.effort: "high"`, but it changes request shape and autonomous-worker cost behavior.  See [OpenAI GPT-5.6 reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning).

All other apparent changes are excluded because they are provider switches, GLM 5.2, embeddings, scoring/evaluation, image generation, aliases, or ambiguous behavior.

## Operator and worker defaults

| Surface | Provider / current model; effort | Proposal / status | Exact baseline references |
| --- | --- | --- | --- |
| Board Manager Codex executor | Codex CLI `gpt-5.5`; `xhigh` | Operator availability/semantics unknown — `RECOMMEND-ONLY` | `scripts/board-manager-codex-exec.mjs:60-61,230-231`; `package.json:137-143` |
| Grashnuk harvest Codex executor | Codex CLI `gpt-5.5`; `xhigh` | Operator availability/semantics unknown — `RECOMMEND-ONLY` | `scripts/grashnuk-harvest-codex-exec.mjs:11-20`; `package.json:252-256` |
| Grashnuk review Codex executor | Codex CLI `gpt-5.5`; `xhigh` | Operator availability/semantics unknown — `RECOMMEND-ONLY` | `scripts/grashnuk-review-codex-exec.mjs:11-26`; `package.json:252-256` |
| Board Manager loop/model executor/worker | OpenRouter `z-ai/glm-5.2`; `high` | Board Manager is opt-in and OpenRouter GLM-only; unsupported providers fail closed — `NO-CHANGE` | `scripts/board-manager-loop.mjs:35-36,47-54,136,144`; `scripts/board-manager-model-exec.mjs:68,122`; `scripts/board-manager-worker.mjs:50,65-72`; `package.json:79,137-143` |
| Deathmarch | DeepSeek direct `deepseek-v4-pro`; no explicit effort | Manual/operator workflow — `RECOMMEND-ONLY` | `scripts/deathmarch.mjs:20-21,871,993` |
| Daily airdrop and public-snapshot launchers | Inherit active DeepSeek defaults | Scoring paths remain `RECOMMEND-ONLY`; launcher has no separate model default | `scripts/profile-daily-airdrop-score.mjs:24`; `scripts/profile-daily-airdrop-worker.mjs:35`; `scripts/profile-public-snapshot.mjs:20`; `package.json:204-209` |

## Local, deploy, and test wiring

| Surface | Current wiring | Status / reason | Exact baseline references |
| --- | --- | --- | --- |
| Local API compose | `CHAT_MODEL_FRONTIER_INSTANT`, task-generation, and review default to `chat-latest` | `NO-CHANGE`.  **`docker-compose.dev.yml` zero-spend defaults at `57f3eac` are protected and must not change.** They deliberately neutralize provider credentials and disable autonomous workers. | `docker-compose.dev.yml:89-177` (model entries `:123-125`; opt-in Board Manager GLM `:175-177`) |
| Local Board Manager profile | Profile-only service uses OpenRouter `z-ai/glm-5.2`; `high` | `NO-CHANGE` here; it is opt-in/zero-spend protected and any model decision is `RECOMMEND-ONLY`. | `docker-compose.dev.yml:155-181` |
| Reward-test compose | Test API wiring sets `chat-latest` fallbacks | `FIXTURE-ONLY`; contains no recorded credential values. | `docker-compose.reward-test.yml:60-83` (model entries `:78-79`) |
| Fly task-generation V2 override | `TASKNODE_HIVE_TASK_GENERATION_PROVIDER` selects OpenRouter and `TASKNODE_HIVE_TASK_GENERATION_MODEL` selects `deepseek/deepseek-v4-pro`; no effort override | `REQUIRED`; change Fly's provider/model/effort override to OpenAI, `gpt-5.6-sol`, `xhigh` with the worker update. | `fly.toml:63-65` (override entries `:64-65`) |
| Fly non-task-generation model configuration | Harvester uses `deepseek/deepseek-v4-pro`; task manager/board secretary use GLM `high` | `RECOMMEND-ONLY`; these non-task-generation deploy settings are inventory-only. | `fly.toml:66-95` (models `:71,77,85`) |
| Provider price/status fallback | GLM, Qwen, DeepSeek, and `gpt-5.5-pro` display rates; OpenRouter live pricing label | `NO-CHANGE`; display fallback is not authoritative target pricing. | `server/system-status.js:34-40,815`; `server/model-pricing-status.js:6-15,135` |

## Focused smoke expectations

These are test/verification expectations, not defaults.  Each row lists every matching focused-smoke location at the baseline.

| Pinned identifier | Classification / status | Exact baseline references |
| --- | --- | --- |
| `chat-latest` | Focused smoke expectation — `FIXTURE-ONLY` | `scripts/chat-billing-postgres-smoke.mjs:93,174`; `scripts/chat-context-status-smoke.mjs:109`; `scripts/chat-spirit-prompt-smoke.mjs:179,203,366`; `scripts/docker-reward-env.mjs:72-73`; `scripts/ethereum-deposit-smoke.mjs:170`; `scripts/runtime-store-smoke.mjs:92-93,140,229,243,253,272,399,417,431,918,948`; `scripts/security-smoke.mjs:166`; `scripts/task-determinism-board-state-audit.mjs:16`; `scripts/task-projection-postgres-smoke.mjs:44` |
| `deepseek-v4-pro` | Focused smoke/operator expectation — `FIXTURE-ONLY` for smoke refs; operator path separately catalogued above | `scripts/agent-chat-origin-smoke.mjs:23,26`; `scripts/agent-hive-chat-smoke.mjs:27,30`; `scripts/board-manager-glm52-cost-smoke.mjs:55,82`; `scripts/board-manager-secretary-packet-smoke.mjs:17,310,423,436,453`; `scripts/chat-spirit-prompt-smoke.mjs:275,322`; `scripts/hive-context-smoke.mjs:411`; `scripts/runtime-store-smoke.mjs:108,112,635,655,667,672`; `scripts/system-status-smoke.mjs:67,72`; `scripts/telegram-bot-webhook-smoke.mjs:85,307` |
| `deepseek/deepseek-v4-flash` | Focused smoke expectation — `FIXTURE-ONLY` | `scripts/chat-memory-postgres-smoke.mjs:54,96`; `scripts/chat-memory-worker-request-smoke.mjs:15`; `scripts/chat-spirit-prompt-smoke.mjs:254`; `scripts/runtime-store-smoke.mjs:100`; `scripts/system-status-smoke.mjs:61` |
| `deepseek/deepseek-v4-pro` | Focused smoke/launcher expectation — `FIXTURE-ONLY` for smoke refs; launchers catalogued above | `scripts/hive-brain-smoke.mjs:96`; `scripts/taskgen-network-v2-smoke.mjs:81,95` |
| `gpt-5.5` | Focused smoke expectation — `FIXTURE-ONLY` | `scripts/board-manager-micro-summary-smoke.mjs:47`; `scripts/chat-spirit-prompt-smoke.mjs:180`; `scripts/runtime-store-smoke.mjs:96-97,144,453,463,474,480,484` |
| `gpt-5.5-pro` | Focused rejection expectation — `FIXTURE-ONLY` | `scripts/hive-project-planning-smoke.mjs:154-192` (Secretary/Project direct and env fail-closed regression) |
| `gpt-5.5-pro-2026-04-23` | Focused dated-model rejection expectation — `FIXTURE-ONLY` | `scripts/hive-project-planning-smoke.mjs:154-192` (Secretary/Project direct and env fail-closed regression) |
| `z-ai/glm-5.2` | Focused smoke expectation — `FIXTURE-ONLY` | `scripts/board-manager-glm52-cost-smoke.mjs:20,45,161`; `scripts/board-manager-v0-smoke.mjs:389,404,419,430,446,451,456,499,532`; `scripts/chat-spirit-prompt-smoke.mjs:255`; `scripts/expert-badge-evaluation-smoke.mjs:83,115`; `scripts/hive-board-secretary-smoke.mjs:67`; `scripts/hive-brain-smoke.mjs:121,300`; `scripts/hive-context-smoke.mjs:358,366`; `scripts/network-badge-verifier-jobs-smoke.mjs:245`; `scripts/runtime-store-smoke.mjs:104`; `scripts/system-status-smoke.mjs:63` |
| `gpt-image-2` / `openai/gpt-image-2` | Profile-NFT smoke/prompt expectation — `FIXTURE-ONLY` | `scripts/profile-nft-flow-smoke.mjs:36,56,78`; `scripts/profile-nft-prompt-smoke.mjs:15,27,36` |
| `gpt-4.1-mini` | User-observability fixture — `FIXTURE-ONLY` | `scripts/user-observability-smoke.mjs:226` |
| `mock-glm-board-secretary` | Mock fixture — `FIXTURE-ONLY` | `scripts/hive-board-secretary-smoke.mjs:84` |
| `glm_board_secretary_status_memo_v1` | Prompt-version fixture, not a model — `FIXTURE-ONLY` | `scripts/hive-board-secretary-smoke.mjs:11` |
| `directory-polish-local` | Migration/integrity fixture, not an LLM model — `FIXTURE-ONLY` | `server/db/migrations/061_projection_fixture_cleanup.sql:57`; `server/repositories/task-projection-integrity.js:21` |
| `deterministic-bag-of-words-v1` | Non-provider embedding fallback — `FIXTURE-ONLY` | `server/embedding-provider.js:7,26-29` |
| `deterministic-recommended-connections-v1` | Non-provider ranking fallback — `FIXTURE-ONLY` | `server/repositories/recommended-connections.js:825` |
| `mock-glm-high-thinking` / `mock-glm-xhigh-thinking` | Report mock outputs — `FIXTURE-ONLY` | `server/hive-report-provider.js:286` |
| Qwen input | Cost-smoke fixture; static display is catalogued below — `FIXTURE-ONLY` | `scripts/board-manager-glm52-cost-smoke.mjs:66,76` |

## UI, docs, prompt labels, and historical display strings

| Identifier / label | Classification / status | Exact baseline references |
| --- | --- | --- |
| `gpt-5.5-pro` | Historical/provider display label — `NO-CHANGE` | Retained only in historical data/pricing and rejection fixtures; current Hive status cards show GLM 5.2. |
| `z-ai/glm-5.2` | Hive UI historical/provider display — `NO-CHANGE` | `src/features/hive/HiveBrainView.jsx:254,278,1440` |
| `deepseek/deepseek-v4-pro` | Hive UI historical/provider display — `NO-CHANGE` | `src/features/hive/HiveBrainView.jsx:266` |
| `gpt-image-2` | Profile UI display copy — `NO-CHANGE` | `src/features/profile/ProfileView.jsx:1070` |
| `glm_board_secretary_status_memo_v1.md` | Prompt filename/docs display, not a model — `NO-CHANGE` | `server/hive-board-secretary-provider.js:6`; `src/features/docs/docs-content.js:89,306` |
| Generic GLM labels | UI/docs status copy, not a pinned provider request — `NO-CHANGE` | `src/features/hive/HiveView.jsx:638`; `src/main.jsx:2173,2383,2969`; `src/features/profile/ProfileView.jsx:90,2024,2026` |
| Claude reference | Prompt prose only; no concrete Claude model ID — `NO-CHANGE` | `prompts/chat/jobs_standard_chat_codex_style_draft.md:46-47` |
| GPT-5 reference | Non-production Codex reference prose only; no concrete active model default — `NO-CHANGE` | `prompts/non_production/codex_ref/chat_codex.md:1` |
| `gpt-image-2` placeholder | Non-production prompt metadata — `FIXTURE-ONLY` | `prompts/non_production/profile_nft_dev/profile_nft_image.placeholder.md:3` |
| Gemini / Claude concrete IDs | None found in the audited tracked paths | `NO-CHANGE` (absence result; search scope defined above) | `prompts/chat/jobs_standard_chat_codex_style_draft.md:46-47`; `prompts/non_production/codex_ref/chat_codex.md:1` |

## Exhaustive literal cross-reference notes

The runtime and smoke rows above account for every pinned identifier found by the required search.  The following non-default occurrences are retained here so that repeated references are not mistaken for unreviewed defaults:

| Identifier / occurrence | Disposition | Exact baseline references |
| --- | --- | --- |
| `deepseek-v4-pro` production default/display | Active routes are catalogued in the runtime matrix; price display is not a change target | `server/board-manager-secretary-packets.js:96`; `server/chat-router.js:81,100`; `server/hive-immediate-response.js:28`; `server/repositories/recommended-connections.js:833`; `server/system-status.js:37`; `server/model-pricing-status.js:135` |
| `deepseek/deepseek-v4-pro` production/default/deploy/display | The task-generation worker/Fly references are required OpenAI changes; all other source/display duplicates are not a second change proposal | `server/context-rewrite-provider.js:130`; `server/profile-daily-airdrop-worker.js:318`; `server/profile-daily-airdrop.js:17`; `server/profile-public-snapshot.js:13`; `server/system-status.js:38`; `server/task-accounting-harvester-provider.js:36`; `server/task-generation-worker.js:253`; `fly.toml:65,71` |
| `z-ai/glm-5.2` production/default/deploy/display | Active GLM routes remain catalogued; Secretary/Project have explicit Fly pins, while unrelated GLM routes remain `RECOMMEND-ONLY`; the former Decision Agent provider was removed and only historical prompt/read-model references remain | `server/board-manager-decision-provider.js:38,41,43`; `server/chat-router.js:70`; `server/context-rewrite-provider.js:129,131,136`; `server/expert-badge.js:41`; `server/hive-board-secretary-provider.js:25`; `server/hive-report-provider.js:6`; `server/hive-task-manager-provider.js:29`; `server/system-status.js:35,815`; `docker-compose.dev.yml:176`; `fly.toml`; `prompts/hive/hive_decision_agent_v1.md`; `server/repositories/hive-decision-agent.js:10,479` |
| `gpt-5.5` active default | Required Frontier Thinking row only; smoke/operator duplicates are catalogued elsewhere | `server/chat-router.js:108` |
| `gpt-5.5-pro` active default/display | Board Manager fallback and Secretary/Project executable defaults removed; system-status pricing and stored historical values remain unchanged. | `server/system-status.js:39`; `scripts/hive-project-planning-smoke.mjs:154-192` |
| `chat-latest` active/default wiring | Required task-generation row; other runtime consumers remain recommendation-only | `server/chat-router.js:89`; `server/task-evidence-processing.js:44`; `server/task-generation-worker.js:257`; `server/task-review-worker.js:1151`; `docker-compose.dev.yml:123-125`; `docker-compose.reward-test.yml:78-79` |
| `gpt-image-2` active prompt/runtime/display | Image model remains `RECOMMEND-ONLY` | `prompts/profile/profile_nft_image_v1.md:3`; `server/profile-nft-generation.js:200`; `server/profile-nft-mint.js:34`; `server/profile-nft-prompts.js:98,109`; `src/features/profile/ProfileView.jsx:1070` |
| `openai/gpt-5.4-mini` | Context-rewrite research stage remains `RECOMMEND-ONLY` | `server/context-rewrite-provider.js:137` |
| `text-embedding-3-small` | Embedding compatibility remains `RECOMMEND-ONLY` | `server/embedding-provider.js:3,13-19` |
| Qwen static rate | Status UI fallback, not an invocation default — `NO-CHANGE` | `server/system-status.js:36` |

No provider-default helper, `*_MODEL` fallback, or reasoning-effort default outside the rows above introduces an additional pinned model identifier.  Environment overrides are intentionally documented as names/precedence only; values are neither read nor recorded.
