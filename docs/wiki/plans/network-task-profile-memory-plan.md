# Network Task Profile Memory Plan

Status: planning

Objective: add an auditable Memory feature that turns a member's current context, memory, profile, and task state into a clean descriptive packet for routing network tasks.

This is not a public profile and not a social feed. It is a user-visible operating profile that answers: what work should the network route to this member right now?

## Product Shape

The Memory page should gain a `Network Task Profile` section near Deep Memory.

The section should show:

- the latest generated Network Task Profile;
- when it was generated;
- the model/provider used;
- the packet digest and prompt digest;
- the exact source counts used, such as 3 deep memories, 1 context document, 4 outstanding tasks, 6 refused tasks, 6 rewarded tasks;
- a `View source packet` disclosure so the user can audit what was sent to the model.

The user should be able to understand and challenge the generated routing profile. The profile must never be hidden system knowledge.

## Source Packet

The source packet is human-readable first, JSON-serializable second. It should have stable headers so both users and models can inspect it.

Canonical packet sections:

```text
NETWORK TASK PROFILE SOURCE PACKET

Generated At
<UTC timestamp>

Account
<account id, display name if present, linked public handles if present>

Profile Snapshot
<private/public profile summary, skills, archetype, alignment score, contribution/reward facts>

Context Document
<full current context document text>

Deep Memory
<up to last 3 deep memory bundles, newest first>

Outstanding Tasks
<all current outstanding tasks, compacted>

Recently Refused Tasks
<last 6 refused tasks, compacted>

Recently Rewarded Tasks
<last 6 rewarded tasks, compacted>
```

Task entries should not include full task forensics, transaction history, evidence payloads, CIDs, or step-by-step event lineage. They should include only what is useful for task routing:

```text
Task: <title>
Kind: <kind>
Status: <status>
Reward: <offered or paid PFT>
Summary: <what the task asked for>
Outcome: <reward summary, refusal reason, cancellation reason, or current next action>
Updated: <timestamp>
```

The packet should preserve enough specificity to route useful work without flooding the model with chain audit detail.

## Model Job

Name: `network_task_profile_v1`

Provider:

- OpenRouter private route;
- DeepSeek Flash class model with ZDR;
- `data_collection: "deny"` when supported by the provider route;
- structured JSON output;
- temperature `0`;
- not billed to the user in v1.

The model receives the source packet and returns a Network Task Profile.

Expected output:

```json
{
  "profile_title": "Concise role for network task routing",
  "routing_summary": "Short explanation of what work should be routed to this member.",
  "best_task_types": [
    "task type this member is well suited for"
  ],
  "avoid_task_types": [
    "task type that should not be routed right now"
  ],
  "current_capacity_signal": "high|medium|low|unknown",
  "routing_reasons": [
    "specific reason from context, memory, profile, or task outcomes"
  ],
  "confidence": "high|medium|low",
  "user_visible_caveats": [
    "thin data, stale context, many refusals, or other limitations"
  ]
}
```

The generated text should be direct and human-readable. It should describe outcomes and fit, not mechanical implementation details. A member should be able to read it and understand why the network would offer them a specific task.

## Data Model

Add a table for generated rows:

```sql
network_task_profiles (
  id text primary key,
  account_id text not null,
  status text not null,
  source_packet_json jsonb not null,
  source_packet_text text not null,
  source_packet_digest text not null,
  output_json jsonb not null default '{}',
  output_text text not null default '',
  provider text not null default '',
  model text not null default '',
  prompt_version text not null default 'network_task_profile_v1',
  prompt_digest text not null default '',
  error text not null default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  superseded_at timestamptz
)
```

Only one completed row should be active per account. Older completed rows can remain for audit history but should be marked superseded.

The job should also have a durable queue/lock path, either in a dedicated `network_task_profile_jobs` table or by following the existing chat memory job pattern if that abstraction is extracted.

## Trigger Policy

The job is asynchronous and must not block chat, task pages, or Memory page loading.

Triggers:

- Memory page opens and no Network Task Profile exists.
- User clicks `Refresh Network Task Profile`.
- Deep memory block completes.
- Current context document changes materially.
- Task projection state changes in outstanding, refused, or rewarded buckets.
- Profile snapshot changes.

Debounce:

- do not regenerate more than once every 30 minutes automatically;
- manual refresh can bypass the debounce but should show pending state;
- if the source packet digest has not changed, do not call the model.

## UX In Memory

Memory should show three layers:

1. `Network Task Profile`: current routing profile and source packet audit.
2. `Deep Memory`: last 3 deep memory bundles.
3. `Recent Memory`: last 36 memory summaries.

The Network Task Profile card should include:

- title;
- routing summary;
- best task types;
- avoid task types;
- capacity signal;
- confidence;
- caveats;
- generated timestamp;
- `View source packet`;
- `Refresh`.

The source packet view should be readable text, not only JSON. Users need to see exactly what the model saw.

## Prompt Contract

Prompt file: `prompts/memory/network_task_profile_v1.md`

Prompt intent:

```text
You create a user-visible Network Task Profile from a Task Node source packet.
This profile is used to route future network tasks.
Write plainly. Do not use jargon, corporate filler, or vague praise.
Explain what kinds of tasks this member should receive, what tasks should be avoided, and why.
Base every claim on the packet. If evidence is thin, say so.
Return only the requested JSON.
```

The prompt should not contain hard-coded examples of specific users, task IDs, or literal current failures. Behavior belongs in the prompt policy and structured output, not regex or one-off code paths.

## Privacy Boundary

This feature is private by default.

The source packet may include the full current context document and deep memory, so it must not be exposed on public profile pages, Hive pages, task cards, or public APIs.

The packet can be used internally for task routing only after the user can audit it in Memory. Later sharing to network routing surfaces should be gated by explicit settings.

Do not include:

- wallet seeds;
- encrypted payload plaintext from other users;
- raw evidence files;
- full task forensics;
- full chat transcripts;
- private profile NFT prompts;
- hidden provider metadata that does not help the user understand routing.

## Routing Use

Once generated, the Network Task Profile becomes an input to network task generation and assignment.

The task router should use it as one input, not as an authority. Routing should still consider:

- current outstanding task count;
- refusal rate;
- recent reward quality;
- user availability settings;
- wallet/task state;
- network priority.

The profile should help decide what to offer, not force a task onto a user.

## Acceptance Criteria

V1 is complete when:

- Memory page shows a Network Task Profile section.
- The generated profile is stored in Postgres with source packet and output digests.
- The user can inspect the exact source packet.
- The source packet includes full context document, up to 3 deep memories, current outstanding tasks, last 6 refused tasks, last 6 rewarded tasks, and profile information.
- Refused/rewarded task entries are compact and do not include full forensics.
- The worker uses a ZDR DeepSeek Flash class route and does not block chat.
- Source packet digest prevents repeated model calls when nothing changed.
- In-app docs list the packet shape, trigger policy, privacy boundary, and Memory UX.

## Out Of Scope For V1

- Public sharing of the Network Task Profile.
- Automatic task assignment without user review.
- Full vector retrieval over every task.
- Full transaction forensics in the source packet.
- Billing users for the background generation job.
- Social recommendations or connection graph changes.
