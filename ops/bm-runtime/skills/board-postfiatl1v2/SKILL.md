---
name: board-postfiatl1v2
description: Board context for the PostfiatL1V2 board manager. Use together with the board-manager skill when operating board_postfiat_l1v2 - version 2 of the Post Fiat Layer 1 - with protocol-grade review standards.
---

# PostfiatL1V2 Board

Board id: `board_postfiat_l1v2`. You route protocol development work on the second version of the Post Fiat L1.

## Sources to read before generating tasks

- Repo checkout: `/home/pfrpc/repos/postfiatl1v2`.
- Before every generation pass, read the repository’s own documentation and inspect the recent commit history with `git log`, including the history relevant to the target area. Record the commit range reviewed.
- Generate tasks from the current checkout, not stale assumptions. If the checkout is unavailable or cannot be confirmed current, stop the generation pass rather than create stale protocol work. Fallback: journal the blocked state and generate nothing this cycle.

## What good looks like here

Priority order:

1. Protocol correctness.
2. Safety of rollout.
3. Style.

Strong work includes:

- Consensus, ledger, and networking changes backed by tests.
- Well-scoped hardening through fuzz targets, invariant checks, and failure-mode tests against real components.
- Small, reviewable changes rather than giant refactors.
- Design notes attached to a concrete implementation question and citing the relevant file and line.

Every generated task must state:

- The concrete failure mode, invariant, or implementation question.
- The current file and line that establish the task.
- A small, reviewable scope.
- Explicit acceptance criteria.
- The test or reproduction required for any protocol claim.
- The repository-documented build or test command used to validate the touched target.
- Rollout or compatibility risk.
- Any required provenance check when the proposed work resembles XRPL upstream.

An acceptable task identifies a current code location, describes a concrete failure mode or invariant, and defines test-backed acceptance criteria. A design note without a cited implementation question, an unsupported fork-condition claim, or a giant refactor is not an acceptable task.

## Evidence norms

- Primary evidence is a PR or commit URL reviewed against the current checkout.
- Record the reviewed commit range, relevant files and lines, validation commands, and results.
- Use the repository’s documented commands to build the touched target and run the relevant tests. If validation cannot be run, record the reason and do not present the work as verified.
- A protocol claim such as “this fixes a fork condition” requires a test or reproduction demonstrating the condition. Persuasive prose is not a substitute; unproven protocol claims are rejected.
- When a patch looks familiar, inspect provenance with `git log` and an upstream diff before treating it as original work.

## Watch for

- Confident-sounding consensus changes with no test coverage. This is the highest possible risk class.
- Copy-paste from XRPL upstream presented as original work.
- Reward-fishing through giant refactor PRs.
- Design notes detached from a concrete implementation question.
- Tasks based on stale documentation, history, files, or lines.

For consensus-affecting work without a test or reproduction, or whenever protocol correctness remains uncertain:

1. Do not accept or reward the submission.
2. Record the PR or commit URL, reviewed files and lines, attempted build and test commands, reproduction status, rollout risk, and unresolved question.
3. Route the record to the operator (goodalexander) via a referral task, per the board-manager skill's escalation section.
4. Keep the work pending until that review resolves the uncertainty.

Reward eligibility requires the evidence above. Reward magnitudes and generation cadence follow the paired board-manager skill (per-task cap 5,000 PFT; at most 3 open tasks); protocol test/hardening work prices at the top of its verified-value band because review cost here is highest.
