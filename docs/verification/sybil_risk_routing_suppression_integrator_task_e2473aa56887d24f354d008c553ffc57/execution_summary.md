# Sybil Risk Routing Suppression Integrator

Task: `task_e2473aa56887d24f354d008c553ffc57`

Reviewer: `@goodalexander`

## Objective

Build the integration layer between the Unified XRPL Sybil Risk Matrix (`task_78bc0498dfcc292ed909b1da6743a1ba`) and the Contributor Routing Suppression Config Generator (`task_c4682ae05cbc47f9669a58d5121cf38d`).

The delivered script reads a risk matrix, applies a configurable threshold, merges qualifying wallets into an existing routing suppression config, and emits an enhanced suppression config plus a reconciliation report.

## Files

- Script: `scripts/orc-sybil-risk-routing-suppression-integrator.mjs`
- Sample risk matrix: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/sample_sybil_risk_matrix.json`
- Sample existing suppression config: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/sample_existing_suppression_config.json`
- Enhanced config output: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/outputs/enhanced_suppression_config.json`
- Reconciliation report: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/outputs/reconciliation_report.json`
- Discord-ready summary: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/outputs/discord_summary.md`
- Batch stdout capture: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/outputs/batch_output.json`
- Help output: `docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/help_output.txt`

## Command

```bash
node scripts/orc-sybil-risk-routing-suppression-integrator.mjs batch \
  --risk-matrix docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/sample_sybil_risk_matrix.json \
  --suppression-config docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/sample_existing_suppression_config.json \
  --out docs/verification/sybil_risk_routing_suppression_integrator_task_e2473aa56887d24f354d008c553ffc57/outputs \
  --threshold 60 \
  --score-field reviewPriorityScore \
  --generated-at 2026-06-20T05:30:00.000Z
```

## Sample Run Result

- Risk matrix wallets scanned: `13`
- Risk levels covered: `high_review_priority=9`, `watch=1`, `low=3`
- Existing suppression entries: `3`
- Threshold: `reviewPriorityScore >= 60`
- Qualifying Sybil-risk wallets: `9`
- Below threshold / not added: `4`
- Enhanced suppression entries: `11`
- Added automatic Sybil-risk entries: `8`
- Updated existing entries with Sybil-risk metadata: `1`
- Unchanged existing entries: `2`

## Boundary

This is an artifact-generation tool only. It did not mutate live routing, ban accounts, sign enforcement payloads, move funds, claw back rewards, or deploy code. Every generated entry keeps `requiresHumanApproval: true` and `operationalUseAllowed: false`.
