{
  "schema": "tasknode.xrpl_contagion_alert.v1",
  "alertId": "alert_5",
  "eventIndex": 10,
  "eventId": "stream_evt_011",
  "observedAt": "2026-06-19T18:41:08.000Z",
  "policy": {
    "enforcementAllowed": false,
    "mode": "recommend_only_review_alert"
  },
  "recommendation": "review_raw_transactions_and_operator_identity_before_any_enforcement",
  "riskBand": "high_review_priority",
  "threshold": 60,
  "triggerTxHash": "D77A9DC000000000000000000000000000000000000000000000000000011",
  "amountScore": 0.22,
  "componentDensity": 0.2364,
  "degreeCentrality": 0.4167,
  "firstSeen": "2026-06-19T18:40:30.000Z",
  "knownPeers": [
    "rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE",
    "rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E",
    "rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4"
  ],
  "lastSeen": "2026-06-19T18:41:08.000Z",
  "priorRiskPeers": [
    "rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB",
    "rn5bGGSQGh5aafNEBdgBiTNs568tsSmV1n"
  ],
  "reasons": [
    "adjacent to 3 known-cluster wallet(s)",
    "adjacent to 2 prior high-risk wallet(s)",
    "funds multiple risk-source wallets",
    "receives from multiple risk-source wallets",
    "has bidirectional flow with risk-source wallets",
    "component density 0.2364"
  ],
  "riskPeerCount": 5,
  "riskScore": 81.3,
  "sourceInPft": 1.2,
  "sourceOutPft": 1.1,
  "wallet": "r3qkVCB8rDazdPokhAvb5nRPjwCfhEVWGC",
  "weightedDegreePft": 2.3
}
