# Verification Response

Requested excerpt from `docs/verification/sybil_blocklist_regression_sample_report.json` showing one passing wallet and one failing wallet with the blocked-status coverage fields:

```json
[
  {
    "wallet": "r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB",
    "status": "pass",
    "expected": "blocked",
    "observed": "blocked",
    "deployableBlocked": true,
    "reviewOnly": false,
    "presentSurfaces": [
      "patchOps",
      "addedEntries",
      "summaryDecisions",
      "allPatchReferences"
    ],
    "gapReason": null
  },
  {
    "wallet": "rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E",
    "status": "fail",
    "expected": "blocked",
    "observed": "not_blocked",
    "deployableBlocked": false,
    "reviewOnly": true,
    "presentSurfaces": [
      "reviewEntries",
      "summaryDecisions",
      "allPatchReferences"
    ],
    "gapReason": "Wallet is present only in review_entries, which is not a deployable block surface by default."
  }
]
```

The script determines deployable blocked coverage from base blocklist config sets, non-patch blocklist config sets, patch ops that add/ban/block wallets, and patch `added_entries`. `review_entries` are surfaced for audit but do not count as deployably blocked unless the script is run with `--count-review-entries-as-blocked`.
