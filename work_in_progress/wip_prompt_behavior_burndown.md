# WIP Prompt Behavior Burndown

Status: proposed cleanup plan
Created: 2026-05-18
Owner: Task Node Official

## Objective

Remove semantic product behavior from hidden code branches and put it into
prompt contracts, prompt files, structured model outputs, or explicit user
controls.

This burndown applies the rule in `RULES.md`: examples from users are debugging
evidence, not product logic. Code may validate schemas, persist records, call
providers, parse mechanical formats, and render explicit structured fields. Code
must not decide task, evidence, verification, scoring, chat, or memory behavior
from keyword lists, literal phrase checks, or one-off hard-coded examples.

## Cleanup Rule

For every item below, the target state is:

- Semantic judgment lives in a prompt or explicit structured product contract.
- Runtime code passes structured context into that prompt.
- Runtime code validates the returned schema.
- UI renders the structured result instead of guessing from text.
- Tests prove the behavior class works with adjacent examples, not only the
  original failing sentence.

## Burndown

| ID | Priority | Surface | Current Violation | Target State | Status |
| --- | --- | --- | --- | --- | --- |
| PB-001 | P0 | Chat web search intent | `server/chat-search-tools.js` uses keyword signals like `search`, `today`, `latest`, and `current` to decide whether web search is enabled. | Replace keyword routing with a prompt-backed `chat_tool_intent` structured decision or an explicit user-selected search control. Billing preflight must consume the same structured decision. | Completed: OpenAI web search tool availability is prompt-governed; the keyword router was removed and preflight reserves max tool cost for Frontier modes. |
| PB-002 | P0 | Task evidence method UI | `src/features/tasks/TaskDetailModal.jsx` guesses evidence type from task text with words like `github`, `screenshot`, `code`, `url`, and `pdf`. | Remove UI guessing. Task generation must produce structured `submission_requirement` and `verification_policy` fields; the modal renders those fields exactly. | Completed: UI now uses structured submission/verification fields only. |
| PB-003 | P0 | Python task generation fallback | `reference_clients/python/tasknode_pftl/taskgen.py` has `_fallback_task()` that hard-codes a complete generated task. | Production task generation must fail visibly if the provider is unavailable. Test/demo fixtures must live outside runtime generation and be clearly labeled as fixtures. | Completed: deterministic fallback generation and CLI fallback flags were removed. |
| PB-004 | P0 | Verification request generation | `reference_clients/python/tasknode_pftl/taskgen.py` hard-codes the verification request text. | `verification_request_v1.md` must be executed through the model path and return structured verification requirements. Code should only validate and publish the result. | Completed: legacy helper now fails; live scenarios use prompt-backed `generate_verification_request`. |
| PB-005 | P0 | Canonical local JSON task loop | `reference_clients/python/tasknode_pftl/scenarios/local_json_task_loop.py` hard-codes a GitHub commit/repository evidence requirement. | The demo should use the same taskgen prompt path as live flows, or load a named fixture that is visibly a fixture. It must not present repository links as the canonical default. | Completed: local-only demo reads a named fixture and uses text receipt evidence. |
| PB-006 | P0 | Evidence suite defaults | `reference_clients/python/tasknode_pftl/engine/evidence_suite.py` hard-codes public gist evidence, maps `github` to `github_commit`, and chooses mixed evidence strategies in code. | Evidence handlers should be selected from the structured task requirement. Demo evidence should be explicit fixture input, not hidden policy. | Completed: hidden gist default and github alias were removed; URL/mixed plans require explicit fixture/user URL. |
| PB-007 | P1 | Multi-wallet scenario prompt fragments | `reference_clients/python/tasknode_pftl/scenarios/task_engine_stage_b.py` hard-codes scenario-specific prompt fragments and evidence strategies. | Replace embedded behavior with ten fixture user packets plus live prompt calls. Offline tests may snapshot outputs, but should not encode task policy in Python branches. | Completed: Stage B cases moved to `reference_clients/python/tasknode_pftl/fixtures/stage_b_cases.json`. |
| PB-008 | P1 | External URL verification policy | `reference_clients/python/tasknode_pftl/verification.py` rejects or accepts evidence classes through code-level URL policy. | Keep URL fetching/parsing mechanical. Let task verification prompts decide whether the fetched content satisfies the task. Unsupported transport errors should be typed, not semantic policy. | Completed: URL classification now validates only URL transport shape; content usefulness is left to evidence extraction and verification prompts. |
| PB-009 | P1 | Context unlock error handling | `src/main.jsx` checks whether an error string contains `unlock` to stop preview hydration. | Return typed wallet/context errors from the API and branch on the typed status. | Completed: hydration errors now carry codes and preview batching branches on those codes. |
| PB-010 | P1 | Duplicate task request handling | `server/task-request-intent.js` falls back to checking whether an error message contains `duplicate`. | Use Postgres constraint codes or repository-level typed errors only. | Completed: duplicate handling now uses Postgres constraint code only. |
| PB-011 | P1 | PFTL connection error rewrite | `server/pftl-submit.js` classifies transport failures with regex and rewrites `rippled`/`xrpl` wording to `PFTL`. | Normalize provider/network errors at the PFTL client boundary with typed error codes and user-facing messages. Do not rewrite arbitrary exception strings. | Completed: transport mapping uses exact error codes and otherwise returns a generic PFTL connect failure. |
| PB-012 | P1 | Unknown chat mode fallback | `server/chat-router.js` silently maps unknown modes to `Private Instant`. | Reject unknown modes with a typed validation error. UI should send one of the known product modes. | Completed: unknown chat modes return `unknown_chat_mode`. |
| PB-013 | P2 | Product metadata string matching | `server/product-contracts.js` derives latency metadata from whether a label includes `Thinking`. | Store latency and reasoning metadata as explicit product contract fields. | Completed: latency metadata now comes from explicit reasoning config. |

