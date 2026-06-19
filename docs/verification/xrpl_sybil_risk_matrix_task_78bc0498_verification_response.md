# Verification Response: Unified XRPL Sybil Risk Matrix

Task: `task_78bc0498dfcc292ed909b1da6743a1ba`

## Requested Items

- Script file: `scripts/xrpl-sybil-risk-matrix.mjs`
- Sample linkage input: `docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json`
- Sample contagion input: `docs/verification/xrpl_contagion_alerts_task_d77a9dc.json`
- Generated risk matrix JSON: `docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json`
- Discord-ready summary: `docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md`
- Evidence packet: `docs/verification/xrpl_sybil_risk_matrix_task_78bc0498_evidence.md`

Public artifact:

- PR: https://github.com/postfiatorg/tasknodeofficial/pull/108
- PR comment: https://github.com/postfiatorg/tasknodeofficial/pull/108#issuecomment-4754619812
- Commit: https://github.com/postfiatorg/tasknodeofficial/commit/4db20e3

## Command

```bash
npm run xrpl-sybil-risk-matrix -- \
  --linkage docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json \
  --contagion docs/verification/xrpl_contagion_alerts_task_d77a9dc.json \
  --matrix docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json \
  --summary docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md
```

## Discord-Ready Summary

Built a read-only Unified XRPL Sybil Risk Matrix that merges the rewarded wallet-linkage graph output with the rewarded contagion-monitor output. It scores 13 wallets using three explicit components: linkage centrality, cluster density, and contagion proximity. The generated matrix reports both a weighted `compositeScore` and a `reviewPriorityScore` so live high-alert wallets are not hidden by lower graph density.

Top review-priority rows:

| Wallet | Composite | Priority | Band | Role |
| --- | ---: | ---: | --- | --- |
| `rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n` | 57.9 | 81.4 | high_review_priority | contagion_review_lead |
| `rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB` | 56.7 | 81.4 | high_review_priority | contagion_review_lead |
| `r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC` | 57.9 | 81.3 | high_review_priority | contagion_review_lead |
| `rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7` | 58.1 | 69.3 | high_review_priority | contagion_review_lead |
| `rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE` | 66.0 | 66.0 | high_review_priority | known_source_wallet |

Stats: 13 wallets scored, 5 known source wallets, 4 contagion review leads, 9 high-priority rows, 1 watch row. The artifact is recommend-only and contains no enforcement code, no blacklist mutation, no clawback path, no signing path, and no fund movement.

## Verification Commands Run

```bash
npm run xrpl-sybil-risk-matrix -- --help
npm run xrpl-sybil-risk-matrix -- --linkage docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json --contagion docs/verification/xrpl_contagion_alerts_task_d77a9dc.json --matrix docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json --summary docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md
npx eslint scripts/xrpl-sybil-risk-matrix.mjs
git diff --check
npm run lint
```

Result: all commands completed successfully.
