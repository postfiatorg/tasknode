# Review Plan: Agents

Source doc: `docs/wiki/surfaces/agents.md`
App doc group: Surfaces
App doc slug: `agents`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `reference_clients/python/tasknode_pftl/`
- Task projection and PFTL cache repositories
- `server/repositories/tasks.js`
- Future delegated capability design, if implemented
- Web app task/cache display surfaces

## What Could Go Wrong

- The app assumes task actions originate only from the web UX.
- External PFTL pointer events are not replayed into the app cache.
- Agent/delegated permission language appears production-ready before a
  capability design exists.
- Cache conflict handling drops externally produced events.

## Best Practices To Check

- External clients should use the same protocol objects and reducer semantics as
  the web app.
- App caches should be rebuildable from wallet histories and IPFS payloads.
- Delegated permissions should remain explicitly future work until implemented.
- Replay should be idempotent and source-attributed.

## Code Review Plan

1. Review Python client scenarios and reducer against app task projections.
2. Verify app task/cache code can ingest externally produced PFTL events.
3. Check whether UI labels external activity honestly.
4. Review any delegated permission claims for implementation backing.
5. Capture gaps between reference client and web cache.

## Evidence To Capture

- Python reducer test output.
- Imported receipt/projection fixture.
- App display of externally generated task state.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
