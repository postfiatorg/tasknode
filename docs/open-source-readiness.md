# Open-Source Readiness

Status: **open-source release completed and verified**

Review date: 2026-08-16
Released source commit: `182dfc266e63b5099a1e4b48584ccf5b17cf187b`
Release unit: the exact output of `scripts/export-public-candidate.mjs`, not the private operator working tree

## Decision

The application-level release blockers identified by the original review have
been repaired and exercised against an independently exported candidate. The
repository is public under the permissive MIT License. `main` and `v*` tags are
protected, and the hosted `public-release` workflow completed against the clean
protected commit without dirty or unlicensed overrides. It emitted the source
archive, checksums, CycloneDX/SPDX SBOMs, source-provenance attestation, and SBOM
attestation.

Production deployment authority remains private and is not part of, or a
prerequisite for, distributing the sanitized source candidate.

## Requirement Status

| Original release requirement | Status | Implemented evidence |
| --- | --- | --- |
| Publication rights and governance | **Implemented** | Task Node is distributed under the permissive MIT License. `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `PRIVACY.md`, `TERMS.md`, `TRADEMARKS.md`, and `THIRD_PARTY_NOTICES.md` exist. Dependency-license and asset-provenance checks are required. |
| Explicit public/private publication boundary | **Implemented** | `release/publication-manifest.json` is an allowlist. It excludes live Fly configuration, operations, verification/incident evidence, generated runs, private plans, production scripts, and the private deterministic-board seed. `PUBLICATION.json` records the emitted inventory and SHA-256 digests. |
| Browser Help boundary | **Implemented** | `docs/public-help-manifest.json` explicitly permits 26 Markdown sources. The build fails if the browser statically or dynamically imports an unapproved document. Each page is loaded on demand; full-text search fetches the allowlisted corpus only after a search. Prompt and private-operation archives are not an implicit Help source. |
| Full-history and exact-candidate secret scanning | **Implemented** | Pinned Gitleaks and TruffleHog scans run in CI. Full history has zero Gitleaks findings and ten reviewed, unverified synthetic/non-secret TruffleHog findings. The exact candidate has zero Gitleaks findings and two reviewed local-test database fixtures, with zero verified or unreviewed findings. Review fingerprints expire and stale or new findings fail CI. |
| Dependency and asset provenance | **Implemented** | `npm audit` reports zero vulnerabilities. CycloneDX and SPDX SBOMs, dependency-license checks, `THIRD_PARTY_NOTICES.md`, `provenance/assets.json`, and an asset-provenance gate are present. |
| Central route authorization | **Implemented** | All 150 registered route policies are centrally enforced across eight auth modes. A source-backed regression scan proves the registry covers 133 literal API paths in the registered handlers, while dynamic route families are declared as patterns. Negative smoke coverage checks anonymous, account, bearer, webhook, admin, stale-session, and cross-account boundaries. The generated API reference must match the registry. |
| Request boundary validation | **Implemented** | Every parsed JSON body receives size, media-type, object-shape, depth, node-count, and prototype-pollution checks. All 77 mutation policy families fail closed without an explicit typed or empty body contract and reject undeclared top-level fields; the sole exception is Telegram's size-bounded, typed-discriminator webhook contract, which preserves provider forward compatibility. The generated API reference publishes each mutation body's enforced byte limit. |
| Shared abuse controls and trusted proxies | **Implemented** | Public rate limits use transactional Postgres buckets rather than process memory. Trusted proxy CIDRs are explicit, and forged forwarding-header behavior is regression-tested. Public startup fails closed if the shared authority is unavailable. |
| Durable identity, auth, wallet, and deposit authority | **Implemented** | Accounts, email/provider identities, profiles, wallet links, web sessions, auth challenges, Ethereum deposit accounts/checkpoints, and terminal auth are Postgres-authoritative. Session, challenge, poll, and bearer secrets are stored as hashes. Legacy JSON import commits before clearing its source. Public startup refuses nondurable authority stores. |
| Account export, deletion, and retention | **Implemented** | Export/deletion dynamically cover account-owned tables, exclude secret hashes, and have lifecycle regression tests. `docs/data-retention.md` states retention and the Nostr/public-chain/IPFS exceptions. Scheduled purge covers expired auth, terminal, rate-limit, and retention-scoped data. |
| Backup, restore, and migration rollback | **Implemented locally; production evidence remains external** | The recovery tool refuses remote or unsafe targets. The exact public candidate applies 118 fresh-database migrations, backs up and restores Postgres plus legacy runtime state, proves sentinels and idempotence, and proves failed-migration rollback. Production backup custody, RPO/RTO, encryption, and two-person restore approval belong to private operations. |
| Safe local defaults | **Implemented** | Development Compose binds published ports to loopback, uses synthetic credentials/data, disables paid-model and protocol workers by default, and requires the explicit integration override for external/testnet connectivity. |
| Production/public-source separation | **Implemented in the candidate; hosted authority remains external** | Live `fly.toml`, data bridges, deploy tooling, incident response, and operator evidence are excluded. `fly.example.toml` contains synthetic names and an explicit trusted-proxy boundary. The public release workflow creates artifacts and attestations but never deploys the official service. |
| Minimal production image | **Implemented** | Pinned Node/Alpine `web-runtime` and `worker-runtime` targets install independent lockfiles and source closures, run as UID 1000, and remove npm, npx, Vite, and Codex. The web image has 278 source files/16 backend packages and no worker orchestrator; the worker image has 204 source files/6 packages and no HTTP entrypoint or browser assets. Synthetic Fly examples select the targets explicitly. The current pinned Trivy scan reports zero fixed HIGH/CRITICAL vulnerabilities in both images. |
| Real quality gate and protected CI definition | **Implemented and enforced** | `npm run check` is green in the source tree and exact candidate. The file-size gate has zero active exceptions. ESLint enforces unused variables, React-hook dependencies, and undefined JSX-component rejection. GitHub requires `check`, `supply-chain`, `container`, and `recovery` on protected `main`; force pushes and deletion are disabled. |
| Reproducible release evidence | **Implemented** | The release workflow exports and rescans the exact candidate, independently installs/checks it, drills its migrations/recovery, and builds/scans both runtime images. It then re-exports a pristine tree, verifies that its publication-inventory digest matches the checked candidate, and emits the deterministic source archive and two SBOM formats without accidentally packaging `node_modules` or `dist`. It produces checksums and creates GitHub provenance/SBOM attestations. |
| Contributor entry points and extension surface | **Implemented** | Supported Node/npm versions, fresh-clone setup, architecture, API reference, recovery, release, security, support, contribution, issue/PR templates, CODEOWNERS, and an extension registry are checked in. The exporter replaces the private operator catalog with 25 canonical development, test, security, recovery, build, and runtime commands backed by one checked suite runner. |

## Exact Candidate Evidence

The completed hosted release exported 844 files: 843 digest-inventoried
candidate files plus `PUBLICATION.json`. It exercised the emitted tree
independently:

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
- Pristine-candidate reproducibility: the checked and artifact exports had the
  same publication inventory digest
  `5fad05f5e04b6bce00182733591d4a3531a95503eb7b43349b86b61dee9c8de4`;
  the normalized source archive has SHA-256
  `c41098b39ac5b0801214de169697e4b7116ce3ba02e81185628716833717bd69`.
- Downloaded artifact checksums passed for the source archive and both SBOMs.
- GitHub stores two attestations for the source archive digest: build
  provenance and the CycloneDX SBOM attestation.

The permanent GitHub release is `v0.1.0`, targeting
`182dfc266e63b5099a1e4b48584ccf5b17cf187b`. Its source archive, both SBOMs,
and checksum manifest were promoted from the successful GitHub Actions run
`31920798001`. Temporary local candidate paths and locally built image tags are
not release artifacts.

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

Release-state gates:

- [x] Copyright owner chooses and adds permissive MIT `LICENSE`.
- [x] Policies, notices, trademarks, and public asset provenance are included and gated.
- [x] Full history and exact candidate pass the reviewed secret-scan policy.
- [x] Private production operations are excluded from the publication boundary.
- [x] Branch/tag protection, required checks, CODEOWNERS routing, and release-ref restrictions are configured.
- [x] Final hosted release run completes against the clean protected commit.

## Reproduce the Engineering Evidence

Run source checks and export a local candidate:

```bash
npm ci
npm run check
node scripts/export-public-candidate.mjs
```

The protected `.github/workflows/public-release.yml` path requires a clean
commit contained in `origin/main` and a nonempty `LICENSE`, scans the exact
exported filesystem before install, runs the candidate check and
recovery/repository drills, scans the exact images, and produces the signed
evidence bundle described in `docs/releasing.md`.
