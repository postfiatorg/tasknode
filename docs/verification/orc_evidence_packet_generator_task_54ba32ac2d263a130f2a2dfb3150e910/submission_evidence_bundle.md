# Evidence Bundle: Orc Evidence Packet Generator

Task: `task_54ba32ac2d263a130f2a2dfb3150e910`

## Tool outputs

- Markdown evidence packet: `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs/evidence_packet.md`
- JSON summary: `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/outputs/submission_summary.json`
- Generator stdout: `docs/verification/orc_evidence_packet_generator_task_54ba32ac2d263a130f2a2dfb3150e910/run_output.json`

## Generated summary excerpt

```json
{
  "ok": true,
  "publicLinks": {
    "prUrl": "https://github.com/postfiatorg/tasknodeofficial/pull/162",
    "commitUrl": "https://github.com/postfiatorg/tasknodeofficial/commit/8b00e39"
  },
  "changedFileCount": 13,
  "artifactCount": 2,
  "commandCount": 3,
  "excerptCount": 2,
  "reviewerChecklist": [
    {
      "item": "Public PR URL is present and GitHub-shaped",
      "ok": true
    },
    {
      "item": "Public commit URL is present",
      "ok": true
    },
    {
      "item": "Changed file paths are included",
      "ok": true
    },
    {
      "item": "Local artifacts exist",
      "ok": true
    },
    {
      "item": "Command results are included",
      "ok": true
    },
    {
      "item": "Critical JSON excerpts are included",
      "ok": true
    }
  ]
}
```

## Checks

```text
node --check scripts/orc-evidence-packet-generator.mjs
node --check scripts/orc-evidence-packet-generator-smoke.mjs
node scripts/orc-evidence-packet-generator-smoke.mjs
orc-evidence-packet-generator-smoke ok
jq empty fixture/run/summary JSON files
```
