# Verification Response: Suppression Entry JSON

Task: `task_c4682ae05cbc47f9669a58d5121cf38d`

The entry below is copied from:

`docs/verification/routing_suppression_config_task_c4682ae05cbc47f9669a58d5121cf38d/outputs/suppression_config.json`

```json
{
  "configSchema": "pf.orc.contributor_routing_suppression_config.v1",
  "configMode": "recommend_only_no_enforcement",
  "configDryRunOnly": true,
  "configOperationalUseAllowed": false,
  "entry": {
    "contributorKey": "rClusterWallet6666666666666666666",
    "walletAddress": "rClusterWallet6666666666666666666",
    "accountId": "acct_cluster_wallet",
    "handle": "clusterwallet",
    "status": "routing_suppression_recommended",
    "mode": "recommend_only_no_enforcement",
    "suppressionScope": "network_task_routing_review",
    "suppressionReason": "quality_threshold_failures:repeated_unverifiable_submissions,consecutive_unverifiable_submissions,low_verified_to_total_ratio",
    "qualityMetrics": {
      "total": 6,
      "verified": 1,
      "unverifiable": 5,
      "selfAttested": 0,
      "refused": 0,
      "cancelled": 0,
      "other": 0,
      "verifiedRatio": 0.1667,
      "refusalCountWindow": 0,
      "maxConsecutiveUnverifiable": 3
    },
    "thresholdFailures": [
      {
        "rule": "repeated_unverifiable_submissions",
        "observed": 5,
        "threshold": 2,
        "windowDays": null,
        "taskIds": [
          "task_cluster_wallet_002",
          "task_cluster_wallet_003",
          "task_cluster_wallet_004",
          "task_cluster_wallet_005",
          "task_cluster_wallet_006"
        ]
      },
      {
        "rule": "consecutive_unverifiable_submissions",
        "observed": 3,
        "threshold": 2,
        "windowDays": null,
        "taskIds": [
          "task_cluster_wallet_004",
          "task_cluster_wallet_005",
          "task_cluster_wallet_006"
        ]
      },
      {
        "rule": "low_verified_to_total_ratio",
        "observed": 0.1667,
        "threshold": 0.3,
        "windowDays": null,
        "taskIds": [
          "task_cluster_wallet_001",
          "task_cluster_wallet_002",
          "task_cluster_wallet_003",
          "task_cluster_wallet_004",
          "task_cluster_wallet_005",
          "task_cluster_wallet_006"
        ]
      }
    ],
    "supportingTaskIds": [
      "task_cluster_wallet_001",
      "task_cluster_wallet_002",
      "task_cluster_wallet_003",
      "task_cluster_wallet_004",
      "task_cluster_wallet_005",
      "task_cluster_wallet_006"
    ],
    "sourceRecommendation": "routing_review_recommended",
    "sourceReportGeneratedAt": "2026-06-20T03:45:00.000Z",
    "sourceReportGeneratedBy": "grashnuk",
    "expiresAt": "2026-07-04T04:00:00.000Z",
    "requiresHumanApproval": true,
    "operationalUseAllowed": false
  }
}
```
