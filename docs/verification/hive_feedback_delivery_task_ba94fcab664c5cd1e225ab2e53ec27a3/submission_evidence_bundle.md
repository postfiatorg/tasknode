# Evidence Bundle: Hive Chat Feedback Message Delivery Script

Task: `task_ba94fcab664c5cd1e225ab2e53ec27a3`

This bundle is self-contained for verification: source, sample payloads, target map, mock delivery report, sent/failed outputs, Discord summary, command output, and help output.

## Execution Summary

# Hive Chat Feedback Message Delivery Script

Task: `task_ba94fcab664c5cd1e225ab2e53ec27a3`

## Delivered files

- `scripts/orc-hive-feedback-delivery.mjs` - runnable mock delivery CLI.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_hive_payloads.json` - five feedback-message payloads.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_targets.json` - target account/wallet/conversation mapping with mock endpoint behavior.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/delivery_report.json` - structured JSON delivery report.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/sent_messages.json` - successful mock deliveries.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/failed_messages.json` - failed mock deliveries with error details.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/discord_execution_summary.md` - Discord-ready execution summary.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/run_output.json` - command stdout.
- `docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/help_output.txt` - CLI help output.

## Safety boundary

The task allowed either Hive Chat API delivery or a clearly defined mock endpoint. I used the mock endpoint path to avoid live user-facing messages without a separate operator approval/rate-limit review. The script does not sign transactions, move funds, apply enforcement, ban users, or send live Hive messages in mock mode.

Mock endpoint behavior:

- targets with `mockStatus: "failed"` reject delivery;
- missing target conversation IDs fail with `conversation_missing`;
- unmapped account/wallet recipients fail with `target_not_found`;
- all other resolved targets return deterministic `mock_hivemsg_*` message IDs.

## Commands run

```bash
chmod +x scripts/orc-hive-feedback-delivery.mjs
node --check scripts/orc-hive-feedback-delivery.mjs
jq empty docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_hive_payloads.json docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_targets.json
node scripts/orc-hive-feedback-delivery.mjs --help > docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/help_output.txt

node scripts/orc-hive-feedback-delivery.mjs deliver \
  --messages docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_hive_payloads.json \
  --targets docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_targets.json \
  --out docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs \
  --mode mock \
  --generated-by grashnuk \
  > docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/run_output.json

jq empty docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/run_output.json docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/delivery_report.json docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/sent_messages.json docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/failed_messages.json

git diff --check -- scripts/orc-hive-feedback-delivery.mjs docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3
```

## Run result

```json
{
  "totalAttempts": 5,
  "sent": 2,
  "failed": 3,
  "byError": {
    "mock_endpoint_rejected": 1,
    "conversation_missing": 1,
    "target_not_found": 1
  }
}
```

Successful mock message IDs:

```json
[
  "mock_hivemsg_30c20e51b1d2e4199c2e",
  "mock_hivemsg_70694f86a01579e006d6"
]
```

Failure cases captured:

- `mock_endpoint_rejected`: contributor has paused automated follow-ups.
- `conversation_missing`: target exists but has no Hive conversation ID.
- `target_not_found`: no account/wallet mapping exists for the payload recipient.

## Sample conversation targets

```md
- task_mock_reward_visibility: gmoney -> account_acct_oauth_31a2b120878c91e24add9ceb_hive (sent)
- task_mock_parser: zoz -> account_acct_oauth_8b6a2004c07fe8d96493d95f_hive (sent)
- task_mock_context_sync: donravle -> account_acct_oauth_donravle_mock_hive (failed)
```

## Source File: scripts/orc-hive-feedback-delivery.mjs

```js
#!/usr/bin/env node

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DELIVERY_SCHEMA = "pf.orc.hive_feedback_delivery.v1";

function usage() {
  return `Usage:
  node scripts/orc-hive-feedback-delivery.mjs deliver --messages <hive_payloads.json> --targets <targets.json> --out <dir> [--mode mock] [--generated-by <handle>]

Reads contributor feedback Hive Chat payloads, resolves target conversations from account IDs or wallet addresses, and records delivery outcomes.

Modes:
  mock  Uses the local mock endpoint defined by targets.json. This is the default and does not call live Hive Chat.

The script does not sign transactions, move funds, apply enforcement, or send live Hive messages in mock mode.`;
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
    options[key] = next;
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
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stableHash(...parts) {
  return crypto.createHash("sha256").update(parts.map((part) => safeText(part)).join("|")).digest("hex").slice(0, 20);
}

async function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizeMessages(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.hiveChatPayloads)) return raw.hiveChatPayloads;
  if (Array.isArray(raw.messages)) return raw.messages;
  throw new Error("Messages JSON must be an array or contain hiveChatPayloads[]/messages[]");
}

