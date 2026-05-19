# Review Plan: Database Architecture

Source doc: `docs/wiki/architecture/database.md`
App doc group: Architecture
App doc slug: `database`
Review status: review_ready
Code review complete: no
Owner: unassigned
Last updated: 2026-05-18

## Important App Surfaces

- `server/db/migrate.js`, `server/db/pool.js`
- `server/db/migrations/*.sql`
- `server/repositories/chat-billing.js`
- `server/repositories/context.js`
- `server/repositories/chat-memory.js`
- `server/repositories/tasks.js`
- `server/repositories/pftl-cache.js`
- Runtime fallback paths in `server/runtime-store.js`

## What Could Go Wrong

- Migration order or idempotency breaks fresh deploys.
- Runtime fallback and Postgres repository behavior diverge.
- Account ownership checks differ by repository.
- Cache tables are treated as canonical without rebuild paths.
- Strict/fallback database behavior hides production persistence failures.

## Best Practices To Check

- Migrations should be idempotent, ordered, and covered by smoke tests.
- Repositories should enforce owner scope at query boundaries.
- Cache tables should have source metadata, replay/rebuild strategy, and stale
  state where applicable.
- Runtime fallbacks should be explicit dev behavior, not silent production
  recovery.

## Code Review Plan

1. Review migration list, table ownership, indexes, and constraints.
2. Review repository account filters and update/delete predicates.
3. Compare runtime fallback behavior with Postgres behavior.
4. Check migration and smoke coverage for each cache family.
5. Identify cache tables that lack rebuild or stale-state contracts.

## Evidence To Capture

- `npm run db:migrate` against a clean database.
- Repository smoke tests for chat, context, memory, tasks, and PFTL cache.
- Negative owner-scope cases where available.

## Completion Checklist

- [ ] Source doc claims mapped to implementation.
- [ ] User-visible workflow reviewed.
- [ ] Persistence and ownership boundaries reviewed.
- [ ] Billing, provider, wallet, or chain effects reviewed where applicable.
- [ ] Tests or smoke evidence recorded.
- [ ] Findings written with realistic severity.

## Review Findings

Not started.
