# Open-Source Readiness

Status: **MIT-licensed engineering candidate verified; clean protected release pending**

Review date: 2026-08-16
Source commit under review: `3ac8dd9c8a8e5e10c1e521501d383dc6173e282a` plus the current working-tree changes
Release unit: the exact output of `scripts/export-public-candidate.mjs`, not the private operator working tree

## Decision

The application-level release blockers identified by the original review have
been repaired and exercised against an independently exported candidate. Do
not change repository visibility yet. The remaining blockers require owner,
legal, security, operations, or hosted-repository authority that cannot be
manufactured in source code:

1. The owner/legal reviewer must approve the privacy policy, terms, trademark
   boundary, third-party notices, and asset/content provenance.
2. A human must review the exact candidate and full history for privacy,
   confidential material, and provenance. Automated secret scanning is clean
   subject to the documented synthetic-fixture reviews, but it is not a legal
   or privacy opinion.
3. GitHub branch/tag protection, CODEOWNERS enforcement, release-environment
   approval, and the separate private production-operations authority must be
   verified in their hosted systems.
4. A release must be generated from a clean protected commit. The current
   verification intentionally used the local-only `--allow-dirty` and
   `--allow-unlicensed` flags and is not a releasable artifact.

Subject to those approvals, there is now an evidence-backed public candidate
rather than a proposal to publish the internal repository directly.

## Requirement Status

| Original release requirement | Status | Implemented evidence |
| --- | --- | --- |
| Publication rights and governance | **Implemented; policy review remains** | Task Node is distributed under the permissive MIT License. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `PRIVACY.md`, `TERMS.md`, `TRADEMARKS.md`, and `THIRD_PARTY_NOTICES.md` exist. Dependency-license and asset-provenance checks are required. |
| Explicit public/private publication boundary | **Implemented** | `release/publication-manifest.json` is an allowlist. It excludes live Fly configuration, operations, verification/incident evidence, generated runs, private plans, production scripts, and the private deterministic-board seed. `PUBLICATION.json` records the emitted inventory and SHA-256 digests. |
| Browser Help boundary | **Implemented** | `docs/public-help-manifest.json` explicitly permits 26 Markdown sources. The build fails if the browser statically or dynamically imports an unapproved document. Each page is loaded on demand; full-text search fetches the allowlisted corpus only after a search. Prompt and private-operation archives are not an implicit Help source. |
| Full-history and exact-candidate secret scanning | **Implemented; human review remains** | Pinned Gitleaks and TruffleHog scans run in CI. Full history has zero Gitleaks findings and nine reviewed, unverified synthetic/non-secret TruffleHog findings. The exact candidate has zero Gitleaks findings and two reviewed local-test database fixtures, with zero verified or unreviewed findings. Review fingerprints expire and stale or new findings fail CI. |
| Dependency and asset provenance | **Implemented; owner approval remains** | `npm audit` reports zero vulnerabilities. CycloneDX and SPDX SBOMs, dependency-license checks, `THIRD_PARTY_NOTICES.md`, `provenance/assets.json`, and an asset-provenance gate are present. |
| Central route authorization | **Implemented** | All 150 registered route policies are centrally enforced across eight auth modes. A source-backed regression scan proves the registry covers 133 literal API paths in the registered handlers, while dynamic route families are declared as patterns. Negative smoke coverage checks anonymous, account, bearer, webhook, admin, stale-session, and cross-account boundaries. The generated API reference must match the registry. |
| Request boundary validation | **Implemented** | Every parsed JSON body receives size, media-type, object-shape, depth, node-count, and prototype-pollution checks. All 77 mutation policy families fail closed without an explicit typed or empty body contract and reject undeclared top-level fields; the sole exception is Telegram's size-bounded, typed-discriminator webhook contract, which preserves provider forward compatibility. The generated API reference publishes each mutation body's enforced byte limit. |
| Shared abuse controls and trusted proxies | **Implemented** | Public rate limits use transactional Postgres buckets rather than process memory. Trusted proxy CIDRs are explicit, and forged forwarding-header behavior is regression-tested. Public startup fails closed if the shared authority is unavailable. |
| Durable identity, auth, wallet, and deposit authority | **Implemented** | Accounts, email/provider identities, profiles, wallet links, web sessions, auth challenges, Ethereum deposit accounts/checkpoints, and terminal auth are Postgres-authoritative. Session, challenge, poll, and bearer secrets are stored as hashes. Legacy JSON import commits before clearing its source. Public startup refuses nondurable authority stores. |
| Account export, deletion, and retention | **Implemented** | Export/deletion dynamically cover account-owned tables, exclude secret hashes, and have lifecycle regression tests. `docs/data-retention.md` states retention and the Nostr/public-chain/IPFS exceptions. Scheduled purge covers expired auth, terminal, rate-limit, and retention-scoped data. |
| Backup, restore, and migration rollback | **Implemented locally; production evidence remains external** | The recovery tool refuses remote or unsafe targets. The exact public candidate applies 118 fresh-database migrations, backs up and restores Postgres plus legacy runtime state, proves sentinels and idempotence, and proves failed-migration rollback. Production backup custody, RPO/RTO, encryption, and two-person restore approval belong to private operations. |
| Safe local defaults | **Implemented** | Development Compose binds published ports to loopback, uses synthetic credentials/data, disables paid-model and protocol workers by default, and requires the explicit integration override for external/testnet connectivity. |
| Production/public-source separation | **Implemented in the candidate; hosted authority remains external** | Live `fly.toml`, data bridges, deploy tooling, incident response, and operator evidence are excluded. `fly.example.toml` contains synthetic names and an explicit trusted-proxy boundary. The public release workflow creates artifacts and attestations but never deploys the official service. |
| Minimal production image | **Implemented** | Pinned Node/Alpine `web-runtime` and `worker-runtime` targets install independent lockfiles and source closures, run as UID 1000, and remove npm, npx, Vite, and Codex. The web image has 278 source files/16 backend packages and no worker orchestrator; the worker image has 204 source files/6 packages and no HTTP entrypoint or browser assets. Synthetic Fly examples select the targets explicitly. The current pinned Trivy scan reports zero fixed HIGH/CRITICAL vulnerabilities in both images. |
| Real quality gate and protected CI definition | **Implemented; hosted enforcement remains external** | `npm run check` is green in the source tree and exact candidate. The file-size gate has zero active exceptions. ESLint enforces unused variables, React-hook dependencies, and undefined JSX-component rejection. CI covers checks, tests, build, bundles, supply chain, images, durable repositories, and recovery. |
| Reproducible release evidence | **Implemented** | The release workflow exports and rescans the exact candidate, independently installs/checks it, drills its migrations/recovery, and builds/scans both runtime images. It then re-exports a pristine tree, verifies that its publication-inventory digest matches the checked candidate, and emits the deterministic source archive and two SBOM formats without accidentally packaging `node_modules` or `dist`. It produces checksums and creates GitHub provenance/SBOM attestations. |
| Contributor entry points and extension surface | **Implemented** | Supported Node/npm versions, fresh-clone setup, architecture, API reference, recovery, release, security, support, contribution, issue/PR templates, CODEOWNERS, and an extension registry are checked in. The exporter replaces the private operator catalog with 25 canonical development, test, security, recovery, build, and runtime commands backed by one checked suite runner. |

