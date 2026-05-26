# Jobs Chat Spirit

Status: deprecated implemented v1/v2 plan. Current product truth lives in `Surfaces -> Chat`, `Architecture -> AI Providers`, and `Prompts -> Jobs Chat OS`.

## Objective

Make the spirit of Task Node chat feel like Steve Jobs: direct, product-led, tasteful, allergic to weak premises, and focused on the human consequence of the work. This is not a celebrity impersonation layer. It is a source-controlled chat operating prompt plus, later, a small pgvector retrieval layer over Jobs reference notes.

The implementation must keep product truth higher than style. The chat must still respect wallet state, billing state, task state, web-search policy, attachment handling, and provider limits. The Jobs layer changes voice and judgment; it must not invent app actions or hide system failures.

The product goal is simple: talking to Task Node should feel like talking to Steve Jobs about your work, not like talking to a generic chatbot. The prompt should make chat sharper, more tasteful, more honest, and more product-led while preserving all of the current app intelligence already wired into chat.

## Source Material

There are two different source assets and they should not be confused:

| Asset | Current location | Size observed | Purpose |
| --- | --- | --- | --- |
| Jobs XML prompt | `prompts/chat/jobs_chat_os_v1.xml` | 29,323 bytes | Active Phase 1 system prompt. It contains XML prompt text with runtime slots for context, current plate, retrieved Jobs essence, and current user message. |
| Jobs corpus gist | `https://gist.github.com/goodalexander/3246640dcf10db350fbae9fab8e6a473` | raw `jobs.md` is 331,597 bytes | Phase 2 retrieval corpus. The gist is Jobs reference notes and source packets, not the runtime prompt itself. |

The gist was inspected through the GitHub gist API. It currently exposes one file named `jobs.md` with raw URL:

```text
https://gist.githubusercontent.com/goodalexander/3246640dcf10db350fbae9fab8e6a473/raw/bd144a47532fbcba8dd4e8a6f81b605a034c4d16/jobs.md
```

Phase 1 does not require pgvector or the full gist corpus. Phase 1 uses the Jobs XML prompt as a source-controlled runtime prompt, wired into the shared chat instruction path, aligned with the current chat context feeds, and tested across the four chat modes.

## Non-Negotiable Boundaries

- Do not hard-code the Jobs prompt in four chat providers or four React surfaces.
- Do not replace the operational Task Node truth prompt with style text.
- Do not use regex or keyword routes to decide whether the Jobs prompt applies.
- Do not expose "Jobs mode", retrieval internals, vector chunks, prompt names, or app plumbing to the user.
- Do not duplicate context, memory, task state, or the user message in multiple instruction blocks.
- Do not lose existing chat awareness: current conversation history, account memory, deep memory, current context document, task state, attachments, and provider/web-search policy must continue to work.
- Do not make private modes use web search.
- Do not commit generated vector database files. Vector rows must be reproducible from source corpus plus embedding model.

## Current Chat Instruction Boundary

All four chat modes already pass through one shared instruction assembly function:

| Runtime path | Code |
| --- | --- |
| Shared instruction assembly | `server/chat-memory-context.js::taskNodeInstructions` |
| Frontier modes | `server/chat-router.js::openAiResponseRequest` uses `instructions: taskNodeInstructions(...)` |
| Private modes | `server/chat-router.js::openRouterMessages` uses `taskNodeInstructions(...)` as the system message |
| Base Task Node prompt | `prompts/chat/task_node_instructions_v1.md` |
| Account context block | `server/chat-account-context.js::formatChatContextDocument` |
| Task context block | `server/chat-task-context.js::formatChatTaskContext` |
| Memory context block | `server/chat-memory-context.js::formatChatMemoryContext` |

That shared boundary is the correct place to add the Jobs prompt. If the Jobs prompt is wired anywhere else, it is probably wrong.

The current chat stack already carries several kinds of awareness. The Jobs prompt must consume those inputs, not replace them:

| Existing awareness | Current source | Jobs XML mapping |
| --- | --- | --- |
| Current chat history | `server/chat-router.js` loads persisted conversation history through `getChatMessages` | Keep as provider messages, not duplicated into XML. |
| Current user message | Provider user message from the current request | Keep as provider user message; only use XML `USER_MESSAGE` if tests prove the provider needs a short pointer. |
| Current context document | `server/chat-account-context.js::formatChatContextDocument` | Render into `CONTEXT_DOCUMENT`. |
| Deep memory and recent memory | `server/chat-memory-context.js::formatChatMemoryContext` | Render into `CURRENT_PLATE` or a dedicated XML memory section if the prompt is revised. |
| Outstanding, verification, refused, and rewarded tasks | `server/chat-task-context.js::formatChatTaskContext` | Render into `CURRENT_PLATE`. |
| Attachments and extracted text | `server/chat-router.js` message/content assembly | Keep in provider message content; do not bury attachments inside the Jobs prompt. |
| Web-search policy | `prompts/chat/task_node_instructions_v1.md` plus provider mode logic | Keep in the operational prompt outside the Jobs style layer. |

