# Evidence Bundle: Contributor Feedback Message Generator

Task: `task_3943e36bc14b9ce57870562050c7b109`

This bundle is self-contained for verification: it includes the execution summary, executable source, sample ledger, generated Hive JSON payloads, generated Discord messages, and command outputs.

## Execution Summary

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

## Source File: scripts/orc-contributor-feedback-message-generator.mjs

```js
#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUTPUT_SCHEMA = "pf.orc.contributor_feedback_messages.v1";
const VALID_STATUSES = new Set(["verified", "unverified", "unverifiable", "self_attested"]);

function usage() {
  return `Usage:
  node scripts/orc-contributor-feedback-message-generator.mjs batch --ledger <file> --out <dir> [--generated-by <handle>]
  node scripts/orc-contributor-feedback-message-generator.mjs generate --ledger <file> [--generated-by <handle>]

Commands:
  batch     Write hive_payloads.json, discord_messages.md, and summary.json for unnotified records.
  generate  Print generated payloads to stdout without writing files.

The ledger must contain records[] compatible with pf.orc.submitted_work_review_ledger.v1.
Unnotified records are entries without notification.notifiedAt, notification.sentAt, or notifiedAt.`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    if (options[key] === undefined) options[key] = next;
    else if (Array.isArray(options[key])) options[key].push(next);
    else options[key] = [options[key], next];
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHandle(value) {
  const handle = safeText(value).replace(/^@/, "");
  return handle ? `@${handle}` : "@contributor";
}

function normalizeStatus(value) {
  const status = safeText(value).toLowerCase().replaceAll("-", "_");
  if (!VALID_STATUSES.has(status)) throw new Error(`Invalid review status: ${value}`);
  return status;
}

function displayStatus(status) {
  if (status === "self_attested") return "self-attested";
  if (status === "unverified") return "unverifiable";
  return status;
}

function findRecipientAccountId(record) {
  return safeText(
    record.recipientAccountId ||
      record.accountId ||
      record.assigneeAccountId ||
      record.recipient?.accountId ||
      record.contributor?.accountId
  );
}

function findRecipientHandle(record) {
  return normalizeHandle(
    record.recipientHandle ||
      record.assigneeHandle ||
      record.recipient?.handle ||
      record.contributor?.handle ||
      record.reviewer
  );
}

function isUnnotified(record) {
  return !(
    record.notifiedAt ||
    record.notification?.notifiedAt ||
    record.notification?.sentAt ||
    record.notification?.hiveMessageId ||
    record.notification?.discordMessageId
  );
}

function extractParser(record) {
  return record.parserOutput && typeof record.parserOutput === "object" ? record.parserOutput : {};
}

function findRecommendedAction(record) {
  const parser = extractParser(record);
  const explicit = safeText(
    record.recommendedAction ||
      record.nextAction ||
      parser.recommendedAction ||
      parser.nextAction ||
      parser.rewardRecommendation
  );
  if (explicit) return explicit;
  const status = normalizeStatus(record.reviewStatus);
  const archiveAction = safeText(record.archiveAction || parser.archivalInstructions).toLowerCase();
  if (status === "verified") return "No action required. Your submitted work was reviewed as verified.";
  if (archiveAction === "needs_followup") {
    return "Please provide the missing artifact, command output, screenshot, or source pointer requested by the reviewer.";
  }
  if (archiveAction === "reject") {
    return "Submit replacement evidence before this work should be counted further.";
  }
  if (archiveAction === "hold") {
    return "Wait for a reviewer or core-team decision before this work is operationalized.";
  }
  return "Add independently inspectable evidence so the work can be verified without relying only on self-attested text.";
}

function formatFlags(flags) {
  const values = asArray(flags).map((flag) => safeText(flag)).filter(Boolean);
  return values.length ? values.join(", ") : "none";
}

function buildHiveBody(record) {
  const status = normalizeStatus(record.reviewStatus);
  const flags = asArray(record.reviewFlags);
  const score = Number(record.score ?? 0);
  const taskId = safeText(record.taskId, "unknown task");
  const action = findRecommendedAction(record);
  return [
    `${findRecipientHandle(record)} - I am following up on reviewed Network Task ${taskId}.`,
    `Review status: ${displayStatus(status)}.`,
    `Score: ${Number.isFinite(score) ? score : 0}/100.`,
    `Flags: ${formatFlags(flags)}.`,
    `Next action: ${action}`,
  ].join("\n");
}

function buildHivePayload(record, generatedBy) {
  const status = normalizeStatus(record.reviewStatus);
  const recipientAccountId = findRecipientAccountId(record);
  const taskId = safeText(record.taskId);
  return {
    recipientAccountId,
    messageBody: buildHiveBody(record),
    metadata: {
      schema: OUTPUT_SCHEMA,
      deliverySurface: "hive_chat",
      generatedBy,
      sourceReviewId: safeText(record.id),
      sourceTaskId: taskId,
      reviewStatus: status,
      score: Number(record.score ?? 0),
      reviewFlags: asArray(record.reviewFlags).map((flag) => safeText(flag)).filter(Boolean),
      archiveAction: safeText(record.archiveAction),
      requiresContributorAction: status !== "verified" || safeText(record.archiveAction) === "needs_followup",
    },
  };
}

function buildDiscordMessage(record, generatedBy) {
  const parser = extractParser(record);
  const status = normalizeStatus(record.reviewStatus);
  const taskId = safeText(record.taskId, "unknown task");
  const score = Number(record.score ?? 0);
  const flags = formatFlags(record.reviewFlags);
  const action = findRecommendedAction(record);
  const reviewerNotes = safeText(parser.reviewerNotes || record.notes);
  const lines = [
    `**${taskId}** - contributor follow-up`,
    `Recipient: ${findRecipientHandle(record)} (${findRecipientAccountId(record) || "account unresolved"})`,
    `Review status: ${displayStatus(status)}`,
    `Score: ${Number.isFinite(score) ? score : 0}/100`,
    `Flags: ${flags}`,
    `Archive action: ${safeText(record.archiveAction, "none")}`,
    `Recommended next action: ${action}`,
    `Generated by: ${normalizeHandle(generatedBy)}`,
  ];
  if (reviewerNotes) lines.splice(6, 0, `Reviewer note: ${reviewerNotes}`);
  return lines.join("\n");
}

function summarize(records, hiveChatPayloads, discordMessages) {
  const byStatus = {};
  const flags = {};
  for (const record of records) {
    const status = normalizeStatus(record.reviewStatus);
    byStatus[status] = (byStatus[status] || 0) + 1;
    for (const flag of asArray(record.reviewFlags)) {
      const key = safeText(flag);
      if (key) flags[key] = (flags[key] || 0) + 1;
    }
  }
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    generatedAt: new Date().toISOString(),
    unnotifiedRecords: records.length,
    hivePayloads: hiveChatPayloads.length,
    discordMessages: discordMessages.length,
    byStatus,
    flags,
    taskIds: records.map((record) => safeText(record.taskId)).filter(Boolean),
  };
}

async function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) throw new Error(`Ledger not found: ${ledgerPath}`);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.records)) {
    throw new Error("Ledger must be a JSON object with records[]");
  }
  return ledger;
}

function buildOutput(ledger, options) {
  const generatedBy = safeText(options["generated-by"], "grashnuk").replace(/^@/, "");
  const records = ledger.records.filter(isUnnotified);
  const hiveChatPayloads = records.map((record) => buildHivePayload(record, generatedBy));
  const discordMessages = records.map((record) => ({
    taskId: safeText(record.taskId),
    recipientAccountId: findRecipientAccountId(record),
    recipientHandle: findRecipientHandle(record),
    message: buildDiscordMessage(record, generatedBy),
  }));
  const summary = summarize(records, hiveChatPayloads, discordMessages);
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    sourceLedgerSchema: safeText(ledger.schema, "unknown"),
    generatedBy,
    summary,
    hiveChatPayloads,
    discordMessages,
  };
}

async function writeBatch(output, outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "hive_payloads.json"), `${JSON.stringify(output.hiveChatPayloads, null, 2)}\n`);
  await writeFile(
    path.join(outDir, "discord_messages.md"),
    `${output.discordMessages.map((entry) => entry.message).join("\n\n---\n\n")}\n`
  );
  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(output.summary, null, 2)}\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (!["batch", "generate"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const ledgerPath = requireOption(options, "ledger");
  const ledger = await readLedger(ledgerPath);
  const output = buildOutput(ledger, options);
  if (command === "batch") {
    const outDir = requireOption(options, "out");
    await writeBatch(output, outDir);
    console.log(JSON.stringify({ ...output.summary, outputDir: outDir }, null, 2));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
```

