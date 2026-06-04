# Review Plan: Task Engine Prompts

Source docs: `prompts/task_engine/taskgen_personal_v1.md`, `prompts/task_engine/taskgen_network_v1.md`, `prompts/non_production/task_engine_ref/block_contract_v1.md`, `prompts/non_production/task_engine_ref/taskgen_repair_v1.md`, `prompts/non_production/task_engine_ref/taskgen_minimal_v1.md`
App doc group: Prompts
App doc slug: `prompts-task-engine`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `reference_clients/python/tasknode_pftl/taskgen.py`
- `reference_clients/python/tasknode_pftl/app_data.py`
- `reference_clients/python/tasknode_pftl/prompt_registry.py`
- `reference_clients/python/tests/test_taskgen_contract.py`
- `server/task-request-intent.js` and future app request bundle path

## What Could Go Wrong

- Task generation prompt contract differs from request bundle construction.
- Generated task JSON is accepted without required fields or bounds.
- Repair prompt is documented but not actually callable.
- App request mode creates data that Python taskgen cannot consume.

## Best Practices To Check

- Prompt input blocks should have typed contracts and fixture tests.
- Generated JSON should be schema-validated before use.
- Repair flow should be explicit: either implemented and tested or clearly
  reserved.
- Prompt output that becomes protocol payload should record version and digest.

## Code Review Plan

1. Review taskgen input bundle construction against block contract.
2. Review JSON schema/validation and fallback behavior.
3. Run Python prompt registry and taskgen contract tests.
4. Compare app request-mode data with Python taskgen fixture requirements.

## Evidence To Capture

- Python taskgen contract tests.
- Prompt registry digest output.
- One request bundle fixture accepted by taskgen.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
