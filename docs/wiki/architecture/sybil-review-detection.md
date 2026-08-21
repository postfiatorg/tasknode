# Sybil Review Detection

Sybil review detection is a recommend-only Orc review system for suspicious Network Task reward patterns. It produces durable review flags for Orcs, Nazgul, Sauron, and core operators to inspect. It does not diagnose a user as definitively Sybil, ban accounts, mutate routing, claw back rewards, sign payloads, or move PFT.

The system exists because Network Task rewards are real money. Automated signals should raise review priority and preserve evidence, not execute punishment.

## Current Implementation

The executable detector is `scripts/sybil-review-detector.mjs`.

```bash
npm run sybil-review-detector -- --help
npm run sybil-review-detector -- batch --input ./input.json --out ./out
npm run sybil-review-detector -- db-scan --out ./sybil_report.json
npm run sybil-review-detector -- db-scan --persist
```

`batch` consumes a bounded JSON fixture. `db-scan` reads Network Task projections and submission events from Postgres. `--persist` writes the result to the Sybil review tables. The default mode is always `recommend_only_no_enforcement`.

## Durable State

Migration `071_sybil_review_flags.sql` adds two shared tables:

| Table | Purpose |
| --- | --- |
| `sybil_review_runs` | One detector run, including schema, detector version, criteria, summary, source metadata, generator, and timestamp. |
| `sybil_review_flags` | One current review flag per subject/run, including account, wallet addresses, handles, provider risk, risk score, risk band, triggered rules, evidence JSON, and recommended action. |

The database enforces the safety boundary:

- `mode` must be `recommend_only_no_enforcement`.
- `operational_use_allowed` must be `false`.
- `requires_human_approval` must be `true`.

Any enforcement path must be a separate human-approved workflow with its own evidence packet and signing boundary.

## Implemented Signals

The first detector version implements these rules:

| Rule | Meaning |
| --- | --- |
| `network_task_burst_gt_3_in_3h` | More than 3 rewarded Network Tasks land inside a 3-hour rolling window for the same contributor subject. |
| `partial_network_rewards_2plus` | The contributor has 2 or more positive partial Network Task rewards. Partial reward means actual reward is greater than 0 but lower than the offered reward. |
| `text_only_no_work_submission` | A submission contains text but no concrete evidence signals: no code block, changed file, command, test result, URL, commit hash, transaction hash, CID, PR, or structured artifact reference. |
| `all_ai_like_text_only_submissions` | Every available Network Task submission for the contributor is text-only with no concrete work proof. |
| `duplicate_submission_text` | Repeated normalized submission text appears across multiple tasks. |
| `repeated_title_family` | Multiple rewarded tasks share the same normalized title family, suggesting task-template recycling. |
| `rapid_accept_to_submit_loop` | Multiple tasks are accepted and submitted within a very short window, default 10 minutes. |
| `provider_risk_email_only_or_email_primary` | Email-only or email-primary signup increases review risk when another task-quality or velocity signal is already present. |
| `provider_risk_unknown_provider` | Missing provider data increases review risk when another signal is already present. |

Provider risk is not a standalone Sybil finding. GitHub and X-linked contributors are lower identity risk than email-only contributors, but linked identity does not clear bad task evidence.

## Text-Only Criterion

The text-only flag means:

> This submission is only prose and shows no concrete work artifact. It could plausibly have been prepared with a chatbot without doing the requested work.

That is a review trigger, not a final accusation. Some valid Network Tasks are product feedback, documentation, or user research. Orc review should inspect the task brief, requested output, original evidence, and any linked artifacts before escalating.

## Risk Scoring

Each triggered rule contributes points to a capped 0-100 review score. Risk bands are:

| Band | Score |
| --- | ---: |
| `watch` | 25-44 |
| `review_required` | 45-74 |
| `high_review_priority` | 75-100 |

Rows below `--minimum-risk-score` are omitted from persisted flags by default. The default threshold is 25.

## Additional Signals To Add

The current detector is deliberately conservative and uses only task, reward, submission, and provider data. Stronger review should add these signals when data and privacy policy are ready:

- Account age and time from signup to first reward.
- Shared device, IP, browser fingerprint, or session traits, only if the privacy policy permits it.
- Wallet funding graph: common funders, common payout sinks, circular transfers, and shared activation patterns.
- Cross-wallet text similarity and title similarity, not only same-subject similarity.
- Task requester/verifier graph concentration, including repeated routing through one manager or verifier.
- Evidence resolvability: whether CIDs, URLs, GitHub PRs, commits, tx hashes, and screenshots actually resolve.
- Follow-up responsiveness: whether the contributor answers specific verification questions with new evidence.
- Reward velocity: PFT per account age, PFT per linked provider, and PFT per verified artifact.
- Reviewer disagreement or repeated manual downgrades.
- LLM-style similarity across supposedly independent users.

These should remain review inputs until Sauron defines a separate enforcement policy.

## Orc Review Flow

1. Run or schedule the detector against the shared Network Task read model.
2. Persist the run and flags.
3. Orcs read `sybil_review_flags` alongside `orc_task_review_queue`.
4. Orcs inspect the raw task packet, submission evidence, identity context, and related review history.
5. Orcs record suspected-only review state unless there is independently verifiable evidence and an approved enforcement path.
6. Enforcement, bans, blacklists, or money actions require Sauron or human operator approval and a separate signed workflow.

## Verification

Use:

```bash
npm run sybil-review-detector-smoke
npm run migration-registration-smoke
```

The smoke test proves:

- a GitHub-linked contributor with code, commands, changed files, and PR evidence is not flagged;
- a bursty email-linked contributor with partial rewards and all text-only submissions is flagged;
- repeated templated work is flagged;
- every generated flag has `operationalUseAllowed=false` and `requiresHumanApproval=true`.