## Phase 1: Prompt Wiring And Mode Testing

Goal: test the Jobs XML prompt across Private Instant, Private Thinking, Frontier Instant, and Frontier Thinking without building retrieval yet.

Phase 1 must be completed locally in Docker before any Fly deployment. The goal is to make the loop fast and observable on `http://localhost:5174`, prove the prompt assembly once, and only then promote the same code path to Fly.

### Implementation Shape

1. `prompts/chat/jobs_chat_os_v1.xml` is the versioned runtime prompt file. The old markdown wrapper was a staging artifact and is not used by runtime code.
2. Keep `prompts/chat/task_node_instructions_v1.md` as the first operational safety and product-truth prompt.
3. Add a small formatter module, likely `server/chat-spirit-context.js`, that loads the Jobs prompt once through `server/prompt-registry.js`.
4. Render the Jobs prompt with the existing account context, task context, and memory context instead of appending duplicate blocks after it.
5. For Phase 1, render the Jobs retrieval slot as empty or "No retrieved Jobs corpus chunks for this turn." Retrieval does not exist yet.
6. Do not inject the current user message into the system prompt unless there is a deliberate reason. The provider already receives the user message as a user message.
7. Add an environment flag so the layer can be disabled quickly:

```text
TASKNODE_CHAT_SPIRIT_ENABLED=true
TASKNODE_CHAT_SPIRIT_PROMPT=chat/jobs_chat_os_v1.xml
```

Recommended assembly:

```text
task_node_instructions_v1.md
jobs_chat_os_v1.xml rendered with:
  CONTEXT_DOCUMENT = formatted account context
  CURRENT_PLATE = formatted task context plus formatted deep memory and recent memory
  RELEVANT_JOBS_ESSENCE_FROM_VECTOR_DB = empty in Phase 1
  USER_MESSAGE = omitted or explicit runtime note that the user message is supplied separately
```

This preserves the existing provider architecture. OpenAI and OpenRouter do not get separate prompt copies.

The formatter should make the XML runtime slots line up with the current product model:

```xml
<runtime_slots>
  <context_document>{{current saved context document}}</context_document>
  <current_plate>
    {{outstanding and verification tasks}}
    {{recently refused/rewarded task summary}}
    {{last 3 deep memories}}
    {{last 36 recent memory summaries}}
  </current_plate>
  <retrieved_jobs_essence>{{empty in Phase 1; top 3 chunks in Phase 2}}</retrieved_jobs_essence>
  <user_message>{{normally omitted because it is already a user message}}</user_message>
</runtime_slots>
```

If the XML prompt needs additional slots, change the XML deliberately rather than hiding extra product context in ad hoc prose.

### Test Matrix

The test matrix should exercise the four configured chat modes:

| Mode | Provider route | Expected proof |
| --- | --- | --- |
| Private Instant | OpenRouter chat completions, ZDR allowlist | System prompt contains the Jobs prompt exactly once and returns a normal answer without web search. |
| Private Thinking | OpenRouter chat completions with high reasoning | Same prompt path, reasoning config unchanged, no web search. |
| Frontier Instant | OpenAI Responses API, `chat-latest` | `instructions` includes the rendered Jobs prompt exactly once; web search remains prompt-governed. |
| Frontier Thinking | OpenAI Responses API, high reasoning | Same instruction path, reasoning config unchanged. |

Use test prompts that reveal whether the model has the right operating spirit without requiring hidden app actions:

- "I have ten product ideas and no working surface. What should I cut?"
- "Why should I care about the task system instead of just chatting?"
- "This plan feels complicated. What is the real product problem?"
- "Help me decide whether to polish search or finish task verification."

Acceptance criteria:

- The response sounds sharper and more product-led, not like a workflow engine.
- It never says "I am Steve Jobs", "as Steve Jobs", or explains the persona.
- It does not expose context machinery, retrieval, tasks injection, memory injection, or prompt names.
- It can still answer questions about the user's context document, remembered work, and task queue when asked.
- It still respects explicit user requests and current app state.
- It still bills normally for chat tokens.
- The same implementation path covers all four chat modes.
- Prompt digest/version is visible in docs or logs for audit.

### Phase 1 Files

Likely changed files:

