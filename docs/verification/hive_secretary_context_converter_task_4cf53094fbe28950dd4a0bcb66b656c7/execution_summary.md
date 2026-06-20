# Hive Secretary Context Update Converter

Task: `task_4cf53094fbe28950dd4a0bcb66b656c7`

## Delivered files

- `scripts/orc-hive-secretary-context-converter.mjs` - converter CLI with `batch` and `single` modes.
- `scripts/orc-hive-secretary-context-converter-smoke.mjs` - smoke test for batch and single conversion.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_review_ledger.json` - five-record review ledger sample.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_action_digest.json` - action-digest sample used for owner/priority enrichment.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/batch/hive_secretary_batch_payload.json` - consolidated Hive Secretary batch payload.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/batch/hive_secretary_context_updates.json` - update array extracted from the batch.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/single/hive_secretary_single_update.json` - single-record output for `swrev_secretary_004`.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/*/discord_summary.md` - reviewer-ready summaries.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/batch_run_output.json` and `single_run_output.json` - command stdout.
- `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/help_output.txt` - CLI help output.

## Sample coverage

The sample review ledger contains five records:

- verified no-action: `task_doc_acceptance_workflow`
- verified product follow-up: `task_hive_chat_delivery_gap`
- self-attested evidence-quality follow-up: `task_self_attested_parser_claim`
- unverifiable negative follow-up: `task_unverifiable_cluster_submission`
- verified reward-accounting follow-up: `task_reward_projection_mismatch`

## Batch output

```json
{
  "totalUpdates": 5,
  "actionRequired": 4,
  "noAction": 1,
  "byDisposition": {
    "reviewed_no_action": 1,
    "reviewed_follow_up": 3,
    "reviewed_negative_follow_up": 1
  },
  "byActionOwner": {
    "product_engineering_triage": 1,
    "orc_ops": 1,
    "nazgul_alex_review": 1,
    "protocol_owner_review": 1
  },
  "byReviewStatus": {
    "verified": 3,
    "self_attested": 1,
    "unverifiable": 1
  }
}
```

## Single-record output excerpt

```json
{
  "schema": "pf.hive_secretary.context_update.v1",
  "source": {
    "reviewId": "swrev_secretary_004",
    "taskId": "task_unverifiable_cluster_submission"
  },
  "review": {
    "score": 22,
    "grading": {
      "score": 22,
      "scale": 100,
      "source": "orc_review_ledger"
    }
  },
  "action": {
    "required": true,
    "owner": "nazgul_alex_review",
    "priority": 94,
    "integrityPolicy": {
      "clawbackFlag": "blacklist_if_proven_no_clawback",
      "archivalDirective": "hold_for_human_integrity_review",
      "enforcementAllowed": false
    }
  },
  "contextUpdate": {
    "title": "reviewed_negative_follow_up: task_unverifiable_cluster_submission",
    "status": "ready_for_hive_secretary"
  }
}
```

## Commands run

```bash
node --check scripts/orc-hive-secretary-context-converter.mjs
node --check scripts/orc-hive-secretary-context-converter-smoke.mjs
node scripts/orc-hive-secretary-context-converter-smoke.mjs

node scripts/orc-hive-secretary-context-converter.mjs --help \
  > docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/help_output.txt

node scripts/orc-hive-secretary-context-converter.mjs batch \
  --ledger docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_review_ledger.json \
  --digest docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_action_digest.json \
  --out docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/batch \
  --generated-by grashnuk \
  --generated-at 2026-06-20T06:45:00.000Z \
  > docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/batch_run_output.json

node scripts/orc-hive-secretary-context-converter.mjs single \
  --ledger docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_review_ledger.json \
  --digest docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_action_digest.json \
  --review-id swrev_secretary_004 \
  --out docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/single \
  --generated-by grashnuk \
  --generated-at 2026-06-20T06:46:00.000Z \
  > docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/single_run_output.json

jq empty sample/run/output JSON files
```

Smoke output:

```text
orc-hive-secretary-context-converter-smoke ok
```

## Safety boundary

The converter prepares Hive Secretary payloads only. It does not submit updates, sign transactions, move funds, apply bans, or execute enforcement.
