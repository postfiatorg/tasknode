# Memory

Memory is lightweight compression of user and assistant interactions. It helps future chats know what the user has been exploring without replaying entire conversations.

## User Flow

1. A user receives an assistant response.
2. The app returns the response immediately.
3. A background worker summarizes the user request and assistant response.
4. Every 36 memory rows, a deep memory job snapshots the exact 36 source memory row IDs and compresses those summaries into broader user, assistant, and memory bullets.
5. The Memory page renders a Network Diagnostic Report that combines the generated Network Task Profile with live Network Context Inputs from profile/task projections.
6. The async Network Task Profile job summarizes the source packet for future network task routing, while live inputs continue to refresh independently.
7. The Memory page lets the user inspect what the system remembers, what the generated report says, and what inputs the report is built from.

## Technical Architecture

The memory UI is `src/features/memory/MemoryView.jsx`. Backend memory logic is in `server/chat-memory-worker.js`, `server/chat-memory-context.js`, `server/repositories/chat-memory.js`, and `server/repositories/network-task-profile.js`. Migrations are `server/db/migrations/004_chat_memory.sql`, `server/db/migrations/005_deep_chat_memory.sql`, `server/db/migrations/013_deep_memory_snapshots.sql`, and `server/db/migrations/024_network_task_profiles.sql`.

Private memory jobs use the configured OpenRouter ZDR model path. Memory writes are not billed to the user right now. Ordinary chat model tokens remain billable.

Deep-memory jobs are stable snapshots. `chat_deep_memory_jobs.source_entry_ids` stores the exact 36 `chat_memory_entries.id` values selected when the block is queued. The worker reads those IDs directly instead of recalculating the block later from timestamps, so backfills, imports, or corrected timestamps cannot change what a queued deep-memory job summarizes. `chat_memory_entries` also enforces one `deep_memory` row per account and block index, so retrying or recreating a deep-memory job updates the existing block summary rather than creating duplicates.

Network Task Profile jobs use the same memory worker and OpenRouter ZDR route. The prompt is `prompts/memory/network_task_profile_v2.md`. The API route is `GET /api/memory/network-task-profile`; `POST /api/memory/network-task-profile` requests a refresh. The generated profile is not required for the page to render. Network Context Inputs are built from profile data and routable `task_projections` on every route read and are returned even while a profile job is pending.

## Network Task Profile

The Memory page shows one task-routing report with two layers:

- Generated Network Task Profile: an async LLM-generated diagnostic report stored in `network_task_profiles`.
- Network Context Inputs: real-time public profile facts plus current task projection text.

In the UI, these are concatenated in the same Network Diagnostic Report card. The generated report appears first because it is the human-readable interpretation. Network Context Inputs appear immediately underneath as the live evidence block, so the user can compare the model summary with the current profile/task state without opening a second section.

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

The generated profile answers three questions only: current focus, primary contribution ability, and "Companies this User Would Move the Needle At." It does not generate "best task types", avoidance lists, routing reasons, or caveats. The routing layer can use the report as context, but the user-facing text should read like a diagnostic understanding of the member rather than a task assignment policy.

## Memory Tab

The Memory tab is an audit surface. It does not silently hide model-derived profile assumptions.

The top card is `Network Diagnostic Report`:

- The first part is generated by `prompts/memory/network_task_profile_v2.md`.
- It shows the generated role title, current focus, primary contribution ability, and companies where the user would move the needle.
- The second part is `Network Context Inputs`, a live text block built directly from profile and task projection rows.
- `View full source packet` shows the exact text packet sent to the model for the latest generated report.

The generated report and Network Context Inputs intentionally live in the same card. The generated report is the interpretation; Network Context Inputs are the evidence. If they disagree, the live inputs are the fresher product state, and the user can refresh the report.

The lower sections remain normal memory inspection:

- `Deep Memory`: the last 3 deep-memory bundles.
- `Memory`: the last 36 ordinary memory summaries.

## Prompt Construction

The Network Diagnostic Report prompt receives a `NETWORK TASK PROFILE SOURCE PACKET`, not raw chat history. `server/repositories/network-task-profile.js::buildNetworkTaskProfileSourcePacket` constructs that packet from bounded product state:

- `Account`: account id and identity context.
- `Network Context Inputs`: live public profile facts plus routable task state grouped by Proposed, Outstanding, Verification, Refused, and Rewarded.
- `Context Document`: the current saved context document text.
- `Deep Memory`: up to the last 3 deep-memory bundles.
- `Recently Refused Tasks`: last 6 compact refused/cancelled task summaries.
- `Recently Rewarded Tasks`: last 6 compact rewarded task summaries.

The prompt is versioned as `network_task_profile_v2`. The worker stores `prompt_version`, `prompt_digest`, `source_packet_digest`, the full source packet, provider/model metadata, and usage metadata in `network_task_profiles`. If the prompt version changes, `GET /api/memory/network-task-profile` queues a fresh async job so old profile shapes do not remain authoritative.

The prompt output contract is deliberately small:

```json
{
  "profile_title": "Concise professional role title",
  "current_focus": ["3 to 6 bullets"],
  "primary_contribution_ability": ["3 to 6 bullets"],
  "domain_expertise": ["5 to 10 public-company fit bullets"]
}
```

The UI labels `domain_expertise` as `Companies this User Would Move the Needle At`. The JSON key stays stable so existing rows and parsers do not break.

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
  API-->>UI: Network Diagnostic Report data
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
