# Memory

Memory is lightweight compression of user and assistant interactions. It helps future chats know what the user has been exploring without replaying entire conversations.

## User Flow

1. A user receives an assistant response.
2. The app returns the response immediately.
3. A background worker summarizes the user request and assistant response.
4. Every 36 memory rows, a deep memory job snapshots the exact 36 source memory row IDs and compresses those summaries into broader user, assistant, and memory bullets.
5. The Memory page renders Network Context Inputs directly from profile/task projections.
6. A separate async Network Task Profile job can summarize the source packet for future network task routing.
7. The Memory page lets the user inspect what the system remembers and what the routing profile saw.

## Technical Architecture

The memory UI is `src/features/memory/MemoryView.jsx`. Backend memory logic is in `server/chat-memory-worker.js`, `server/chat-memory-context.js`, `server/repositories/chat-memory.js`, and `server/repositories/network-task-profile.js`. Migrations are `server/db/migrations/004_chat_memory.sql`, `server/db/migrations/005_deep_chat_memory.sql`, `server/db/migrations/013_deep_memory_snapshots.sql`, and `server/db/migrations/024_network_task_profiles.sql`.

Private memory jobs use the configured OpenRouter ZDR model path. Memory writes are not billed to the user right now. Ordinary chat model tokens remain billable.

Deep-memory jobs are stable snapshots. `chat_deep_memory_jobs.source_entry_ids` stores the exact 36 `chat_memory_entries.id` values selected when the block is queued. The worker reads those IDs directly instead of recalculating the block later from timestamps, so backfills, imports, or corrected timestamps cannot change what a queued deep-memory job summarizes. `chat_memory_entries` also enforces one `deep_memory` row per account and block index, so retrying or recreating a deep-memory job updates the existing block summary rather than creating duplicates.

Network Task Profile jobs use the same memory worker and OpenRouter ZDR route. The prompt is `prompts/memory/network_task_profile_v1.md`. The API route is `GET /api/memory/network-task-profile`; `POST /api/memory/network-task-profile` requests a refresh. The generated profile is not required for the page to render. Network Context Inputs are built from profile data and routable `task_projections` on every route read and are returned even while a profile job is pending.

## Network Task Profile

The Memory page now has two task-routing layers:

- Generated Network Task Profile: an async LLM-generated routing summary stored in `network_task_profiles`.
- Network Context Inputs: real-time public profile facts plus current task projection text.

The task state block inside Network Context Inputs is grouped as Proposed, Outstanding, Verification, Refused, and Rewarded. It shows task name, state, description, reward, and outcome when available. It intentionally does not show updated timestamps, CIDs, transaction hashes, event IDs, reducer names, raw JSON, or full forensics.

Network Context Inputs filters out non-routable projections. Blank `unknown` projections, orphan historical submissions, and rows without a readable task title or description are not routing context. Those records can exist as raw PFTL cache observations, but they should not be promoted into the user-visible task routing packet.

The generated profile source packet contains:

- account and profile snapshot;
- full current context document text;
- up to the last 3 deep memories;
- current Network Context Inputs text;
- current proposed, outstanding, and verification tasks;
- last 6 refused tasks;
- last 6 rewarded tasks.

The packet is private and visible only in the Memory page. It is stored for audit so users can see exactly what was sent to the model.

## Data Model

- Memory row: date, conversation title, user summary, assistant summary, memory summary.
- Deep memory job: account, block number, exact source memory entry IDs, retry and lock state.
- Deep memory row: batch number, user bullets, assistant bullets, combined memory summary. There is only one deep-memory row per account/block.
- Network Task Profile job: account, lock/retry state, source packet JSON/text, source packet digest.
- Network Task Profile row: source packet, generated output JSON/text, provider, model, prompt version, prompt digest, usage metadata, completed timestamp.
- Chat context injection: last 3 deep memories plus last 36 memory summaries.

## Diagram

```mermaid
sequenceDiagram
  participant Chat as Chat Response
  participant Worker as Memory Worker
  participant OR as ZDR Model
  participant DB as Postgres
  Chat-->>Worker: enqueue user plus assistant turn
  Worker->>OR: summarize
  OR-->>Worker: compressed memory
  Worker->>DB: insert memory row
  Worker->>DB: maybe create deep memory every 36 rows
```

```mermaid
sequenceDiagram
  participant UI as Memory Page
  participant API as Memory API
  participant DB as Postgres
  participant Worker as Memory Worker
  participant OR as OpenRouter ZDR
  UI->>API: GET /api/memory/network-task-profile
  API->>DB: read profile facts and task_projections for Network Context Inputs
  API->>DB: read latest generated profile
  API-->>UI: Network Context Inputs plus latest or pending profile
  API->>DB: enqueue profile job when missing or stale
  Worker->>DB: claim network_task_profile_jobs
  Worker->>OR: summarize source packet
  Worker->>DB: write network_task_profiles
```

## Failure Modes

- Memory jobs must not block chat responses.
- Network Task Profile jobs must not block Memory page rendering.
- Network Context Inputs should remain current even if profile generation fails.
- Memory failure should be logged and retryable.
- User-derived memory should be presented as memory context, not as app policy.
- Users should be able to inspect memory entries for trust.
