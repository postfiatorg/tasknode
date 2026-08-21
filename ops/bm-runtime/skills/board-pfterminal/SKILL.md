---
name: board-pfterminal
description: Board context for the PF Terminal board manager. Use together with the board-manager skill when operating board_pf_terminal - Post Fiat's internal terminal tool - with repo-grounded task generation and code-first review.
---

# PF Terminal Board

Board id: `board_pf_terminal`. You route work on PF Terminal, Post Fiat's
internal terminal agent tool: a Rust/TypeScript codebase forked from Codex
CLI with Post Fiat integrations for vault, wallet, plans, GPU rental,
Telegram, and Task Node.

## Sources to read before generating tasks

- Repo checkout: `/home/pfrpc/repos/PfTerminal`.
- Confirm the checkout is available and current before using it. If it is
  missing or its freshness cannot be established, stop task generation and
  report the board as blocked.
- Ground every task in a real file, issue, or defect you located yourself.
  Read:
  - `README.md`
  - Open TODOs: `rg -n "TODO|FIXME" --glob '!node_modules'`
  - Recent commits: `git log --oneline -20`
  - Open PRs: `gh pr list -R postfiatorg/PfTerminal`
- Check open PRs before creating a task so work already in progress is not
  duplicated.

## Task admission and format

Create a task only when it has:

- A real source file, issue, TODO, or independently reproduced defect.
- Exact reproduction commands, versions, and output when behavior is
  defective or flaky.
- Relevant file paths or symbols showing where the work likely belongs.
- A small proposed scope that respects the existing architecture.
- Concrete acceptance criteria, including the expected behavior.
- The package tests or other validation expected for the touched code.
- A statement that open PRs were checked for overlapping work.
- A priority rationale based on reproducibility, impact, and verification.

Use this task body:

```markdown
## Source
- File, issue, TODO, or defect:
- Relevant paths or symbols:
- Overlapping open PRs checked:

## Reproduction
- Commands:
- Versions:
- Actual output:
- Expected behavior:

## Scope
- Proposed change:
- Explicit scope limits:

## Acceptance criteria
- [ ] Defect or behavior is addressed.
- [ ] Relevant test coverage is added or updated.
- [ ] Touched code passes the required checks.
- [ ] Evidence URL is provided.

## Validation
- Commands:
- Expected evidence:

## Priority rationale
- Reproducibility, impact, and verification:
```

## What good looks like here

- Small, verifiable PRs against real defects. A reproduced bug with a fix
  and a test beats any amount of documentation.
- Reproduction packets for flaky behavior: exact commands, versions,
  output, and where in the code the fault likely lives.
- Contributions that respect the existing architecture. A PR that rewrites
  half a subsystem to fix a typo is a request-changes.
- Performance work backed by a benchmark before and after the change.

## Evidence norms

- Primary evidence is a GitHub PR or commit URL.
- Review PRs with `gh pr diff` and `gh pr view` against the checkout.
- Open the diff and confirm every referenced path exists.
- Run `cargo check` and the touched package's tests when the diff warrants
  it.
- For TypeScript changes, run the touched package's own scripts as declared in its `package.json`; do not invent repository-wide commands.
- Screenshots are supporting evidence for TUI behavior only and must be
  paired with the commands needed to reproduce the behavior.
- If required checks cannot be run, record that validation as incomplete.
  Do not treat the submission as verified until the missing evidence is
  available.

Use this review checklist:

```markdown
- [ ] GitHub PR or commit URL inspected.
- [ ] Diff and referenced paths verified.
- [ ] Change matches the task's scope and acceptance criteria.
- [ ] `cargo check` completed when applicable.
- [ ] Touched package tests completed when applicable.
- [ ] TUI screenshots include reproduction commands when applicable.
- [ ] Benchmark before and after is present for performance claims.
- [ ] Documentation-only work is not claiming code-tier rewards.
```

## Watch for

- Documentation-only PRs claiming code-tier rewards.
- AI-generated PRs that do not compile or reference files that do not
  exist—open the diff and check the paths.
- Vague “improve performance” claims with no benchmark before and after.
- Large subsystem rewrites presented as fixes for narrowly scoped defects.
- Claims based only on screenshots, summaries, or generated text rather
  than the submitted code and reproducible evidence.

## Scope and unresolved board policy

- Checkout freshness: read-only `git -C /home/pfrpc/repos/PfTerminal fetch origin` then compare `git log origin/HEAD -1`; never mutate the checkout (it is a shared working tree).
- TypeScript commands: whatever the touched package's `package.json` declares; absence of declared tests is itself review feedback.
- Cadence: at most 3 open tasks on this board at once.
- Reward tiers and task-sizing thresholds beyond rejecting
  documentation-only claims for code-tier rewards: cap documentation-only work at 1,000 PFT and say so in the task.
- Repository-specific security review rules for vault, wallet, and other
  Post Fiat integrations: treat vault/wallet/billing-touching PRs as high risk — escalate to the operator rather than reward when custody boundaries are unclear.
- Dependency updates and vulnerability reports: require a reproduction or advisory link plus the minimal diff; bulk bump PRs are request-changes by default.
