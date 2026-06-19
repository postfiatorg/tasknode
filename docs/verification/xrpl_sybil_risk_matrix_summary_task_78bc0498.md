# Unified XRPL Sybil Risk Matrix Summary

@goodalexander review note: this is a recommend-only aggregation output. It contains no blocklist mutation, ban, clawback, signing path, or fund movement.

Status: review_required
Wallets scored: 13
Known source wallets: 5
Contagion review leads: 4
High-priority rows: 9
Watch rows: 1
Weights: centrality 0.3, cluster density 0.2, contagion proximity 0.5

## Top Wallets

| Wallet | Composite | Priority | Band | Role | Centrality | Density | Contagion | Recommendation |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |
| rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n | 57.9 | 81.4 | high_review_priority | contagion_review_lead | 41.7 | 23.6 | 81.4 | review raw transactions and operator identity before any enforcement decision |
| rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB | 56.7 | 81.4 | high_review_priority | contagion_review_lead | 37.5 | 23.6 | 81.4 | review raw transactions and operator identity before any enforcement decision |
| r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC | 57.9 | 81.3 | high_review_priority | contagion_review_lead | 41.7 | 23.6 | 81.3 | review raw transactions and operator identity before any enforcement decision |
| rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7 | 58.1 | 69.3 | high_review_priority | contagion_review_lead | 62.5 | 23.6 | 69.3 | review raw transactions and operator identity before any enforcement decision |
| rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE | 66 | 66 | high_review_priority | known_source_wallet | 37.5 | 23.6 | 100 | confirm source labeling and raw transaction lineage before using as a seed risk source |
| rNHx6Xze9YXgsp66k5Vv1UrWEoudWNfepj | 66 | 66 | high_review_priority | known_source_wallet | 37.5 | 23.6 | 100 | confirm source labeling and raw transaction lineage before using as a seed risk source |
| rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4 | 66 | 66 | high_review_priority | known_source_wallet | 37.5 | 23.6 | 100 | confirm source labeling and raw transaction lineage before using as a seed risk source |
| r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB | 62.2 | 62.2 | high_review_priority | known_source_wallet | 25 | 23.6 | 100 | confirm source labeling and raw transaction lineage before using as a seed risk source |
| rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E | 62.2 | 62.2 | high_review_priority | known_source_wallet | 25 | 23.6 | 100 | confirm source labeling and raw transaction lineage before using as a seed risk source |
| raNPH8hdpy3S9uvcc4jK5tuE9Eysvk8Y3j | 38 | 44 | watch | connected_wallet | 37.5 | 23.6 | 44 | monitor in future streams or sample raw evidence if the cluster expands |

## How Scores Were Derived

- Linkage centrality score = linkage graph degreeCentrality * 100.
- Cluster density score = max observed component density from linkage or contagion graph * 100.
- Contagion proximity score = max of live alert risk, final contagion risk ledger score, known-source seed score, or discounted linkage secondary-risk score.
- Composite score = weighted sum of those three component scores using the reported weights.
- Review priority score = max of composite score and direct live/high-source risk scores, so high-alert wallets are not hidden by lower centrality or density.

## Command

```bash
node scripts/xrpl-sybil-risk-matrix.mjs --linkage /home/pfrpc/repos/grashnuk-runtime/docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json --contagion /home/pfrpc/repos/grashnuk-runtime/docs/verification/xrpl_contagion_alerts_task_d77a9dc.json --matrix <risk-matrix.json> --summary <summary.md>
```

## Boundary

This artifact is local analysis for reviewer triage. It does not write to Task Node state, XRPL, a blocklist, or any enforcement system.
