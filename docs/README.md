# Task Node Documentation

This directory contains several different kinds of material. They do not all
have the same authority or publication status.

## Read Order

1. [`wiki/index.md`](wiki/index.md) — user/product Help map.
2. [`wiki/architecture/current-system.md`](wiki/architecture/current-system.md)
   — implemented runtime and trust boundaries.
3. [`wiki/architecture/bootup.md`](wiki/architecture/bootup.md) — local startup
   and focused verification.
4. [`open-source-readiness.md`](open-source-readiness.md) — blockers and exit
   gates for a safe public release.
5. Topic-specific surface or architecture pages linked from the wiki index.

## Authority Rules

- Current behavior is defined by the implementation, migrations, deployment
  configuration, and executable tests. Documentation must be corrected when it
  disagrees with those sources.
- Current user and product behavior belongs in `docs/wiki/surfaces/` and the
  small set of current architecture pages linked from `wiki/index.md`.
- A dated file under `docs/wiki/plans/` is a proposal or historical execution
  record unless it explicitly identifies itself as the current active plan. It
  must not silently override implemented behavior.
- `docs/archive/` is historical reference only.
- `docs/verification/` is internal evidence, not product documentation. Its
  contents have not been approved for public release.
- Legacy PFTasks and PFDocs material is migration archaeology, not executable
  authority for this repository. The PFDocs integration is a separate service
  boundary used by the current Docs surface.

Do not describe all of `docs/wiki/**` as uniformly authoritative. The current
tree contains dated plans, migrations, audits, and operator details alongside
current Help pages; separating those classes is a P0 open-source task.

## In-App Help Publication Boundary

The production frontend imports Markdown and prompt files through
`src/features/docs/docs-content.js`. Imported text is compiled into browser
assets and should be treated as public to every visitor, even if a page is not
prominent in navigation.

The present import graph is too broad for public release. Before open sourcing:

1. define an explicit allowlist of public user/developer pages;
2. exclude production runbooks, incident notes, user-specific evidence, dated
   cutover artifacts, and prompts not explicitly approved for publication;
3. test the built assets for forbidden strings and unapproved source files; and
4. keep private operations and verification evidence in an access-controlled
   system.

## Documentation Audiences

Use these destinations consistently:

| Audience | Location | Content |
| --- | --- | --- |
| Product users | `docs/wiki/surfaces/` | Current behavior, limits, recovery, and privacy expectations |
| Public contributors | root README and future public architecture/API/security docs | Safe setup, trust boundaries, contribution and verification rules |
| Internal operators | private operations repository | Production app names, credentials classes, deploy/pause/restore and incident procedures |
| Historical research | `docs/archive/` or external archive | Superseded specs, mocks, decisions, and dated evidence |
| Verification evidence | private artifact store | Screenshots, account/wallet/task identifiers, generated payloads, and review packets |

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

## Missing Public Documents

The following are release blockers, not a casual backlog:

- owner-approved license and copyright notices;
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and `SUPPORT.md`;
- privacy policy, terms, retention/deletion/export policy, and subprocessors;
- third-party notices, SBOM, asset/content provenance, and trademark policy;
- public architecture and generated API/auth matrix;
- reproducible fresh-clone guide and protected CI/release policy.

The required contents and objective exit gates are tracked in
[`open-source-readiness.md`](open-source-readiness.md).
