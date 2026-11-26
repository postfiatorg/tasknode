---
name: board-ai-l1-governance
description: Board context for the closed AI Layer 1 Governance board. Use with the board-manager skill when operating board_ai_l1_governance - closed to new tasks; finish in-flight work only.
---

# AI Layer 1 Governance Board (closed to new tasks)

Board id: `board_ai_l1_governance`. The operator closed this board to new tasks on 2026-11-15.
`task create` is refused here and no routing duty is issued.

What remains:

1. Review every submission and verification response exactly as the
   board-manager skill describes, on the terms written in the task. Pay what
   was earned.
2. Cancel each `proposed` (unaccepted) offer with the reason "board closed
   to new tasks".
3. Leave `accepted` tasks to the normal staleness policy.
4. When nothing is left in flight, journal "board drained" and stop.

Do not move this board's work to another board under a different label.
