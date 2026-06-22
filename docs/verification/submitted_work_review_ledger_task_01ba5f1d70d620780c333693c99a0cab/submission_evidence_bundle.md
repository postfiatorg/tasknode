# Evidence Bundle: Submitted Work Review Ledger Tool

Task: `task_01ba5f1d70d620780c333693c99a0cab`

This bundle is self-contained for Task Node verification: it includes the reviewer summary, executable source, sample ledger, exercised working ledger, and captured add/query/list/report outputs.

## Reviewer Summary

# Submitted Work Review Ledger Tool

Task: `task_01ba5f1d70d620780c333693c99a0cab`

## Delivered files

- `scripts/orc-submitted-work-review-ledger.mjs` - dependency-free Node CLI for review-ledger add/query/list/report operations.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/sample_ledger.json` - sample ledger with all required review states.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json` - exercised ledger after adding one extra smoke record.
- `docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/*.json` - captured command outputs.

## Ledger fields

Each record stores:

- `taskId`
- `reviewer`
- `reviewStatus`: `verified`, `unverified`, or `self_attested`
- `score`
- `reviewFlags`
- `archiveAction`
- `timestamp`
- `source.cid`
- `source.txHash`
- `parserOutput.taskGrade`
- `parserOutput.rewardRecommendation`
- `parserOutput.flagIndicators`
- `parserOutput.archivalInstructions`
- `parserOutput.reviewerNotes`

This shape is JSON-compatible with review-prompt/parser style outputs from `task_c47...` and `task_8df...`: parsed grade, recommendation, flags, archival instructions, and notes are preserved under `parserOutput`, while the ledger keeps normalized query fields at the top level.

## Commands run

```bash
chmod +x scripts/orc-submitted-work-review-ledger.mjs
node --check scripts/orc-submitted-work-review-ledger.mjs
node scripts/orc-submitted-work-review-ledger.mjs --help
cp docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/sample_ledger.json docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json

node scripts/orc-submitted-work-review-ledger.mjs add \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --task-id task_01ba5f1d70d620780c333693c99a0cab \
  --reviewer grashnuk \
  --status verified \
  --score 88 \
  --archive-action archive_hot \
  --flag ledger_smoke_test \
  --task-grade pass \
  --reward-recommendation eligible \
  --note "Smoke record proving add operation for the submitted-work review ledger task." \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/add_output.json

node scripts/orc-submitted-work-review-ledger.mjs query \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --task-id task_01ba5f1d70d620780c333693c99a0cab \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/query_by_task_output.json

node scripts/orc-submitted-work-review-ledger.mjs query \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --reviewer grashnuk \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/query_by_reviewer_output.json

node scripts/orc-submitted-work-review-ledger.mjs list \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --status self_attested \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/list_self_attested_output.json

node scripts/orc-submitted-work-review-ledger.mjs list \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  --flag money_sensitive \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/list_flag_output.json

node scripts/orc-submitted-work-review-ledger.mjs report \
  --ledger docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json \
  > docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/outputs/report_output.json
```

## Sample input

`sample_ledger.json` contains three baseline records:

- `verified`: `task_c47...`
- `unverified`: `task_8df...`, flagged `missing_public_artifact` and `pipeline_adjacent`
- `self_attested`: `task_d77...`, flagged `money_sensitive` and `do_not_operationalize`

## Output proof

The working ledger report output shows:

```json
{
  "totalRecords": 4,
  "averageScore": 77.25,
  "byStatus": {
    "verified": 2,
    "unverified": 1,
    "self_attested": 1
  },
  "flagCounts": {
    "missing_public_artifact": 1,
    "pipeline_adjacent": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1,
    "ledger_smoke_test": 1
  },
  "archiveActions": {
    "archive_hot": 2,
    "needs_followup": 1,
    "hold": 1
  }
}
```
The captured outputs prove:

- add: inserted a verified smoke record for `task_01ba5f1d70d620780c333693c99a0cab`
- query by task: returned that exact task
- query by reviewer: returned all `grashnuk` records
- list by status: returned the self-attested record
- list by flag: returned the money-sensitive record
- report: summarized status counts, average score, flags, and archive actions

## Expected review flow

