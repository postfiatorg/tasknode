# Sybil Enforcement State Tracker Evidence

Task: `task_237cd8157cf717e90bdaf5c889d36356`

## Delivered Bundle

- Script: `scripts/orc-sybil-enforcement-state-tracker.mjs`
- Inputs:
  - `inputs/sample_sybil_risk_matrix.json`
  - `inputs/enhanced_suppression_config.json`
  - `inputs/sample_verifier_report.json`
- Generated outputs:
  - `outputs/enforcement_state.json`
  - `outputs/state_report.json`
  - `outputs/discord_summary.md`
  - `outputs/query_violation_wallet.json`
  - `outputs/list_gap_only.json`
  - `outputs/state_after_add.json`
  - `outputs/state_after_update.json`
  - `outputs/add_output.json`
  - `outputs/update_output.json`

## Source Grounding

The sample bundle preserves the source lineage requested in the task:

- Risk matrix: `task_78bc0498dfcc292ed909b1da6743a1ba`, CID `QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB`
- Suppression config/integrator: `task_e2473aa56887d24f354d008c553ffc57`, CID `Qme8s5wg6C69EnUbEZ6hCahNYN9vNocaJRdxWNak2KX4gc`
- Enforcement verifier: `task_06376269c285c93f098d02f585d2dc92`, CID `QmdUzjpPXHm2kLjEBxxMJ5drxCFKUqWCvwbj92MhzyAAJe`

The verifier input is a task-local fixture modeled on the verifier report schema. It exercises `enforced`, `violated`, `expired`, `not_tested`, and missing-verification coverage so the state tracker can prove its gap detection paths.

## Commands Run

```bash
node scripts/orc-sybil-enforcement-state-tracker.mjs batch \
  --risk-matrix docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/inputs/sample_sybil_risk_matrix.json \
  --suppression-config docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/inputs/enhanced_suppression_config.json \
  --verifier-report docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/inputs/sample_verifier_report.json \
  --out docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs \
  --generated-at 2026-06-20T06:20:00.000Z

node scripts/orc-sybil-enforcement-state-tracker.mjs query \
  --state docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/enforcement_state.json \
  --wallet r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB

node scripts/orc-sybil-enforcement-state-tracker.mjs list \
  --state docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/enforcement_state.json \
  --gap-only

node scripts/orc-sybil-enforcement-state-tracker.mjs add \
  --state docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/enforcement_state.json \
  --wallet rManualWatchState8888888888888888888 \
  --risk-score 45 \
  --risk-band watch \
  --suppression-status not_suppressed \
  --verification-status not_tested \
  --last-verified-at 2026-06-20T06:25:00.000Z \
  --gap manual_follow_up_needed \
  --out docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/state_after_add.json

node scripts/orc-sybil-enforcement-state-tracker.mjs update \
  --state docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/state_after_add.json \
  --wallet rManualWatchState8888888888888888888 \
  --suppression-status suppression_recommended \
  --verification-status enforced \
  --last-verified-at 2026-06-20T06:30:00.000Z \
  --out docs/verification/sybil_enforcement_state_tracker_task_237cd8157cf717e90bdaf5c889d36356/outputs/state_after_update.json
```

## Output Metrics

`outputs/enforcement_state.json` summary:

- Wallets tracked: 16
- Risk bands covered: `high_review_priority`, `watch`, `low`, `unknown`
- Suppression entries represented: 11
- Verifier contributor rows represented: 6
- Verification status counts: 10 `missing_verification`, 2 `enforced`, 2 `not_tested`, 1 `violated`, 1 `expired`
- Wallets with detected gaps: 10
- Explicit post-suppression active allocation finding: `r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB`

The `query` command proves wallet-level lookup for the violated sample wallet. The `list --gap-only` command returned 10 gap rows. The `add` command wrote a 17-wallet state file, and the `update` command changed the manual wallet to `suppression_recommended` plus `enforced` while preserving the manual follow-up gap.

## Operational Boundary

This bundle is read-only and recommend-only. It writes local JSON/Markdown artifacts only. It does not mutate live routing, sign transactions, ban accounts, blacklist accounts, claw back rewards, move PFT, or deploy. Any operational enforcement requires separate human approval and a different signed flow.
