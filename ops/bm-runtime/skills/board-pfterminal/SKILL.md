---
name: board-pfterminal
description: Board context for the Corbanu Terminal board (id board_pf_terminal). Use with the board-manager skill - Corbanu Terminal code changes and testing that ends in a merged fix, every task from the Wanted list.
---

# Corbanu Terminal Board

Board id: `board_pf_terminal` (the board was called "PF Terminal" before
2026-11-25; the product is Corbanu Terminal). The operator reopened it on
2026-11-25.

It pays for work on Corbanu Terminal (`CorbanuCore/CorbanuTerminal`):

- **Code changes** (`--work-type code_task` or `core_repo_work`, core
  contributor badge), paid on a pull request merged into the default branch,
  authored by the contributor's linked GitHub account.
- **Testing that ends in a fix** (`--work-type qa_report`, `product_qa` or
  `repro_packet`, qa_worker badge): a reproduced defect and the merged pull
  request that fixes it. A bug report alone is not paid here.

Every task comes from an open item on this board's Wanted list
(`bm wanted board_pf_terminal`). Pay with
`review <taskId> --decision reward --pft N --reason "..." --feedback "..."`.