1. A reviewer or parser emits normalized review output for a submitted network task.
2. `add` stores the review with the task id, reviewer, status, score, flags, archive action, source pointers, and parser output.
3. `query` retrieves a task-specific or reviewer-specific audit trail.
4. `list` surfaces work by review state or flag for follow-up queues.
5. `report` gives @goodalexander and the operator layer a compact status/flag/archive summary.

No enforcement, ban, clawback, deployment, or money-moving action was performed by this tool. It is a local review-ledger artifact for tracking submitted-work review state.

## Source File: scripts/orc-submitted-work-review-ledger.mjs

```js
#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

const LEDGER_SCHEMA = "pf.orc.submitted_work_review_ledger.v1";
const VALID_STATUSES = new Set(["verified", "unverified", "self_attested"]);
const VALID_ARCHIVE_ACTIONS = new Set([
  "archive_hot",
  "archive_cold",
  "needs_followup",
  "reject",
  "hold",
]);

function usage() {
  return `Usage:
  node scripts/orc-submitted-work-review-ledger.mjs add --ledger <file> --task-id <id> --reviewer <handle> --status <verified|unverified|self_attested> --score <0-100> --archive-action <action> [--flag <flag>] [--note <text>]
  node scripts/orc-submitted-work-review-ledger.mjs query --ledger <file> (--task-id <id> | --reviewer <handle>)
  node scripts/orc-submitted-work-review-ledger.mjs list --ledger <file> [--status <status>] [--flag <flag>]
  node scripts/orc-submitted-work-review-ledger.mjs report --ledger <file>

Statuses: ${[...VALID_STATUSES].join(", ")}
Archive actions: ${[...VALID_ARCHIVE_ACTIONS].join(", ")}`;
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
    if (options[key] === undefined) {
      options[key] = next;
    } else if (Array.isArray(options[key])) {
      options[key].push(next);
    } else {
      options[key] = [options[key], next];
    }
  }
  return { command, options };
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!VALID_STATUSES.has(normalized)) {
    throw new Error(`Invalid review status: ${value}`);
  }
  return normalized;
}

function normalizeArchiveAction(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!VALID_ARCHIVE_ACTIONS.has(normalized)) {
    throw new Error(`Invalid archive action: ${value}`);
  }
  return normalized;
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Score must be a number from 0 to 100: ${value}`);
  }
  return Number(score.toFixed(2));
}

function stableHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 20);
}

function nowIso() {
  return new Date().toISOString();
}

function blankLedger() {
  return {
    schema: LEDGER_SCHEMA,
    updatedAt: nowIso(),
    records: [],
  };
}

async function readLedger(path) {
  if (!path) throw new Error("--ledger is required");
  if (!existsSync(path)) return blankLedger();
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Ledger must be a JSON object");
  if (!Array.isArray(parsed.records)) throw new Error("Ledger must contain records[]");
  if (!parsed.schema) parsed.schema = LEDGER_SCHEMA;
  return parsed;
}

async function writeLedger(path, ledger) {
  ledger.schema = LEDGER_SCHEMA;
  ledger.updatedAt = nowIso();
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function buildRecord(options) {
  const taskId = requireOption(options, "task-id");
  const reviewer = requireOption(options, "reviewer").replace(/^@/, "");
  const reviewStatus = normalizeStatus(requireOption(options, "status"));
  const score = normalizeScore(requireOption(options, "score"));
  const archiveAction = normalizeArchiveAction(requireOption(options, "archive-action"));
  const reviewFlags = asArray(options.flag).map((flag) =>
    String(flag).trim().toLowerCase().replaceAll(" ", "_")
  ).filter(Boolean);
  const timestamp = options.timestamp ? new Date(String(options.timestamp)).toISOString() : nowIso();
  const reviewerNotes = String(options.note || "").trim();
  const sourceCid = String(options["source-cid"] || "").trim();
  const sourceTxHash = String(options["source-tx-hash"] || "").trim();
  const rewardRecommendation = String(options["reward-recommendation"] || "").trim();
  const taskGrade = String(options["task-grade"] || "").trim();
  const id = `swrev_${stableHash(`${taskId}|${reviewer}|${timestamp}|${reviewStatus}`)}`;
  return {
    id,
    taskId,
    reviewer,
    reviewStatus,
    score,
    reviewFlags,
    archiveAction,
    timestamp,
    source: {
      cid: sourceCid,
      txHash: sourceTxHash,
    },
    parserOutput: {
      taskGrade,
      rewardRecommendation,
      flagIndicators: reviewFlags,
      archivalInstructions: archiveAction,
      reviewerNotes,
    },
  };
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    const timeCompare = String(left.timestamp || "").localeCompare(String(right.timestamp || ""));
    if (timeCompare !== 0) return timeCompare;
    return String(left.taskId || "").localeCompare(String(right.taskId || ""));
  });
}

