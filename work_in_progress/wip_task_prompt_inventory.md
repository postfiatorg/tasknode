# WIP Task Prompt Inventory

Status: current implementation inventory as of 2026-05-18.

## Operational Answer

The app can currently record a task request intent from Chat. It does not yet
turn that UX action into a live PFTL task offer by itself. The live end-to-end
task request, generation, verification request, verification response, reward,
and replay path exists in the Python reference client.

Production task generation prompts are not yet centralized in `prompts/`.
The active task prompt logic lives beside the code that executes it.

## Prompt Surfaces

| Surface | Status | File | Prompt / Policy ID | Provider / Model | Notes |
| --- | --- | --- | --- | --- | --- |
| Chat base assistant | Active app chat | `server/chat-memory-context.js` | implicit `taskNodeInstructions` | OpenAI or OpenRouter depending chat mode | System instructions for Task Node chat. Memory is appended as background context, not command authority. |
| Turn memory summary | Active async memory worker | `server/chat-memory-worker.js` | `chat_memory_v1` | OpenRouter, default `deepseek/deepseek-v4-flash` | Summarizes one user/assistant exchange into user summary, system summary, and memory text. |
| Deep memory summary | Active async memory worker | `server/chat-memory-worker.js` | `deep_memory_v1` | OpenRouter, default `deepseek/deepseek-v4-flash` | Triggered every 36 turn-memory records; produces account-level memory. |
| Task request intent | Active UX correlation only | `server/task-request-intent.js` | `pf.task.request_intent.v1` | None | Records canonical request text plus user detail text. Does not generate a task yet. |
| Task generation | Active Python replay only | `reference_clients/python/tasknode_pftl/taskgen.py` | `taskgen-minimal-v1` | OpenAI, default `chat-latest` | Generates `pf.taskgen.output.v1` with title, description, task kind, submission requirement, verification policy, reward offer, deadline. |
| Task generation schema | Active Python replay only | `reference_clients/python/tasknode_pftl/taskgen.py` | `TASKGEN_RESPONSE_FORMAT` | OpenAI Chat Completions JSON schema | Strict output shape for task generation. |
| Verification request | Active Python replay only | `reference_clients/python/tasknode_pftl/taskgen.py` | `verification-minimal-v1` | None currently | Deterministic follow-up ask generated from task offer and initial submission, not an LLM prompt yet. |
| Screenshot evidence read | Active Python verification examples | `reference_clients/python/tasknode_pftl/verification.py` | implicit screenshot evidence prompt | OpenAI Responses, default `gpt-5.5` | Reads visible screenshot evidence. PDF, DOCX, and URL readers are deterministic extractors. |
| Verification response packet | Active Python verification examples | `reference_clients/python/tasknode_pftl/verification.py` | `pf.task.verification_response.v1` | None | Builds canonical packet from evidence summaries. |
| Reward scoring | Not implemented in Task Node Official | n/a | n/a | n/a | PFTasks has reference reward prompts, but this repo has not ported scoring prompts yet. Current Python replay issues deterministic reward from the generated offer. |
| Motivation | Prompt research / product surface, not currently wired as task engine | `prompts/openai_jobs_motivation.md`, `prompts/steve_jobs_*.md` | prompt artifact | n/a | These are not task generation prompts and should not be treated as production task-engine policy. |

## Current Task Generation Prompt

File: `reference_clients/python/tasknode_pftl/taskgen.py`

```text
You generate one concise Task Node task.
Return only JSON. No markdown.
The task must be specific, useful, and verifiable.
Do not include unrelated PFTasks legacy fields.
Use reward_offer.amount_estimate_pft as a decimal string from 0.50 to 5.00 unless the input packet explicitly says otherwise.
```

The user prompt is assembled as:

```text
Generate a minimal Task Node task from this input packet. Return JSON matching schema pf.taskgen.output.v1.

<canonical JSON taskgen input packet>
```

## Current Verification Request Text

File: `reference_clients/python/tasknode_pftl/taskgen.py`

```text
Confirm the run completed end to end. Include the request, offer, acceptance, submission, verification response, and reward transaction hashes, plus the replayed final status.
```

This is deterministic v1 behavior. It should become policy-driven before the
app exposes live task issuance to normal users.

## Current Screenshot Evidence Prompt

File: `reference_clients/python/tasknode_pftl/verification.py`

```text
Read this screenshot as Task Node verification evidence.
Return a concise evidence description. Include visible text, completion state, important UI state, and any proof-relevant numbers.
Do not invent hidden state. If a claim is not visible, say so.

Task title: ...
Task description: ...
Verification criteria: ...
```

## Gaps Before UX Live Task Requests

- Move task prompt policies into a small versioned registry instead of leaving
  them embedded in Python functions.
- Wire Chat `task_request_intent` to live server-side PFTL request creation.
- Add a task authority worker that generates offers and writes PFTL pointers.
- Add verification request policies by submission type.
- Add reward scoring policies, or explicitly keep v1 deterministic reward
  issuance for constrained testnet tasks.
- Make the projection cache sync from chain/RPC workers, not only imported
  replay receipts.
