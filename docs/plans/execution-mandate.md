# Execution Mandate

This document is the operating contract for Task Node development.

## Core Rule

Do not claim a feature is done unless the actual user-facing path has been executed and verified in the running app or by an equivalent live protocol test that exercises the same production code path.

If a Python demo, smoke test, unit test, or script proves only a reference path, it must be described as a reference path. It is not the app pipeline unless the app invokes it.

## Repository Boundary

- Primary repo: `/home/pfrpc/repos/tasknode`
- Local app URL: `http://localhost:5174`
- API container: `tasknodeofficial-api-1`
- Web container: `tasknodeofficial-web-1`
- Postgres container: `tasknodeofficial-db-1`
- Postgres database: `tasknodeofficial`
- Postgres user: `tasknodeofficial`

PFTasks is historical reference material only. It is not the runtime authority for this app.

## Required Development Loop

For every product behavior change:

1. Identify the real boundary that failed: UX, route, worker, wallet signing, encryption, IPFS, PFTL, cache, projection, provider, persistence, or docs.
2. Patch that boundary in this repo.
3. Run fast static checks.
4. Run route/API checks.
5. Run the actual local app path when the change affects UX.
6. For task, wallet, and PFTL changes, run a live protocol smoke or state exactly why a live run was not possible.
7. Update these in-app docs for changed behavior.
8. Report what was verified with concrete identifiers where relevant: transaction hash, CID, task ID, request ID, route, screenshot path, or database row.

## UX Verification

When changing visible UX, inspect the rendered app at `http://localhost:5174`.

Screenshots are required for substantial layout changes, modal changes, navigation changes, task detail pages, wallet flows, chat composer behavior, docs pages, or anything explicitly reported as visually broken.

A React build proves compilation. It does not prove the UX is correct.

## Task Engine Definition

Task requests are not complete when they are merely recorded.

A complete task request pipeline means:

1. User action creates a signed `pf.task.request.v1` PFTL pointer.
2. A worker consumes the request.
3. The authority emits a `pf.task.offer.v1` pointer.
4. The PFTL cache and reducer project the task into `task_projections`.
5. The Tasks UX shows the task in the correct tab.
6. The task detail and forensics pages show event history, CIDs, transaction hashes, and readable payload content when decryptable.

If only step 1 works, call it request publishing. If steps 1 and 2 work, call it queue ingestion. Only call it end-to-end task generation when the UX shows the generated task from projection state.

## Baseline Verification Commands

```bash
npm run quality
npm run build
npm run runtime-smoke
npm run security-smoke
npm run chat-attachment-smoke
npm run route-smoke
git diff --check
```

Database inspection:

```bash
docker exec tasknodeofficial-db-1 psql -U tasknodeofficial -d tasknodeofficial -c "SELECT now();"
```

Logs:

```bash
docker logs --tail 120 tasknodeofficial-api-1
docker logs --tail 120 tasknodeofficial-web-1
```

## Status Language

- Published request pointer: a PFTL request transaction exists.
- Queued: a durable worker-readable row or event exists.
- Generated offer: a `pf.task.offer.v1` event exists.
- Visible task: `task_projections` backs a task shown in the UX.
- End-to-end: the full user-visible flow completed.

Reference demos are useful, but they are not production integration until the app invokes them.
