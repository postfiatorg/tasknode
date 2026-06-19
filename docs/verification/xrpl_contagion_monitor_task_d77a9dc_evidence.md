# XRPL Contagion Risk Monitor Evidence

Task: `task_d77a9dc367ff181ff9463f58d01362c9`
Title: Build XRPL Contagion Risk Monitoring Script
Operator: `@grashnuk` machine_agent

## Delivered Artifact

I extended the rewarded XRPL Wallet Linkage Graph Analyzer lineage into a runnable live-monitoring script:

- `scripts/xrpl-contagion-risk-monitor.mjs`
- `docs/verification/xrpl_contagion_stream_task_d77a9dc.json`
- `docs/verification/xrpl_contagion_alerts_task_d77a9dc.json`
- `docs/verification/xrpl_contagion_monitor_state_task_d77a9dc.json`
- `docs/verification/xrpl_contagion_monitor_summary_task_d77a9dc.md`
- `package.json` script: `xrpl-contagion-risk-monitor`

The monitor is read-only and recommend-only. It ingests XRPL-format transaction events, seeds prior state from the wallet-linkage graph report, updates local linkage state, calculates contagion risk from known-cluster adjacency, prior high-risk adjacency, centrality, cluster density, bidirectional flow, and risk-source amounts, then emits structured JSON review alerts.

## Integrity Hashes

```text
4d0e5d615ebd46876683876f60ca5cf9d218f716f72cb8ba12d6bd0dc20943de  scripts/xrpl-contagion-risk-monitor.mjs
e573a29fcbfb935f1521d3239e373e0eab7eb396632b22b59a04e007a0f8d834  docs/verification/xrpl_contagion_stream_task_d77a9dc.json
95f4a460e6396c66d6751a2cf82c4594aa8ea459063dd5765a4ff4603ee11d5d  docs/verification/xrpl_contagion_alerts_task_d77a9dc.json
9c92dd0cc825c17900837bceae18720d9965ed9722c3fd451bfa011cb78a1974  docs/verification/xrpl_contagion_monitor_summary_task_d77a9dc.md
11b3ba843281223dd0911fc0e350a947801ed764d28b8f7a3ac33328e2e5ec60  docs/verification/xrpl_contagion_monitor_state_task_d77a9dc.json
```

## Execution Commands

```bash
npm run xrpl-contagion-risk-monitor -- --help

npm run xrpl-contagion-risk-monitor -- \
  --events docs/verification/xrpl_contagion_stream_task_d77a9dc.json \
  --baseline docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json \
  --alerts docs/verification/xrpl_contagion_alerts_task_d77a9dc.json \
  --summary docs/verification/xrpl_contagion_monitor_summary_task_d77a9dc.md \
  --state-out docs/verification/xrpl_contagion_monitor_state_task_d77a9dc.json \
  --high-risk-threshold 60 \
  --watch-threshold 40

npx eslint scripts/xrpl-contagion-risk-monitor.mjs
git diff --check
npm run lint
```

All commands above completed successfully.

## Sample Output

The sample stream processed 11 events with no skips or duplicate transaction hashes:

```json
{
  "schema": "tasknode.xrpl_contagion_risk_monitor.v1",
  "summary": {
    "status": "review_required",
    "newAlerts": 5,
    "interpretation": "Live event stream produced high-priority contagion review alerts. Review raw transaction lineage before any enforcement."
  },
  "ingest": {
    "eventsRaw": 11,
    "eventsIncluded": 11,
    "duplicateTxHashes": 0,
    "skipped": 0
  },
  "graphStats": {
    "knownWallets": 5,
    "priorHighRiskWallets": 2,
    "nodes": 13,
    "directedEdges": 27,
    "alertsEmitted": 5
  }
}
```

Top alert excerpts:

```json
[
  {
    "alertId": "alert_1",
    "wallet": "rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n",
    "riskScore": 76.6,
    "riskBand": "high_review_priority",
    "triggerTxHash": "D77A9DC000000000000000000000000000000000000000000000000000000004",
    "knownPeers": [
      "r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB",
      "rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE",
      "rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E"
    ],
    "priorRiskPeers": [
      "rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB"
    ],
    "recommendation": "review_raw_transactions_and_operator_identity_before_any_enforcement"
  },
  {
    "alertId": "alert_5",
    "wallet": "r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC",
    "riskScore": 81.3,
    "riskBand": "high_review_priority",
    "triggerTxHash": "D77A9DC000000000000000000000000000000000000000000000000000000011",
    "knownPeers": [
      "rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE",
      "rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E",
      "rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4"
    ],
    "priorRiskPeers": [
      "rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB",
      "rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n"
    ],
    "recommendation": "review_raw_transactions_and_operator_identity_before_any_enforcement"
  }
]
```

## Discord-Ready Summary

@goodalexander review note: I built a runnable XRPL contagion monitor extending `task_bab6bd...`. It uses the prior wallet-linkage graph report as baseline state, ingests an XRPL-format event stream, updates wallet and edge linkage in memory, scores contagion risk from known-cluster peers, prior high-risk peers, centrality, density, bidirectional flow, and risk-source amounts, then emits JSON review alerts.

Fixture result: 11 events included, 13 graph nodes, 27 directed edges, 5 high-priority alerts. New secondary wallets `rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n` and `r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC` crossed the high-risk threshold after linking to known-cluster wallets plus prior high-risk baseline wallets. Output is strictly recommend-only; it contains no enforcement mutation, no signing path, no blocklist update, no ban, no clawback, and no fund movement.

## Core Implementation Excerpt

The scoring model combines graph and stream signals while preserving the review-only boundary:

```js
const directKnownScore = (Math.min(stats.knownPeers.length, 5) / 5) * 28;
const contagionScore = (Math.min(stats.priorRiskPeers.length, 4) / 4) * 18;
const bridgeScore = (sharedFunder ? 14 : 0) + (sharedSink ? 14 : 0) + (bidirectionalRisk ? 12 : 0);
const centralityScore = node.degreeCentrality * 14;
const densityScore = Math.min(density.density * 40, 10);
const amountScore = Math.min(((stats.sourceInPft + stats.sourceOutPft) / maxAmount) * 12, 12);
const riskScore = Math.min(
  100,
  directKnownScore + contagionScore + bridgeScore + centralityScore + densityScore + amountScore
);
```

Alert payloads explicitly mark the output as review-only:

```js
const alert = {
  schema: "tasknode.xrpl_contagion_alert.v1",
  policy: {
    enforcementAllowed: false,
    mode: "recommend_only_review_alert",
  },
  recommendation: "review_raw_transactions_and_operator_identity_before_any_enforcement",
  riskBand: band,
  threshold: args.highRiskThreshold,
  triggerTxHash: tx.txHash,
  ...scored,
};
```

## Boundary

This is not an enforcement artifact. It is a local monitor and review packet generator. Any account action, blacklist decision, clawback, or routing policy change requires separate review and authorization.
