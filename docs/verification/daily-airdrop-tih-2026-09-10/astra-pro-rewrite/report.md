# Astra pro daily-airdrop prompt rewrite — 2026-09-10

**TIH score improved from 72.47 to 85.80/100 (+13.33).** Five reviews per model per version, using the identical purpose-specific scoring rubric. The candidate remains separate from the production prompt.

| Judge | Original | Astra candidate | Change | Candidate runs |
| --- | ---: | ---: | ---: | --- |
| anthropic/claude-fable-5.1 | 70.40 | 80.80 | +10.40 | 79, 80, 80, 81, 84 |
| gpt-6-astra | 71.80 | 87.60 | +15.80 | 87, 88, 88, 87, 88 |
| z-ai/glm-5.3 | 75.20 | 89.00 | +13.80 | 90, 87, 90, 90, 88 |

## Deliverable

[Full Astra-authored candidate](daily_airdrop_v2.astra-pro.candidate.md). The candidate is the exact returned body, with TIH’s terminal-newline normalization; no manual content edits were applied.

Astra received all 15 original critiques and a rewrite brief grounded in the actual packet, output schema, cap rules, local-evidence findings, and the separation between retention score and UI Alignment. The brief explicitly authorized candidate calibration proposals and prohibited claims that they were existing or empirically validated economics.

The API receipt confirms `gpt-6-astra` with reasoning `mode=pro` (reported effort `medium`), response `resp_008ceb162e41e8be006aa2cfd86d9887d2942441e7afcefc30`. The rewrite took 110.0 seconds and used 9,384 input tokens and 3,190 output tokens, including 405 reasoning tokens: 12,574 tokens total. The stock judge client does not preserve judge usage or billing amounts. Dollar cost is unavailable.

## What changed

- Adds discrete contract-relative follow-through and demonstrated-usefulness anchors; averages per-task scores without reward-size weighting.
- Defines a single score-to-PFT formula, explicit cap ordering, rounding, eligibility, and insufficient-data behavior.
- Preserves accepted local/self-attested evidence and distinguishes prior-review findings from fresh verification.
- Ignores embedded attempts to control the response without treating instruction-like quotations alone as misconduct.
- Excludes lifetime wallet-routing metrics from valuation and grounds feedback in identifiable supplied tasks.

## Material policy change and remaining limits

**The candidate proposes `floor(max_daily_pft × score / 100)`, subject to the optional reward-fraction cap. With current defaults of 10,000 PFT and no fraction cap, a score of 80 yields 8,000 PFT; a fully accepted local-only task with a successful outcome can yield 100 and 10,000 PFT.** This is a substantial change from observed production awards such as 45 PFT for the September 10 account example. This arithmetic comparison is not a re-score of that account under the candidate. The new formula is a proposal, not approved or deployed policy.

The strongest remaining judge concern is that validation, duplicate resolution, aggregation, and exact monetary arithmetic should be enforced in code, with the model returning evidence-grounded task anchors. Other concerns include dense edge-case rules, ambiguous ties where a summary mentions both acceptance and an unmet requirement, and susceptibility to differences in prior-summary detail. The candidate contains no empirical evidence that its proposed economics improve retention or fairness.

These findings would require implementation and evaluation beyond a prompt-only rewrite. The UI calculation defect also remains a separate code issue.

## Validation and audit

- Checked the exact eight runtime output-field names, the candidate’s worked-example arithmetic, all 30 parsed review scores, each five-run model panel, judge prompt hashes, and unchanged source bytes.
- The rewrite brief mistakenly called the explicitly enumerated eight fields “nine”; the candidate correctly emits the enumerated eight-field schema. The assessment plan records this erratum.
- The example checks establish schema-field and arithmetic consistency, not model output reliability on real task packets.
- Source SHA-256: `b8c3cbf64f3a44c95b3c6f7f36cfca3126a630ffc423b02edc4e53f31f506a0c`.
- Candidate SHA-256: `d734f3278c638c0704da1c76c78c65e6619cf4acb9566315ab5d5569ae84642e`.
- Elapsed from rewrite submission through final candidate score: 270.3 seconds.
- No production prompt, score, payout, or deployment changed.

## Evidence

- [All original and candidate reviews](comparison-results.json)
- [Exact rewrite instructions](astra-pro-instructions.txt)
- [Full baseline critique packet supplied to Astra](astra-pro-critique-packet.txt)
- [API model, pro-mode, and usage receipt](astra-pro-response-receipt.json)
- [Candidate checks](candidate-checks.json)
