# Alignment restored — 2026-09-10

Deployed production release 735, status complete, created 2026-09-10T16:24:22Z.
Image: `registry.fly.io/tasknodeofficial-dev:deployment-01M262422HJ1P2AH0ZCEQFQNFH`.

The Profile briefing again displays Alignment / 100. It uses the existing model retention score (`retentionValueScore`), rounded and bounded to 0–100, instead of the legacy payout-to-maximum ratio. Existing completed runs use their stored score immediately. Real zero remains zero; unavailable component input shows an em dash. This restoration changes no backend scoring, monetary prompt, eligibility, issuance, or payout calculation.

Changed source: `src/features/profile/ProfileBriefing.jsx`; behavior documented in `docs/wiki/surfaces/daily-airdrop.md` and the in-app documentation index.

Validation:

- `npm run lint`, `npm run format-check`, `npm run build`, `git diff --check`: passed.
- `node scripts/profile-daily-airdrop-browser-smoke.mjs`: actual component in Chrome; model score 80 remains 80 for low and high legacy payout ratios, zero and missing scores, paid/pending/empty states, feedback and expanded reasoning. See `browser-local.json`.
- `npm run fly:deploy:prod`: passed preflight, deployment, and all nine background process guards.
- Production Chrome: actual deployed Profile route and bundles, synthetic signed-in HTTP fixtures; verified Alignment 80 / 100 with near-zero legacy payout ratio and preserved paid amount, task count, and feedback. See `browser-production.json`. This browser check did not use a real user's session or create payments.

The prior account investigation recorded 0xpostfiatchad's September 10 run `airdrop_a3f4ef6b-8ed0-4ae2-8a0d-61044d0386f2` at model score 80 and daily amount 45 PFT. No rescoring was needed or performed for this restoration.
