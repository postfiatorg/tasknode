# Blocklist Regression Summary

@goodalexander regression result: FAIL

Historical flagged wallets tested: 5
Deployably blocked: 2
Gaps: 3

## Tested Wallets

| Wallet | Result | Evidence surfaces | Gap reason |
| --- | --- | --- | --- |
| r99Grjej3Ytp6MmopQYvBB9bNZmNrhJLjB | pass | patchOps, addedEntries, summaryDecisions, allPatchReferences |  |
| rD6YbKDLDso1YQpZNxUgvNbG7hGekb7JHE | pass | patchOps, addedEntries, summaryDecisions, allPatchReferences |  |
| rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E | fail | reviewEntries, summaryDecisions, allPatchReferences | Wallet is present only in review_entries, which is not a deployable block surface by default. |
| rNHx6Xze9YXgsp66k5Vv1UrWEoudWNfepj | fail | none | Wallet is absent from deployable blocklist surfaces. |
| rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4 | fail | none | Wallet is absent from deployable blocklist surfaces. |

## Interpretation

The regression test found historical Sybil-flow flagged wallets that are not present in deployable blocklist surfaces. Review-only entries are called out but do not satisfy the block requirement unless the command is run with --count-review-entries-as-blocked.

Recommended action: update the automated blocklist generator or current blocklist config so every historical flagged wallet is either deployably blocked or explicitly documented with a reviewed exception.

## Command

```bash
node scripts/sybil-blocklist-regression.mjs --graph /tmp/orc_blocklist_regression_sources/fund_flow/sample_graph.json --blocklist /tmp/orc_blocklist_regression_sources/blocklist_generator/blocklist_patch.json --base /tmp/orc_blocklist_regression_sources/blocklist_generator/base_blocklist.json
```

