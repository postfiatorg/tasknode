# Team Context Report Plan

Status: IMPLEMENTED AND VERIFIED LOCALLY — 2026-08-31

## Scope

Add a one-page Team Context report to the Team surface. The report lists every
current team member, summarizes recently rewarded work in plain English, and
shows deterministic rewarded-task counts for the trailing 24 hours and seven
days. A checkmark control lets the signed-in account opt into including the
report in its personal execution context so both browser chats and wallet-origin
agent chats receive it.

Every canonical rewarded-task change affecting a visible teammate must enqueue
a fresh report. GLM 5.3 Flash must be called through Vercel AI Gateway for each
changed report fingerprint. A failed provider call retains the last good report
and retries; it must not silently fall back to another model or provider.

## Current Codebase

- `src/features/team/TeamView.jsx` renders collaboration members and task-history
  access, but has no team report or context preference.
- `server/collaboration-routes.js` owns `/api/team`, and
  `server/repositories/collaboration.js` resolves directional grants and current
  teammate task summaries.
- `server/offchain-task-lifecycle.js` and
  `server/repositories/task-replay-import.js` already converge canonical reward
  changes on the rewarded-task-memory enqueue boundary.
- `server/chat-context-load.js` loads the personal Context document, Memory, and
  task state for all chat execution. Wallet-origin machine-agent requests pass
  through the same product chat contract.
- `server/background-workers.js` runs memory/profile work in the dedicated
  `worker:memory-profile` process.
- The repository has no Vercel inference client. Production configuration
  already exposes `VERCEL_AI_GATEWAY_API_KEY`; the official OpenAI-compatible
  endpoint is `https://ai-gateway.vercel.sh/v1/chat/completions`, and the
  required model slug is `zai/glm-5.3-flash`.

## Task 1 — Persistence and Deterministic Source Packet

To-dos:

- Add account-scoped inclusion preferences, latest reports, and a durable
  idempotent job table.
- Build a source packet from current Team relationships and active directional
  task-history grants.
- Derive reward timestamps from canonical `pf.reward.v1` task events, falling
  back to projection event timestamps only where required by existing canonical
  projection behavior.
- Calculate trailing-day and trailing-week counts in SQL/application code, not
  in the model.
- Include recent rewarded task titles/descriptions only for members whose task
  history the viewer is currently authorized to read. Members without an
  incoming grant remain listed with unavailable activity rather than leaking
  task data.

Acceptance criteria:

- The packet fingerprint changes when membership, grant direction, or any
  visible rewarded-task input changes.
- Counts are exact at 24-hour and seven-day boundaries.
- Fixture and non-canonical reward projections are excluded through the existing
  canonical projection contract.
- Revoked grants are absent from every newly loaded packet and context block.

## Task 2 — Reward Fan-out and Vercel Worker

To-dos:

- Fan out a team-context enqueue from both canonical reward ingestion paths to
  every account that can view the rewarded member's task history.
- Treat Team membership/grant changes as immediate fingerprint invalidations on
  the next Team or execution-context read, and enqueue when the inclusion
  preference changes.
- Add a dedicated worker using Vercel AI Gateway and exactly
  `zai/glm-5.3-flash`.
- Require typed JSON output containing only plain-English work summaries. Merge
  model text with server-owned identities and counts.
- Use digest-aware completion so an older in-flight result cannot overwrite a
  newer source packet. Retry failures while preserving the last good report.

Acceptance criteria:

- A new canonical reward queues all and only authorized affected viewers.
- Replaying an unchanged reward does not cause another model call.
- A changed reward fingerprint causes one new GLM 5.3 Flash Vercel call per
  affected report.
- No provider/model fallback occurs.
- Provider, model, prompt version, source fingerprint, generation time, usage,
  and last error are observable.

## Task 3 — Team API and UX

To-dos:

- Extend Team APIs with report retrieval and preference update. The existing
  Team refresh action reloads the report and enqueues stale input.
- Render a compact one-page report above the member cards.
- Show each member's plain-English recent work, trailing-day count, and
  trailing-week count.
- Add a checkmark control labeled `Include Team Context in personal context`.
- Expose updating, current, and last-update-failed states without blocking the
  rest of Team.

Acceptance criteria:

- The report is readable on desktop and mobile without exposing raw model JSON.
- The checkmark is persistent and scoped to the current account.
- Enabling inclusion queues a missing/stale report immediately.
- Team remains usable if Vercel is unavailable.

## Task 4 — Chat and Agent Context

To-dos:

- Add a bounded Team Context loader and formatter to the shared chat execution
  context.
- Include it only when the account preference is enabled and the report's source
  fingerprint still matches current authorization and rewarded-task state.
- Pass the block through prompt builders, estimates, context status, normal
  browser chats, and wallet-origin agent chats.
- Do not mutate the user's editable personal Context document; Team Context is a
  separate generated block composed alongside it.

Acceptance criteria:

- Disabled preference contributes zero Team Context characters/tokens.
- Enabled, current reports appear in both browser and wallet-agent prompt paths.
- A revoked grant removes the affected member immediately, even before a new
  model report completes.
- Prompt status states whether Team Context was included, pending, stale, empty,
  or disabled.

## Task 5 — Verification and Documentation

To-dos:

- Add repository-level smoke coverage for source fingerprints, time-window
  counts, fan-out/idempotency, stale-completion protection, provider/model
  pinning, route contracts, authorization pruning, and prompt inclusion.
- Extend the Team visible-UX smoke for the report and checkmark.
- Update the durable Team, Context, Chat, Agents, database, and provider docs.

Acceptance criteria:

- Focused backend smokes pass against a temporary or transaction-cleaned store.
- `npm run lint`, `npm run build`, and `git diff --check` pass for touched code.
- The rendered Team page is inspected at desktop and mobile widths.
- No unrelated dirty-worktree changes are modified.

## Verification Result

- Database-backed smoke passed for exact/rolling time windows, canonical reward
  filtering, digest fan-out, the exact Vercel model and wire request, structured
  response validation, preference persistence, shared chat execution-context
  injection, and authorization revocation.
- Desktop and 390px mobile browser smokes passed for the report, counts,
  checkmark, and existing teammate-task popout.
- Migration registration, collaboration/auth contracts, request validation,
  provider egress, prompt/public-help boundaries, worker liveness, file size,
  lint, production build, API reference, and diff checks passed.
