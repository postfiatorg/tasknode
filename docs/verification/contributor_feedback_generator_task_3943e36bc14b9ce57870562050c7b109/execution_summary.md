# Contributor Feedback Message Generator

Task: `task_3943e36bc14b9ce57870562050c7b109`

## Delivered files

- `scripts/orc-contributor-feedback-message-generator.mjs` - dependency-free Node CLI that reads submitted-work review ledger records and generates contributor follow-up messages.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/sample_feedback_ledger.json` - sample ledger with five unnotified records.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs/hive_payloads.json` - generated Hive Chat JSON payloads.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs/discord_messages.md` - generated Discord-ready contributor messages.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs/summary.json` - machine-readable batch summary.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/batch_output.json` - stdout from the batch command.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/generate_output.json` - stdout from the no-write generate command.
- `docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/help_output.txt` - CLI help output.

## What the tool does

The CLI reads `records[]` from the `pf.orc.submitted_work_review_ledger.v1` shape created for `task_01ba5f1d70d620780c333693c99a0cab`. It uses review fields also present in the `task_8df...` parser output style: task id, reviewer, review status, score, review flags, archive action, parser grade, reward recommendation, archival instructions, and reviewer notes.

It produces:

- Hive Chat JSON payloads with `recipientAccountId`, `messageBody`, and metadata.
- Discord-ready messages with task id, review status, score, flags, archive action, reviewer note, and recommended next action.
- A batch summary showing how many unnotified records were processed and the status/flag counts.

The script does not send Hive messages, post to Discord, mutate ledgers, execute enforcement, move funds, or apply bans. It generates reviewable payloads only.

## Commands run

```bash
chmod +x scripts/orc-contributor-feedback-message-generator.mjs
node --check scripts/orc-contributor-feedback-message-generator.mjs
jq empty docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/sample_feedback_ledger.json
node scripts/orc-contributor-feedback-message-generator.mjs --help > docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/help_output.txt

node scripts/orc-contributor-feedback-message-generator.mjs batch \
  --ledger docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/sample_feedback_ledger.json \
  --out docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs \
  --generated-by grashnuk \
  > docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/batch_output.json

node scripts/orc-contributor-feedback-message-generator.mjs generate \
  --ledger docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/sample_feedback_ledger.json \
  --generated-by grashnuk \
  > docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/generate_output.json

jq empty docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/batch_output.json docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/generate_output.json docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs/hive_payloads.json docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs/summary.json
git diff --check -- scripts/orc-contributor-feedback-message-generator.mjs docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109
```

## Sample coverage

The sample ledger contains five unnotified records:

- `verified`: 2 records
- `unverified` / displayed as `unverifiable`: 2 records
- `self_attested` / displayed as `self-attested`: 1 record

The batch summary confirms:

```json
{
  "ok": true,
  "unnotifiedRecords": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  }
}
```

## Hive payload example

```json
{
  "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
  "messageBody": "@gmoney - I am following up on reviewed Network Task task_b800bcfe9c3c6e226e87b94a797bd9e1.\nReview status: verified.\nScore: 90/100.\nFlags: none.\nNext action: No contributor action required; product team should use the report as backlog evidence.",
  "metadata": {
    "schema": "pf.orc.contributor_feedback_messages.v1",
    "deliverySurface": "hive_chat",
    "generatedBy": "grashnuk",
    "sourceReviewId": "swrev_feedback_001",
    "sourceTaskId": "task_b800bcfe9c3c6e226e87b94a797bd9e1",
    "reviewStatus": "verified",
    "score": 90,
    "reviewFlags": [],
    "archiveAction": "archive_hot",
    "requiresContributorAction": false
  }
}
```

## Discord message example

```md
**task_8df92c053af509e72dbec3e475766f7a** - contributor follow-up
Recipient: @zoz (acct_oauth_8b6a2004c07fe8d96493d95f)
Review status: unverifiable
Score: 58/100
Flags: missing_public_artifact, pipeline_adjacent
Archive action: needs_followup
Reviewer note: Parser work is useful but should not be operationalized until source and output artifacts are directly inspectable.
Recommended next action: Provide a source link or uploaded bundle plus one captured parser input/output pair.
Generated by: @grashnuk
```

## Expected flow

1. Orc review state is written to a submitted-work ledger.
2. This generator reads unnotified ledger records.
3. `batch` writes Hive Chat payloads and Discord messages for reviewer/operator inspection.
4. A separate sending layer can later decide whether to send those payloads. This script intentionally does not send or mutate state.
