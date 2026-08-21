# Task Node Documentation

This directory contains several different kinds of material. They do not all
have the same authority or publication status.

## Read Order

1. [`wiki/index.md`](wiki/index.md) — user/product Help map.
2. [`wiki/architecture/current-system.md`](wiki/architecture/current-system.md)
   — implemented runtime and trust boundaries.
3. [`wiki/architecture/bootup.md`](wiki/architecture/bootup.md) — local startup
   and focused verification.
4. [`open-source-readiness.md`](open-source-readiness.md) — invariants proving
   that this repository remains the canonical production source.
5. Topic-specific surface or architecture pages linked from the wiki index.

## Authority Rules

- Current behavior is defined by the implementation, migrations, deployment
  configuration, and executable tests. Documentation must be corrected when it
  disagrees with those sources.
- Current user and product behavior belongs in `docs/wiki/surfaces/` and the
  small set of current architecture pages linked from `wiki/index.md`.
- Legacy PFTasks and PFDocs material is migration archaeology, not executable
  authority for this repository. The PFDocs integration is a separate service
  boundary used by the current Docs surface.

Do not describe all of `docs/wiki/**` as uniformly authoritative. Current
behavior still comes from code, migrations, deployment configuration, and
executable tests.

## In-App Help Publication Boundary

The production frontend imports Markdown and prompt files through
`src/features/docs/docs-content.js`. Imported text is compiled into browser
assets and should be treated as public to every visitor, even if a page is not
prominent in navigation.

The import graph is constrained by `docs/public-help-manifest.json` and checked
by `scripts/public-help-boundary.mjs`. Private evidence and user data are not
repository content.

## Documentation Audiences

Use these destinations consistently:

| Audience | Location | Content |
| --- | --- | --- |
| Product users | `docs/wiki/surfaces/` | Current behavior, limits, recovery, and privacy expectations |
| Public contributors | root README and public architecture/API/security docs | Safe setup, trust boundaries, contribution and verification rules |
| Operators | `ops/` and current architecture docs | Public executable procedures; credentials remain in the deployment secret store |
| Historical research | external archive | Superseded specs, mocks, decisions, and dated evidence |
| Verification evidence | private artifact store outside Git | Screenshots, account/wallet/task identifiers, generated payloads, and review packets |

## Writing Rules

- State whether a feature is implemented, configuration-gated, intentionally
  disabled, deprecated, or proposed.
- Do not copy route lists, process lists, model IDs, or environment values by
  hand when they can be generated or linked from the owning source.
- Do not include real secrets, credential suffixes, private incident details,
  personal identifiers, raw production data, recovery phrases, or decrypted
  user content.
- Use repository-relative commands. Machine-specific paths such as
  `/home/<user>/...` and temporary evidence paths do not belong in public docs.
- A public-chain address or transaction is still user-linked data. Include it
  only when publication is necessary, consented, and documented.
- Do not append generic reviewer checklists to every page. Use a focused
  verification section only when the reader can actually run the checks.
- Keep product truth current; move completed plans and dated investigations out
  of the authoritative navigation rather than adding permanent disclaimers to
  stale prose.

The publication and production-source invariants are tracked in
[`open-source-readiness.md`](open-source-readiness.md).
