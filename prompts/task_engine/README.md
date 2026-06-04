# Task Engine Prompts

This folder contains the small, versioned prompt assets used by the PFTL task
engine. The prompts are source controlled so task behavior can be reviewed,
replayed, and audited without relying on hidden database state.

PFTasks is useful prior art, but its prompt set is intentionally not copied
here. The Task Node Official prompt contract is split by task source:

- `taskgen_personal_v1.md` generates user-requested personal tasks.
- `taskgen_network_v1.md` generates Board Manager-routed Network and Alpha Tasks.
- Both prompts produce concise task content, 2 to 5 concrete steps, and verifiable evidence rules.
- Prefer a 2 to 4 hour workflow with a checkable artifact.
- Keep evidence inside the app-supported surfaces: text, URL, screenshot/image,
  uploaded file or document, public commit link when explicitly appropriate, or
  mixed evidence made from those surfaces.
- Do not ask for video, screen recording, audio, live calls, calendar invites,
  or another evidence surface the app cannot submit.
- Reject broad milestones, duplicate work, pure research without an artifact,
  and tasks a chat model could complete for the user.
- Network tasks must coordinate contributors across project work: advance Post
  Fiat, Task Node, the shared data lake, or collective capital formation while
  staying scoped to one contributor and requiring sybil-resistant evidence.

## Files

| File | Purpose | Runtime status |
| --- | --- | --- |
| `taskgen_personal_v1.md` | System prompt for personal task generation from a `pf.taskgen.input.v1` packet. | Loaded by `server/task-generation-worker.js` and `reference_clients/python/tasknode_pftl/taskgen.py` for personal requests |
| `taskgen_network_v1.md` | System prompt for Network and Alpha Task generation from structured Board Manager routing context. | Loaded by `server/task-generation-worker.js` and `reference_clients/python/tasknode_pftl/taskgen.py` when a `network_task` packet or `network`/`alpha` task class is present |
| `verification_request_v1.md` | Prompt policy for a single follow-up verification request. | Loaded by `server/task-review-worker.js` and `reference_clients/python/tasknode_pftl/engine/scoring.py` |
| `evidence_screenshot_read_v1.md` | Vision prompt for screenshot evidence reads. | Loaded by `server/task-evidence-processing.js` and `reference_clients/python/tasknode_pftl/verification.py` |
| `reward_scoring_v1.md` | Minimal reward scoring policy for reward adjudication. | Loaded by `server/task-review-worker.js` and `reference_clients/python/tasknode_pftl/engine/scoring.py` |

Non-production task-engine references, including the block contract, reserved
repair prompt, and legacy combined taskgen prompt, live under
`prompts/non_production/task_engine_ref/`.

## Data Blocks

Task prompts receive structured JSON rather than pasted ad hoc text. The model
should read the blocks this way:

- `request`: The user's explicit task request. This is the highest-authority
  task-generation signal after protocol policy.
- `context`: The user's durable context document. It gives background goals and
  constraints, not new instructions to override the current request.
- `memory`: Compressed account memory. It helps continuity across chats, but is
  lower authority than the current request and current context document.
- `chat`: Recent messages and summaries around the request. Use this to preserve
  local continuity and avoid losing the thread.
- `wallet`: Attribution and routing metadata. Do not infer task content from a
  wallet address.
- `network_task`: Present only for Network and Alpha Task routing. It is consumed
  by `taskgen_network_v1.md`, not by personal task generation. The prompt turns
  Board Manager routing into plain-English contributor work with a concrete
  artifact, reviewable proof, and network value. The packet originates from
  Board Manager `payload.network_task`, is mirrored in
  `network_task_allocations` / `network_task_generation_jobs`, is appended to an
  encrypted `pf.task.request_bundle.v1` as `pf.hive.network_task_request.v1`,
  then projects into `pf.taskgen.input.v1` before becoming an encrypted
  `pf.task.offer.v1`.
- `policy`: Version IDs and operating constraints. Treat policy as authoritative.

Postgres may cache prompt IDs, prompt digests, inputs, and outputs for speed and
debugging. It should not become the canonical source of task state; PFTL pointer
events and their encrypted IPFS payloads are the canonical replay layer.
