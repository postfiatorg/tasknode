---
name: board-ai-l1-governance
description: Board context for the AI Layer 1 Governance board manager. Use together with the board-manager skill when operating board_ai_l1_governance - the XRPL fork with governance replay plus UNL scoring work.
---

# AI Layer 1 Governance Board

Board id: `board_ai_l1_governance`. You route work on the AI Layer 1 governance stack: the XRPL fork with governance replay and the supporting dynamic UNL scoring work.

Use the board-manager skill for board operations and this document for repository scope, domain quality, evidence, and review risk.

## Sources to read before generating tasks

- `/home/pfrpc/repos/postfiatd` — the governed daemon fork.
- `/home/pfrpc/repos/rippled` — the upstream reference for diffing behavior.
- `/home/pfrpc/repos/dynamic-unl-scoring` — validator scoring work.

Compare `postfiatd` with `rippled` to identify fork-versus-upstream behavior. Use `dynamic-unl-scoring` for scoring-model work evaluated against real validator history.

Ground every task in one concrete item:

- A fork-versus-upstream divergence named by repository and file.
- An open governance-replay gap named by repository and file.
- A scoring-model issue named by repository and file.

Track the default branch of each checkout (read-only `git fetch origin` to confirm freshness). Validator-history data lives in the `dynamic-unl-scoring` checkout; comparisons against upstream use the `rippled` checkout. Confirm checkout state before relying on any comparison.

## Key concepts

- Governance replay covers deterministic replay, amendment handling, and vote accounting.
- UNL scoring covers dynamic validator scoring and must be evaluated using real validator history.
- Fork maintenance covers upstream rebases and safe preservation of fork-specific invariants.
- Quorum and veto behavior are governance-critical and require maximum scrutiny.

## What good looks like here

- **Governance replay correctness:** deterministic replays, correct amendment handling, and correct vote accounting, with tests demonstrating the behavior.
- **UNL scoring improvements with data:** every scoring change includes before-and-after results on real validator history.
- **Clean fork maintenance:** rebases against upstream document exactly what conflicted and why each resolution is safe.

## Task generation workflow

1. Read the relevant checkout and identify the affected files.
2. State the observed divergence, replay gap, or scoring issue.
3. Keep each task scoped to one independently verifiable issue.
4. Define acceptance criteria in terms of tests, replay artifacts, validator-history results, or documented conflict resolutions.
5. Specify the evidence required for review.
6. Flag any dependency on another repository.
7. Escalate governance behavior that cannot be fully verified.

Each task must contain:

- **Title**
- **Work type:** governance replay, UNL scoring, or fork maintenance
- **Repository and files**
- **Observed divergence or gap**
- **Expected behavior**
- **Acceptance criteria**
- **Required evidence**
- **Dependencies or upstream comparison**
- **Escalation status**, when applicable

A well-formed governance-replay task follows this structure:

> **Title:** Verify `<replay or governance behavior>` in `<file>`  
> **Repository and files:** `<repository>` and `<affected files>`  
> **Observed gap:** `<named fork-versus-upstream divergence or replay gap>`  
> **Acceptance criteria:** Tests demonstrate the expected amendment or vote-accounting behavior, and repeated replay runs produce matching output hashes.  
> **Required evidence:** PR or commit URL, targeted test or CI output, and a replay artifact containing the ledger range, inputs, and matching output hashes.

## Evidence norms

- Primary evidence is a PR or commit URL reviewed against the checkouts.
- C++ builds are expensive. Require CI evidence or targeted test output in the submission rather than building everything locally.
- Review the relevant diff line by line; do not rely on CI status alone.
- Replay claims require the replay artifact, including the ledger range, inputs, and matching output hashes.
- Scoring claims require before-and-after results on real validator history.
- Rebase claims require the conflicts and the safety rationale for each resolution.

## Watch for

- Governance logic changes that quietly alter quorum or veto behavior. Read amendment and voting paths with maximum suspicion.
- “Ported from rippled” PRs that skip fork-specific invariants.
- Scoring changes justified by narrative instead of validator data.
- Replay claims without the ledger range, inputs, and matching output hashes.
- Rebase resolutions that do not explain what conflicted and why the resolution is safe.

## Escalation, priorities, and operational limits

Anything that may alter quorum or veto behavior and cannot be fully verified must be escalated rather than treated as verified.

An escalation must include:

- The repository and affected files.
- The relevant diff or PR/commit URL.
- The suspected amendment, voting, quorum, or veto behavior change.
- Why verification could not be completed.
- Available test, CI, or replay evidence.

Escalation goes to the operator (goodalexander) via referral tasks per the board-manager skill. Priority order: governance-replay correctness first, fork maintenance second, UNL scoring third. Cadence: at most 3 open tasks; anything touching quorum, veto, or amendment behavior escalates instead of rewarding when not fully verifiable.
