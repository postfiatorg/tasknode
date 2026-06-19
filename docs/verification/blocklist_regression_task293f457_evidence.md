# Build Blocklist Regression Test Suite Script Evidence

Task: task_293f457ca04266f94e65db175f0babe7

## Delivered artifacts

- Script: `scripts/sybil-blocklist-regression.mjs`
- Package command: `npm run sybil-blocklist-regression`
- JSON report: `docs/verification/sybil_blocklist_regression_sample_report.json`
- Discord-ready summary: `docs/verification/sybil_blocklist_regression_summary.md`

## Source lineage reviewed

- `task_2ec03c162f35f5060453d1f5476fadf2` - XRPL Sybil Fund Flow Graph Script, reward CID `QmefkU6HW2okwUeuVVNuuDkwcNzGqfu7dyX3358RCX7QRr`
- `task_cc79625ec50467785ae070b1e4336fff` - Automated Sybil Blocklist Patch Generator, reward CID `QmbzyjFcUu4EHbW95GqBVKAeVJ3kUa8yGKY4nBmJxiRzUJ`
- `task_07f8a1bcb02702eadbbf797b29b70406` - Blocklist Propagation Verification Script

Verified public evidence artifacts were fetched from the lineage task records and used as script inputs.

## Sample command

```bash
node scripts/sybil-blocklist-regression.mjs \
  --graph /tmp/orc_blocklist_regression_sources/fund_flow/sample_graph.json \
  --blocklist /tmp/orc_blocklist_regression_sources/blocklist_generator/blocklist_patch.json \
  --base /tmp/orc_blocklist_regression_sources/blocklist_generator/base_blocklist.json \
  --report docs/verification/sybil_blocklist_regression_sample_report.json \
  --summary docs/verification/sybil_blocklist_regression_summary.md \
  --allow-gaps
```

## Sample result

```json
{
  "status": "fail",
  "totalHistoricalFlaggedWallets": 5,
  "passed": 2,
  "failed": 3,
  "missingWallets": [
    "rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E",
    "rNHx6Xze9YXgsp66k5Vv1UrWEoudWNfepj",
    "rwgkFFBxRacLTHuhvbr9pUUWQu6VZe1PK4"
  ]
}
```

The command intentionally exits nonzero without `--allow-gaps` when deployable blocklist coverage is incomplete. In the sample data, `rGWeCk5kkCqMcp8MognqhxQj3Pi6QGk96E` is present only as a review entry, and the other two missing wallets are absent from deployable blocklist surfaces.

## Verification run

- `node scripts/sybil-blocklist-regression.mjs --graph /tmp/orc_blocklist_regression_sources/fund_flow/sample_graph.json --blocklist /tmp/orc_blocklist_regression_sources/blocklist_generator/blocklist_patch.json --base /tmp/orc_blocklist_regression_sources/blocklist_generator/base_blocklist.json` - exits 1 with 3 gaps, as expected.
- `npm run sybil-blocklist-regression -- --graph /tmp/orc_blocklist_regression_sources/fund_flow/sample_graph.json --blocklist /tmp/orc_blocklist_regression_sources/blocklist_generator/blocklist_patch.json --base /tmp/orc_blocklist_regression_sources/blocklist_generator/base_blocklist.json --allow-gaps` - exits 0 and reports the same gaps for evidence generation.
- `npm run orc-shared-state-smoke` - pass.
- `npx eslint scripts/sybil-blocklist-regression.mjs` - pass after `npm ci`.
- `git diff --check` - pass.
