# XRPL Contagion Risk Monitor Summary

@goodalexander review note: this is a recommend-only live-monitor output. It emits review alerts and contains no blocklist mutation, ban, clawback, signing path, or fund movement.

Status: review_required
Input events: 11
Included events: 11
Known wallets: 5
Prior high-risk baseline wallets: 2
Nodes after stream: 13
Directed edges after stream: 27
Alerts emitted: 5

## Alerts

| Alert | Wallet | Risk | Trigger tx | Known peers | Prior-risk peers | Reasons |
| --- | --- | ---: | --- | ---: | ---: | --- |
| alert_1 | rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n | 76.6 | D77A9DC000000000000000000000000000000000000000000000000000004 | 3 | 1 | adjacent to 3 known-cluster wallet(s); adjacent to 1 prior high-risk wallet(s); funds multiple risk-source wallets; receives from multiple risk-source wallets; has bidirectional flow with risk-source wallets; component density 0.2222 |
| alert_2 | r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC | 61.3 | D77A9DC000000000000000000000000000000000000000000000000000010 | 3 | 1 | adjacent to 3 known-cluster wallet(s); adjacent to 1 prior high-risk wallet(s); funds multiple risk-source wallets; has bidirectional flow with risk-source wallets; component density 0.2273 |
| alert_3 | rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB | 81.1 | D77A9DC000000000000000000000000000000000000000000000000000010 | 3 | 2 | adjacent to 3 known-cluster wallet(s); adjacent to 2 prior high-risk wallet(s); funds multiple risk-source wallets; receives from multiple risk-source wallets; has bidirectional flow with risk-source wallets; component density 0.2273 |
| alert_4 | rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n | 81.4 | D77A9DC000000000000000000000000000000000000000000000000000011 | 3 | 2 | adjacent to 3 known-cluster wallet(s); adjacent to 2 prior high-risk wallet(s); funds multiple risk-source wallets; receives from multiple risk-source wallets; has bidirectional flow with risk-source wallets; component density 0.2364 |
| alert_5 | r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC | 81.3 | D77A9DC000000000000000000000000000000000000000000000000000011 | 3 | 2 | adjacent to 3 known-cluster wallet(s); adjacent to 2 prior high-risk wallet(s); funds multiple risk-source wallets; receives from multiple risk-source wallets; has bidirectional flow with risk-source wallets; component density 0.2364 |

## Top Risk Ledger

| Wallet | Risk | Band | Recommendation |
| --- | ---: | --- | --- |
| rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB | 81.4 | high_review_priority | review_raw_transactions_and_operator_identity_before_any_enforcement |
| rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n | 81.4 | high_review_priority | review_raw_transactions_and_operator_identity_before_any_enforcement |
| r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC | 81.3 | high_review_priority | review_raw_transactions_and_operator_identity_before_any_enforcement |
| rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7 | 69.3 | high_review_priority | review_raw_transactions_and_operator_identity_before_any_enforcement |
| raNPH8hdpy3S9uvcc4jK5tuE9Eysvk8Y3j | 44 | watch | continue_monitoring |
| r333GeMFLp38KsJqX4WK5mdPaQcb2Dzsro | 37.1 | below_watch | continue_monitoring |

## Command

```bash
node scripts/xrpl-contagion-risk-monitor.mjs --events /home/pfrpc/repos/grashnuk-runtime/docs/verification/xrpl_contagion_stream_task_d77a9dc.json --baseline /home/pfrpc/repos/grashnuk-runtime/docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json --alerts <alerts.json> --summary <summary.md> --state-out <state.json>
```

## Boundary

This script is read-only local analysis. It processes event streams, updates an in-memory graph, emits JSON review alerts, and leaves all enforcement decisions to separate human/core-team review.
