# Board Manager Spec + Orc Proposal Progress

Source mandate: `work_in_progress/whip_mandate_boardmanager.md` in the primary
Task Node worktree.

Source proposal: `work_in_progress/board_manager_spec_and_orc_proposal.md` in
the primary Task Node worktree.

Rules carried forward:

- One branch and PR per phase.
- No deploys from these phase PRs.
- Do not decide Part 6 questions reserved for Alex.
- Preserve task lifecycle, capacity, reward, and custody boundaries.
- Do not add reward caps, blocklists, wallet bans, or deterministic
  auto-rejection gates.

## Phase Checklist

- [ ] Phase A - Specification and Instrumentation
  - Branch: `feat/bm-phase-a-spec-instrumentation`
  - PR: #74
  - Status: ready for review
  - Scope: docs/prompt vocabulary, Board Manager capability instrumentation
    source fields, Secretary capability-gap preservation, non-mutating smokes.
- [ ] Phase B - Capability Profiles
  - Branch: `feat/bm-phase-b-capability-profiles`
  - PR: #75
  - Status: ready for review
  - Scope: durable capability-profile table and admin-bearer verification
    route, Board Manager source-packet read model, task-work-type audit field,
    capability-profile smoke coverage.
- [ ] Phase C - Evidence Evaluation Orc
  - Branch: `feat/bm-phase-c-evidence-orc`
  - PR: #76
  - Status: ready for review
  - Scope: read-only artifact evaluation packet builder, persistence table,
    Board Manager/Hive task-detail surfacing, agent read helpers, evidence-orc
    smoke coverage.
- [ ] Phase D - Prompt/Taskgen Integration
  - Branch: pending
  - PR: pending
  - Status: not started
- [ ] Phase E - Orc UI
  - Branch: pending
  - PR: pending
  - Status: not started
