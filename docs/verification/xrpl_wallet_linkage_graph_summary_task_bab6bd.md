# XRPL Wallet Linkage Graph Analyzer Summary

@goodalexander review note: this is recommend-only graph evidence. It does not execute or propose a ban, blocklist patch, clawback, or fund movement.

Status: review_required
Raw transactions: 17
Included transactions: 17
Nodes: 9
Directed edges: 16
Known-cluster wallets: 5
High-risk secondary wallets: 2

## High-Risk Secondary Wallets

| Wallet | Risk | Band | Known peers | Reasons | Recommendation |
| --- | ---: | --- | ---: | --- | --- |
| rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB | 75.6 | high_review_priority | 3 | funds multiple known-cluster wallets; receives from multiple known-cluster wallets; has bidirectional flow with known-cluster wallets; adjacent to 3 known-cluster wallets | review_raw_evidence_before_any_enforcement |
| rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7 | 69.4 | high_review_priority | 5 | funds multiple known-cluster wallets; adjacent to 5 known-cluster wallets | review_raw_evidence_before_any_enforcement |
| raNPH8hdpy3S9uvcc4jK5tuE9Eysvk8Y3j | 40.9 | watch | 3 | funds multiple known-cluster wallets; adjacent to 3 known-cluster wallets | monitor_or_sample_if_cluster_expands |
| r333GeMFLp38KsJqX4WK5mdPaQcb2Dzsro | 33.9 | watch | 2 | funds multiple known-cluster wallets | monitor_or_sample_if_cluster_expands |

## Cluster Density

| Component | Wallets | Known | Secondary | Density | PFT |
| --- | ---: | ---: | ---: | ---: | ---: |
| component_1 | 9 | 5 | 4 | 0.2222 | 128.750007 |

## Command

```bash
node scripts/xrpl-wallet-linkage-graph.mjs --transactions /home/pfrpc/repos/grashnuk-runtime/docs/verification/xrpl_wallet_linkage_sample_transactions_task_bab6bd.json --report <report.json> --summary <summary.md>
```

## Boundary

The output is a reviewer triage packet. It intentionally contains no deployable enforcement patch, no signing path, no blacklist mutation, and no clawback instruction.
