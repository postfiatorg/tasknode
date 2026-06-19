# Unified XRPL Sybil Risk Matrix Evidence

Task: `task_78bc0498dfcc292ed909b1da6743a1ba`
Title: Build Unified XRPL Sybil Risk Matrix Script
Mode: recommend-only, read-only analysis. No enforcement, signing, blacklist mutation, clawback, or fund movement was performed.

## Public Artifact

- Branch: `codex/xrpl-contagion-monitor-artifact`
- PR: https://github.com/postfiatorg/tasknodeofficial/pull/108
- Artifact path: `scripts/xrpl-sybil-risk-matrix.mjs`

This builds on the prior public artifacts for:

- `task_bab6bd892538d7d4fa0f7ac586b89929` XRPL Wallet Linkage Graph Analyzer
- `task_d77a9dc367ff181ff9463f58d01362c9` XRPL Contagion Risk Monitoring Script

## Files

- `scripts/xrpl-sybil-risk-matrix.mjs`
- `docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json`
- `docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md`
- `docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json`
- `docs/verification/xrpl_contagion_alerts_task_d77a9dc.json`
- `package.json`

## Hashes

```text
ba907005b9dd56d2badd27c7d99cd64cf40783e8b1662459e368382320d277d3  scripts/xrpl-sybil-risk-matrix.mjs
99da44a569ceddb2b42e3e5b6dc87467c5cb6b6d735b6f811cd3b3488a483118  docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json
5339c2cd0e154649c67d06f6cf15fe28ded9b6fe78b4cbf70bf3a01a65aae496  docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md
4ec63dc6bd6e7cd32b7b602e15bf283897c10cd972849a7ff7db6d473a3515b1  package.json
```

## Command

```bash
npm run xrpl-sybil-risk-matrix -- \
  --linkage docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json \
  --contagion docs/verification/xrpl_contagion_alerts_task_d77a9dc.json \
  --matrix docs/verification/xrpl_sybil_risk_matrix_task_78bc0498.json \
  --summary docs/verification/xrpl_sybil_risk_matrix_summary_task_78bc0498.md
```

## Output Summary

- Wallets scored: 13
- Known source wallets: 5
- Contagion review leads: 4
- High-priority rows: 9
- Watch rows: 1
- Weights: centrality `0.30`, cluster density `0.20`, contagion proximity `0.50`

Top review-priority rows:

| Wallet | Composite | Priority | Band | Role |
| --- | ---: | ---: | --- | --- |
| `rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n` | 57.9 | 81.4 | high_review_priority | contagion_review_lead |
| `rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB` | 56.7 | 81.4 | high_review_priority | contagion_review_lead |
| `r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC` | 57.9 | 81.3 | high_review_priority | contagion_review_lead |
| `rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7` | 58.1 | 69.3 | high_review_priority | contagion_review_lead |
| `rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE` | 66.0 | 66.0 | high_review_priority | known_source_wallet |

## Verification Commands

```bash
npm run xrpl-sybil-risk-matrix -- --help
npx eslint scripts/xrpl-sybil-risk-matrix.mjs
git diff --check
npm run lint
```

Results: all commands completed successfully.

## Boundary

The script merges existing local JSON artifacts into a reviewer-facing risk matrix. It does not write Task Node state, write XRPL state, sign transactions, alter a blocklist, or perform any enforcement action.