| File | Purpose |
| --- | --- |
| `prompts/chat/jobs_chat_os_v1.xml` | Versioned Jobs XML prompt. |
| `server/chat-spirit-context.js` | Loads and renders the Jobs prompt once. |
| `server/chat-memory-context.js` | Calls the Jobs formatter from the shared instruction path. |
| `src/features/docs/docs-content.js` | Makes the prompt visible in Help under Prompts. |
| `docs/wiki/surfaces/chat.md` | Documents how the Jobs chat spirit is wired. |
| `docs/wiki/architecture/ai-providers.md` | Notes that all four providers/modes use the same instruction assembly. |

Likely tests:

| Test | Purpose |
| --- | --- |
| `scripts/chat-spirit-prompt-smoke.mjs` | Asserts all four mode request builders include the Jobs prompt exactly once. |
| `npm run chat-markdown-smoke` | Confirms markdown rendering is not broken by changed chat output. |
| `npm run route-smoke` | Confirms Help and Chat still render. |
| Optional live provider smoke | Sends one small prompt through each enabled provider route and records mode/model/result metadata. |

### Local Docker Gate

Run Phase 1 against local Docker first:

```bash
npm run docker:dev
```

The local gate is not just a build. It must prove the running app path:

1. Local web is reachable at `http://localhost:5174`.
2. Local API uses the same prompt assembly function as production.
3. `TASKNODE_CHAT_SPIRIT_ENABLED=true` is set in local Docker env.
4. The Jobs XML prompt is loaded from one runtime prompt file.
5. Private Instant, Private Thinking, Frontier Instant, and Frontier Thinking all route through the same rendered instruction path.
6. Context document access still works.
7. Deep memory and recent memory still work.
8. Task context still works.
9. Attachments still flow through the existing chat attachment path.
10. Frontier web search remains available only when the user asks for current/external/source-grounded information.
11. Private modes do not gain web search.
12. Billing still records ordinary chat tokens.

Local verification should include:

- `npm run quality`
- `npm run build`
- `npm run route-smoke`
- `npm run chat-attachment-smoke`
- `npm run runtime-smoke`
- `scripts/chat-spirit-prompt-smoke.mjs` once it exists
- one browser screenshot of the local chat/docs surface if UI docs or visible prompt controls change
- one local provider smoke per enabled mode, or a precise explanation for any mode not configured locally

Only after this local gate passes should the same commit be tested on Fly.

## Phase 2: pgvector Jobs Retrieval

Goal: retrieve three relevant Jobs corpus chunks for the user's workflow and inject them into the Jobs prompt retrieval slot.

Phase 2 should be a database-backed retrieval layer, not a static file loaded into every request.

### Corpus Ingestion

The gist corpus should be imported through an idempotent script, not a local DB dump:

```text
scripts/jobs-corpus-ingest.mjs
  fetch pinned raw gist URL or read a local corpus file
  compute source sha256 and size
  split into stable chunks
  embed chunks with configured embedding model
  upsert rows by source_sha256 + chunk_index + embedding_model
```

Chunk metadata should preserve:

- source URL;
- source raw SHA-256;
- packet name or source title when detectable;
- chunk index;
- content SHA-256;
- character count;
- token estimate;
- embedding model;
- created/updated timestamps.

The source corpus is about 331 KB raw. The deployed pgvector footprint may be around 1.9 MB after chunk text, metadata, indexes, and vectors. That is small enough to live in the primary Fly Postgres database first.

### Database Shape

Recommended tables:

```text
jobs_corpus_sources
  id
  source_url
  raw_sha256
  raw_size_bytes
  source_label
  fetched_at
  metadata_json
  created_at
  updated_at

jobs_corpus_chunks
  id
  source_id
  chunk_index
  packet_label
  title
  content
  content_sha256
  token_estimate
  embedding_model
  embedding vector(...)
  metadata_json
  created_at
  updated_at
```

Migration:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Index choice can be conservative. At this corpus size, a sequential cosine scan may be acceptable. If latency requires an index, add pgvector HNSW or IVFFlat with a measured smoke test.

### Retrieval Path

Runtime query:

1. Build a compact retrieval query from the current user message plus bounded context from task state, account memory, and current context document.
2. Embed the retrieval query.
3. Query `jobs_corpus_chunks` for the top 3 cosine-similar chunks.
4. Render only those three chunks into `RELEVANT_JOBS_ESSENCE_FROM_VECTOR_DB`.
5. Record retrieval metadata in logs or model-run metadata:
   - chunk IDs;
   - source SHA;
   - similarity scores;
   - embedding model;
   - latency.

