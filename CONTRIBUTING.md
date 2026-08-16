# Contributing

Task Node accepts focused changes that preserve its account, wallet, data, and
provider trust boundaries. Start with an issue for changes that alter a public
API, schema, authentication model, wallet behavior, billing, rewards, or data
retention.

## Development setup

Use Node 20 and the npm version declared by `packageManager` in `package.json`.

```bash
npm ci
npm run check:fast
```

The default Docker stack is loopback-only, synthetic, and disables external
protocol workers and paid-model credentials. Start it with:

```bash
npm run docker:dev -- -d
```

Testnet integration is opt-in:

```bash
npm run docker:integration -- -d
```

Never use production data, credentials, wallet seeds, or a live deployment
target in contributor fixtures.

## Change requirements

1. Fix the failed boundary, not only the reported literal example.
2. Add a regression test for the behavior class and adjacent cases.
3. Run the smallest focused checks while iterating, then `npm run check` before
   requesting review.
4. Update current documentation when behavior or data flow changes.
5. Keep generated evidence, screenshots, provider output, and production logs
   out of commits.

Security-sensitive changes require negative tests for unauthenticated,
cross-account, stale/replayed, and malformed inputs as applicable. Database
changes require a forward migration, an explicit rollback/restore note, and a
focused migration test.

## Commits and rights

Sign off every commit (`git commit -s`) to certify the Developer Certificate of
Origin 1.1: you created the contribution or have the right to submit it under
the project's governing license. Do not contribute third-party code, prompts,
documents, fonts, images, or generated media without recording their source and
license in `provenance/assets.json`.

Task Node is distributed under the MIT License. By contributing, you agree that
your contribution may be distributed under that license.

## Review

Maintainers may request smaller commits, clearer tests, threat-model updates,
or provenance evidence. Approval requires the relevant CODEOWNERS reviewers;
authors do not approve their own security, release, or migration changes.
