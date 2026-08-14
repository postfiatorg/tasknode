# Context Rewrite

Context Rewrite is the full-document context rewrite flow for Task Node. It is not a general rewrite tool and it is not the same thing as Context Refine.

Context Refine makes one targeted, reviewable edit to the current context document after discussion. Context Rewrite consumes the user's current context document, memory, rewrite discussion, task history, network-task profile, Jobs retrieval, and a small research packet, then returns a better Markdown operating brief as a copyable and downloadable artifact.

The MVP is exposed in Chat from the `+` menu and from Sidebar -> More. It does not auto-save, auto-publish, or replace the user's current context document.

## User Flow

1. The user is signed in and chatting in Task Node.
2. The user chooses `Context Rewrite`.
3. The composer badge changes to `Context Rewrite` and warns that the tool uses multiple model calls and web research.
4. The user sends rewrite instructions.
5. The server creates an async `context_rewrite_jobs` row and a pending assistant message.
6. The background worker assembles sources, scores the current context once, runs two privacy-safe research calls using explicit domain questions, writes a draft Markdown artifact, runs a second GLM 5.2 `xhigh` polish pass, and bills actual provider usage.
7. The completed assistant message shows a `Context Rewrite` artifact card with `Copy Markdown` and `Download .md`.

## Product Boundary

The output is a human-readable operating brief. It is not a prompt guide, AI instruction manual, task ledger, apology block, legal disclaimer, or therapy disclaimer.

The final Markdown should:

- convey urgency without melodrama;
- state values, strategy, constraints, decision rules, and tactical milestone maps;
- make tactics flow up to strategy;
- interpret task completion history as evidence instead of repeating tasks;
- preserve concrete source facts;
- use relevant academic, technical, market, operational, or workflow best practices;
- use Steve Jobs business wisdom where relevant, especially focus, taste, saying no, end-to-end ownership, customer clarity, and craft;
- remove repetition and low-value sprawl without abbreviating away important source facts;
- be substantial enough to serve as the user's operating context document;
- render cleanly in Task Node Markdown.

## Runtime Architecture

The implementation boundary is:

- `src/main.jsx::ChatSurface`: Context Rewrite mode, job creation, polling, composer warning, and menu entries.
- `src/features/context/context-rewrite-client.js`: create and poll client.
- `src/features/chat/ChatMessages.jsx`: visible progress trace and artifact card with copy/download actions.
- `server/context-rewrite-actions.js`: authenticated route handler.
- `server/context-rewrite-worker.js`: queued job processor.
- `server/context-rewrite-provider.js`: Ambient structured-output and web-search tool calls, plus the mock-provider smoke path. Several internal response-parser helpers retain historical OpenRouter names, but no request leaves for OpenRouter.
- `server/context-rewrite-source-packet.js`: source packet assembly.
- `server/context-rewrite-scoring.js`: 15-dimension score normalization and aggregation.
- `server/context-rewrite-search.js`: privacy-safe query selection.
- `server/repositories/context-rewrite.js`: jobs, score runs, search results, artifacts, and assistant-message updates.
- `server/repositories/chat-billing.js::recordBillableModelRun`: durable billing/model-run accounting for each Context Rewrite provider call.
- `server/db/migrations/078_context_rewrite_jobs.sql`: durable job, score, search, and artifact tables.

The background worker starts from `server/background-workers.js` and is gated by `TASKNODE_CONTEXT_REWRITE_WORKER_ENABLED !== "false"`.

## Source Packet

The job input packet is assembled server-side and account-scoped. It includes state markers for missing or empty sources and redacts obvious secrets before provider calls.

Required sources:

- current context document from `server/repositories/context.js::getContextDocument`;
- pinned rewrite instruction message from the chat turn that created the job;
- recent chat messages from the active conversation;
- memory context from `server/chat-memory-context.js`;
- task state from `server/chat-task-context.js`, grouped as active, verification, refused, and rewarded work;
- latest network task profile from `network_task_profiles` when present;
- relevant Steve Jobs corpus chunks from pgvector retrieval.

Task history is source evidence. It should inform values, constraints, urgency, capability, and follow-through patterns, but the final document should not repeat task rows.

## Scoring Harness

Context Rewrite uses a text-improvement-harness shape:

1. preserve a canonical source packet;
2. run repeated structured scorer calls;
3. persist every scorer output;
4. aggregate weaknesses and rewrite priorities;
5. feed the aggregate score, source packet, research, and Jobs retrieval into the draft writer;
6. run a final polish pass for readability, persuasion, flow, formatting, consistency, and action.

The user-facing artifact does not show score totals, score improvements, internal scorer outputs, or aggregate scoring JSON unless the user explicitly asks for scoring output during verification or review.

Each scorer returns exactly 15 scores, each 0-15:

| Band | Meaning |
| --- | --- |
| 0-5 | Weak, generic, stale, prompt-like, repetitive, ungrounded, or missing the dimension. |
| 5-10 | Usable but incomplete, vague, conflicted, too broad, or weakly supported. |
| 10-15 | Strong, specific, non-repetitive, grounded, tactically useful, and improves downstream task decisions. |

Dimensions:

1. `human_readability`
2. `not_prompt_guide`
3. `urgency`
4. `values_clarity`
5. `strategy_clarity`
6. `milestone_map`
7. `task_history_interpretation`
8. `markdown_renderability`
9. `best_practice_grounding`
10. `jobs_business_wisdom`
11. `concision`
12. `no_disclaimer_drift`
13. `source_grounding`
14. `specificity`
15. `downstream_task_utility`

Launch scoring uses `CONTEXT_REWRITE_SCORE_RUNS_PER_MODEL`, default `3` and capped at `3`, across two independently labelled scorer lanes. Both lanes default to Ambient `z-ai/glm-5.2` after the provider cutover. `CONTEXT_REWRITE_GLM_MODEL` and `CONTEXT_REWRITE_SECONDARY_MODEL` may select only models supported by the shared Ambient adapter.

The aggregate score is the median per dimension and the average of the 15 medians. It is stored internally on the job. Malformed scorer JSON is treated as a failed scorer packet, not as an all-zero valid score.

The scorer calls are launched concurrently. The job continues when scorer quorum is met, defaulting to two-thirds of configured scorer calls with a floor of two successful packets. If quorum is not met, the job fails before rewrite. Source packet assembly also parallelizes independent local reads for context, chat, memory, task state, network profile, and active Context Refine proposal before Jobs retrieval runs against the assembled source material.

Production scoring happens once before rewrite. The polished final artifact is not scored again in the app path; post-rewrite scoring is only a live-verification harness behavior.

## Web Research

Scorer outputs include research requests. The backend uses those requests only as classification signals, then selects exactly two privacy-safe domain questions from `server/context-rewrite-search.js`. It does not pass the full source packet, raw context document, private project code names, wallet addresses, emails, handles, private chat excerpts, or task IDs to web search.

Search questions should be complete domain-level questions such as:

- `What are best practices for goal hierarchy, milestone planning, and implementation intentions in operating plans?`
- `What are best practices for startup product strategy, focus, tradeoffs, and customer clarity?`

The search calls run concurrently through Ambient `research_text`, defaulting to `z-ai/glm-5.2`, with Ambient's `websearch` tool continuation. The request body contains only the selected question. Results are stored in `context_rewrite_search_results` and used as general best-practice context, not as facts about the user. Research is optional after scoring: failed query calls are recorded, but successful query calls still feed the rewrite.

## Visible Progress Trace

Every job writes a public `progress_json` object with schema `context_rewrite.progress.v1`. The same progress payload is mirrored into the pending assistant message metadata under `metadata.contextRewrite.progress`, so the app can render what is happening without relying on hidden worker knowledge.

The visible trace includes:

- `queued`: waiting for the worker;
- `source_packet`: assembling context sources and Jobs retrieval;
- `scoring`: concurrent structured scorer calls through Ambient;
- `research`: two concurrent Ambient web-search calls;
- `final_rewrite`: draft GLM rewrite;
- `polish_rewrite`: second GLM 5.2 `xhigh` polish pass;
- `completed`: Markdown artifact ready.

`progress_json.events` keeps the recent stage events with timestamps. Public job reads also expose `lastProgressAt`, `elapsedSinceProgressMs`, `staleAfter`, `retryCount`, `attempt`, `stalled`, and `statusMessage` so the app can distinguish a healthy long-running provider call from a stale worker lease.

Provider-level audit is durable in `context_rewrite_provider_calls`, `chat_model_runs`, `context_rewrite_score_runs`, and `context_rewrite_search_results`. A provider-call row is inserted before each Ambient dispatch and heartbeated while the call is in flight.

## Provider And Billing

Context Rewrite is a billed multi-call pipeline. Route preflight checks available account credit against `CONTEXT_REWRITE_ESTIMATE_USD`, default `$0.50`. Actual billing records provider-reported usage per scorer, research, draft writer, and polish writer call.

Provider calls have bounded defaults so a hung Ambient request does not wedge the in-process worker indefinitely:

- scorer calls: `CONTEXT_REWRITE_SCORE_TIMEOUT_MS`, default 12 minutes;
- research calls: `CONTEXT_REWRITE_SEARCH_TIMEOUT_MS`, default 5 minutes;
- draft rewrite: `CONTEXT_REWRITE_FINAL_TIMEOUT_MS`, default 45 minutes;
- polish rewrite: `CONTEXT_REWRITE_POLISH_TIMEOUT_MS`, default 45 minutes unless overridden.

`CONTEXT_REWRITE_PROVIDER_TIMEOUT_MS` can set a shared fallback, and a stage-specific timeout can override it. Production-shaped environments do not allow disabling timeouts with `0`, `none`, `false`, `off`, or `no` unless `CONTEXT_REWRITE_ALLOW_UNSAFE_NO_TIMEOUT=true` is explicitly set.

