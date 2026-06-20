# Hive Chat Delivery Failure Repair

Task: `task_914927149f7f301950b5457ef91d6d59`

## Delivered files

- `scripts/orc-hive-delivery-repair.mjs` - runnable repair CLI for Hive Chat delivery diagnostics.
- `scripts/orc-hive-delivery-repair-smoke.mjs` - fixture smoke test for the before/after repair path.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_before_delivery_log.json` - five-contributor diagnostic sample with a `@zoz` retrieval-failure scenario.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_repair_fixture.json` - mock repair plan for conversation-scan and idempotent-repost fallback.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/prior_bridge_diagnostic/repair_report.json` - before/after repair report using the actual prior bridge diagnostic output from `task_c6a991a7ef8956a53c3b593e93cbc2a1`.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair/repair_report.json` - before/after repair report for the five-contributor `@zoz` sample.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/*/discord_summary.md` - Discord-ready summaries.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/prior_bridge_run_output.json` and `sample_run_output.json` - command stdout.
- `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/help_output.txt` - CLI help output.

## Failure point

The prior bridge diagnostic shows a successful message post followed by a failed direct message retrieval:

- prior record: `msg_yuuki_retrieval_failure`
- post HTTP status: `201`
- posted message id: `hmsg_yuuki_unretrievable_001`
- retrieval HTTP status: `404`
- retrieval error: `message not visible in Hive Chat read path`

The repair treats that as `direct_message_retrieval_read_path_missing_index_after_successful_post`.

## Fix/fallback

The repair script applies two fallback layers for `message_retrieval` failures:

1. `conversation_scan_fallback`: verify the posted message through the conversation transcript read path using the known `conversationId` and `postedMessageId`.
2. `idempotent_repost`: if the transcript scan cannot prove visibility, repost with a stable idempotency key and verify the replacement message.

Failures outside the retrieval path, such as `conversation_lookup` and `message_post`, are preserved as not applicable so the repair does not hide unrelated delivery problems.

## Commands run

```bash
node --check scripts/orc-hive-delivery-repair.mjs
node --check scripts/orc-hive-delivery-repair-smoke.mjs
node scripts/orc-hive-delivery-repair-smoke.mjs

node scripts/orc-hive-delivery-repair.mjs --help \
  > docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/help_output.txt

node scripts/orc-hive-delivery-repair.mjs repair \
  --diagnostics docs/verification/verified_orc_messaging_bridge_task_c6a991a7ef8956a53c3b593e93cbc2a1/outputs/delivery_log.json \
  --repair-fixture docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_repair_fixture.json \
  --out docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/prior_bridge_diagnostic \
  --generated-by grashnuk \
  --generated-at 2026-06-20T06:30:00.000Z \
  > docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/prior_bridge_run_output.json

node scripts/orc-hive-delivery-repair.mjs repair \
  --diagnostics docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_before_delivery_log.json \
  --repair-fixture docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_repair_fixture.json \
  --out docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair \
  --generated-by grashnuk \
  --generated-at 2026-06-20T06:31:00.000Z \
  > docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_run_output.json

jq empty \
  docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/prior_bridge_run_output.json \
  docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/sample_run_output.json \
  docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/prior_bridge_diagnostic/repair_report.json \
  docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair/repair_report.json
```

## Before/after results

Actual prior bridge diagnostic:

```json
{
  "before": {
    "totalMessages": 5,
    "deliveredVerified": 2,
    "failed": 3
  },
  "after": {
    "totalMessages": 5,
    "deliveredVerified": 3,
    "failed": 2,
    "repaired": 1
  }
}
```

Five-contributor `@zoz` sample:

```json
{
  "before": {
    "totalMessages": 5,
    "deliveredVerified": 1,
    "failed": 4
  },
  "after": {
    "totalMessages": 5,
    "deliveredVerified": 3,
    "failed": 2,
    "repaired": 2
  }
}
```

The `@zoz` sample row repairs `postHttpStatus: 201` plus `retrievalHttpStatus: 404` using `conversation_scan_fallback`, producing `after.verification.ok: true`.

## Safety boundary

This is a mock repair harness. It does not send live Hive messages, sign transactions, move funds, ban users, or mutate production user state.
