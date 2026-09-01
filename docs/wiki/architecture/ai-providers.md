# AI Providers

Task Node uses Ambient as its default inference boundary. There are two scoped
external exceptions: profile NFT image output uses OpenAI Images as a blind
renderer, and Team Context generation uses Vercel AI Gateway with the exact
`zai/glm-5.3-flash` model. Neither exception is a general chat-routing path.

## Runtime Boundary

`server/ambient-inference.js` owns authentication, model policy, request
normalization, JSON output, streaming, image input, web search, errors, timeouts,
catalog caching, and Ambient-only capacity fallback. Feature modules must not
construct inference provider URLs or read retired provider credentials.

Configuration:

- `AMBIENT_API_KEY`
- `AMBIENT_BASE_URL`, default `https://api.ambient.xyz/v1`
- `AMBIENT_MODEL_FAST_TEXT`, default `deepseek/deepseek-v4-flash-0731`
- `AMBIENT_MODEL_REASONING`, default `z-ai/glm-5.2`
- `AMBIENT_MODEL_STRUCTURED`, default `z-ai/glm-5.2`
- `AMBIENT_MODEL_RESEARCH`, default `z-ai/glm-5.2`
- `AMBIENT_MODEL_VISION`, default `moonshotai/kimi-k2.7-code`

OpenRouter, direct DeepSeek, and general OpenAI inference keys and hosts are
retired. `npm run provider-egress-check` fails when one reappears in an active
runtime, operator script, Fly configuration, or Docker configuration.

`server/vercel-inference.js` is the narrow Vercel adapter. It reads
`VERCEL_AI_GATEWAY_API_KEY` (or the gateway-compatible `AI_GATEWAY_API_KEY`),
uses the OpenAI-compatible chat-completions endpoint, requests a JSON object,
and permits no model substitution. `server/team-context-worker.js` is its only
feature consumer. It sends task titles/descriptions and reward metadata that
the viewer is already authorized to read; deterministic day/week counts remain
local and are not delegated to the provider.

Some internal functions and historical schema fields still contain names such
as `executeOpenRouter`, `openRouterMessages`, `fetchOpenRouter`,
`generateTaskWithOpenAi`, or `callOpenAiJson`. They are compatibility names,
response parsers, and migration archaeology; their executable dispatch goes
through `server/ambient-inference.js`. Provider identity is determined by the
outbound host and persisted run metadata, not by a legacy symbol name.

## Capability Matrix

| Capability | Default Ambient model | Used for |
| --- | --- | --- |
| `fast_text` | `deepseek/deepseek-v4-flash-0731` | Instant chat, Help, memory, short narration |
| `reasoning_text` | `z-ai/glm-5.2` | Thinking chat and high-stakes reasoning |
| `strict_json` | `z-ai/glm-5.2` | Task generation/review, Hive, profiles, Context Rewrite, economic decisions |
| `research_text` | `z-ai/glm-5.2` | Prompt-governed web research |
| `verification_vision` | `moonshotai/kimi-k2.7-code` | Screenshots, rendered PDF pages, DOCX images, NFT privacy review |

The dated DeepSeek route is deliberate: the undated route returned a live
no-worker response during the 2026-08-12 capability check. Fast-text requests
may fall back to GLM 5.2 on that specific Ambient capacity error. No fallback
may leave Ambient, and vision may fall back only after another image-input model
has a live contract test.

## Chat Modes

The mode API and every picker expose exactly three canonical labels:

| Mode | Capability | Model |
| --- | --- | --- |
| Instant | `fast_text` | `deepseek/deepseek-v4-flash-0731` |
| Thinking | `reasoning_text` | `z-ai/glm-5.2` |
| Help | `fast_text` plus the Help prompt and user guide | `deepseek/deepseek-v4-flash-0731` |

Historical Private, Discount, and Frontier labels normalize one-way to Instant
or Thinking so old stored preferences and clients remain usable. They are not
returned by the mode API, shown in pickers, or eligible for separate provider
routing. Billing and durable model-run records store `provider=ambient` plus the
actual returned model ID.

Chat personality is orthogonal to this table. The browser sends an allowlisted
`persona` enum (`jobs`, `odv`, or `trading-coach`) while the mode continues to
choose the capability and model. Jobs alone may query the local Jobs pgvector
corpus. ODV and Trading Coach use their canonical prompts with the normal
account Context document, memory, tasks, history, and attachments, and the
router records Jobs retrieval as skipped before any embedding/search call.

## Attachments And Verification

Ambient does not parse arbitrary office or archive files. Task Node decodes and
extracts them locally in `server/evidence-file-extraction.js` with byte, entry,
page, and expansion limits.

- Text, Markdown, JSON, CSV, source files: bounded UTF-8 extraction.
- PDF: bounded text extraction plus rendered page images.
- DOCX: OOXML text plus bounded embedded images.
- ZIP, TAR, GZIP: bounded text-file extraction; binary entries are reported and
  skipped.
- Images: preserved as image parts.

Chat passes extracted text to its selected text capability and switches to the
approved vision capability when preserved images are present. Task evidence
sends every bounded visual page/image through Kimi and combines those
observations with extracted text for the final GLM verification decision. A
vision outage fails retryably; it is never converted into a zero score.

## Embeddings

Ambient currently has no embeddings endpoint. Retrieval uses the pinned local
`deterministic-bag-of-words-v1` provider at 1536 dimensions. Model, dimensions,
and provider remain part of every corpus row so vectors from different models
cannot be mixed. Production cutover requires re-running `npm run
jobs-corpus-ingest` after migration 105 changes the live defaults.

## Profile NFT Exception

The trusted path in `server/profile-nft-generation.js` sends bounded profile,
activity, memory, and context inputs only to Ambient GLM 5.2. GLM performs an
abstraction pass and a separate privacy-review pass against an allowlisted art
schema. Deterministic validation rejects URLs, handles, wallet-like values,
hashes, monetary details, long identifiers, or private-source overlap.

Only the sanitized rendered prompt and image settings enter the durable
`profile_nft_render_jobs` queue. `server/profile-nft-image-provider.js` is the
only allowlisted OpenAI host and the only module that reads
`PROFILE_NFT_OPENAI_API_KEY`. The dedicated renderer process cannot accept a raw
source packet. Before IPFS publication, Kimi scans the generated pixels for
text, numbers, usernames, brands, wallets, QR codes, documents, source code,
financial symbols, or recognizable people; any violation fails closed.

Fly unsets the renderer credential from every other process command. The
renderer is the sole process that retains it.

## Operations And Failure Modes

- Missing `AMBIENT_API_KEY` disables inference-backed features explicitly.
- Missing `VERCEL_AI_GATEWAY_API_KEY` leaves Team Context jobs pending and does not affect ordinary chat.
- Missing `PROFILE_NFT_OPENAI_API_KEY` affects only queued NFT rendering.
- Invalid structured output remains subject to feature-level schema validation
  and fail-closed behavior.
- Catalog reads use a short cache and last-known-good result.
- Logs and optional Ambient metrics include workload/capability, model, request
  ID, fallback, error class, and latency, never prompt content.
- Migrations preserve historical provider labels. New defaults use `ambient`
  and deterministic embeddings.
