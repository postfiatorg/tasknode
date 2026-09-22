# Daily-airdrop near-term patch — release 734

Deployed to https://tasknode.postfiat.org on 2026-09-10. Fly release 734 completed; image `registry.fly.io/tasknodeofficial-dev:deployment-01M2618T0TGSFJMHXY9AT3B27G`. All nine background process groups passed the deployment's read-only liveness/restart guard. No migrations or new infrastructure were introduced.

## Final implementation

- The monetary scorer, its full input packet, original prompt bytes, model, normalization, eligibility, caps, recipient selection, and issuance protections remain unchanged.
- After amount normalization, an optional feedback-only GLM review returns four strings. Its response schema and explicit parsed-field allowlist exclude amount, score, eligibility, and recipient. A 30-second overall deadline bounds the extra call; unavailable or malformed feedback produces neutral text and allows the existing payout flow to continue. Audit metadata is stored under `output_json.feedback_review`.
- The feedback input omits account/wallet routing and lifetime statistics. Its prompt honors evidence standards already accepted by task reviewers, distinguishes quoted attacks from misconduct, attributes findings, avoids character judgments, and requests corrective action only for actual unresolved requirements.
- The Profile panel removes the misleading payout-to-maximum ratio labeled Alignment / 100. Headings now read What contributed, Reward details, and Next step. Paid/pending status, amount, history, task count, and full reasoning remain available.
- Existing stored explanations are preserved. Improved explanations are generated on subsequent scoring runs. This patch adds no cross-account Sybil controls and makes no claim to solve economic calibration.

## Why the direct scoring rewrite was not shipped

A scoring-only canary using the initial revised monetary prompt proposed 800 PFT on a packet whose recorded award was 45 PFT. That change was not deployed or paid. The final design preserves the monetary prompt exactly and confines revised guidance to feedback. This release is not the Astra formula or its 85.8-point TIH candidate.

## Verification

- `npm run profile-daily-airdrop-feedback-smoke`: verifies unchanged primary model input, feedback routing-metadata exclusion/invariance, cap and zero-reward behavior, rejection of monetary/eligibility fields injected into feedback, and neutral fallback on malformed output or provider failure.
- `npm run profile-daily-airdrop-worker-smoke`: passed.
- `npm run lint`, `npm run build`, `npm run inference-no-regex-check` (238 files), `npm run format-check`, and `git diff --check`: passed.
- Actual TodaysBriefing component in Chrome: paid/pending/empty states, task count, expandable reasoning, neutral headings, and absence of the alignment ratio passed.
- Deployed production App/Profile bundle in Chrome with isolated synthetic HTTP fixtures: new labels, actual lazy-loaded route, paid amount, and hidden misleading alignment passed. No real account session was used.
- Live GLM feedback examples: accepted local restore, private runbook quoting an attack, and no-positive-work packet. Accepted work received no fabricated corrective-action request; the quote was recognized as task evidence. Supplied 45/45/0 amounts remained 45/45/0.
- Deployed airdrop worker's actual feedback function reviewed account `acct_oauth_b259edff110c43d66cb95267`'s existing September 10 snapshot, source run `airdrop_a3f4ef6b-8ed0-4ae2-8a0d-61044d0386f2`. It preserved 45 PFT, score 80, and eligibility, with feedback focused on accepted artifacts and specific missing deliverables. No run or payment was written by this check. Its provider-reported gateway cost was $0.00397372; 4,269 tokens. This is the cost of that one deployed canary, not the total development/deployment bill.
- Deployed scorer and both prompt files match local SHA-256 values. The original monetary prompt hash is unchanged from the previously scored baseline.

## Evidence

- [Deployed browser result](browser-production.json)
- [Local browser result](browser-local.json)
- [Live feedback fixtures](live-feedback.json)
- [Deployed real-packet feedback canary](account-feedback-deployed.json)
- [Deployed source hashes](deployed-source-hashes.json)
- [Rejected monetary-scoring canary](rejected-scoring-canary.json)

The test calls did not mutate production scores or submit payments. New daily runs will use the optional feedback review as part of the existing worker flow. Existing unrelated workspace edits from the earlier release were preserved; no commit or push was performed.
