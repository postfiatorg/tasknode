# Daily-airdrop prompt TIH score — 2026-09-10

**Overall score: 72.47/100**, the equal-weight mean of 15 independent reviews: five per judge. This is a prompt-design assessment, not an empirical test of payout accuracy or fairness.

| Judge | Individual scores | Mean |
| --- | --- | --- |
| anthropic/claude-fable-5.1 | 70, 72, 70, 72, 68 | 70.40 |
| gpt-6-astra | 68, 73, 73, 73, 72 | 71.80 |
| z-ai/glm-5.3 | 74, 78, 74, 74, 76 | 75.20 |

## Shared findings

- The central numeric decision is underspecified: qualitative contribution evidence has no anchored rubric mapping it to a retention score or PFT amount. Caps limit the amount without establishing why a particular amount is justified.
- The strongest feature is the explicit boundary between routing metadata and untrusted prose, with a zero-positive-work eligibility rule and structured output.
- The mandatory penalty for embedded payout, eligibility, or retention claims is too broad; reviewers warn it could penalize legitimate quoted task content.
- Missing/contradictory inputs and evidence provenance need explicit handling. The fixed 0–10000 example range can also conflict with a separately configured maximum.

The recurring proposed next edit is a versioned calibration rubric with concrete evidence anchors and an explicit payout rule. Suggested numerical bands in raw critiques are reviewer proposals, not adopted product policy. No prompt edits, production scoring, payout changes, or deployment occurred.

## Method and provenance

- Used the existing TIH `score --gate full` path with five reviews per judge and temperature zero where supported. Fable’s client omits temperature. Default output budgets: 4,000 tokens for Astra/Fable and 16,000 for GLM. All 15 reviews returned on the first attempt.
- First ran one Astra review on the actual prompt and inspected its structured score and substantive critique. The full pass added four Astra, five Fable, and five GLM reviews; the preflight counts as Astra run 1.
- Used a purpose-specific scoring instruction asking judges to assess the document as a production airdrop prompt, not execute it. The exact rubric and all constructed judge prompts are saved. Judges did not receive our prior diagnosis or private user records.
- Used the score command rather than the optimization-round command: this request is scoring only, and the latter also invokes a regex-based critique/modality classifier, contrary to the workspace LLM-path constraint.
- Prompt file SHA-256: `b8c3cbf64f3a44c95b3c6f7f36cfca3126a630ffc423b02edc4e53f31f506a0c`.
- Runtime-trimmed prompt digest: `4b2df4fd216d8dcb769de92f9a87b64a7519784b3f65a671d44de636876d250d`, matching the September 10 production runs inspected earlier.
- Harness commit: `441c3473c8842fb8c1f7ba5468f6d952aa591676`.
- Calls took 85.9 seconds across preflight and full phases; 104.0 seconds including inspection between phases.
- Dollar cost is unavailable: the stock TIH client discards usage and billing metadata. No estimate is substituted.
- SQLite audit ledger: `/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-daily-airdrop-tih-20260910/harness.sqlite3`.

Source prompt bytes, document hashes, constructed scoring-prompt hashes, 15 parsed JSON scores, and the complete five-run panel were verified before export.

## Artifacts

- [Full reviews and reproducibility metadata](results.json)
- [Exact scored prompt snapshot](daily_airdrop_v1.md)
- [Exact scoring rubric](scoring-rubric.txt)
