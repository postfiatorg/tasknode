# Sybil Enforcement Provenance Audit Trail

Task: `task_3acca09c782268d962c323fc09161c68`

## What Changed

Added `scripts/orc-sybil-provenance-audit-trail.mjs`, a read-only provenance audit tool that reconstructs chronological per-wallet timelines from:

- risk-matrix flagging source: `task_78bc0498dfcc292ed909b1da6743a1ba`, CID `QmcLKpe9ckisrEhc4tps4xiwuQLsBM7rD5eBRWhBJUkEgB`;
- suppression source: `task_e2473aa56887d24f354d008c553ffc57`, CID `QmczB9qF2TfMs9ZDsLbx8gasowsp92EmAXzAj4Cej26xRL`;
- enforcement-state source: `task_237cd8157cf717e90bdaf5c889d36356`, CID `QmfPtUP4hDUejirB1FRmaW1faNmxrKpwBnCDsRekiRZhCR`.

The script maps the fields needed for flagging, suppression, enforcement verification, detected gaps, and clearance events. It emits:

- `provenance_audit_report.json`
- `wallet_timelines.json`
- `provenance_metrics.json`
- `discord_summary.md`

All outputs are read-only/recommend-only. They do not mutate routing, ban accounts, move funds, claw back rewards, deploy, or sign anything.

## Mock Input Dataset

Inputs under `inputs/` cover 10 wallets across 3 risk levels:

- 4 high-review-priority wallets
- 3 watch wallets
- 3 low-risk wallets

Scenarios include:

- flagging only;
- suppression recommended;
- suppression missing after high-risk flag;
- verification enforced;
- post-suppression violation;
- not-tested suppression;
- low-risk suppression review boundary;
- clearance by verification;
- expired suppression clearance.

## Command Run

```bash
node scripts/orc-sybil-provenance-audit-trail.mjs audit \
  --risk-matrix docs/verification/sybil_provenance_audit_task_3acca09c782268d962c323fc09161c68/inputs/mock_risk_matrix.json \
  --suppression-config docs/verification/sybil_provenance_audit_task_3acca09c782268d962c323fc09161c68/inputs/mock_suppression_config.json \
  --enforcement-state docs/verification/sybil_provenance_audit_task_3acca09c782268d962c323fc09161c68/inputs/mock_enforcement_state.json \
  --out docs/verification/sybil_provenance_audit_task_3acca09c782268d962c323fc09161c68/outputs \
  --generated-at 2026-06-20T10:50:00.000Z \
  --generated-by grashnuk
```

Result:

- `walletCount: 10`
- `eventCount: 27`
- `clearanceWallets: 2`
- `violationWallets: 1`
- `walletsNeedingHumanReview: 6`

## Verification

```bash
npm run orc-sybil-provenance-audit-trail-smoke
npm run lint
npm run format-check
git diff --check
```

Observed results:

- `orc-sybil-provenance-audit-trail-smoke ok`
- lint passed
- `format check ok`
- `git diff --check` passed

## Safety Boundary

The report explicitly carries:

- `wouldMutateLiveRouting: false`
- `wouldMoveFunds: false`
- `wouldBanAccounts: false`
- `wouldClawBackRewards: false`
- `wouldDeploy: false`
- `requiresHumanApprovalForAnyOperationalUse: true`
