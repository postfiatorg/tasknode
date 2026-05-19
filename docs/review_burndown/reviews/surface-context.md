# Review Plan: Context

Source doc: `docs/wiki/surfaces/context.md`
App doc group: Surfaces
App doc slug: `context`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `src/main.jsx` / `ContextView`
- `src/features/context/context-view-utils.jsx`
- `src/features/context/context-publish.js`, `src/features/context/context.css`
- `shared/context-html.js`
- `server/repositories/context.js`
- `server/context-publish.js`, `server/context-ipfs.js`, `server/context-history-rpc.js`
- `server/pftl-pointer.js`, `server/pftl-submit.js`
- `server/db/migrations/003_context_cache.sql`

## What Could Go Wrong

- Context editing accidentally requires a wallet or loses signed-in account state.
- Autosave or restore overwrites current context without clear user intent.
- Published context pointer metadata and cached document revision diverge.
- Historical context for a delinked or different wallet remains visible.
- HTML normalization differs between client and server.

## Best Practices To Check

- Current context cache should be account-scoped and wallet-independent.
- Publish should require explicit wallet state and produce recoverable metadata.
- Restore should be preview-first and explicit before replacing current content.
- HTML/text normalization should be shared, tested, and bounded.

## Code Review Plan

1. Trace save, autosave, restore, publish, and history discovery paths.
2. Verify account scope for current context and wallet scope for history.
3. Review HTML sanitization and normalization on client/server.
4. Review PFTL/IPFS publish path and pointer metadata.
5. Run context repository and history smoke tests.

## Evidence To Capture

- `npm run db:context-smoke`
- `npm run context-history-rpc-smoke`
- A delink/relink history visibility case.
- A restore preview/overwrite workflow note.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
