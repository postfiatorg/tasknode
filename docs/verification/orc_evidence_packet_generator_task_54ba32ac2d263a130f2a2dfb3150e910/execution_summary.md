# Orc Evidence Packet Generator Tool

Task: `task_54ba32ac2d263a130f2a2dfb3150e910`

## Delivered files

- `scripts/orc-evidence-packet-generator.mjs` - CLI that generates reviewer-ready evidence markdown and compact JSON summary from a PR URL, commit ref, artifacts, command results, and JSON excerpts.
- `scripts/orc-evidence-packet-generator-smoke.mjs` - smoke test that runs the generator against the merged Hive delivery repair task fixture.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_commands.json` - command-result fixture.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_json_excerpts.json` - critical JSON excerpt fixture.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs/evidence_packet.md` - generated markdown evidence packet.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs/submission_summary.json` - generated compact JSON summary.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/run_output.json` - generator command stdout.
- `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/help_output.txt` - CLI help output.

## Evidence fields covered

The generator validates and emits:

- public GitHub PR URL;
- public commit URL;
- changed files resolved from `git show --name-only`;
- local artifact existence checks;
- command results;
- critical JSON excerpts;
- reviewer checklist with pass/fail states.

## Fixture run

The sample run uses the merged Hive delivery repair task:

- PR: `https://github.com/postfiatorg/tasknodeofficial/pull/162`
- Commit: `https://github.com/postfiatorg/tasknodeofficial/commit/8b00e39`
- Artifact: `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair/repair_report.json`
- Artifact: `docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/execution_summary.md`

Generated summary:

```json
{
  "ok": true,
  "changedFileCount": 13,
  "artifactCount": 2,
  "commandCount": 3,
  "excerptCount": 2,
  "checklistPassed": 6,
  "checklistTotal": 6
}
```

The generated markdown packet includes the `@zoz`-sample failure classification excerpt:

```json
{
  "failingApiStep": "message_retrieval",
  "observedPattern": "post_success_then_direct_read_missing",
  "postHttpStatus": 201,
  "retrievalHttpStatus": 404,
  "rootCause": "direct_message_retrieval_read_path_missing_index_after_successful_post"
}
```

## Commands run

```bash
node --check scripts/orc-evidence-packet-generator.mjs
node --check scripts/orc-evidence-packet-generator-smoke.mjs
node scripts/orc-evidence-packet-generator-smoke.mjs

node scripts/orc-evidence-packet-generator.mjs --help \
  > docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/help_output.txt

node scripts/orc-evidence-packet-generator.mjs generate \
  --task-id task_914927149f7f301950b5457ef91d6d59 \
  --title "Repair Hive Chat Delivery Failure Path" \
  --pr-url https://github.com/postfiatorg/tasknodeofficial/pull/162 \
  --commit 8b00e39 \
  --artifact docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/outputs/sample_zoz_repair/repair_report.json \
  --artifact docs/verification/hive_delivery_failure_repair_task_914927149f7f301950b5457ef91d6d59/execution_summary.md \
  --commands docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_commands.json \
  --json-excerpts docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_json_excerpts.json \
  --out docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs \
  --repo-root . \
  > docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/run_output.json

jq empty \
  docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_commands.json \
  docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/fixture_json_excerpts.json \
  docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/run_output.json \
  docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs/submission_summary.json
```

Smoke output:

```text
orc-evidence-packet-generator-smoke ok
```
