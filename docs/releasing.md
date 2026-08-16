# Public Releases

Public releases are built from the sanitized publication allowlist, never from
the internal operator tree. The exporter fails unless the source is a clean
commit and the MIT `LICENSE` exists. `--allow-dirty` and `--allow-unlicensed`
exist only for testing incomplete local candidates; the protected release
workflow never uses either override.

The `public-release` GitHub environment permits only the protected `main`
branch and `v*` release tags. A release tag is accepted only when its commit is
contained in `origin/main`. The workflow then:

1. runs the canonical source check;
2. exports the exact public candidate and scans that clean filesystem with
   pinned Gitleaks and TruffleHog images;
3. independently installs and checks the candidate, then runs its fresh-schema
   recovery drill and durable runtime-authority repository tests;
4. builds the candidate's production image and rejects fixed HIGH/CRITICAL
   vulnerabilities;
5. re-exports a pristine candidate, verifies that its publication-inventory
   digest matches the candidate already scanned and tested, then emits the
   deterministic source archive and CycloneDX/SPDX SBOMs from that unmodified
   tree;
6. creates Sigstore-backed GitHub provenance and SBOM attestations; and
7. uploads checksums and the evidence bundle without deploying any official
   service.

Repository rules require the `check`, `supply-chain`, `container`, and
`recovery` GitHub Actions checks on `main`, enforce linear history, resolve
conversations, and disallow force pushes and branch deletion. Release tags are
protected against deletion and rewriting. `CODEOWNERS` routes review requests
without creating a single-maintainer approval deadlock. The `public-release`
environment accepts only `main` and `v*` refs. These hosted settings should be
rechecked through the GitHub API when cutting a release.

Verify downloaded release artifacts with GitHub CLI:

```bash
gh attestation verify tasknode-public-source.tar.gz --repo OWNER/REPOSITORY
sha256sum --check SHA256SUMS
```

Generated JavaScript bundles and the source archive are reproducible for a
fixed source commit, Node/npm version, lockfile, and `SOURCE_DATE_EPOCH`. OCI
image bytes are not claimed reproducible because Alpine security-index updates
are intentionally applied during the build; the attestation and scan bind the
exact produced image digest to the protected workflow run.

The source archive must never be made from the candidate directory after
`npm ci` or `npm run check`, because those commands add `node_modules` and
`dist`. The release workflow therefore archives a fresh export and rejects an
inventory-digest mismatch with the independently checked candidate.