function normalizeTargets(raw) {
  const contributors = asArray(raw.contributors || raw.targets);
  const byAccount = new Map();
  const byWallet = new Map();
  for (const contributor of contributors) {
    const accountId = safeText(contributor.accountId);
    const walletAddress = safeText(contributor.walletAddress);
    const target = {
      accountId,
      walletAddress,
      handle: safeText(contributor.handle),
      conversationId: safeText(contributor.conversationId),
      conversationTitle: safeText(contributor.conversationTitle, "Task review follow-up"),
      mockStatus: safeText(contributor.mockStatus, "sent"),
      mockError: safeText(contributor.mockError),
    };
    if (accountId) byAccount.set(accountId, target);
    if (walletAddress) byWallet.set(walletAddress, target);
  }
  return { byAccount, byWallet, contributors };
}

function recipientWalletFromMessage(message) {
  return safeText(
    message.recipientWalletAddress ||
      message.walletAddress ||
      message.metadata?.recipientWalletAddress ||
      message.metadata?.walletAddress
  );
}

function resolveTarget(message, targets) {
  const accountId = safeText(message.recipientAccountId || message.metadata?.recipientAccountId);
  const walletAddress = recipientWalletFromMessage(message);
  if (accountId && targets.byAccount.has(accountId)) {
    return { resolution: "account_id", target: targets.byAccount.get(accountId) };
  }
  if (walletAddress && targets.byWallet.has(walletAddress)) {
    return { resolution: "wallet_address", target: targets.byWallet.get(walletAddress) };
  }
  return {
    resolution: "unresolved",
    target: null,
    error: accountId || walletAddress
      ? `No target conversation found for account ${accountId || "(none)"} wallet ${walletAddress || "(none)"}`
      : "Message has no recipientAccountId or wallet address",
  };
}

function buildMockSentResult(message, target, generatedAt) {
  const sourceTaskId = safeText(message.metadata?.sourceTaskId, "unknown_task");
  const sourceReviewId = safeText(message.metadata?.sourceReviewId, "unknown_review");
  const messageId = `mock_hivemsg_${stableHash(target.accountId, target.walletAddress, sourceReviewId, generatedAt)}`;
  return {
    status: "sent",
    messageId,
    deliveredAt: generatedAt,
    conversationId: target.conversationId,
    conversationTitle: target.conversationTitle,
    bodyPreview: safeText(message.messageBody).slice(0, 240),
    sourceTaskId,
    sourceReviewId,
  };
}

function attemptDelivery(message, index, targets, generatedAt) {
  const { resolution, target, error } = resolveTarget(message, targets);
  const base = {
    index: index + 1,
    recipientAccountId: safeText(message.recipientAccountId || message.metadata?.recipientAccountId),
    recipientWalletAddress: recipientWalletFromMessage(message),
    resolution,
    target: target
      ? {
        accountId: target.accountId,
        walletAddress: target.walletAddress,
        handle: target.handle,
        conversationId: target.conversationId,
      }
      : {},
    sourceTaskId: safeText(message.metadata?.sourceTaskId),
    sourceReviewId: safeText(message.metadata?.sourceReviewId),
  };
  if (!target) {
    return {
      ...base,
      status: "failed",
      errorCode: "target_not_found",
      error,
    };
  }
  if (!target.conversationId) {
    return {
      ...base,
      status: "failed",
      errorCode: "conversation_missing",
      error: "Target exists but has no Hive conversation id",
    };
  }
  if (target.mockStatus === "failed") {
    return {
      ...base,
      status: "failed",
      errorCode: "mock_endpoint_rejected",
      error: target.mockError || "Mock endpoint rejected delivery",
    };
  }
  return {
    ...base,
    ...buildMockSentResult(message, target, generatedAt),
  };
}

function summarize(attempts) {
  const sent = attempts.filter((attempt) => attempt.status === "sent");
  const failed = attempts.filter((attempt) => attempt.status === "failed");
  const byError = {};
  for (const attempt of failed) {
    byError[attempt.errorCode] = (byError[attempt.errorCode] || 0) + 1;
  }
  return {
    totalAttempts: attempts.length,
    sent: sent.length,
    failed: failed.length,
    byError,
    conversationTargets: attempts
      .filter((attempt) => attempt.target?.conversationId)
      .map((attempt) => ({
        sourceTaskId: attempt.sourceTaskId,
        handle: attempt.target.handle,
        conversationId: attempt.target.conversationId,
        status: attempt.status,
      })),
  };
}