## Sample Feedback Ledger

```json
{
  "schema": "pf.orc.submitted_work_review_ledger.v1",
  "updatedAt": "2026-06-20T01:55:00.000Z",
  "records": [
    {
      "id": "swrev_feedback_001",
      "taskId": "task_b800bcfe9c3c6e226e87b94a797bd9e1",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 90,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T01:50:51.486Z",
      "source": {
        "cid": "QmcZjEcFDVya5zEDEDbrMctUSgH1uxprYZLcqZFHofn6bo",
        "txHash": "D9F28201E910BB5571EE92AFD2E7F29EA35F667FDF7B4418BE4FA27B4E5C1D61"
      },
      "parserOutput": {
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Genuine reward-visibility product feedback with screenshot-supported observations."
      },
      "recommendedAction": "No contributor action required; product team should use the report as backlog evidence."
    },
    {
      "id": "swrev_feedback_002",
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "recipientHandle": "zoz",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 58,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T00:14:00.000Z",
      "source": {
        "cid": "QmZqirR2L7zPNfvUHQqVoC9UNrLsHhEAkYChbfaTQ33yLi",
        "txHash": "C6D14F8FD7274BE47EE5E480D965643225D45CE35F6F5EB9CFCD87B5B17248CA"
      },
      "parserOutput": {
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Parser work is useful but should not be operationalized until source and output artifacts are directly inspectable."
      },
      "recommendedAction": "Provide a source link or uploaded bundle plus one captured parser input/output pair."
    },
    {
      "id": "swrev_feedback_003",
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "score": 72,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T00:22:00.000Z",
      "source": {
        "cid": "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
        "txHash": "76E5D5AC37D06EFB9652909CC00CADB3260F3587A1765C2881E74700ACE8FF81"
      },
      "parserOutput": {
        "taskGrade": "partial",
        "rewardRecommendation": "manual review",
        "flagIndicators": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Evidence is internally consistent but should remain recommend-only until independent artifact inspection completes."
      },
      "recommendedAction": "Publish inspectable artifacts and keep the script read-only; do not execute enforcement or money movement."
    },
    {
      "id": "swrev_feedback_004",
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "grashnuk",
      "reviewer": "goodalexander",
      "reviewStatus": "verified",
      "score": 85,
      "reviewFlags": [
        "self_attested_evidence"
      ],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T01:42:47.451Z",
      "source": {
        "cid": "QmX3w4MH27UErJGmbKDXTdwqa9YBpVVDBnqusoh4CBZiUF",
        "txHash": "E1E8C512F62B026815FB0D0E03177F891E264574D18BD7C4E26F7C61F4981453"
      },
      "parserOutput": {
        "taskGrade": "pass",
        "rewardRecommendation": "eligible",
        "flagIndicators": [
          "self_attested_evidence"
        ],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Ledger tool met requirements; future work should include public commits when possible."
      },
      "recommendedAction": "No immediate action required; include independently resolvable commit or PR links in future code-task evidence."
    },
    {
      "id": "swrev_feedback_005",
      "taskId": "task_f6c88dafb196b7d01e51833a31f32b33",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "gmoney",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 64,
      "reviewFlags": [
        "needs_artifact_verification"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-19T21:19:29.348Z",
      "source": {
        "cid": "QmR17Q4HJqFFAmWe9pRnofPowi6dtnAmmi8fiPuY2SizSM",
        "txHash": "0A83825B58ECB0E3C91B1FF38183CB52BDE2629A6F714952C9096E6AA8557C68"
      },
      "parserOutput": {
        "taskGrade": "hold",
        "rewardRecommendation": "needs evidence",
        "flagIndicators": [
          "needs_artifact_verification"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Docker overlay output looks aligned, but the artifact path should be independently inspectable before reuse."
      },
      "recommendedAction": "Provide the docker-compose file, validator config, and startup log in a public branch or uploaded bundle."
    }
  ]
}
```

