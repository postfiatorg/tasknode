# Orc Review Pipeline Orchestrator

Task: `task_871a1f7f1df76652377ded6a52ed886a`

## Delivered files

- `scripts/orc-review-pipeline-orchestrator.mjs` - single-command local pipeline orchestrator.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json` - five mock network-task submissions.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json` - submitted-work review ledger produced by the orchestrator.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json` - JSON pipeline report.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json` - generated Hive Chat payloads.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/discord_messages.md` - generated Discord-ready messages.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/summary.json` - feedback-generator summary.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json` - stdout from the orchestrator run.
- `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/help_output.txt` - CLI help output.

## Workflow

The orchestrator connects the three Orc review pipeline layers into one local command:

1. Review parser stage: parses mock submissions into `pf.orc.review_parser_output.v1` verdict fields compatible with the `task_8df...` parser output shape.
2. Ledger stage: records each verdict into a `pf.orc.submitted_work_review_ledger.v1` ledger record compatible with `task_01ba...`.
3. Feedback stage: calls `scripts/orc-contributor-feedback-message-generator.mjs` from `task_3943...` to generate Hive Chat JSON payloads and Discord-ready contributor follow-up messages.
4. Report stage: writes `pipeline_report.json`, proving each submission produced parser output, a ledger record, and contributor messages.

The script is local and payload-only. It does not send Hive messages, post to Discord, mutate live task state, sign payments, move funds, or execute enforcement.

## Commands run

```bash
chmod +x scripts/orc-review-pipeline-orchestrator.mjs
node --check scripts/orc-review-pipeline-orchestrator.mjs
jq empty docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json
node scripts/orc-review-pipeline-orchestrator.mjs --help > docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/help_output.txt

node scripts/orc-review-pipeline-orchestrator.mjs run \
  --input docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/mock_submissions.json \
  --out docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs \
  --generated-by grashnuk \
  > docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json

jq empty docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/run_output.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/summary.json

git diff --check -- scripts/orc-review-pipeline-orchestrator.mjs docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a
```

## Run result

The orchestrator stdout confirmed:

```json
{
  "ok": true,
  "processedSubmissions": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  }
}
```

The pipeline report confirmed each mock submission was recorded and received both message outputs:

```json
[
  {
    "taskId": "task_mock_verified_reward_visibility",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_unverifiable_parser",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_self_attested_contagion",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_verified_ledger",
    "recorded": true,
    "hive": true,
    "discord": true
  },
  {
    "taskId": "task_mock_unverified_docker_overlay",
    "recorded": true,
    "hive": true,
    "discord": true
  }
]
```

## Output locations

- Pipeline report: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_report.json`
- Ledger: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/pipeline_ledger.json`
- Hive payloads: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/hive_payloads.json`
- Discord messages: `docs/verification/orc_review_pipeline_orchestrator_task_871a1f7f1df76652377ded6a52ed886a/outputs/feedback_messages/discord_messages.md`
