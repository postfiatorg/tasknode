# Evidence Bundle: Hive Secretary Context Update Converter

Task: `task_4cf53094fbe28950dd4a0bcb66b656c7`

## Artifacts

- Converter script: `scripts/orc-hive-secretary-context-converter.mjs`
- Smoke test: `scripts/orc-hive-secretary-context-converter-smoke.mjs`
- Sample ledger: `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_review_ledger.json`
- Sample digest: `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/sample_action_digest.json`
- Batch payload: `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/batch/hive_secretary_batch_payload.json`
- Batch updates: `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/batch/hive_secretary_context_updates.json`
- Single update: `docs/verification/hive_secretary_context_converter_task_4cf53094fbe28950dd4a0bcb66b656c7/outputs/single/hive_secretary_single_update.json`

## Batch proof

```json
{
  "totalUpdates": 5,
  "actionRequired": 4,
  "noAction": 1,
  "byReviewStatus": {
    "verified": 3,
    "self_attested": 1,
    "unverifiable": 1
  }
}
```

## Payload shape proof

```json
{
  "schema": "pf.hive_secretary.context_update.v1",
  "target": {
    "service": "hive_secretary",
    "operation": "append_context_update"
  },
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
    "status": "ready_for_hive_secretary"
  }
}
```

## Checks

```text
node --check scripts/orc-hive-secretary-context-converter.mjs
node --check scripts/orc-hive-secretary-context-converter-smoke.mjs
node scripts/orc-hive-secretary-context-converter-smoke.mjs
orc-hive-secretary-context-converter-smoke ok
jq empty sample/run/output JSON files
```

Payload generation only; no Hive Secretary submission or enforcement execution occurred.