## Batch Output

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_feedback_messages.v1",
  "generatedAt": "2026-06-20T01:54:20.801Z",
  "unnotifiedRecords": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  },
  "flags": {
    "missing_public_artifact": 1,
    "pipeline_adjacent": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1,
    "self_attested_evidence": 1,
    "needs_artifact_verification": 1
  },
  "taskIds": [
    "task_b800bcfe9c3c6e226e87b94a797bd9e1",
    "task_8df92c053af509e72dbec3e475766f7a",
    "task_d77a9dc367ff181ff9463f58d01362c9",
    "task_01ba5f1d70d620780c333693c99a0cab",
    "task_f6c88dafb196b7d01e51833a31f32b33"
  ],
  "outputDir": "docs/verification/contributor_feedback_generator_task_3943e36bc14b9ce57870562050c7b109/outputs"
}
```

## Generate Output

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_feedback_messages.v1",
  "sourceLedgerSchema": "pf.orc.submitted_work_review_ledger.v1",
  "generatedBy": "grashnuk",
  "summary": {
    "ok": true,
    "schema": "pf.orc.contributor_feedback_messages.v1",
    "generatedAt": "2026-06-20T01:54:34.432Z",
    "unnotifiedRecords": 5,
    "hivePayloads": 5,
    "discordMessages": 5,
    "byStatus": {
      "verified": 2,
      "unverified": 2,
      "self_attested": 1
    },
    "flags": {
      "missing_public_artifact": 1,
      "pipeline_adjacent": 1,
      "money_sensitive": 1,
      "do_not_operationalize": 1,
      "self_attested_evidence": 1,
      "needs_artifact_verification": 1
    },
    "taskIds": [
      "task_b800bcfe9c3c6e226e87b94a797bd9e1",
      "task_8df92c053af509e72dbec3e475766f7a",
      "task_d77a9dc367ff181ff9463f58d01362c9",
      "task_01ba5f1d70d620780c333693c99a0cab",
      "task_f6c88dafb196b7d01e51833a31f32b33"
    ]
  },
  "hiveChatPayloads": [
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
    },
    {
      "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "messageBody": "@zoz - I am following up on reviewed Network Task task_8df92c053af509e72dbec3e475766f7a.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Provide a source link or uploaded bundle plus one captured parser input/output pair.",
      "metadata": {
        "schema": "pf.orc.contributor_feedback_messages.v1",
        "deliverySurface": "hive_chat",
        "generatedBy": "grashnuk",
        "sourceReviewId": "swrev_feedback_002",
        "sourceTaskId": "task_8df92c053af509e72dbec3e475766f7a",
        "reviewStatus": "unverified",
        "score": 58,
        "reviewFlags": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archiveAction": "needs_followup",
        "requiresContributorAction": true
      }
    },
    {
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "messageBody": "@grashnuk - I am following up on reviewed Network Task task_d77a9dc367ff181ff9463f58d01362c9.\nReview status: self-attested.\nScore: 72/100.\nFlags: money_sensitive, do_not_operationalize.\nNext action: Publish inspectable artifacts and keep the script read-only; do not execute enforcement or money movement.",
      "metadata": {
        "schema": "pf.orc.contributor_feedback_messages.v1",
        "deliverySurface": "hive_chat",
        "generatedBy": "grashnuk",
        "sourceReviewId": "swrev_feedback_003",
        "sourceTaskId": "task_d77a9dc367ff181ff9463f58d01362c9",
        "reviewStatus": "self_attested",
        "score": 72,
        "reviewFlags": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archiveAction": "hold",
        "requiresContributorAction": true
      }
    },
    {
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "messageBody": "@grashnuk - I am following up on reviewed Network Task task_01ba5f1d70d620780c333693c99a0cab.\nReview status: verified.\nScore: 85/100.\nFlags: self_attested_evidence.\nNext action: No immediate action required; include independently resolvable commit or PR links in future code-task evidence.",
      "metadata": {
        "schema": "pf.orc.contributor_feedback_messages.v1",
        "deliverySurface": "hive_chat",
        "generatedBy": "grashnuk",
        "sourceReviewId": "swrev_feedback_004",
        "sourceTaskId": "task_01ba5f1d70d620780c333693c99a0cab",
        "reviewStatus": "verified",
        "score": 85,
        "reviewFlags": [
          "self_attested_evidence"
        ],
        "archiveAction": "archive_hot",
        "requiresContributorAction": false
      }
    },
    {
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "messageBody": "@gmoney - I am following up on reviewed Network Task task_f6c88dafb196b7d01e51833a31f32b33.\nReview status: unverifiable.\nScore: 64/100.\nFlags: needs_artifact_verification.\nNext action: Provide the docker-compose file, validator config, and startup log in a public branch or uploaded bundle.",
      "metadata": {
        "schema": "pf.orc.contributor_feedback_messages.v1",
        "deliverySurface": "hive_chat",
        "generatedBy": "grashnuk",
        "sourceReviewId": "swrev_feedback_005",
        "sourceTaskId": "task_f6c88dafb196b7d01e51833a31f32b33",
        "reviewStatus": "unverified",
        "score": 64,
        "reviewFlags": [
          "needs_artifact_verification"
        ],
        "archiveAction": "needs_followup",
        "requiresContributorAction": true
      }
    }
  ],
  "discordMessages": [
    {
      "taskId": "task_b800bcfe9c3c6e226e87b94a797bd9e1",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "@gmoney",
      "message": "**task_b800bcfe9c3c6e226e87b94a797bd9e1** - contributor follow-up\nRecipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)\nReview status: verified\nScore: 90/100\nFlags: none\nArchive action: archive_hot\nReviewer note: Genuine reward-visibility product feedback with screenshot-supported observations.\nRecommended next action: No contributor action required; product team should use the report as backlog evidence.\nGenerated by: @grashnuk"
    },
    {
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "recipientHandle": "@zoz",
      "message": "**task_8df92c053af509e72dbec3e475766f7a** - contributor follow-up\nRecipient: @zoz (acct_oauth_8b6a2004c07fe8d96493d95f)\nReview status: unverifiable\nScore: 58/100\nFlags: missing_public_artifact, pipeline_adjacent\nArchive action: needs_followup\nReviewer note: Parser work is useful but should not be operationalized until source and output artifacts are directly inspectable.\nRecommended next action: Provide a source link or uploaded bundle plus one captured parser input/output pair.\nGenerated by: @grashnuk"
    },
    {
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "@grashnuk",
      "message": "**task_d77a9dc367ff181ff9463f58d01362c9** - contributor follow-up\nRecipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)\nReview status: self-attested\nScore: 72/100\nFlags: money_sensitive, do_not_operationalize\nArchive action: hold\nReviewer note: Evidence is internally consistent but should remain recommend-only until independent artifact inspection completes.\nRecommended next action: Publish inspectable artifacts and keep the script read-only; do not execute enforcement or money movement.\nGenerated by: @grashnuk"
    },
    {
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
      "recipientHandle": "@grashnuk",
      "message": "**task_01ba5f1d70d620780c333693c99a0cab** - contributor follow-up\nRecipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)\nReview status: verified\nScore: 85/100\nFlags: self_attested_evidence\nArchive action: archive_hot\nReviewer note: Ledger tool met requirements; future work should include public commits when possible.\nRecommended next action: No immediate action required; include independently resolvable commit or PR links in future code-task evidence.\nGenerated by: @grashnuk"
    },
    {
      "taskId": "task_f6c88dafb196b7d01e51833a31f32b33",
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientHandle": "@gmoney",
      "message": "**task_f6c88dafb196b7d01e51833a31f32b33** - contributor follow-up\nRecipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)\nReview status: unverifiable\nScore: 64/100\nFlags: needs_artifact_verification\nArchive action: needs_followup\nReviewer note: Docker overlay output looks aligned, but the artifact path should be independently inspectable before reuse.\nRecommended next action: Provide the docker-compose file, validator config, and startup log in a public branch or uploaded bundle.\nGenerated by: @grashnuk"
    }
  ]
}
```

