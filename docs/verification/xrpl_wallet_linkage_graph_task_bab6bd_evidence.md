# XRPL Wallet Linkage Graph Analyzer Evidence

Task: `task_bab6bd892538d7d4fa0f7ac586b89929`
Title: Build XRPL Wallet Linkage Graph Analyzer
Operator: Grashnuk machine agent
Mode: read-only, recommend-only

## Deliverables

- Script: `scripts/xrpl-wallet-linkage-graph.mjs`
- Package command: `npm run xrpl-wallet-linkage-graph`
- Sample input: `docs/verification/xrpl_wallet_linkage_sample_transactions_task_bab6bd.json`
- Generated JSON report: `docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json`
- Reviewer summary: `docs/verification/xrpl_wallet_linkage_graph_summary_task_bab6bd.md`

## What The Script Does

The analyzer ingests normalized XRPL/PFTL transaction rows or XRPL `account_tx`
style rows, builds a directed wallet-linkage graph, and computes:

- node-level in/out transaction counts, PFT flow totals, degree, degree
  centrality, and weighted degree;
- connected components and cluster density;
- secondary-wallet risk scores based on adjacency to known cluster wallets,
  shared funding, shared sink behavior, bidirectional known-cluster flow, degree
  centrality, and known-cluster flow amount;
- a structured JSON reviewer packet plus a Discord-ready Markdown summary.

The output is not an enforcement artifact. It contains no deployable blocklist
patch, no signing path, no blacklist mutation, and no clawback instruction.
Risk flags are review leads only.

## Commands Run

```bash
node scripts/xrpl-wallet-linkage-graph.mjs --help
```

```bash
npm run xrpl-wallet-linkage-graph -- \
  --transactions docs/verification/xrpl_wallet_linkage_sample_transactions_task_bab6bd.json \
  --report docs/verification/xrpl_wallet_linkage_graph_report_task_bab6bd.json \
  --summary docs/verification/xrpl_wallet_linkage_graph_summary_task_bab6bd.md
```

```bash
npx eslint scripts/xrpl-wallet-linkage-graph.mjs
npm run lint
git diff --check
```

## Sample Result

The fixture contains 17 native Payment rows touching five known `sybil_003`
wallets and four secondary wallets.

Generated report summary:

```json
{
  "status": "review_required",
  "nodes": 9,
  "directedEdges": 16,
  "knownWallets": 5,
  "secondaryWallets": 4,
  "highRiskSecondaryWallets": [
    "rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB",
    "rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7"
  ]
}
```

Top secondary-wallet rows:

| Wallet | Risk | Band | Reason |
| --- | ---: | --- | --- |
| `rDU5msWZ4mrCpVwayJuMKZpSuMb9uWguhB` | 75.6 | `high_review_priority` | Funds and receives from multiple known-cluster wallets; bidirectional known-cluster flow. |
| `rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7` | 69.4 | `high_review_priority` | Funds five known-cluster wallets. |
| `raNPH8hdpy3S9uvcc4jK5tuE9Eysvk8Y3j` | 40.9 | `watch` | Funds three known-cluster wallets. |
| `r333GeMFLp38KsJqX4WK5mdPaQcb2Dzsro` | 33.9 | `watch` | Funds two known-cluster wallets. |

Cluster density result:

```json
{
  "componentId": "component_1",
  "walletCount": 9,
  "knownWalletCount": 5,
  "secondaryWalletCount": 4,
  "directedEdgeCount": 16,
  "density": 0.2222,
  "amountPft": 128.750007
}
```

## Verification

- CLI help exits successfully.
- Fixture execution exits successfully and writes both report artifacts.
- `npx eslint scripts/xrpl-wallet-linkage-graph.mjs` passed.
- `npm run lint` passed.
- `git diff --check` passed.
- Generated files are ASCII-only with no trailing whitespace.

## Reviewer Boundary

Use this output to decide which wallet relationships deserve raw evidence
comparison or additional reviewer inspection. Do not treat it as proof of Sybil
behavior, a ban recommendation, a blocklist patch, or a PFT-moving instruction.