async function addRecord(options) {
  const ledger = await readLedger(options.ledger);
  const record = buildRecord(options);
  const existingIndex = ledger.records.findIndex((entry) => entry.id === record.id);
  if (existingIndex >= 0) {
    ledger.records[existingIndex] = record;
  } else {
    ledger.records.push(record);
  }
  ledger.records = sortRecords(ledger.records);
  await writeLedger(options.ledger, ledger);
  return {
    ok: true,
    operation: "add",
    ledger: options.ledger,
    inserted: existingIndex < 0,
    record,
  };
}

async function queryLedger(options) {
  const ledger = await readLedger(options.ledger);
  const taskId = options["task-id"] ? String(options["task-id"]) : "";
  const reviewer = options.reviewer ? String(options.reviewer).replace(/^@/, "") : "";
  if (!taskId && !reviewer) throw new Error("query requires --task-id or --reviewer");
  const records = sortRecords(ledger.records).filter((entry) => {
    if (taskId && entry.taskId !== taskId) return false;
    if (reviewer && entry.reviewer !== reviewer) return false;
    return true;
  });
  return {
    ok: true,
    operation: "query",
    filters: { taskId, reviewer },
    count: records.length,
    records,
  };
}

async function listLedger(options) {
  const ledger = await readLedger(options.ledger);
  const status = options.status ? normalizeStatus(options.status) : "";
  const flag = options.flag ? String(options.flag).trim().toLowerCase().replaceAll(" ", "_") : "";
  const records = sortRecords(ledger.records).filter((entry) => {
    if (status && entry.reviewStatus !== status) return false;
    if (flag && !asArray(entry.reviewFlags).includes(flag)) return false;
    return true;
  });
  return {
    ok: true,
    operation: "list",
    filters: { status, flag },
    count: records.length,
    records,
  };
}

function summarizeLedger(ledger) {
  const byStatus = Object.fromEntries([...VALID_STATUSES].map((status) => [status, 0]));
  const byReviewer = {};
  const flagCounts = {};
  const archiveActions = {};
  let scoreTotal = 0;
  for (const entry of ledger.records) {
    byStatus[entry.reviewStatus] = (byStatus[entry.reviewStatus] || 0) + 1;
    byReviewer[entry.reviewer] = (byReviewer[entry.reviewer] || 0) + 1;
    archiveActions[entry.archiveAction] = (archiveActions[entry.archiveAction] || 0) + 1;
    for (const flag of asArray(entry.reviewFlags)) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
    scoreTotal += Number(entry.score || 0);
  }
  const total = ledger.records.length;
  return {
    ok: true,
    operation: "report",
    schema: LEDGER_SCHEMA,
    totalRecords: total,
    averageScore: total ? Number((scoreTotal / total).toFixed(2)) : 0,
    byStatus,
    byReviewer,
    flagCounts,
    archiveActions,
    tasksWithFlags: sortRecords(ledger.records)
      .filter((entry) => asArray(entry.reviewFlags).length > 0)
      .map((entry) => ({
        taskId: entry.taskId,
        reviewer: entry.reviewer,
        reviewStatus: entry.reviewStatus,
        reviewFlags: entry.reviewFlags,
        archiveAction: entry.archiveAction,
      })),
    generatedAt: nowIso(),
  };
}