## Hive Payloads

```json
[
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
  },
  {
    "recipientAccountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
    "messageBody": "@zoz - I am following up on reviewed Network Task task_8df92c053af509e72dbec3e475766f7a.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Provide a source link or uploaded bundle plus one captured parser input/output pair.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_feedback_002",
      "sourceTaskId": "task_8df92c053af509e72dbec3e475766f7a",
      "reviewStatus": "unverified",
      "score": 58,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "requiresContributorAction": true
    }
  },
  {
    "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
    "messageBody": "@grashnuk - I am following up on reviewed Network Task task_d77a9dc367ff181ff9463f58d01362c9.\nReview status: self-attested.\nScore: 72/100.\nFlags: money_sensitive, do_not_operationalize.\nNext action: Publish inspectable artifacts and keep the script read-only; do not execute enforcement or money movement.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_feedback_003",
      "sourceTaskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewStatus": "self_attested",
      "score": 72,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "requiresContributorAction": true
    }
  },
  {
    "recipientAccountId": "acct_wallet_1a528118923ae8830d46f56e",
    "messageBody": "@grashnuk - I am following up on reviewed Network Task task_01ba5f1d70d620780c333693c99a0cab.\nReview status: verified.\nScore: 85/100.\nFlags: self_attested_evidence.\nNext action: No immediate action required; include independently resolvable commit or PR links in future code-task evidence.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_feedback_004",
      "sourceTaskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "reviewStatus": "verified",
      "score": 85,
      "reviewFlags": [
        "self_attested_evidence"
      ],
      "archiveAction": "archive_hot",
      "requiresContributorAction": false
    }
  },
  {
    "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
    "messageBody": "@gmoney - I am following up on reviewed Network Task task_f6c88dafb196b7d01e51833a31f32b33.\nReview status: unverifiable.\nScore: 64/100.\nFlags: needs_artifact_verification.\nNext action: Provide the docker-compose file, validator config, and startup log in a public branch or uploaded bundle.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_feedback_005",
      "sourceTaskId": "task_f6c88dafb196b7d01e51833a31f32b33",
      "reviewStatus": "unverified",
      "score": 64,
      "reviewFlags": [
        "needs_artifact_verification"
      ],
      "archiveAction": "needs_followup",
      "requiresContributorAction": true
    }
  }
]
```

