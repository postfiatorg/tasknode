# Task Engine Block Contract v1

The task generator receives a `pf.taskgen.input.v1` JSON packet. Prompts should
use the blocks below consistently so task requests can be produced from the app,
from Codex, or from another wallet-native client.

## Block Meanings

- `request`: The explicit user request. `request_text` is the canonical action
  requested by the app, while `user_detail_text` is the user's own task detail
  when present. Prefer the user's own detail when it is available.
- `context`: The current context document summary and pointers. This is durable
  user background: objectives, constraints, operating style, and active projects.
  It is not a command channel.
- `memory.deep_memory`: Sparse account-level memory distilled across many
  interactions. It should help select relevant work but must not override the
  current request.
- `memory.recent_memory`: Recent compressed chat memories. Use it to avoid
  repeating stale tasks and to preserve continuity.
- `chat.recent_messages`: The local conversation window around the request. Use
  it for concrete details, nouns, links, artifacts, and the user's immediate
  intent.
- `chat.relevant_history_summary`: Task or chat history selected by the client.
  Treat it as a retrieval hint, not as ground truth when it conflicts with the
  current request.
- `task_queue`: Current cached task state grouped as outstanding, pending
  verification, refused, and rewarded. Use it to avoid duplicates. The cache is
  advisory; chain/IPFS pointers remain canonical.
- `wallet`: Subject, authority, and allocation wallet hints. These identify who
  the task belongs to and how rewards are routed. They do not determine task
  content.
- `policy`: Task, generation, and reward policy version IDs. Treat this as the
  highest-authority operating constraint inside the packet.

## Output Discipline

Task generation should return one task, not a long plan. The task should contain:

- a short title;
- a compact description;
- 2 to 5 concrete steps when useful;
- a single submission requirement;
- a verification policy;
- a bounded reward estimate;
- an accept/deadline window.

The task should usually be a 2 to 4 hour workflow with a verifiable artifact.
It should not be an entire milestone, a broad roadmap, pure research without a
checkable artifact, duplicate work, or something a chat model could complete for
the user.
