# XRPL Wallet Linkage Graph Verification Response

Task: `task_bab6bd892538d7d4fa0f7ac586b89929`

Requested excerpt from
`docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json`, showing
one flagged secondary wallet entry with risk score, risk band, and contributing
metrics:

```json
{
  "wallet": "rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB",
  "riskScore": 75.6,
  "riskBand": "high_review_priority",
  "adjacentKnownCount": 3,
  "knownInPft": 0.000004,
  "knownOutPft": 0.000003,
  "degreeCentrality": 0.375,
  "weightedDegreePft": 0.000007,
  "knownPeers": [
    "rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE",
    "rNHx6Xze9YXgsp66k5Vv1UrWEoudWNfepj",
    "rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4"
  ],
  "reasons": [
    "funds multiple known-cluster wallets",
    "receives from multiple known-cluster wallets",
    "has bidirectional flow with known-cluster wallets",
    "adjacent to 3 known-cluster wallets"
  ],
  "recommendation": "review_raw_evidence_before_any_enforcement"
}
```

This entry is a graph-review lead only. It is not a ban, blocklist patch,
clawback instruction, or proof of Sybil behavior.