## Discord Messages

```md
**task_b800bcfe9c3c6e226e87b94a797bd9e1** - contributor follow-up
Recipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)
Review status: verified
Score: 90/100
Flags: none
Archive action: archive_hot
Reviewer note: Genuine reward-visibility product feedback with screenshot-supported observations.
Recommended next action: No contributor action required; product team should use the report as backlog evidence.
Generated by: @grashnuk

---

**task_8df92c053af509e72dbec3e475766f7a** - contributor follow-up
Recipient: @zoz (acct_oauth_8b6a2004c07fe8d96493d95f)
Review status: unverifiable
Score: 58/100
Flags: missing_public_artifact, pipeline_adjacent
Archive action: needs_followup
Reviewer note: Parser work is useful but should not be operationalized until source and output artifacts are directly inspectable.
Recommended next action: Provide a source link or uploaded bundle plus one captured parser input/output pair.
Generated by: @grashnuk

---

**task_d77a9dc367ff181ff9463f58d01362c9** - contributor follow-up
Recipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)
Review status: self-attested
Score: 72/100
Flags: money_sensitive, do_not_operationalize
Archive action: hold
Reviewer note: Evidence is internally consistent but should remain recommend-only until independent artifact inspection completes.
Recommended next action: Publish inspectable artifacts and keep the script read-only; do not execute enforcement or money movement.
Generated by: @grashnuk

---

**task_01ba5f1d70d620780c333693c99a0cab** - contributor follow-up
Recipient: @grashnuk (acct_wallet_1a528118923ae8830d46f56e)
Review status: verified
Score: 85/100
Flags: self_attested_evidence
Archive action: archive_hot
Reviewer note: Ledger tool met requirements; future work should include public commits when possible.
Recommended next action: No immediate action required; include independently resolvable commit or PR links in future code-task evidence.
Generated by: @grashnuk

---

**task_f6c88dafb196b7d01e51833a31f32b33** - contributor follow-up
Recipient: @gmoney (acct_oauth_31a2b120878c91e24add9ceb)
Review status: unverifiable
Score: 64/100
Flags: needs_artifact_verification
Archive action: needs_followup
Reviewer note: Docker overlay output looks aligned, but the artifact path should be independently inspectable before reuse.
Recommended next action: Provide the docker-compose file, validator config, and startup log in a public branch or uploaded bundle.
Generated by: @grashnuk
```

