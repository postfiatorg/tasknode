# Agent Review Quality Guidelines

Date: 2026-05-23
Audience: agents reviewing Task Node Official PRs

## Purpose

The goal of a review is to establish whether a change is safe to merge into the current app, not whether the branch description sounds plausible. A good review ties every claim to current `origin/main`, concrete files, concrete tests, and the actual runtime path when applicable.

## Required Review Loop

1. Fetch the branch and current `origin/main`.
2. Confirm the branch base and divergence before reading code.
3. Simulate the merge before saying the branch is mergeable.
4. Review the actual diff against `origin/main...HEAD`.
5. Inspect the exact surfaces requested by the author.
6. Run the smallest tests that prove the changed behavior.
7. Run at least one broader quality check when the branch touches shared code.
8. Clearly separate what was verified from what was not verified.

## Branch And Merge Checks

Run these first:

```bash
git fetch origin main <branch-name>
git status --short --branch
git rev-parse --short origin/main
git rev-parse --short HEAD
git merge-base HEAD origin/main
git rev-list --left-right --count origin/main...HEAD
git merge-tree --write-tree origin/main HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

Use `origin/main...HEAD` for PR review diffs. Do not rely on `origin/main..HEAD` until you know the branch is rebased cleanly; otherwise it can make current `main` work look like deletions from the branch.

If `merge-tree` reports a conflict, say that directly. Do not call a branch ready while it still needs conflict resolution.

## Findings Standard

Findings must be written like code review findings:

- Lead with the issue, not praise.
- Include severity when useful: P0, P1, P2.
- Include file and line references.
- Explain the user or system consequence.
- State the concrete fix expected.

Avoid vague statements like "looks good overall" unless all targeted risks were actually checked.

## Verification Standard

A check is only valid for the code path it exercises.

Examples:

- A JSON runtime-store smoke does not prove Postgres persistence.
- A unit helper test does not prove `/api/chat/send`.
- A branch-local script does not prove the Docker container if Docker is still running `main`.
- A dry-run response does not prove normal send or stream persistence.
- A reference Python demo does not prove the app pipeline.

When a claim is about persistence, query the persistence layer or run a smoke that asserts the row. For chat model metadata, verify `chat_model_runs.metadata_json`.

When a claim is about Docker, first verify the container actually contains the branch code:

```bash
docker exec tasknodeofficial-api-1 sh -lc 'git rev-parse --short HEAD 2>/dev/null || true'
docker exec tasknodeofficial-api-1 sh -lc 'test -f server/<new-file>.js && echo present || echo missing'
```

If the container is still on `main`, say "Docker was not a valid verification target for this branch." Then either deploy the branch into Docker or run an isolated branch server and label it accurately.

## PR #1 Lessons

The chat review PR had four review-critical areas:

- `contextStatus` response shape in dry-run and send responses.
- `runMetadata.contextStatus` persistence through `appendChatTurn`.
- Context Refine using a separate chat path that also needed metadata.
- Jobs retrieval timeout status being masked by a generic skipped branch.

The correct review was not only "does `contextStatus` appear somewhere." The review needed to answer:

- Does dry-run return the status shape?
- Does normal send return the status shape?
- Does stream `done` SSE return the status shape?
- Does Context Refine persist the status shape?
- Does Postgres store the status shape in `chat_model_runs.metadata_json`?
- Does the timeout state report as `timeout`, not merely `skipped`?

## Minimum Evidence For Chat Reviews

For chat provider, context, billing, memory, attachment, or stream changes, capture:

```bash
npm run quality
npm run chat-attachment-smoke
npm run security-smoke
git diff --check origin/main...HEAD
```

Add targeted checks for the changed surface. If the change touches context status, include:

```bash
npm run chat-context-status-smoke
DATABASE_URL=postgres://tasknodeofficial:tasknodeofficial@localhost:5436/tasknodeofficial node scripts/chat-context-status-smoke.mjs
```

If stream behavior changed, verify the SSE events and final `done` payload.

## Reporting Template

Use this shape in the final review:

```md
Findings

1. P1: <issue>
   File: <path:line>
   Impact: <what breaks>
   Fix: <what must change>

2. P2: <issue>
   File: <path:line>
   Impact: <what breaks>
   Fix: <what must change>

Verification

- Branch: <branch>@<sha>
- Base: origin/main@<sha>
- Merge simulation: clean/conflict
- Commands run:
  - <command> - passed/failed
- Runtime checked:
  - Docker: yes/no, and whether Docker contained this branch
  - Branch server: yes/no

Recommendation

- Merge / do not merge / rebase and rerun.
```

## Do Not Overclaim

Use precise language:

- "Unit smoke passed" means helper behavior passed.
- "Postgres persistence passed" means a Postgres row was asserted.
- "Route checked" means the API route was exercised.
- "Docker checked" means the running Docker service contained the branch code.
- "Mergeable" means merge simulation or actual merge completed without conflicts.

If a check was skipped, say why and what would be needed to complete it.