function discordSummary(report) {
  const lines = [
    "**Hive feedback delivery mock run**",
    `Generated by: @${report.generatedBy}`,
    `Mode: ${report.mode}`,
    `Attempts: ${report.summary.totalAttempts}`,
    `Sent: ${report.summary.sent}`,
    `Failed: ${report.summary.failed}`,
    "",
    "**Sample conversation targets**",
  ];
  for (const target of report.summary.conversationTargets.slice(0, 8)) {
    lines.push(`- ${target.sourceTaskId}: ${target.handle || "unknown"} -> ${target.conversationId} (${target.status})`);
  }
  if (report.summary.failed) {
    lines.push("", "**Failures**");
    for (const attempt of report.attempts.filter((entry) => entry.status === "failed")) {
      lines.push(`- ${attempt.sourceTaskId || `attempt ${attempt.index}`}: ${attempt.errorCode} - ${attempt.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function deliver(options) {
  const messagePath = requireOption(options, "messages");
  const targetPath = requireOption(options, "targets");
  const outDir = requireOption(options, "out");
  const generatedBy = safeText(options["generated-by"], "grashnuk").replace(/^@/, "");
  const mode = safeText(options.mode, "mock").toLowerCase();
  if (mode !== "mock") throw new Error("Only --mode mock is implemented; live Hive Chat delivery requires a separate safety review.");

  const messages = normalizeMessages(await readJson(messagePath));
  const targets = normalizeTargets(await readJson(targetPath));
  const generatedAt = new Date().toISOString();
  const attempts = messages.map((message, index) => attemptDelivery(message, index, targets, generatedAt));
  const report = {
    ok: true,
    schema: DELIVERY_SCHEMA,
    generatedAt,
    generatedBy,
    mode,
    mockEndpoint: {
      name: "local_hive_chat_delivery_mock_v1",
      behavior: "targets with mockStatus=failed reject; missing route or conversation id fails; all other resolved targets return mock_hivemsg_* ids",
    },
    inputs: {
      messages: messagePath,
      targets: targetPath,
    },
    summary: summarize(attempts),
    attempts,
  };

  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "delivery_report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "sent_messages.json"), `${JSON.stringify(attempts.filter((entry) => entry.status === "sent"), null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "failed_messages.json"), `${JSON.stringify(attempts.filter((entry) => entry.status === "failed"), null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "discord_execution_summary.md"), discordSummary(report), "utf8");
  return {
    ok: true,
    schema: DELIVERY_SCHEMA,
    mode,
    outputDir: outDir,
    reportPath,
    ...report.summary,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command !== "deliver") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await deliver(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
```

## Sample Hive Payloads

```json
[
  {
    "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
    "messageBody": "@gmoney - I am following up on reviewed Network Task task_mock_reward_visibility.\nReview status: verified.\nScore: 90/100.\nFlags: none.\nNext action: No contributor action required.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_delivery_001",
      "sourceTaskId": "task_mock_reward_visibility",
      "reviewStatus": "verified",
      "score": 90,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "requiresContributorAction": false
    }
  },
  {
    "recipientWalletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
    "messageBody": "@zoz - I am following up on reviewed Network Task task_mock_parser.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Provide source and output artifacts.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_delivery_002",
      "sourceTaskId": "task_mock_parser",
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
    "recipientAccountId": "acct_oauth_donravle_mock",
    "messageBody": "@donravle - I am following up on reviewed Network Task task_mock_context_sync.\nReview status: verified.\nScore: 82/100.\nFlags: none.\nNext action: Product team can use the report as backlog evidence.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_delivery_003",
      "sourceTaskId": "task_mock_context_sync",
      "reviewStatus": "verified",
      "score": 82,
      "reviewFlags": [],
      "archiveAction": "archive_hot",
      "requiresContributorAction": false
    }
  },
  {
    "recipientAccountId": "acct_oauth_missing_conversation",
    "messageBody": "@boscovich - I am following up on reviewed Network Task task_mock_wallet_visibility.\nReview status: self-attested.\nScore: 71/100.\nFlags: self_attested_evidence.\nNext action: Provide independently inspectable artifacts.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_delivery_004",
      "sourceTaskId": "task_mock_wallet_visibility",
      "reviewStatus": "self_attested",
      "score": 71,
      "reviewFlags": [
        "self_attested_evidence"
      ],
      "archiveAction": "hold",
      "requiresContributorAction": true
    }
  },
  {
    "recipientAccountId": "acct_oauth_unmapped_mock",
    "messageBody": "@unknown - I am following up on reviewed Network Task task_mock_unmapped.\nReview status: unverified.\nScore: 55/100.\nFlags: missing_public_artifact.\nNext action: Provide missing evidence.",
    "metadata": {
      "schema": "pf.orc.contributor_feedback_messages.v1",
      "deliverySurface": "hive_chat",
      "generatedBy": "grashnuk",
      "sourceReviewId": "swrev_delivery_005",
      "sourceTaskId": "task_mock_unmapped",
      "reviewStatus": "unverified",
      "score": 55,
      "reviewFlags": [
        "missing_public_artifact"
      ],
      "archiveAction": "needs_followup",
      "requiresContributorAction": true
    }
  }
]
```

## Sample Targets

```json
{
  "schema": "pf.orc.hive_feedback_delivery_targets.v1",
  "contributors": [
    {
      "accountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "walletAddress": "rKTbxK4DRZii5hFmvqJ5z5nxvD6uYCgot3",
      "handle": "gmoney",
      "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive",
      "conversationTitle": "Hive follow-up: gmoney",
      "mockStatus": "sent"
    },
    {
      "accountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "walletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
      "handle": "zoz",
      "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive",
      "conversationTitle": "Hive follow-up: zoz",
      "mockStatus": "sent"
    },
    {
      "accountId": "acct_oauth_donravle_mock",
      "walletAddress": "raL2kvMockDonravleWalletFGwzd",
      "handle": "donravle",
      "conversationId": "account_acct_oauth_donravle_mock_hive",
      "conversationTitle": "Hive follow-up: donravle",
      "mockStatus": "failed",
      "mockError": "Mock endpoint rejected delivery because contributor has paused automated follow-ups."
    },
    {
      "accountId": "acct_oauth_missing_conversation",
      "walletAddress": "rDT8rfMockBoscovichWalletQCBi",
      "handle": "boscovich",
      "conversationId": "",
      "conversationTitle": "Hive follow-up: boscovich",
      "mockStatus": "sent"
    }
  ]
}
```

## Run Output

```json
{
  "ok": true,
  "schema": "pf.orc.hive_feedback_delivery.v1",
  "mode": "mock",
  "outputDir": "docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs",
  "reportPath": "docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/outputs/delivery_report.json",
  "totalAttempts": 5,
  "sent": 2,
  "failed": 3,
  "byError": {
    "mock_endpoint_rejected": 1,
    "conversation_missing": 1,
    "target_not_found": 1
  },
  "conversationTargets": [
    {
      "sourceTaskId": "task_mock_reward_visibility",
      "handle": "gmoney",
      "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive",
      "status": "sent"
    },
    {
      "sourceTaskId": "task_mock_parser",
      "handle": "zoz",
      "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive",
      "status": "sent"
    },
    {
      "sourceTaskId": "task_mock_context_sync",
      "handle": "donravle",
      "conversationId": "account_acct_oauth_donravle_mock_hive",
      "status": "failed"
    }
  ]
}
```

## Delivery Report

```json
{
  "ok": true,
  "schema": "pf.orc.hive_feedback_delivery.v1",
  "generatedAt": "2026-06-20T02:17:27.296Z",
  "generatedBy": "grashnuk",
  "mode": "mock",
  "mockEndpoint": {
    "name": "local_hive_chat_delivery_mock_v1",
    "behavior": "targets with mockStatus=failed reject; missing route or conversation id fails; all other resolved targets return mock_hivemsg_* ids"
  },
  "inputs": {
    "messages": "docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_hive_payloads.json",
    "targets": "docs/verification/hive_feedback_delivery_task_ba94fcab664c5cd1e225ab2e53ec27a3/sample_targets.json"
  },
  "summary": {
    "totalAttempts": 5,
    "sent": 2,
    "failed": 3,
    "byError": {
      "mock_endpoint_rejected": 1,
      "conversation_missing": 1,
      "target_not_found": 1
    },
    "conversationTargets": [
      {
        "sourceTaskId": "task_mock_reward_visibility",
        "handle": "gmoney",
        "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive",
        "status": "sent"
      },
      {
        "sourceTaskId": "task_mock_parser",
        "handle": "zoz",
        "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive",
        "status": "sent"
      },
      {
        "sourceTaskId": "task_mock_context_sync",
        "handle": "donravle",
        "conversationId": "account_acct_oauth_donravle_mock_hive",
        "status": "failed"
      }
    ]
  },
  "attempts": [
    {
      "index": 1,
      "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "recipientWalletAddress": "",
      "resolution": "account_id",
      "target": {
        "accountId": "acct_oauth_31a2b120878c91e24add9ceb",
        "walletAddress": "rKTbxK4DRZii5hFmvqJ5z5nxvD6uYCgot3",
        "handle": "gmoney",
        "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive"
      },
      "sourceTaskId": "task_mock_reward_visibility",
      "sourceReviewId": "swrev_delivery_001",
      "status": "sent",
      "messageId": "mock_hivemsg_30c20e51b1d2e4199c2e",
      "deliveredAt": "2026-06-20T02:17:27.296Z",
      "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive",
      "conversationTitle": "Hive follow-up: gmoney",
      "bodyPreview": "@gmoney - I am following up on reviewed Network Task task_mock_reward_visibility.\nReview status: verified.\nScore: 90/100.\nFlags: none.\nNext action: No contributor action required."
    },
    {
      "index": 2,
      "recipientAccountId": "",
      "recipientWalletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
      "resolution": "wallet_address",
      "target": {
        "accountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
        "walletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
        "handle": "zoz",
        "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive"
      },
      "sourceTaskId": "task_mock_parser",
      "sourceReviewId": "swrev_delivery_002",
      "status": "sent",
      "messageId": "mock_hivemsg_70694f86a01579e006d6",
      "deliveredAt": "2026-06-20T02:17:27.296Z",
      "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive",
      "conversationTitle": "Hive follow-up: zoz",
      "bodyPreview": "@zoz - I am following up on reviewed Network Task task_mock_parser.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Provide source and output artifacts."
    },
    {
      "index": 3,
      "recipientAccountId": "acct_oauth_donravle_mock",
      "recipientWalletAddress": "",
      "resolution": "account_id",
      "target": {
        "accountId": "acct_oauth_donravle_mock",
        "walletAddress": "raL2kvMockDonravleWalletFGwzd",
        "handle": "donravle",
        "conversationId": "account_acct_oauth_donravle_mock_hive"
      },
      "sourceTaskId": "task_mock_context_sync",
      "sourceReviewId": "swrev_delivery_003",
      "status": "failed",
      "errorCode": "mock_endpoint_rejected",
      "error": "Mock endpoint rejected delivery because contributor has paused automated follow-ups."
    },
    {
      "index": 4,
      "recipientAccountId": "acct_oauth_missing_conversation",
      "recipientWalletAddress": "",
      "resolution": "account_id",
      "target": {
        "accountId": "acct_oauth_missing_conversation",
        "walletAddress": "rDT8rfMockBoscovichWalletQCBi",
        "handle": "boscovich",
        "conversationId": ""
      },
      "sourceTaskId": "task_mock_wallet_visibility",
      "sourceReviewId": "swrev_delivery_004",
      "status": "failed",
      "errorCode": "conversation_missing",
      "error": "Target exists but has no Hive conversation id"
    },
    {
      "index": 5,
      "recipientAccountId": "acct_oauth_unmapped_mock",
      "recipientWalletAddress": "",
      "resolution": "unresolved",
      "target": {},
      "sourceTaskId": "task_mock_unmapped",
      "sourceReviewId": "swrev_delivery_005",
      "status": "failed",
      "errorCode": "target_not_found",
      "error": "No target conversation found for account acct_oauth_unmapped_mock wallet (none)"
    }
  ]
}
```

## Sent Messages

```json
[
  {
    "index": 1,
    "recipientAccountId": "acct_oauth_31a2b120878c91e24add9ceb",
    "recipientWalletAddress": "",
    "resolution": "account_id",
    "target": {
      "accountId": "acct_oauth_31a2b120878c91e24add9ceb",
      "walletAddress": "rKTbxK4DRZii5hFmvqJ5z5nxvD6uYCgot3",
      "handle": "gmoney",
      "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive"
    },
    "sourceTaskId": "task_mock_reward_visibility",
    "sourceReviewId": "swrev_delivery_001",
    "status": "sent",
    "messageId": "mock_hivemsg_30c20e51b1d2e4199c2e",
    "deliveredAt": "2026-06-20T02:17:27.296Z",
    "conversationId": "account_acct_oauth_31a2b120878c91e24add9ceb_hive",
    "conversationTitle": "Hive follow-up: gmoney",
    "bodyPreview": "@gmoney - I am following up on reviewed Network Task task_mock_reward_visibility.\nReview status: verified.\nScore: 90/100.\nFlags: none.\nNext action: No contributor action required."
  },
  {
    "index": 2,
    "recipientAccountId": "",
    "recipientWalletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
    "resolution": "wallet_address",
    "target": {
      "accountId": "acct_oauth_8b6a2004c07fe8d96493d95f",
      "walletAddress": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
      "handle": "zoz",
      "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive"
    },
    "sourceTaskId": "task_mock_parser",
    "sourceReviewId": "swrev_delivery_002",
    "status": "sent",
    "messageId": "mock_hivemsg_70694f86a01579e006d6",
    "deliveredAt": "2026-06-20T02:17:27.296Z",
    "conversationId": "account_acct_oauth_8b6a2004c07fe8d96493d95f_hive",
    "conversationTitle": "Hive follow-up: zoz",
    "bodyPreview": "@zoz - I am following up on reviewed Network Task task_mock_parser.\nReview status: unverifiable.\nScore: 58/100.\nFlags: missing_public_artifact, pipeline_adjacent.\nNext action: Provide source and output artifacts."
  }
]
```

## Failed Messages

```json
[
  {
    "index": 3,
    "recipientAccountId": "acct_oauth_donravle_mock",
    "recipientWalletAddress": "",
    "resolution": "account_id",
    "target": {
      "accountId": "acct_oauth_donravle_mock",
      "walletAddress": "raL2kvMockDonravleWalletFGwzd",
      "handle": "donravle",
      "conversationId": "account_acct_oauth_donravle_mock_hive"
    },
    "sourceTaskId": "task_mock_context_sync",
    "sourceReviewId": "swrev_delivery_003",
    "status": "failed",
    "errorCode": "mock_endpoint_rejected",
    "error": "Mock endpoint rejected delivery because contributor has paused automated follow-ups."
  },
  {
    "index": 4,
    "recipientAccountId": "acct_oauth_missing_conversation",
    "recipientWalletAddress": "",
    "resolution": "account_id",
    "target": {
      "accountId": "acct_oauth_missing_conversation",
      "walletAddress": "rDT8rfMockBoscovichWalletQCBi",
      "handle": "boscovich",
      "conversationId": ""
    },
    "sourceTaskId": "task_mock_wallet_visibility",
    "sourceReviewId": "swrev_delivery_004",
    "status": "failed",
    "errorCode": "conversation_missing",
    "error": "Target exists but has no Hive conversation id"
  },
  {
    "index": 5,
    "recipientAccountId": "acct_oauth_unmapped_mock",
    "recipientWalletAddress": "",
    "resolution": "unresolved",
    "target": {},
    "sourceTaskId": "task_mock_unmapped",
    "sourceReviewId": "swrev_delivery_005",
    "status": "failed",
    "errorCode": "target_not_found",
    "error": "No target conversation found for account acct_oauth_unmapped_mock wallet (none)"
  }
]
```

## Discord Execution Summary

```md
**Hive feedback delivery mock run**
Generated by: @grashnuk
Mode: mock
Attempts: 5
Sent: 2
Failed: 3

**Sample conversation targets**
- task_mock_reward_visibility: gmoney -> account_acct_oauth_31a2b120878c91e24add9ceb_hive (sent)
- task_mock_parser: zoz -> account_acct_oauth_8b6a2004c07fe8d96493d95f_hive (sent)
- task_mock_context_sync: donravle -> account_acct_oauth_donravle_mock_hive (failed)

**Failures**
- task_mock_context_sync: mock_endpoint_rejected - Mock endpoint rejected delivery because contributor has paused automated follow-ups.
- task_mock_wallet_visibility: conversation_missing - Target exists but has no Hive conversation id
- task_mock_unmapped: target_not_found - No target conversation found for account acct_oauth_unmapped_mock wallet (none)
```

## Help Output

```text
Usage:
  node scripts/orc-hive-feedback-delivery.mjs deliver --messages <hive_payloads.json> --targets <targets.json> --out <dir> [--mode mock] [--generated-by <handle>]

Reads contributor feedback Hive Chat payloads, resolves target conversations from account IDs or wallet addresses, and records delivery outcomes.

Modes:
  mock  Uses the local mock endpoint defined by targets.json. This is the default and does not call live Hive Chat.

The script does not sign transactions, move funds, apply enforcement, or send live Hive messages in mock mode.
```
