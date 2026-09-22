# Budget Decisions integration

Task Node Chat + menu now starts budget Corbanu Decisions with optional saved
Context, durable chat progress, inline Markdown reports and Markdown/PDF/packet
downloads. The signed gateway integration enforces budget mode and account
ownership. Like the existing internal Deep Research route, service-sponsored
usage does not debit a user's prepaid balance.

Validation:

- `npm run lint`, `npm run format-check`, `npm run build`.
- `npm run decisions-boundary-smoke`, `npm run deep-research-boundary-smoke`.
- `npm run migration-registration-smoke`, `npm run public-help-check`.
- `DATABASE_URL=<local fixture database> npm run decisions-repository-smoke`:
  creates and removes an isolated schema; checks concurrent idempotency, context
  pinning, account isolation, rollback, durable report and stale poll handling.
- With Vite on port 5199 and Playwright available,
  `npm run decisions-browser-smoke`: real ChatSurface, mocked API responses;
  checks composer, context selection, progress, reload without a second create,
  inline report, copy, Markdown download, PDF/packet links and mobile layout.
- Gateway: 58 Decisions and Deep Research tests passed, plus typecheck/build.
  Includes the complete budget pipeline with synthetic model/research responses,
  HMAC/body/expiry checks, sponsored accounting and cross-account denials.

No paid decision was submitted for these fixtures. Public API prepaid billing
and standard mode remain separate from the budget-only Task Node integration.

Production verification:

- Gateway commit `1c5f5c6` deployed on both API machines.
- Task Node code commit `002c71f`; applied onto the existing local production
  checkout while preserving its unrelated edits. The app image extends the
  previous production image and replaces only the touched server files, migration,
  and rebuilt browser assets. Existing worker images remain unchanged.
- App machine `8d4930ae156638` is healthy on
  `registry.fly.io/tasknodeofficial-dev:decisions-budget-20260919`
  (`sha256:8f0fbe5fdde994a0b110fbffc38579e35331decac6df079f5963f0f010989116`).
- Migration `141_decision_jobs.sql` is applied and `decision_jobs` exists.
- A signed production Task Node lookup of an absent job returns Corbanu's
  `404 decision_not_found`; an empty signed create returns
  `400 invalid_decision_request` before any model or research call.
- Unauthenticated Task Node Decisions retrieval returns `401`.
- All five entry-page JS/CSS assets served at `tasknode.postfiat.org` match the
  release bytes. Existing account-switching and daily-airdrop server hashes match
  the previous production image.

These checks verify deployment, signing, migration and delivery. The complete
model/research workflow was exercised with fixtures; no new paid live report was
commissioned for this UI integration.

## Context and memory attachment repair

The original integration attached the saved Context document but omitted chat
memories. Account inspection confirmed that decision-relevant personal context
was present in the normal chat memory selection but absent from the saved
Decisions input and every downstream model prompt.

Commit `6309cc8` adds account-scoped loading of three deep and 36 recent memory
records, with dated summaries and current-user correction precedence. The job
stores a document revision, memory IDs and input hash. Idempotent retries retain
the original snapshot; failed loads and oversized inputs stop before submission.
The card discloses the attached document and memory count, and old jobs remain
labeled as document-only. No existing report is retroactively changed.

Validation: lint, formatting, build, public-help and migration discovery passed;
the PostgreSQL fixture covers memory inclusion, snapshot stability, concurrent
idempotency, opt-out, failed-load rollback, memory-only context and persistence.
The signed request fixture passed. The browser rendered the new checkbox and
39-memory disclosure with reload, copy, downloads and mobile layout checks.

Production app image `decisions-context-memory-20260919`, digest
`sha256:5008851b189a96bb033d28ff816bc454d9298b5d0ba0921b82c9aa196b780d0c`,
is healthy. Migration `142_decision_context_snapshot.sql` is applied. All five
public entry assets match the release bytes. The deployed loader and signed
request serializer were exercised against actual account data with the HTTP
dispatch stubbed: the complete expected document and all 39 selected memories
matched the preview exactly. No new job or paid model call was made; the
existing report hash remained unchanged. This verifies attachment, not a new
model-generated recommendation. Private evidence remains outside the repository.
