# Review Plan: Reward Prompts

Source doc: `prompts/task_engine/reward_scoring_v1.md`
App doc group: Prompts
App doc slug: `prompts-reward`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `prompts/task_engine/reward_scoring_v1.md`
- `reference_clients/python/tasknode_pftl/scenarios/full_lifecycle.py`
- `reference_clients/python/tasknode_pftl/scenarios/multi_wallet_async_demo.py`
- Future reward scoring worker, if implemented
- Reward wallet/allocation transaction paths

## What Could Go Wrong

- Reserved reward prompt appears active even though reward scoring is not wired.
- Reward payment can occur without traceable task/evidence state.
- Reward amount policy differs between prompt, scenario, and app display.
- Allocation wallet failure is hidden behind a completed task state.

## Best Practices To Check

- Reward policy should be explicit, deterministic enough to audit, and versioned.
- Payments should be tied to task ID, evidence, authority, allocation wallet, and
  tx hash.
- Reserved prompts should not be invoked accidentally.
- Failed rewards should be visible and retryable without duplicate payment.

## Code Review Plan

1. Confirm whether reward scoring prompt has any runtime caller.
2. Review lifecycle scenario reward payment metadata.
3. Check app projection fields for reward status and reward tx hash.
4. Record gap between reserved scoring policy and actual reward flow.

## Evidence To Capture

- `rg` for `reward_scoring_v1`.
- Full lifecycle receipt showing reward payment metadata.
- Projection row or reducer output with reward state.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