## Exact Candidate Evidence

The latest local verification exported 843 files: 842 digest-inventoried
candidate files plus `PUBLICATION.json`. It used the
unlicensed/dirty test overrides, then exercised the emitted tree independently:

- `npm ci && npm run check`: pass.
- File-size gate: pass with zero active exceptions and no file over its normal configured limit.
- API/auth inventory: 150 policies covering 133 registered literal paths across eight auth modes.
- Request contracts: 77 fail-closed mutation policy families; minimum valid shapes and adjacent unknown-field rejection verified.
- Help boundary: 26 allowlisted Markdown sources.
- Browser bundles: main application 309 KB, Help shell 37 KB, and wallet application code 12 KB. React, XRPL encoding, key cryptography, and deferred libsodium have separate measured budgets; Help Markdown is page-scoped.
- Dependency audit: zero vulnerabilities.
- Gitleaks exact-candidate filesystem scan: zero findings.
- TruffleHog exact-candidate filesystem scan: two reviewed synthetic local-test
  database strings; zero verified or unreviewed findings.
- Fresh-database recovery drill: 118 migrations; database and legacy runtime
  restore, migration idempotence, failed-transaction rollback, and
  pre-migration rollback all verified.
- CycloneDX: 466 dependency components. SPDX: 467 packages.
- Candidate images: UID 1000; npm, npx, Vite, and Codex absent.
- Runtime role boundary: independently derived web and worker code/dependency graphs; web 278 files/16 packages, worker 204 files/6 packages.
- Pinned Trivy image scans: zero fixed HIGH/CRITICAL findings in both role-specific images.
- Pristine-candidate reproducibility: two independent exports had publication
  inventory digest
  `68075d9ce1467e38799d31bac4db2e03aa8febbae62dbb99064e517bf5a96b38`;
  their normalized source archives had identical SHA-256
  `e54838a7925f5067a3a10308988aad07eeee673473765dfda08eb74d60c25f79`.