## Prompt Work Required

| Prompt Area | File Target | Required Behavior |
| --- | --- | --- |
| Chat tool intent | `prompts/chat/task_node_instructions_v1.md` | Frontier modes expose the web search tool; the assistant prompt instructs when the model should use it. Billing preflight reserves the maximum configured tool budget for Frontier requests. |
| Task generation | `prompts/task_engine/taskgen_minimal_v1.md` or successor | Produce task content, reward offer, submission requirement, evidence expectations, and verification policy without UI/code guessing. |
| Verification request | `prompts/task_engine/verification_request_v1.md` | Given the task and first submission, produce the next verification request. Private-work tasks should prefer screenshot, code excerpt, text evidence, or local artifact proof when public links are not appropriate. |
| Reward scoring | `prompts/task_engine/reward_scoring_v1.md` | Score submitted verification evidence against the task and verification request, then return structured reward outcome fields. |

## Implementation Order

1. Remove task/evidence UI guessing first: PB-002.
2. Remove deterministic Python task and verification fallbacks: PB-003 and PB-004.
3. Convert the local JSON and multi-wallet demos to use prompt-backed task and verification flows: PB-005, PB-006, PB-007.
4. Replace chat web-search keyword routing with a structured prompt decision or explicit search control: PB-001.
5. Replace string/error-message branching with typed API errors: PB-009, PB-010, PB-011, PB-012.
6. Clean minor product metadata heuristics: PB-013.

## Acceptance Criteria

- No task evidence method is chosen by scanning task text for keywords.
- No production task generation path returns a hidden hard-coded fallback task.
- No production verification request is hard-coded in runtime code.
- Chat web search is enabled by a prompt-backed structured decision or explicit
  user action, not by keyword arrays.
- Prompt files describe the product behavior in plain language.
- Runtime tests include paraphrases and adjacent cases for every migrated
  semantic behavior.
- Fixtures are named fixtures and cannot be mistaken for live product logic.

## Verification Commands

Run after each cleanup pass:

```bash
npm run quality
npm run security-smoke
npm run runtime-smoke
npm run chat-attachment-smoke
python -m pytest reference_clients/python/tests
git diff --check
```
