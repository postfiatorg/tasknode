# Ambient Inference Cutover Plan

Status: complete; production cutover finalized as Fly release 588; retired provider secrets removed and the egress guard reverified 2026-08-13
Owner: Task Node engineering
Last verified: 2026-08-13

This is a completion record. Sections labelled **historical pre-cutover** preserve the inventory and reasoning used to perform the migration; they do not describe current egress. The current contract is [AI Providers](#docs/ai-providers).

## Implementation Record

Implemented on 2026-08-12:

- shared Ambient adapter, capability registry, structured output, SSE, vision,
  Ambient `/v1/tools` web-search execution/continuation, catalog cache/LKG
  behavior, timeouts, and
  Ambient-only fast-text capacity fallback;
- Ambient routing for chat, Context Refine/Rewrite, task generation/review,
  evidence vision, memory/profile work, Hive/Board Manager work, daily airdrop,
  accounting, and operator inference scripts;
- local TXT/PDF/DOCX/archive extraction with bounded PDF-page and DOCX-image
  preservation for Kimi verification;
- deterministic local embeddings and forward provider-default migration 105;
- two-pass GLM 5.2 NFT privacy gateway, sanitized durable render queue,
  dedicated renderer process/credential, exact OpenAI payload allowlist, and
  post-render Kimi privacy review before IPFS publication;
- retired-provider zero-egress gate, Fly/Docker Ambient configuration, and
  migrations 105-106.

Production completion on 2026-08-12:

- releases 584-586 deployed the cutover, readiness correction, and the
  model-aware Jobs corpus backfill fix; the retired-secret hard cut produced
  release 587 and the readiness compatibility cleanup produced release 588;
- migrations 105-106 are recorded in production and the durable NFT render
  queue is present;
- the Jobs corpus was backfilled with 259
  `deterministic-bag-of-words-v1` chunks while retaining 259 historical OpenAI
  vectors for compatibility;
- a live completion from the deployed web machine succeeded through Ambient
  `deepseek/deepseek-v4-flash-0731`;
- the web process inherited Ambient but not the NFT OpenAI credential, while
  the dedicated renderer inherited the NFT credential;
- post-deploy worker and interactive traffic showed no retired-provider hosts
  or non-renderer OpenAI egress;
- OpenRouter, direct DeepSeek, general OpenAI, Vercel AI Gateway, legacy
  provider-order, and obsolete raw NFT prompt Fly secrets were deleted. Only
  `AMBIENT_API_KEY` and the isolated `PROFILE_NFT_OPENAI_API_KEY` remain from
  the inference-provider credential set.
- the chat picker was collapsed to the canonical `Instant`, `Thinking`, and
  `Help` modes. Instant is pinned to DeepSeek Flash 7/31, Thinking to GLM 5.2,
  and historical Private/Discount/Frontier labels normalize only for backward
  compatibility.

Release evidence: mocked contract tests, focused lifecycle/provider suites,
lint, migration registration, and production build pass. Live Ambient checks
pass for GLM structured output, dated DeepSeek streaming, Kimi image input, and
the complete web-search tool continuation. Ambient's tool executor has also
shown intermittent upstream DNS failures; the adapter retries the read-only
tool call and then returns an explicit provider error rather than an empty
response.
The repository-wide file-size check remains blocked by pre-existing oversized
tracked and untracked files unrelated to this cutover; this is recorded as a
release exception rather than weakening the provider or privacy gates.

## Goal

Move Task Node's text, reasoning, structured-output, and vision-understanding
boundaries to Ambient and retire every active OpenRouter, direct DeepSeek, and
OpenAI Frontier inference path. Retain one explicit OpenAI exception: blind
Profile NFT image rendering from a heavily redacted art brief produced and
privacy-reviewed by Ambient GLM 5.2.

This is a provider-boundary migration, not a model-name search-and-replace. The
finished system must have one Ambient client, one request/response contract, and
Ambient-only model failover. Historical provider labels may remain in stored
records. No production request may leave for OpenRouter or direct DeepSeek, and
no request may leave for OpenAI except the isolated Profile NFT renderer calling
`/v1/images/generations` with an approved redacted prompt.

## Definition Of Done

The cutover is complete only when all of these are true:

- All runtime text, reasoning, structured-output, streaming, and vision calls go
  through a shared Ambient adapter.
- Task verification detects visual evidence and sends the original image, or a
  rendered page from a scanned document, to an Ambient model that explicitly
  supports image input. A text-only model may never stand in for visual review.
- OpenRouter routing preferences, ZDR flags, file-parser plugins, attribution
  headers, pricing catalog fetches, and provider allowlists are gone from active
  code.
- Direct DeepSeek and general-purpose OpenAI base URLs and API keys are not
  required by any app, worker, operator script, or deployment test. The isolated
  NFT renderer uses its own `PROFILE_NFT_OPENAI_API_KEY` and cannot accept raw
  user packets.
- Stored historical values such as `openrouter`, `deepseek`, and `frontier`
  remain readable, while new inference records use `ambient` plus the actual
  Ambient model ID.
- PDFs, DOCX files, text files, archives, and images follow explicit local
  preprocessing rules before Ambient inference.
- Retrieval does not use OpenAI embeddings.
- Profile NFT generation sends private Task Node source data through Ambient GLM
  5.2 abstraction and privacy-review passes. OpenAI receives only the validated
  high-level art prompt and image settings.
- CI has a zero-egress regression check for retired provider hosts, secrets, and
  every non-allowlisted OpenAI call site.
- Production telemetry shows no requests to retired provider hosts and no
  OpenAI requests outside the NFT renderer for at least one full worker cycle
  and one normal interactive usage window before old secrets are destroyed.

## What “Ambient” Means Here

Use the OpenAI-compatible API at `https://api.ambient.xyz/v1` with the canonical
configuration:

- `AMBIENT_API_KEY`
- `AMBIENT_BASE_URL`, default `https://api.ambient.xyz/v1`

The provider catalog is available from `GET /v1/models`. The machine-readable
contract is [Ambient OpenAPI](https://api.ambient.xyz/openapi.json), and the
product documentation is [Ambient API](https://docs.ambient.xyz/API-27ee653486a3808f8393faae8960d0aa?pvs=21).

Do not make `AMBIENT_API_KEY` an alias that is read through an old
`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENAI_API_KEY` code path. A short
deployment compatibility window may read old variables centrally, but feature
modules must depend only on the new adapter and the compatibility reads must be
removed at the hard cut. The NFT renderer's dedicated
`PROFILE_NFT_OPENAI_API_KEY` is a separate, narrow output-provider credential;
it must not be exposed through the general inference adapter.

## Verified Ambient Capability Snapshot

The following snapshot was checked against the live Ambient model catalog and
small live requests on 2026-08-12. Availability is operational state, so the
adapter must not assume it is permanent.

| Ambient model | Input | Output | Observed state | Planned role |
| --- | --- | --- | --- | --- |
| `z-ai/glm-5.2` | Text | Text | Ready; plain completion and reasoning-off request succeeded | High-stakes reasoning and structured workers |
| `ambient/large` | Text | Text | Alias for GLM 5.2 | Optional stable alias after model-ID/usage behavior is tested |
| `deepseek/deepseek-v4-flash` | Text | Text | Catalog ready, but live requests returned no-worker `429` | Do not use as the initial production default |
| `deepseek/deepseek-v4-flash-0731` | Text | Text | Live completion succeeded | Fast and low-cost text route |
| `moonshotai/kimi-k2.7-code` | Text, image, video | Text | Live image-understanding request succeeded | Screenshot and image attachment understanding |

The catalog advertises reasoning controls, tools, JSON/structured output, and
large context windows for relevant models. These capabilities still need Task
Node-shaped live contract tests before each workload moves.

Current API gaps that change the migration design:

- Ambient exposes no `/v1/embeddings` endpoint.
- Ambient exposes no `/v1/images/generations` endpoint and no catalog model with
  image output.
- Generic PDF/DOCX/archive input is not a supported inference part. Documents
  must be decoded and extracted on Task Node before sending bounded text.
- Web search appears in the API tool contract, but Task Node's exact request,
  citation, streaming, and timeout behavior must be proven before Context
  Rewrite research or Frontier-style chat moves.

## Historical Pre-Cutover Provider Egress Inventory

This inventory captured real outbound provider boundaries before the cutover. It is retained so reviewers can reconstruct what moved. None of these rows is an approved current route. Line numbers have drifted and several old helper names remain as compatibility symbols.

### Historical OpenRouter Runtime Calls

| Consumer | Outbound boundary | Current default | Important behavior to port |
| --- | --- | --- | --- |
| Chat Private Instant and Private Thinking | `server/chat-router.js`: `executeOpenRouter`, `streamOpenRouter` | `deepseek/deepseek-v4-flash`; `z-ai/glm-5.2` | Non-streaming and SSE, reasoning controls, usage, image/text/file parts, ZDR/provider routing |
| Turn memory, deep memory, and network task profile | `server/chat-memory-worker.js`: three `/chat/completions` calls | `deepseek/deepseek-v4-flash` | Three separate prompts, deterministic persistence, provider ordering |
| Board Manager decision | `server/board-manager-decision-provider.js`: `fetchOpenRouterBoardManagerDecision` | `z-ai/glm-5.2` | Strict schema, high reasoning, usage/cost, fail-closed action selection |
| Context Rewrite score, research, final, and polish | `server/context-rewrite-provider.js`: shared `fetchOpenRouter`, four logical stages | DeepSeek V4 Pro, OpenAI-routed mini research model, GLM 5.2 | Long timeouts, structured scoring, web research/citations, resumable stages |
| Expert badge evaluator | `server/expert-badge.js` | `z-ai/glm-5.2` | High-reasoning structured evaluation |
| Hive Board Secretary memo | `server/hive-board-secretary-provider.js` | `z-ai/glm-5.2` | Markdown memo, worker availability/preflight |
| Hive project planner | `server/hive-project-worker.js` | `z-ai/glm-5.2` | High-reasoning structured projects, provider normalization |
| Hive report generation and review | `server/hive-report-provider.js` | `z-ai/glm-5.2` | Multiple report operations, high/xhigh reasoning, structured output |
| Hive Secretary | `server/hive-secretary-worker.js` | `z-ai/glm-5.2` | High-reasoning structured report |
| Hive Task Manager | `server/hive-task-manager-provider.js` | `z-ai/glm-5.2` | Strict task selection/action schema |
| Daily airdrop scoring | `server/profile-daily-airdrop.js` | `deepseek/deepseek-v4-pro` | Economic decision, strict JSON, audit metadata |
| Public profile snapshot | `server/profile-public-snapshot.js` | `deepseek/deepseek-v4-pro` | Structured profile summary |
| Task accounting harvester | `server/task-accounting-harvester-provider.js` | `deepseek/deepseek-v4-pro` | Retried structured extraction, accounting actions |
| Board Manager narrator | `server/bm-narrator-worker.js` | `deepseek/deepseek-v4-flash-0731` | Hard-coded OpenRouter URL, short narrative, deterministic fallback |
| Personal/network task generation override | `server/task-generation-worker.js`: OpenRouter branch in `taskgenApiConfig` | Configurable; production currently selects OpenAI | Strict task schema, replay safety, high reasoning |
| Model catalog and pricing status | `server/model-pricing-status.js`: `/models` and model endpoint discovery | OpenRouter catalog | Not inference, but still OpenRouter egress and provider-specific policy UI |

### Historical Direct DeepSeek Runtime Calls

| Consumer | Outbound boundary | Current default | Important behavior to port |
| --- | --- | --- | --- |
| Chat Discount Thinking and Help | `server/chat-router.js`: `executeDeepSeek`, `streamDeepSeek` | `deepseek-v4-pro` | 120-second budget, stream-to-nonstream recovery, text-only attachments |
| Board Manager Secretary packet | `server/board-manager-secretary-packets.js` | `deepseek-v4-pro` | High reasoning, compact/repaired structured packet, digest reuse |
| Hive immediate response | `server/hive-immediate-response.js` | `deepseek-v4-pro` | Synchronous user-facing reply with Hive/context attachments |
| Recommended connections rerank | `server/repositories/recommended-connections.js` | `deepseek-v4-pro` | Reranks pgvector candidates and handles private/discoverable policy |

### Historical OpenAI And Frontier Runtime Calls

| Consumer | Outbound boundary | Current default | Important behavior to port |
| --- | --- | --- | --- |
| Chat Frontier Instant and Frontier Thinking | `server/chat-router.js`: `executeOpenAi`, `streamOpenAi` | `chat-latest`; `gpt-5.6-sol` | Responses API, SSE, web search, reasoning, response gate, arbitrary file parts |
| Context Refine chat | `server/context-edit-chat.js` through `chat-router.js::executeOpenAi` | Frontier route configuration | Strict context-edit response contract |
| Personal and network task generation | `server/task-generation-worker.js`: default `taskgenApiConfig` branch | `gpt-5.6-sol` in production | Chat Completions, strict task schema, xhigh reasoning, replay/publish safety |
| Verification request and reward scoring | `server/task-review-worker.js`: `callOpenAiJson`, two logical calls | `TASKNODE_TASK_REVIEW_MODEL`, taskgen model, then `chat-latest` | Two economic/lifecycle decisions, strict JSON, audit digests |
| Screenshot evidence reading | `server/task-evidence-processing.js`: `describeScreenshotWithOpenAi` | Frontier Instant/OpenAI fallback | Vision through Responses, task criteria grounding |
| Jobs/profile retrieval embeddings | `server/embedding-provider.js`: `openAiEmbeddings` | `text-embedding-3-small`, 1536 dimensions | Vector compatibility and pgvector indexes; deterministic fallback exists |
| Profile NFT image generation | `server/profile-nft-generation.js`: `openAiImageGeneration` | `gpt-image-2` | Image output, retry classification, IPFS pinning, daily worker |

### Operator And Live-Audit Calls

These are outside the web runtime but must move before old credentials can be
deleted:

- `scripts/deathmarch.mjs` calls direct DeepSeek for local planning/review.
- `scripts/task-determinism-board-state-audit.mjs` calls OpenAI Chat
  Completions.
- `scripts/context-rewrite-live-smoke.mjs` requires OpenRouter and normally uses
  OpenAI embeddings.
- `scripts/board-manager-model-exec.mjs`, `scripts/board-manager-loop.mjs`, and
  `scripts/board-manager-worker.mjs` expose OpenRouter-only provider selection
  and reach the Board Manager provider module.
- `scripts/jobs-corpus-ingest.mjs` defaults to OpenAI embeddings.
- `scripts/docker-reward-env.mjs` copies and requires `OPENAI_API_KEY` for the
  reward test stack.

### Secondary Provider Coupling

Removing HTTP calls is not enough. The following layers encode the old provider
architecture and must be migrated deliberately:

- Request shaping: `server/chat-provider-message-builders.js`,
  `server/chat-search-tools.js`, and the OpenAI/OpenRouter/DeepSeek branches in
  `server/chat-router.js`.
- Availability and product contracts: `server/chat-mode-defaults.js`,
  `server/product-contracts.js`, system status, Telegram provider-specific
  handling, and worker `isConfigured` checks.
- Deployment: `fly.toml`, `docker-compose.dev.yml`,
  `docker-compose.reward-test.yml`, local env templates, Fly secrets, and
  process-specific environment copying.
- Persisted labels/defaults: `server/context-rewrite-worker.js`, repository
  defaults in `server/repositories/context-rewrite.js`,
  `server/repositories/hive-task-manager.js`, and
  `server/repositories/hive-decision-agent.js`; old migration defaults include
  `043_board_manager_secretary_packets.sql` (`deepseek`) and
  `080_hive_decision_runs.sql` (`openrouter`). Do not edit old migrations or
  rewrite historical rows. Add a new migration for any live table default.
- Cost and privacy copy: `server/model-pricing-status.js`, provider labels in API
  responses, chat mode pricing, `/api/system/status`, and AI Provider docs.
- Tests and mocks: numerous smoke scripts assert provider names, old request
  shapes, old keys, or OpenRouter routing fields. They need behavioral Ambient
  assertions, not bulk string substitution.

## Target Architecture

All feature modules should call one semantic inference boundary:

```text
chat / task engine / Hive / profile / context / operator scripts
                              |
                    server/ambient-inference.js
             +----------------+----------------+
             |                |                |
          text/chat       structured JSON    image understanding
             |                |                |
    DeepSeek 0731/GLM 5.2    GLM 5.2       Kimi K2.7 Code
             +----------------+----------------+
                              |
                  https://api.ambient.xyz/v1
```

Feature modules describe required capabilities; they do not construct provider
URLs or choose a provider. The adapter owns:

- authentication and base URL;
- model selection from a small policy registry;
- Chat Completions/Responses request normalization;
- reasoning translation, including `none` and excluded reasoning;
- structured output and schema validation;
- multimodal image parts;
- non-streaming and SSE parsing;
- normalized output text, annotations, usage, cost, model, request ID, latency,
  finish reason, and provider metadata;
- timeout, abort, retry, rate-limit, and no-worker handling;
- Ambient-only failover by capability and workload risk;
- redacted, bounded error messages and observability;
- test injection for fetch and deterministic fixtures.

Profile NFT output generation is the single separate branch:

```text
private actions + memory + profile
                  |
       deterministic minimization
                  |
   Ambient GLM 5.2 abstraction pass
                  |
 Ambient GLM 5.2 privacy-review/repair pass
                  |
 deterministic schema + leakage validator
                  |
      sanitized render-job queue
                  |
 isolated OpenAI image renderer (no private source access)
                  |
 Ambient vision privacy check of generated image
                  |
             IPFS publish
```

OpenAI must be a blind renderer in this branch. It must never receive task
titles, descriptions, evidence, memory text, profile prose, identifiers, or the
GLM privacy audit. The renderer receives only allowlisted visual fields rendered
into a high-level prompt.

Create a policy registry instead of scattering model defaults across workers.
Suggested capability names are:

- `fast_text`
- `reasoning_text`
- `strict_json`
- `research_text`
- `vision_text`
- `verification_vision`

Each call also supplies a workload name for metrics and any narrower limits such
as timeout, output tokens, reasoning effort, schema, and privacy classification.

## Initial Workload Mapping

This is the first migration hypothesis, not permission to silently change
quality. Each row needs fixture comparison and a live contract test.

| Workload class | Initial Ambient model | Ambient-only fallback | Rationale |
| --- | --- | --- | --- |
| Fast chat, Help, memory, narrator, profile prose | `deepseek/deepseek-v4-flash-0731` | `z-ai/glm-5.2` | The dated route passed a live call; the undated route did not have workers |
| Private/Frontier Thinking, Context Refine | `z-ai/glm-5.2` | `moonshotai/kimi-k2.7-code` after text-quality proof | High reasoning and long context |
| Task generation/review, Board Manager, accounting, badges, airdrop | `z-ai/glm-5.2` | Fail closed, then an explicitly approved Ambient structured model | These outputs mutate lifecycle/economic state; do not silently degrade |
| Hive planning, reports, Context Rewrite score/final/polish | `z-ai/glm-5.2` | An explicitly tested Ambient structured model | Structured, long-context workloads |
| Screenshot and image-based task verification | `moonshotai/kimi-k2.7-code` | Another live-tested Ambient image-input model only; otherwise queue for retry | Verification requires the pixels, and live image understanding succeeded |
| Image chat attachments | `moonshotai/kimi-k2.7-code` | Another live-tested Ambient image-input model only; otherwise return a retriable capability error | A text-only fallback would silently discard user input |
| Context Rewrite research and Frontier web search | `z-ai/glm-5.2` with Ambient web-search tool | No fallback until citation behavior is proven | Tool contract still needs live Task Node validation |

Never fail back to OpenRouter, OpenAI, or direct DeepSeek after a workload is
cut over. For low-risk background prose, a deterministic local result may be a
valid fallback. For economic or task-state decisions, failure must remain
visible and retryable rather than producing unvalidated actions.

## Task Verification Vision Policy

Image-capable inference is a required part of task verification, not an optional
chat feature. The verification pipeline must separate evidence perception from
the final lifecycle/economic decision:

1. The ingestion boundary identifies evidence modalities from file signatures,
   validated MIME types, and the task's verification contract.
2. Every screenshot or image is sent with the task title, task requirements,
   verification criteria, filename, and digest to the `verification_vision`
   capability. The initial model is `moonshotai/kimi-k2.7-code` because its live
   image-input path was verified.
3. The vision model returns a strict evidence-observation packet: visible text,
   relevant UI/state, criteria-supported facts, criteria-conflicting facts,
   unreadable regions, uncertainty, and the source-image digest. It does not
   issue rewards or mutate task state.
4. The final verification/reward model receives the original task packet,
   extracted document text, the structured vision observations, and provenance.
   It remains responsible for the accept/follow-up/reject and reward decision.
5. Mixed evidence preserves every modality. Text extraction must never replace
   attached images, and a successful image read must never cause document text
   or URLs to be discarded.

PDF handling must distinguish text PDFs from scanned or visually significant
PDFs. Extract searchable text locally, render bounded pages when the document is
scanned or visual layout matters, and send those page images through
`verification_vision`. DOCX ingestion should likewise preserve relevant embedded
images instead of returning only paragraph text.

The adapter may fail over only to another Ambient model whose live catalog and
Task Node contract test prove image input. If no approved image model is
available, mark verification as retryable with a specific capability error and
leave the task pending. Never send only the filename/OCR placeholder to a text
model, never infer that an unread image failed the task, and never convert model
unavailability into a zero score.

Before enabling production verification, maintain a vision fixture set covering
screenshots, photographs, dense UI, small text, multiple images, contradictory
text/image evidence, scanned PDFs, embedded DOCX images, corrupt files, and
irrelevant images. The acceptance gate must measure fact extraction and final
verification outcomes separately so a scoring-model improvement cannot hide a
vision regression.

## Chat Mode Product Migration

The existing mode names encode provider history. Preserve old values as input
aliases so saved conversations and clients do not break, but route them to
capability policies during transition:

| Existing mode | Transitional capability | Eventual product label |
| --- | --- | --- |
| Private Instant | `fast_text`, switch to an approved image-input capability for image input | Ambient Instant |
| Private Thinking | `reasoning_text` | Ambient Thinking |
| Discount Thinking | `reasoning_text` with a lower output/reasoning budget | Either merge into Ambient Thinking or rename by capability/cost |
| Frontier Instant | `fast_text` plus proven research tools when requested | Ambient Instant or Ambient Research |
| Frontier Thinking | `reasoning_text` | Ambient Thinking |
| Help | `fast_text` with Help prompt | Help |

Do not change stored mode strings and provider routing in one release. First
make old names aliases to Ambient behavior, observe them, then change UI labels
and default selection. Remove obsolete aliases only after every supported client
has migrated.

## Document And Attachment Boundary

OpenRouter's file-parser and OpenAI's generic `input_file` currently hide a
product boundary. Ambient does not replace that behavior.

Build or extract one shared, server-side evidence/document ingestion library
used by task submissions and chat:

1. Decode the uploaded data URL or multipart body with strict size limits.
2. Detect the actual type using both MIME and content signatures.
3. Extract bounded text from TXT/Markdown/JSON/CSV, PDF, and DOCX.
4. Inspect supported archives recursively with entry-count, depth, expanded-size,
   path traversal, and decompression-bomb limits.
5. Preserve filename, MIME, byte size, digest, extractor version, warnings, and
   truncation metadata.
6. Send only extracted text and metadata to text models.
7. Send images as image parts only to a catalog-confirmed vision model.
8. Render bounded pages from scanned or visually significant PDFs for vision
   verification, and retain relevant embedded DOCX images.
9. Reject encrypted, corrupt, unsupported, or empty documents with a useful
   user-facing reason; do not convert them into blank model input.

Regression fixtures must include good and malformed PDF/DOCX documents, scanned
PDF behavior, text files, multi-file archives, oversized/deep archives, binary
files, and an image. The observed “DOCX parsed badly / PDF scored zero” example
is evidence for this general ingestion boundary, not a file-specific exception.

## Embeddings Decision

Ambient currently cannot replace OpenAI `/embeddings`. Choose and complete one
of these before removing the general `OPENAI_API_KEY` dependency from non-NFT
paths:

1. Preferred: use a pinned local embedding model/service with a versioned model
   ID and dimensions, then rebuild each pgvector corpus into a new versioned
   column/index before switching reads.
2. Interim: promote the existing `deterministic-bag-of-words-v1` provider from
   test fallback only after measuring retrieval quality on Jobs and recommended
   connections fixtures.
3. If semantic retrieval cannot meet its acceptance threshold locally, disable
   the affected retrieval/rerank features visibly until an Ambient embedding
   endpoint exists. Do not retain a hidden OpenAI exception.

Never mix vectors from different models in the same index. The migration needs
model/dimension metadata, a backfill job, comparison metrics, atomic read
cutover, and a reversible index/version switch.

## Profile NFT Privacy Gateway Decision

Decision: keep OpenAI image generation for Profile NFTs, but make it an isolated
blind renderer behind an Ambient GLM 5.2 privacy gateway. OpenAI is not an
approved source-data inference provider and may see only a validated, high-level
art brief.

### Source Packet

The trusted preparation worker may use bounded Task Node-owned information to
make the NFT personally meaningful:

- broad recent activity categories and coarse achievement bands;
- existing memory summaries, with direct quotations removed before modeling;
- existing profile archetype, role themes, skills, preferences, and visual
  palette hints;
- coarse task mix and progress patterns rather than individual task records.

The preparation worker should minimize deterministically before GLM sees the
packet. Do not include payload fields that have no visual purpose. Treat every
user-controlled string as untrusted data, not as model instructions.

### Information That Must Not Reach OpenAI

The redaction boundary must remove or generalize:

- exact task titles, descriptions, steps, evidence, comments, verification
  criteria, and unreleased plans;
- raw memory text, quotations, private strategy, research conclusions, alpha,
  counterparties, and specific opportunities;
- names, handles, account IDs, wallet addresses, transaction hashes, repository
  names, organization names, URLs, email addresses, and external IDs;
- balances, reward amounts, prices, positions, exact counts, exact dates/times,
  deadlines, and uniquely identifying activity sequences;
- secrets, credentials, tokens, private keys, code fragments, filenames, and
  document contents;
- rare combinations of otherwise harmless facts that could reconstruct a
  person, project, or current action.

Allowed output is intentionally abstract: role archetypes, broad domains such as
“software building” or “community coordination,” coarse achievement tiers,
generic visual metaphors, mood, palette, composition, and non-identifying style.

### GLM 5.2 Redaction Process

Use two separate structured GLM 5.2 calls through the Ambient adapter:

1. **Abstraction pass:** transform the minimized private packet into a strict NFT
   art-brief schema. No input string may be copied into an output free-text slot.
2. **Privacy-review pass:** compare the candidate brief with the private packet,
   classify semantic leakage and re-identification risk, and return either an
   approved brief or a repaired brief. High or unresolved risk fails closed.

The output schema should be small and mostly enumerated:

- `archetype`
- `activity_themes`, maximum three values from an allowlist
- `achievement_band`, using coarse non-numeric tiers
- `visual_metaphors`, maximum three generic symbols from an allowlist
- `mood`
- `palette`
- `composition`
- `style_tags`, bounded allowlist
- `negative_constraints`, always including no text, logos, usernames, wallet
  strings, QR codes, documents, source code, or recognizable brands
- internal-only `privacy_risk`, `privacy_findings`, source digest, prompt version,
  and GLM model/request metadata

The OpenAI prompt renderer must consume only the approved visual fields. It must
not accept arbitrary suffixes, user notes, raw profile fields, raw memory, or
free-form task data. Internal privacy findings and source metadata are never
included in the OpenAI payload.

After GLM approval, apply deterministic mechanical checks for addresses, URLs,
handles, hashes, secrets, long identifiers, exact monetary/numeric detail, and
verbatim overlap with the private source packet. These checks are defense in
depth; GLM's structured semantic review is the primary privacy classifier. Any
failure returns the brief to GLM for one bounded repair attempt, then fails the
job without calling OpenAI.

### Process And Credential Isolation

Split generation into two durable jobs:

1. A trusted preparation job reads the user's bounded source packet, calls GLM
   5.2, validates the result, and writes only the sanitized render brief plus an
   opaque job ID.
2. A renderer job reads only sanitized render jobs and calls OpenAI Images. It
   should run as a dedicated process with a database role limited to the render
   queue/profile-image result tables and a dedicated
   `PROFILE_NFT_OPENAI_API_KEY`. It must not receive `AMBIENT_API_KEY`, general
   `OPENAI_API_KEY`, or code paths that load private task/memory/context packets.

Create an explicit module such as `server/profile-nft-image-provider.js` as the
only allowlisted OpenAI network boundary. Remove OpenAI transport from
`server/profile-nft-generation.js`; that orchestration module may enqueue work
but may not build an OpenAI request from user data.

The current raw assembly through `buildProfileNftUserData`,
`profileNftGenerationContextDocument`, and
`prompts/profile/profile_nft_image_v1.md` must not feed the renderer. Replace it
with versioned GLM abstraction/privacy-review prompts and a renderer prompt that
accepts only the approved art-brief schema.

The OpenAI request contains only:

- the rendered redacted art prompt;
- model, size, quality, and output-format settings;
- no user/account identifier, source digest, filename, metadata, or private
  source packet.

Before IPFS publication, pass the generated image through an approved Ambient
vision model to detect legible text, logos, QR codes, identifiers, documents, or
other prohibited details. Failure rejects or regenerates from the same sanitized
brief; it never enriches the OpenAI prompt with private source data.

### Failure, Audit, And Retention Rules

- If either GLM pass, semantic approval, deterministic validation, render-job
  isolation, OpenAI generation, or post-generation privacy review fails, do not
  publish an image.
- Never fall back to the current raw prompt path.
- Key idempotency to a digest of the minimized source version, redaction prompt
  versions, schema version, and rendering settings.
- Persist the approved redacted brief and audit metadata so an operator can
  inspect exactly what was sent to OpenAI. Keep the private source packet in its
  existing Task Node stores rather than duplicating it into render jobs or logs.
- Log only job ID, models, prompt/schema versions, digests, risk status, latency,
  usage, and bounded errors. Do not log private inputs.
- Existing NFT CIDs and images remain readable throughout the migration.

Required fixtures include private project names, wallet strings, transaction
hashes, URLs, code, exact financial actions, rare activity combinations, prompt
injection inside memory/profile fields, harmless high-level profiles, and
redaction-provider outages. Tests must assert on the exact serialized OpenAI
request body, not only the GLM result.

## Implementation Sequence

### Phase 0 — Freeze And Baseline

- [ ] Announce a temporary freeze on new provider-specific feature code.
- [ ] Capture latency, error rate, token usage, schema failures, and cost by
  current workload and model.
- [ ] Build representative sanitized fixtures for chat, task generation/review,
  Context Rewrite, Hive, profiles, evidence, and retrieval.
- [ ] Add an inventory test that enumerates provider hosts and direct fetch
  boundaries so new ones cannot appear during the migration.
- [ ] Decide the embedding path and freeze the Profile NFT art-brief allowlists,
  privacy thresholds, and process-isolation contract.

### Phase 1 — Shared Ambient Adapter

- [ ] Implement the shared Ambient client and capability/model registry.
- [ ] Normalize non-streaming output, streaming events, usage, errors, reasoning,
  structured output, images, annotations, and request IDs.
- [ ] Add catalog caching with a short TTL and a last-known-good view. A catalog
  outage must not automatically disable every configured model.
- [ ] Add per-workload timeouts and Ambient-only capacity fallback.
- [ ] Add request redaction and workload/model metrics without logging private
  prompt content.
- [ ] Prove live contracts for GLM 5.2 plain/structured/reasoning, DeepSeek 0731,
  Kimi vision, SSE, and Ambient web search/citations.

### Phase 2 — Low-Risk Async Workloads

- [ ] Move memory summaries and network task profiles.
- [ ] Move Board Manager narrator and public profile snapshot.
- [ ] Move non-mutating Hive memos/reports one operation at a time.
- [ ] Compare fixture outputs and operational telemetry before removing each old
  route.

### Phase 3 — Structured And Stateful Workers

- [ ] Move Board Manager, Board Secretary packets, Hive Secretary, projects, Task
  Manager, and reports.
- [ ] Move Context Rewrite score/final/polish, then research after tool proof.
- [ ] Move expert badges and recommended-connections reranking.
- [ ] Keep schema validation and fail-closed behavior outside the model response.

### Phase 4 — Task And Economic Decisions

- [ ] Move personal/network task generation.
- [ ] Move screenshot, image, scanned-PDF, and embedded-document-image evidence
  reading to `verification_vision` before moving verification decisions.
- [ ] Validate the vision observation schema, provenance, uncertainty, and
  retry-without-zero behavior.
- [ ] Move verification requests and reward scoring.
- [ ] Move task accounting harvesting and daily airdrop scoring.
- [ ] Run lifecycle tests from request through offer, submission, verification,
  reward, replay, and accounting.
- [ ] Require explicit sign-off on quality and economic invariants before
  enabling production writes.

### Phase 5 — Interactive Chat And Attachments

- [ ] Route old mode strings through Ambient capability policies.
- [ ] Move non-streaming, SSE, response gating, Help, Telegram, terminal chat,
  and Context Refine.
- [ ] Land shared document extraction before removing generic provider file
  inputs.
- [ ] Route image inputs to Kimi and text/documents to the selected text policy.
- [ ] Rename/consolidate UI modes only after the compatibility release is stable.

### Phase 6 — Embeddings And Isolated Profile Images

- [ ] Backfill and atomically switch pgvector retrieval to the approved local or
  deterministic embedding path.
- [ ] Implement the GLM 5.2 abstraction and privacy-review schemas, deterministic
  leakage validator, and bounded repair path.
- [ ] Replace the current raw Profile NFT prompt assembly with versioned GLM
  redaction/review prompts and an allowlisted renderer-only prompt.
- [ ] Split trusted NFT preparation from the isolated OpenAI renderer using a
  sanitized durable render queue and dedicated credentials/database access.
- [ ] Add Ambient vision review before IPFS publication and migrate the manual
  route and daily worker to the same pipeline.
- [ ] Verify existing vectors, profile images, and CIDs remain readable.

### Phase 7 — Hard Cut And Cleanup

- [ ] Change Fly, Docker, reward-test, local env, and operator scripts to Ambient.
- [ ] Add new database defaults through a forward migration; preserve historical
  provider values.
- [ ] Replace OpenRouter pricing/catalog status with Ambient model metadata and
  Task Node-owned pricing policy.
- [ ] Remove old request builders, provider branches, error names, headers,
  allowlists, file-parser plugins, docs, and status copy.
- [ ] Enforce a CI allowlist that rejects retired hosts and credential reads in
  active code. Historical docs/migrations and the single NFT OpenAI image module
  may be explicitly allowlisted.
- [ ] Observe zero retired-provider egress and zero non-NFT OpenAI egress, then
  delete OpenRouter, DeepSeek, and general OpenAI secrets. Rotate the remaining
  NFT renderer credential into the dedicated process only.

## Verification Matrix

| Boundary | Required proof |
| --- | --- |
| Adapter | Unit fixtures for request mapping, auth, errors, timeouts, retries, reasoning, usage, structured output, multimodal parts, and SSE chunk assembly |
| Models | Live smoke for GLM 5.2, DeepSeek 0731, and every approved verification vision model; explicit no-worker/rate-limit behavior |
| Structured workers | Valid schema, invalid schema, repair/retry policy, fail-closed mutation, idempotent replay |
| Chat | Every old mode alias; short/long response gate; streaming and non-streaming equivalence; cancellation; Help; Telegram; terminal |
| Tools | Web-search trigger/no-trigger, citations, tool errors, timeout, and stream behavior |
| Documents | Text and scanned PDF, DOCX text and embedded images, text, archive, standalone image, corrupt/encrypted/empty input, truncation and bomb limits |
| Task lifecycle | Generation, accept, submit, modality routing, vision observation, verification request, evidence review, reward scoring, unavailable-vision retry without a zero, replay, accounting |
| Retrieval | Corpus-version backfill, dimension/model isolation, quality benchmark, atomic cutover and rollback |
| Profile images | GLM abstraction, GLM privacy repair, schema/overlap validation, prompt-injection fixtures, exact OpenAI payload snapshot, renderer isolation, generated-image privacy scan, IPFS pin/retry, and existing CID display |
| Operations | Fly and Docker boot without old provider keys except the dedicated NFT renderer key; worker preflights; system status; cost/usage metrics; retired-host and non-NFT OpenAI egress scans |

Do not shadow-send raw private user packets to two providers. Quality comparison
should use sanitized recorded fixtures or synthetic packets. If sampled shadow
traffic is ever approved, it must be read-only, explicitly privacy-reviewed,
and incapable of committing model-selected actions.

## Static Zero-Egress Gate

Add a focused script that fails CI when active runtime or operator code contains
any of the following outside an explicit historical allowlist and the isolated
NFT image-provider module:

- `openrouter.ai`
- `api.openrouter.ai`
- `api.deepseek.com`
- `api.openai.com`, permitted only for the NFT `/v1/images/generations` boundary
- reads of `OPENROUTER_API_KEY`, `OPENROUTER`, `DEEPSEEK_API_KEY`, `DEEPSEEK`,
  or general `OPENAI_API_KEY`
- reads of `PROFILE_NFT_OPENAI_API_KEY` anywhere except the isolated NFT renderer

Also assert that outbound input inference calls are only made from the Ambient
adapter, outbound OpenAI calls are only made from the NFT image-provider module,
and the serialized image request contains only approved render fields. A string
scan is a cleanup gate, not the architecture: module-level tests must prove
feature code cannot bypass the adapter through a configurable old base URL or
pass private source objects into the renderer.

## Rollout And Rollback Rules

- Cut over one workload class at a time behind a workload-specific flag.
- A rollback before hard cut may restore the previous deployment. After a
  workload's hard cut, operational fallback stays inside Ambient; old providers
  are not a runtime circuit breaker.
- Never dual-write model-selected actions. Compare outputs without dispatching
  the shadow result.
- Keep model selection and capability flags server-side so a capacity event can
  switch between already-approved Ambient models without a client release.
- Economic paths fail closed. Chat and low-risk summaries may fail over or use a
  clearly labeled deterministic fallback.
- Do not delete old secrets until logs and the static gate agree that they are
  unused. Keep only the dedicated NFT OpenAI credential, available only to the
  renderer process; do not consider the migration complete while a general
  OpenAI credential remains a hidden dependency.

## Remaining Product Decisions After Cutover

- Whether to replace the deployed versioned
  `deterministic-bag-of-words-v1` embedding path with a stronger local semantic
  model after retrieval-quality measurement.
- Resolved 2026-08-12: Discount Thinking merged into Thinking; both Frontier
  modes were removed from the picker. The three canonical modes do not expose
  web search.
- Are `ambient/large` aliases acceptable in persisted audit rows, or should Task
  Node always store the resolved concrete model ID?
- What sanitized evaluation set and thresholds approve GLM 5.2 for reward,
  airdrop, task generation, and Board Manager actions?
- Which second Ambient image-input model qualifies as the production fallback
  once it is live and passes the verification vision fixture set?
- Which allowlisted archetypes, activity themes, achievement bands, symbols,
  palettes, and style tags form the Profile NFT redaction schema?

The target is now explicit: all source-data completion, reasoning, structured
output, verification vision, and privacy classification run through Ambient.
OpenAI remains only as a blind Profile NFT image renderer operating on a GLM
5.2-approved redacted brief. The provider-removal implementation and production
hard cut are complete.