This evidence must be regenerated from the final licensed, clean, protected
commit. Temporary local candidate paths and locally built image tags are not
release artifacts.

## Accurate Data and Privacy Boundary

| Surface | Plaintext stored by Task Node? | Other processors or durable locations |
| --- | --- | --- |
| AI Chat | **Yes.** User and assistant message bodies are stored in Postgres. Attachments, summaries, and derived memory may also be persisted. | The configured inference provider receives the request packet. Configured analytics receives product events, not a blanket exemption from the privacy policy. |
| More → Messages | **No message body.** The browser encrypts/decrypts NIP-17 messages and connects directly to selected Nostr relays. Task Node stores identity/profile bindings, not message bodies or private Nostr keys. | Independent relays retain encrypted gift wraps and observe relay-level metadata according to their own policies. |
| Context and Memory | **Yes for native server-side context, revisions, and derived memory.** Historical encrypted protocol payloads are decrypted client-side where specified. | Public-chain/IPFS pointers or encrypted payloads remain subject to those networks' retention characteristics. |
| PFDocs | Task Node stores integration/account metadata needed to address the service; document-body storage follows the PFDocs/CryptPad deployment boundary. | The separately operated PFDocs/CryptPad service stores its own application state and must have a matching policy. |
| Wallet | Task Node stores public addresses, links, proof metadata, and deposit-account/checkpoint data. It must not receive or store the browser wallet's recovery phrase or signing key. | Public networks permanently expose submitted transactions and addresses. |

The implementation and public policies preserve the important distinction:
Nostr Messages are not Task Node plaintext storage, while AI Chat is.

## Remaining Engineering Debt

There are no active source-tree file-size exceptions. The former system-status,
runtime-store, wallet, task-detail, Hive, Profile, application-shell, and global
stylesheet exceptions were replaced with bounded modules and focused
regressions.

Do not reintroduce an exception as a substitute for a trust-boundary
extraction. Material changes to an auth, wallet, upload, provider, task/reward,
or worker boundary still require focused tests.

## Publication Checklist

Engineering evidence:

- [x] Exact candidate selected by an explicit allowlist and digest inventory.
- [x] Browser Help limited to an explicit allowlist.
- [x] Source and exact candidate pass the canonical check.
- [x] Dependency audit, dependency licenses, asset provenance, and SBOMs pass.
- [x] Full-history and exact-candidate automated secret scans reviewed.
- [x] Central auth matrix and negative tests pass.
- [x] Durable runtime identity/auth/deposit repository tests pass.
- [x] Account export, deletion, retention, backup, restore, and migration drills pass.
- [x] Local defaults are loopback-only, synthetic, and network-minimal.
- [x] Candidate images are non-root/minimal and pass the fixed HIGH/CRITICAL threshold.
- [x] Public release workflow produces checksums and attestations without deploying.

Owner/external gates:

- [x] Copyright owner chooses and adds permissive MIT `LICENSE`.
- [ ] Owner/legal approves policies, notices, trademarks, and content/assets.
- [ ] Human privacy/provenance review signs the exact candidate and history.
- [ ] Private production-operations authority and two-person destructive-action controls are verified.
- [ ] Branch/tag protection, required checks, CODEOWNERS, and release-environment approval are verified.
- [ ] Final candidate is regenerated from a clean protected commit and all evidence rerun.

## Reproduce the Engineering Evidence

Run source checks and export a local, explicitly unreleasable candidate:

```bash
npm ci
npm run check
node scripts/export-public-candidate.mjs --allow-dirty --allow-unlicensed
```

The protected `.github/workflows/public-release.yml` path intentionally does
not use those overrides. It requires a clean commit contained in `origin/main`
and a nonempty `LICENSE`, scans the exact exported filesystem before install,
runs the candidate check and recovery/repository drills, scans the exact image,
and produces the signed evidence bundle described in `docs/releasing.md`.
