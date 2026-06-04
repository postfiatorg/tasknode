# WIP Task Prompt Inventory

Status: current implementation inventory as of 2026-05-18.

## Operational Answer

The app can currently record a task request intent from Chat. It does not yet
turn that UX action into a live PFTL task offer by itself. The live end-to-end
task request, generation, verification request, verification response, reward,
and replay path exists in the Python reference client.

Production task generation prompts now live in `prompts/task_engine/`.
The Python reference client loads the active prompt files and records prompt
digests in taskgen and verification metadata.

## Prompt Surfaces

| Surface | Status | File | Prompt / Policy ID | Provider / Model | Notes |
| --- | --- | --- | --- | --- | --- |
| Chat base assistant | Active app chat | `server/chat-memory-context.js` | implicit `taskNodeInstructions` | OpenAI or OpenRouter depending chat mode | System instructions for Task Node chat. Memory is appended as background context, not command authority. |
| Turn memory summary | Active async memory worker | `server/chat-memory-worker.js` | `chat_memory_v1` | OpenRouter, default `deepseek/deepseek-v4-flash` | Summarizes one user/assistant exchange into user summary, system summary, and memory text. |
| Deep memory summary | Active async memory worker | `server/chat-memory-worker.js` | `deep_memory_v1` | OpenRouter, default `deepseek/deepseek-v4-flash` | Triggered every 36 turn-memory records; produces account-level memory. |
| Task request intent | Active UX correlation only | `server/task-request-intent.js` | `pf.task.request_intent.v1` | None | Records canonical request text plus user detail text. Does not generate a task yet. |
| Personal task generation | Active app worker and Python replay | `prompts/task_engine/taskgen_personal_v1.md`, selected by `server/task-generation-worker.js` and `reference_clients/python/tasknode_pftl/taskgen.py` | `taskgen_personal_v1` | OpenAI, default `chat-latest` | Generates personal `pf.taskgen.output.v1` tasks with title, description, task kind, steps, submission requirement, verification policy, reward offer, deadline. |
| Network task generation | Active app worker and Python replay | `prompts/task_engine/taskgen_network_v1.md`, selected when a `network_task` packet or `network`/`alpha` task class is present | `taskgen_network_v1` | OpenAI, default `chat-latest` | Generates Network/Alpha `pf.taskgen.output.v1` tasks from structured Board Manager routing context. |
| Task generation schema | Active Python replay only | `reference_clients/python/tasknode_pftl/taskgen.py` | `TASKGEN_RESPONSE_FORMAT` | OpenAI Chat Completions JSON schema | Strict output shape for task generation. |
| Verification request | Active Python replay only | `prompts/task_engine/verification_request_v1.md`, referenced by `reference_clients/python/tasknode_pftl/taskgen.py` | `verification_request_v1` | None currently | Deterministic follow-up ask generated from task offer and initial submission; prompt policy is present for the future model-backed verifier. |
| Screenshot evidence read | Active Python verification examples | `prompts/task_engine/evidence_screenshot_read_v1.md`, loaded by `reference_clients/python/tasknode_pftl/verification.py` | `evidence_screenshot_read_v1` | OpenAI Responses, default `gpt-5.5` | Reads visible screenshot evidence. PDF, DOCX, and URL readers are deterministic extractors. |
| Verification response packet | Active Python verification examples | `reference_clients/python/tasknode_pftl/verification.py` | `pf.task.verification_response.v1` | None | Builds canonical packet from evidence summaries. |
| Reward scoring | Not implemented in Task Node Official | n/a | n/a | n/a | PFTasks has reference reward prompts, but this repo has not ported scoring prompts yet. Current Python replay issues deterministic reward from the generated offer. |
| Motivation | Prompt research / product surface, not currently wired as task engine | `prompts/non_production/steve_jobs_ref/openai_jobs_motivation.md`, `prompts/non_production/steve_jobs_ref/steve_jobs_*.md` | prompt artifact | n/a | These are not task generation prompts and should not be treated as production task-engine policy. |

## Current Task Generation Prompts

Files:

- `prompts/task_engine/taskgen_personal_v1.md`
- `prompts/task_engine/taskgen_network_v1.md`

The prompts are intentionally split. Personal task generation receives user
request, context, memory, chat, relevant history, task queue, wallet, and policy
blocks. Network task generation receives those blocks plus structured
`network_task` routing context from Board Manager and owns translating routing
shorthand into contributor-facing work.

The user prompt is assembled as:

```text
Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.

<canonical JSON taskgen input packet>
```

## Current Verification Request Text

Policy file: `prompts/task_engine/verification_request_v1.md`

Current deterministic v1 text in `reference_clients/python/tasknode_pftl/taskgen.py`:

```text
Confirm the run completed end to end. Include the request, offer, acceptance, submission, verification response, and reward transaction hashes, plus the replayed final status.
```

This is deterministic v1 behavior. It should become policy-driven before the
app exposes live task issuance to normal users.

## Current Screenshot Evidence Prompt

File: `prompts/task_engine/evidence_screenshot_read_v1.md`

```text
Read this screenshot as Task Node verification evidence.
Return a concise evidence description. Include visible text, completion state, important UI state, and any proof-relevant numbers.
Do not invent hidden state. If a claim is not visible, say so.

Task title: ...
Task description: ...
Verification criteria: ...
```

## Gaps Before UX Live Task Requests

- Wire Chat `task_request_intent` to live server-side PFTL request creation.
- Add a task authority worker that generates offers and writes PFTL pointers.
- Add verification request policies by submission type.
- Add reward scoring policies, or explicitly keep v1 deterministic reward
  issuance for constrained testnet tasks.
- Make the projection cache sync from chain/RPC workers, not only imported
  replay receipts.