async function reportLedger(options) {
  const ledger = await readLedger(options.ledger);
  return summarizeLedger(ledger);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  let result;
  if (command === "add") result = await addRecord(options);
  else if (command === "query") result = await queryLedger(options);
  else if (command === "list") result = await listLedger(options);
  else if (command === "report") result = await reportLedger(options);
  else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
```

## Sample Ledger JSON

```json
{
  "schema": "pf.orc.submitted_work_review_ledger.v1",
  "updatedAt": "2026-06-20T00:00:00.000Z",
  "records": [
    {
      "id": "swrev_sample_verified",
      "taskId": "task_c47ab945b126e0ec2c773e794eabc389",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 92,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T00:01:00.000Z",
      "source": {
        "cid": "QmPCEeyatJpdDndUcNn3nWxrcXZYYZRJ3vLAepZu9hJte6",
        "txHash": "1524DFA97D1AFCA8B10B60CF3A652F2ED74CBF76E246185DF250537CAEF85694"
      },
      "parserOutput": {
        "taskGrade": "A",
        "rewardRecommendation": "full_reward",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Triage routing implementation packet is internally consistent and implementation-ready."
      }
    },
    {
      "id": "swrev_sample_unverified",
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 61,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T00:02:00.000Z",
      "source": {
        "cid": "QmZqirR2L7zPNfvUHQqVoC9UNrLsHhEAkYChbfaTQ33yLi",
        "txHash": "C6D14F8FD7274BE47EE5E480D965643225D45CE35F6E5EB9CFCD87B5B17248CA"
      },
      "parserOutput": {
        "taskGrade": "C",
        "rewardRecommendation": "partial_reward_until_artifacts_verified",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Useful review formatter direction, but do not operationalize parser output until script and tests are resolvable."
      }
    },
    {
      "id": "swrev_sample_self_attested",
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "score": 68,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T00:03:00.000Z",
      "source": {
        "cid": "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
        "txHash": "76E5D5AC37D06EFB9652909CC00CADB3260F3587A1765C2881E74700ACE8FF81"
      },
      "parserOutput": {
        "taskGrade": "B-",
        "rewardRecommendation": "partial_reward_with_controls",
        "flagIndicators": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Treat executable reward-integrity artifacts as context only until independently verified."
      }
    }
  ]
}
```

## Working Ledger JSON

```json
{
  "schema": "pf.orc.submitted_work_review_ledger.v1",
  "updatedAt": "2026-06-20T01:36:39.281Z",
  "records": [
    {
      "id": "swrev_sample_verified",
      "taskId": "task_c47ab945b126e0ec2c773e794eabc389",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 92,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T00:01:00.000Z",
      "source": {
        "cid": "QmPCEeyatJpdDndUcNn3nWxrcXZYYZRJ3vLAepZu9hJte6",
        "txHash": "1524DFA97D1AFCA8B10B60CF3A652F2ED74CBF76E246185DF250537CAEF85694"
      },
      "parserOutput": {
        "taskGrade": "A",
        "rewardRecommendation": "full_reward",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Triage routing implementation packet is internally consistent and implementation-ready."
      }
    },
    {
      "id": "swrev_sample_unverified",
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 61,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T00:02:00.000Z",
      "source": {
        "cid": "QmZqirR2L7zPNfvUHQqVoC9UNrLsHhEAkYChbfaTQ33yLi",
        "txHash": "C6D14F8FD7274BE47EE5E480D965643225D45CE35F6E5EB9CFCD87B5B17248CA"
      },
      "parserOutput": {
        "taskGrade": "C",
        "rewardRecommendation": "partial_reward_until_artifacts_verified",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Useful review formatter direction, but do not operationalize parser output until script and tests are resolvable."
      }
    },
    {
      "id": "swrev_sample_self_attested",
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "score": 68,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T00:03:00.000Z",
      "source": {
        "cid": "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
        "txHash": "76E5D5AC37D06EFB9652909CC00CADB3260F3587A1765C2881E74700ACE8FF81"
      },
      "parserOutput": {
        "taskGrade": "B-",
        "rewardRecommendation": "partial_reward_with_controls",
        "flagIndicators": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Treat executable reward-integrity artifacts as context only until independently verified."
      }
    },
    {
      "id": "swrev_a1ad67024c43b6d98e47",
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [
        "ledger_smoke_test"
      ],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T01:36:39.274Z",
      "source": {
        "cid": "QmQc4QKRr3j5KpNZNUp8fLvnpyVt8VzkKdYm2ggWV4EpTu",
        "txHash": "4B2451DBC848F3CD56ECC7907BE065879F7C2EAAFEACAF93AD7ED50848860E93"
      },
      "parserOutput": {
        "taskGrade": "A-",
        "rewardRecommendation": "full_reward_candidate",
        "flagIndicators": [
          "ledger_smoke_test"
        ],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Smoke-added review ledger record proving add/query/list/report operations."
      }
    }
  ]
}
```

## Output: add_output.json

```json
{
  "ok": true,
  "operation": "add",
  "ledger": "docs/verification/submitted_work_review_ledger_task_01ba5f1d70d620780c333693c99a0cab/working_ledger.json",
  "inserted": true,
  "record": {
    "id": "swrev_a1ad67024c43b6d98e47",
    "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
    "reviewer": "grashnuk",
    "reviewStatus": "verified",
    "score": 88,
    "reviewFlags": [
      "ledger_smoke_test"
    ],
    "archiveAction": "archive_hot",
    "timestamp": "2026-06-20T01:36:39.274Z",
    "source": {
      "cid": "QmQc4QKRr3j5KpNZNUp8fLvnpyVt8VzkKdYm2ggWV4EpTu",
      "txHash": "4B2451DBC848F3CD56ECC7907BE065879F7C2EAAFEACAF93AD7ED50848860E93"
    },
    "parserOutput": {
      "taskGrade": "A-",
      "rewardRecommendation": "full_reward_candidate",
      "flagIndicators": [
        "ledger_smoke_test"
      ],
      "archivalInstructions": "archive_hot",
      "reviewerNotes": "Smoke-added review ledger record proving add/query/list/report operations."
    }
  }
}
```

## Output: query_by_task_output.json

```json
{
  "ok": true,
  "operation": "query",
  "filters": {
    "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
    "reviewer": ""
  },
  "count": 1,
  "records": [
    {
      "id": "swrev_a1ad67024c43b6d98e47",
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [
        "ledger_smoke_test"
      ],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T01:36:39.274Z",
      "source": {
        "cid": "QmQc4QKRr3j5KpNZNUp8fLvnpyVt8VzkKdYm2ggWV4EpTu",
        "txHash": "4B2451DBC848F3CD56ECC7907BE065879F7C2EAAFEACAF93AD7ED50848860E93"
      },
      "parserOutput": {
        "taskGrade": "A-",
        "rewardRecommendation": "full_reward_candidate",
        "flagIndicators": [
          "ledger_smoke_test"
        ],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Smoke-added review ledger record proving add/query/list/report operations."
      }
    }
  ]
}
```

## Output: query_by_reviewer_output.json

```json
{
  "ok": true,
  "operation": "query",
  "filters": {
    "taskId": "",
    "reviewer": "grashnuk"
  },
  "count": 3,
  "records": [
    {
      "id": "swrev_sample_verified",
      "taskId": "task_c47ab945b126e0ec2c773e794eabc389",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 92,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T00:01:00.000Z",
      "source": {
        "cid": "QmPCEeyatJpdDndUcNn3nWxrcXZYYZRJ3vLAepZu9hJte6",
        "txHash": "1524DFA97D1AFCA8B10B60CF3A652F2ED74CBF76E246185DF250537CAEF85694"
      },
      "parserOutput": {
        "taskGrade": "A",
        "rewardRecommendation": "full_reward",
        "flagIndicators": [],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Triage routing implementation packet is internally consistent and implementation-ready."
      }
    },
    {
      "id": "swrev_sample_unverified",
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "score": 61,
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup",
      "timestamp": "2026-06-20T00:02:00.000Z",
      "source": {
        "cid": "QmZqirR2L7zPNfvUHQqVoC9UNrLsHhEAkYChbfaTQ33yLi",
        "txHash": "C6D14F8FD7274BE47EE5E480D965643225D45CE35F6E5EB9CFCD87B5B17248CA"
      },
      "parserOutput": {
        "taskGrade": "C",
        "rewardRecommendation": "partial_reward_until_artifacts_verified",
        "flagIndicators": [
          "missing_public_artifact",
          "pipeline_adjacent"
        ],
        "archivalInstructions": "needs_followup",
        "reviewerNotes": "Useful review formatter direction, but do not operationalize parser output until script and tests are resolvable."
      }
    },
    {
      "id": "swrev_a1ad67024c43b6d98e47",
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "score": 88,
      "reviewFlags": [
        "ledger_smoke_test"
      ],
      "archiveAction": "archive_hot",
      "timestamp": "2026-06-20T01:36:39.274Z",
      "source": {
        "cid": "QmQc4QKRr3j5KpNZNUp8fLvnpyVt8VzkKdYm2ggWV4EpTu",
        "txHash": "4B2451DBC848F3CD56ECC7907BE065879F7C2EAAFEACAF93AD7ED50848860E93"
      },
      "parserOutput": {
        "taskGrade": "A-",
        "rewardRecommendation": "full_reward_candidate",
        "flagIndicators": [
          "ledger_smoke_test"
        ],
        "archivalInstructions": "archive_hot",
        "reviewerNotes": "Smoke-added review ledger record proving add/query/list/report operations."
      }
    }
  ]
}
```

## Output: list_self_attested_output.json

```json
{
  "ok": true,
  "operation": "list",
  "filters": {
    "status": "self_attested",
    "flag": ""
  },
  "count": 1,
  "records": [
    {
      "id": "swrev_sample_self_attested",
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "score": 68,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T00:03:00.000Z",
      "source": {
        "cid": "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
        "txHash": "76E5D5AC37D06EFB9652909CC00CADB3260F3587A1765C2881E74700ACE8FF81"
      },
      "parserOutput": {
        "taskGrade": "B-",
        "rewardRecommendation": "partial_reward_with_controls",
        "flagIndicators": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Treat executable reward-integrity artifacts as context only until independently verified."
      }
    }
  ]
}
```

## Output: list_flag_output.json

```json
{
  "ok": true,
  "operation": "list",
  "filters": {
    "status": "",
    "flag": "do_not_operationalize"
  },
  "count": 1,
  "records": [
    {
      "id": "swrev_sample_self_attested",
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "score": 68,
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold",
      "timestamp": "2026-06-20T00:03:00.000Z",
      "source": {
        "cid": "QmVpLdsySyxwrPY27kn5wmGp7nRpW4vF4X2W7NkU2FKwvW",
        "txHash": "76E5D5AC37D06EFB9652909CC00CADB3260F3587A1765C2881E74700ACE8FF81"
      },
      "parserOutput": {
        "taskGrade": "B-",
        "rewardRecommendation": "partial_reward_with_controls",
        "flagIndicators": [
          "money_sensitive",
          "do_not_operationalize"
        ],
        "archivalInstructions": "hold",
        "reviewerNotes": "Treat executable reward-integrity artifacts as context only until independently verified."
      }
    }
  ]
}
```

## Output: report_output.json

```json
{
  "ok": true,
  "operation": "report",
  "schema": "pf.orc.submitted_work_review_ledger.v1",
  "totalRecords": 4,
  "averageScore": 77.25,
  "byStatus": {
    "verified": 2,
    "unverified": 1,
    "self_attested": 1
  },
  "byReviewer": {
    "grashnuk": 3,
    "tasknodeorc": 1
  },
  "flagCounts": {
    "missing_public_artifact": 1,
    "pipeline_adjacent": 1,
    "money_sensitive": 1,
    "do_not_operationalize": 1,
    "ledger_smoke_test": 1
  },
  "archiveActions": {
    "archive_hot": 2,
    "needs_followup": 1,
    "hold": 1
  },
  "tasksWithFlags": [
    {
      "taskId": "task_8df92c053af509e72dbec3e475766f7a",
      "reviewer": "grashnuk",
      "reviewStatus": "unverified",
      "reviewFlags": [
        "missing_public_artifact",
        "pipeline_adjacent"
      ],
      "archiveAction": "needs_followup"
    },
    {
      "taskId": "task_d77a9dc367ff181ff9463f58d01362c9",
      "reviewer": "tasknodeorc",
      "reviewStatus": "self_attested",
      "reviewFlags": [
        "money_sensitive",
        "do_not_operationalize"
      ],
      "archiveAction": "hold"
    },
    {
      "taskId": "task_01ba5f1d70d620780c333693c99a0cab",
      "reviewer": "grashnuk",
      "reviewStatus": "verified",
      "reviewFlags": [
        "ledger_smoke_test"
      ],
      "archiveAction": "archive_hot"
    }
  ],
  "generatedAt": "2026-06-20T01:36:54.623Z"
}
```