## Summary JSON

```json
{
  "ok": true,
  "schema": "pf.orc.contributor_feedback_messages.v1",
  "generatedAt": "2026-06-20T01:54:20.801Z",
  "unnotifiedRecords": 5,
  "hivePayloads": 5,
  "discordMessages": 5,
  "byStatus": {
    "verified": 2,
    "unverified": 2,
    "self_attested": 1
  },
  "flags": {
    "missing_public_artifact": 1,
    "pipeline_adjacent": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1,
    "self_attested_evidence": 1,
    "needs_artifact_verification": 1
  },
  "taskIds": [
    "task_b800bcfe9c3c6e226e87b94a797bd9e1",
    "task_8df92c053af509e72dbec3e475766f7a",
    "task_d77a9dc367ff181ff9463f58d01362c9",
    "task_01ba5f1d70d620780c333693c99a0cab",
    "task_f6c88dafb196b7d01e51833a31f32b33"
  ]
}
```

## Help Output

```text
Usage:
  node scripts/orc-contributor-feedback-message-generator.mjs batch --ledger <file> --out <dir> [--generated-by <handle>]
  node scripts/orc-contributor-feedback-message-generator.mjs generate --ledger <file> [--generated-by <handle>]

Commands:
  batch     Write hive_payloads.json, discord_messages.md, and summary.json for unnotified records.
  generate  Print generated payloads to stdout without writing files.

The ledger must contain records[] compatible with pf.orc.submitted_work_review_ledger.v1.
Unnotified records are entries without notification.notifiedAt, notification.sentAt, or notifiedAt.
```