Retrieval output should be advisory calibration, not a quote dump. The Jobs XML prompt already tells the model to use retrieved Jobs material as calibration and not expose retrieval machinery.

### Fly Deployment Model

Do not deploy a local vector DB file per server. Use the shared Fly Postgres database so every app instance reads the same rows.

Fly is the second environment, not the first proving ground. For Phase 1, Fly deployment should happen only after Docker proves the prompt path across the four chat modes. For Phase 2, Fly deployment should happen only after local Docker proves pgvector migration, ingestion idempotency, retrieval, failure fallback, and prompt injection.

Deployment plan:

1. Add the pgvector migration to the normal DB migration path.
2. Run ingestion as a one-shot release task or operator script.
3. Use a Postgres advisory lock during ingestion so multiple Fly instances cannot seed the same corpus concurrently.
4. Make ingestion idempotent by source hash and embedding model.
5. Let app servers cache retrieval results in process for a short TTL only; Postgres remains canonical for the corpus.
6. If Fly runs read replicas later, route retrieval reads to the nearest healthy replica only after replication lag is measured.

Failure behavior:

- If pgvector is unavailable, chat should still work with the Jobs prompt and an empty retrieval slot.
- If retrieval times out, skip retrieval for that turn and log the timeout.
- If ingestion is incomplete, do not block chat startup.
- Retrieval should never make private modes use web search.

### Phase 2 Acceptance Criteria

- Gist corpus can be fetched or loaded locally and chunked deterministically.
- Re-running ingestion with the same source hash does not duplicate rows.
- A smoke query returns three relevant chunks with chunk IDs and scores.
- Chat instructions include the three chunks only once.
- Provider calls continue to work across all four chat modes.
- Fly deployment uses shared Postgres rows, not local container state.
- The app still works when retrieval fails.

## Current Implementation State

- `server/chat-spirit-context.js` loads `prompts/chat/jobs_chat_os_v1.xml` through the prompt registry.
- `server/chat-memory-context.js::taskNodeInstructions` renders the base Task Node operational prompt first, then renders the Jobs XML with the current context document, task projection, memory context, and Jobs retrieval context.
- OpenAI Frontier modes receive the rendered instructions through `instructions`.
- OpenRouter Private modes receive the same rendered instructions as the system message.
- The current user message, conversation history, and attachments remain provider user messages. They are not duplicated into the XML prompt.
- `server/db/migrations/014_jobs_corpus_pgvector.sql` installs `pgvector` and creates `jobs_corpus_sources` and `jobs_corpus_chunks`.
- `scripts/jobs-corpus-ingest.mjs` fetches the pinned gist or reads a local file, chunks the corpus deterministically, embeds chunks with `text-embedding-3-small`, and upserts rows idempotently.
- `server/jobs-corpus.js::jobsRetrievalForChat` builds a compact query from the current user message, context document, memory, and task state, then retrieves the top three chunks from Postgres.
- If retrieval fails or times out, chat continues with the explicit empty-retrieval note.
- `server/chat-estimate.js::chatEstimate` counts the full rendered instruction text, including the Jobs XML, so the preflight credit check reserves for the actual prompt payload.
- The layer is on by default and can be disabled with `TASKNODE_CHAT_SPIRIT_ENABLED=false`.

## Remaining Open Decisions

- Whether retrieval query embeddings should be billed internally or eventually included in a small chat overhead buffer.

## Done Definition

Phase 1 is done when the running app has one shared Jobs prompt loader, all four chat modes use it through the same instruction assembly path, Help shows the prompt source, and live or request-builder smoke tests prove no duplicate prompt injection.

Phase 2 is locally implemented when the gist corpus is in pgvector, top-3 retrieval is injected into the Jobs prompt slot, local Docker reads from shared Postgres, and chat remains operational when retrieval is empty or degraded.

## Reviewer To Do List

Review implementation against this document (jobs chat spirit). Mark each item when verified.

### Memory Efficiency
- [ ] Plan phases avoid loading unbounded history or corpus into single jobs.
- [ ] Derived read models prefer projections over duplicate materialized stores.

### Code Quality
- [ ] Done criteria map to testable checks or smoke commands.
- [ ] Status (implemented vs planned) accurate on every section.

### Coherence
- [ ] Plan does not contradict shipped behavior in Surfaces/Architecture docs.
- [ ] Dependencies on other plans explicitly named and still valid.

### Bloat
- [ ] Plan scoped to stated phase; future work not implied as shipped.
- [ ] Avoid duplicating full surface doc content; link instead.

### Security
- [ ] New tables/routes in plan include account ownership and encryption notes.
- [ ] Operator-only actions identified with audit requirements.