All calls go through `server/ambient-inference.js`; feature code does not select an alternate transport or pass retired OpenRouter routing fields. Source packets are redacted before dispatch, research receives only selected domain questions, and structured results are schema-validated before persistence.

The user-facing warning is:

> Context Rewrite runs multiple model calls and web research. The charge may be higher than other tool calls.

Each provider call writes:

- one `context_rewrite_provider_calls` row before dispatch, then `completed`, `failed`, `timed_out`, or `orphaned`;
- one `chat_model_runs` row;
- one `billing_ledger_entries` debit when provider usage reports non-zero cost;
- one stage row in `context_rewrite_score_runs` or `context_rewrite_search_results` when applicable.

Context Rewrite passes deterministic billing idempotency keys based on job, stage, and provider-call id. Retries should not duplicate ledger debits for a completed provider call. Each job also carries `max_cost_usd` as a retry guardrail; if retries have already consumed the configured job budget, the worker stops before launching another provider call.

## API Surface

- `POST /api/context/rewrite/jobs`: create a job, perform billing preflight, persist the instruction and pending assistant message, return `202`.
- `GET /api/context/rewrite/jobs/:jobId`: read public status, progress, assistant message, and final artifact when complete.
- `GET /api/context/rewrite/jobs/:jobId/artifact`: read the final Markdown artifact.
- `POST /api/context/rewrite/jobs/:jobId/cancel`: cancel queued or running jobs.

Public API responses do not include internal scores.

## Data Model

Migration `078_context_rewrite_jobs.sql` creates:

- `context_rewrite_jobs`: account, conversation, instruction message, assistant message, status, stage, public progress trace, frozen source packet snapshot, base context hash, source packet digest, estimate, max retry cost, actual cost, internal aggregate score JSON, Jobs retrieval JSON, draft checkpoint, final Markdown, and timestamps.
- `context_rewrite_score_runs`: one row per scorer call, including parsed structured JSON.
- `context_rewrite_search_results`: one row per selected web query.
- `context_rewrite_artifacts`: final Markdown artifact rows.

Migration `081_context_rewrite_reliability.sql` adds:

- `context_rewrite_provider_calls`: provider-call audit rows created before dispatch with attempt id, stage, call index, request digest, timeout, heartbeat, usage, cost, parsed result, and terminal status;
- source packet and draft checkpoint fields on jobs so retries can resume from the first incomplete stage;
- attempt/provider-call references on score and search rows;
- `is_current` on artifacts plus a unique current-final-artifact index.

Current statuses:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Cancellation is terminal. Stage updates, failure updates, and final artifact writes require the job to still be `running` and, when a worker lock exists, still owned by that lock. A worker that returns after cancellation can still record provider spend already incurred, but it cannot revive the job, overwrite it to failed, or publish an artifact.

The worker can reclaim stale `running` jobs after `CONTEXT_REWRITE_RUNNING_STALE_MINUTES`, default `60`. Stage updates refresh the lock heartbeat, and provider calls refresh both `context_rewrite_jobs.locked_at` and `context_rewrite_provider_calls.heartbeat_at` every `CONTEXT_REWRITE_HEARTBEAT_INTERVAL_MS`, default 30 seconds.

Reclaim is resumable. A reclaimed job keeps its current stage, gets a new `current_attempt_id`, reuses the frozen source packet, reuses completed score and research rows, reconstructs missing stage rows from completed provider-call rows when possible, and resumes from the first incomplete required stage instead of restarting from `source_packet`.

The worker also runs a watchdog every `CONTEXT_REWRITE_WATCHDOG_INTERVAL_MS`, default 60 seconds. The watchdog marks stale running provider calls as `timed_out` or `orphaned`, writes server warnings, emits `user.context_rewrite.stalled` observability events, and feeds Context Rewrite counts into `/api/system/status`.

Current stages:

- `queued`
- `source_packet`
- `scoring`
- `research`
- `final_rewrite`
- `polish_rewrite`
- `completed`

## Verification

Focused checks:

- `npm run build`
- `npm run lint`
- `npm run migration-registration-smoke`
- `npm run context-rewrite-sample-smoke`

`context-rewrite-sample-smoke` requires `DATABASE_URL` and runs against Postgres with deterministic Jobs embeddings and `CONTEXT_REWRITE_PROVIDER_MOCK=true`. It seeds `/home/pfrpc/repos/sample_context.md`, verifies that the artifact does not regress a local quality heuristic, verifies 15 internal score dimensions, verifies provider-call audit rows, verifies one current final artifact, verifies stale public job fields, verifies stale reclaim resumes without adding duplicate score/search rows, verifies the polish stage appears in the public progress trace, verifies public job and assistant metadata do not expose scores, and verifies a claimed running job cannot be revived, failed, or completed after cancellation.
