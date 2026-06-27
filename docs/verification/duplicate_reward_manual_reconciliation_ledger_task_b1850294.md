# Duplicate Reward Manual Reconciliation Ledger

Generated: 2026-06-27T12:49:26.661Z
Source harvest: `task_b1850294f50ed777c7b0eb29a75e7d4a`
Source report: git:f5d33d55a654d002155d298deb709b0ae9459d8d:docs/verification/duplicate_reward_reconciliation_task_b1850294.json

This ledger is an operator review artifact only. It does not sign, publish task
events, mutate database state, approve rewards, execute clawbacks, apply offsets,
ban users, or move funds.

## Aggregate

- Ledger entries: 13
- Duplicate-payment entries: 10
- Duplicate-decision-only entries: 3
- Duplicate payment after first payment: 153002.500000 PFT
- Scanner recommended offset amount: 150002.500000 PFT
- Assigned owner: `accounting_operator_review`

## Entries

| Task | Payments | Decisions | Duplicate-after-first PFT | Scanner recommended offset PFT | Owner | Review type |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `task_70828af0024abd3cff1501aadb689e22` | 2 | 2 | 30000.000000 | 30000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_724460b146babbd93e71cdce425bd0e6` | 2 | 2 | 30000.000000 | 30000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_19f12b461da11ee0fa9b4eb688fcb7a2` | 2 | 2 | 18000.000000 | 18000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_5dc3c23dd1460a044bfa2ce1fede2292` | 2 | 2 | 18000.000000 | 18000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_dc07336c457592a783e53b0b7a175df9` | 2 | 2 | 18000.000000 | 18000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_e5e3e7b9a600bcde85e3d8cf626ed6bb` | 2 | 2 | 18000.000000 | 18000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_2ebb368d49cd48d11802d4f3c4692dd7` | 2 | 2 | 12000.000000 | 9000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_51695c2b7a50bcd890040e330391f6dd` | 2 | 2 | 9000.000000 | 9000.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_a0911f73caee5fbf37eccd570f13e2e9` | 2 | 2 | 1.500000 | 1.500000 | accounting_operator_review | manual_reward_accounting_review |
| `task_faa50b46bd3a34a4e2acd32eaf14753d` | 2 | 2 | 1.000000 | 1.000000 | accounting_operator_review | manual_reward_accounting_review |
| `task_07db61566d7c4c44f0a3ffe3c88458e0` | 1 | 2 | 0.000000 | 0.000000 | accounting_operator_review | review_duplicate_decision_only |
| `task_cdd241775a0a65ddae909bae3b771d29` | 0 | 2 | 0.000000 | 0.000000 | accounting_operator_review | review_duplicate_decision_only |
| `task_d2527276782f04a30ce1bbe19bc5c188` | 1 | 2 | 0.000000 | 0.000000 | accounting_operator_review | review_duplicate_decision_only |

## Review Boundary

Each entry requires manual accounting review. The scanner amounts are inputs for
operator reconciliation only and must be checked against canonical reward intent,
chain-settled payments, current projections, and the project's approved
reconciliation policy before any adjustment is made.
