#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPAIR_SCHEMA = "pf.orc.hive_delivery_repair.v1";

function usage() {
  return `Usage:
  node scripts/orc-hive-delivery-repair.mjs repair --diagnostics <delivery_log.json> --repair-fixture <fixture.json> --out <dir> [--generated-by grashnuk] [--generated-at ISO]

Reads verified Orc messaging diagnostics, identifies the Hive Chat delivery failure point, and applies a mock repair/fallback plan.

Repair behavior:
  - Successful records are carried forward unchanged.
  - Non-retrieval failures are preserved with their original failure stage.
  - message_retrieval failures first use a conversation-scan fallback to verify a posted message by conversation transcript.
  - If conversation scan cannot prove visibility, an optional idempotent repost fallback can post and verify a replacement message.

This script writes repair_report.json and discord_summary.md. Mock mode only: it does not send live Hive messages, sign transactions, move funds, or mutate user state.`;
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
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeRecords(raw) {
  const records = Array.isArray(raw) ? raw : raw.records || raw.deliveryRecords || raw.attempts;
  if (!Array.isArray(records)) {
    throw new Error("Diagnostics JSON must be an array or contain records[]/deliveryRecords[]/attempts[]");
  }
  return records.map((record, index) => ({
    index: index + 1,
    messageId: safeText(record.messageId || record.id || `record_${index + 1}`, 180),
    sourceTaskId: safeText(record.sourceTaskId, 180),
    sourceReviewId: safeText(record.sourceReviewId, 180),
    target: record.target && typeof record.target === "object" ? record.target : {},
    finalStatus: safeText(record.finalStatus || record.status, 80),
    failureStage: safeText(record.failureStage || "none", 120),
    failureCode: safeText(record.failureCode, 180),
    error: safeText(record.error, 600),
    postedMessageId: safeText(record.postedMessageId || record.sentMessageId, 180),
    postAttempts: asArray(record.postAttempts),
    retrieval: record.retrieval && typeof record.retrieval === "object" ? record.retrieval : {},
    verification: record.verification && typeof record.verification === "object" ? record.verification : {},
    diagnostics: record.diagnostics && typeof record.diagnostics === "object" ? record.diagnostics : {},
  }));
}

function normalizeFixture(raw) {
  const repairs = asArray(raw.repairs || raw.scenarios);
  const byMessageId = new Map();
  for (const repair of repairs) {
    const messageId = safeText(repair.messageId, 180);
    if (!messageId) continue;
    byMessageId.set(messageId, {
      messageId,
      rootCause: safeText(repair.rootCause || "direct_message_retrieval_unavailable_after_successful_post", 300),
      repairMethod: safeText(repair.repairMethod || "conversation_scan_fallback", 120),
      conversationScan: repair.conversationScan && typeof repair.conversationScan === "object" ? repair.conversationScan : {},
      fallbackPost:
        repair.fallbackPost && typeof repair.fallbackPost === "object"
          ? repair.fallbackPost
          : repair.idempotentRepost && typeof repair.idempotentRepost === "object"
            ? repair.idempotentRepost
            : {},
    });
  }
  return { byMessageId };
}

function latestPostAttempt(record) {
  const attempts = asArray(record.postAttempts);
  return attempts[attempts.length - 1] || {};
}

function inspectFailure(record) {
  const post = latestPostAttempt(record);
  const retrieval = record.retrieval || {};
  if (record.failureStage === "message_retrieval") {
    return {
      failingApiStep: "message_retrieval",
      observedPattern: "post_success_then_direct_read_missing",
      postHttpStatus: safeNumber(post.httpStatus, null),
      retrievalHttpStatus: safeNumber(retrieval.httpStatus, null),
      retrievalFailureCode: safeText(retrieval.failureCode || record.failureCode, 180),
      retrievalError: safeText(retrieval.error || record.error, 600),
      rootCause:
        safeNumber(post.httpStatus, 0) >= 200 && safeNumber(post.httpStatus, 0) < 300 && safeNumber(retrieval.httpStatus, 0) === 404
          ? "direct_message_retrieval_read_path_missing_index_after_successful_post"
          : "direct_message_retrieval_failed_after_post",
    };
  }
  return {
    failingApiStep: record.failureStage || "none",
    observedPattern: record.finalStatus === "delivered_verified" ? "already_verified" : "not_repaired_by_this_tool",
    postHttpStatus: safeNumber(post.httpStatus, null),
    retrievalHttpStatus: retrieval.httpStatus === undefined ? null : safeNumber(retrieval.httpStatus, null),
    retrievalFailureCode: safeText(retrieval.failureCode || record.failureCode, 180),
    retrievalError: safeText(retrieval.error || record.error, 600),
    rootCause: record.finalStatus === "delivered_verified" ? "none" : "outside_retrieval_repair_scope",
  };
}

function conversationScanRepair({ record, repair }) {
  const scan = repair.conversationScan || {};
  const messages = asArray(scan.messages);
  const matching = messages.find((message) => {
    const id = safeText(message.id || message.messageId, 180);
    return id && id === record.postedMessageId && message.visible !== false;
  });
  const httpStatus = safeNumber(scan.httpStatus, messages.length ? 200 : 404);
  const ok = httpStatus >= 200 && httpStatus < 300 && Boolean(matching);
  return {
    ok,
    method: "conversation_scan_fallback",
    httpStatus,
    durationMs: safeNumber(scan.durationMs, 12),
    matchedMessageId: matching ? safeText(matching.id || matching.messageId, 180) : "",
    error: ok ? "" : safeText(scan.error || "conversation scan did not find the posted message", 500),
    response: {
      scannedMessageCount: messages.length,
      visibleMatch: Boolean(matching),
      conversationId: safeText(scan.conversationId || record.target?.conversationId, 180),
    },
  };
}

function idempotentRepostRepair({ record, repair }) {
  const fallback = repair.fallbackPost || {};
  const attempts = asArray(fallback.postAttempts || fallback.attempts);
  if (!attempts.length) {
    return {
      ok: false,
      method: "idempotent_repost",
      attempted: false,
      attempts: [],
      retrieval: {},
      verification: { ok: false, visible: false },
      error: "no idempotent repost fallback configured",
    };
  }

  const normalizedAttempts = [];
  let sentMessageId = "";
  for (const [index, attempt] of attempts.entries()) {
    const httpStatus = safeNumber(attempt.httpStatus, 500);
    const ok = attempt.ok !== false && httpStatus >= 200 && httpStatus < 300;
    const response = attempt.response && typeof attempt.response === "object" ? attempt.response : {};
    normalizedAttempts.push({
      attempt: index + 1,
      ok,
      httpStatus,
      durationMs: safeNumber(attempt.durationMs, ok ? 20 : 30),
      idempotencyKey: safeText(attempt.idempotencyKey || fallback.idempotencyKey, 180),
      response,
      error: ok ? "" : safeText(attempt.error || response.error || "idempotent repost failed", 500),
    });
    if (ok) {
      sentMessageId = safeText(response.messageId || fallback.messageId, 180);
      break;
    }
  }
  const retrieval = fallback.retrieval && typeof fallback.retrieval === "object" ? fallback.retrieval : {};
  const retrievalStatus = safeNumber(retrieval.httpStatus, sentMessageId ? 200 : 404);
  const retrievedMessageId = safeText(retrieval.response?.messageId || retrieval.response?.id || sentMessageId, 180);
  const visible = retrieval.visible !== false && retrieval.response?.visible !== false;
  const ok = Boolean(sentMessageId) && retrievalStatus >= 200 && retrievalStatus < 300 && retrievedMessageId === sentMessageId && visible;
  return {
    ok,
    method: "idempotent_repost",
    attempted: true,
    attempts: normalizedAttempts,
    retrieval: {
      ok: retrievalStatus >= 200 && retrievalStatus < 300,
      httpStatus: retrievalStatus,
      durationMs: safeNumber(retrieval.durationMs, 10),
      response: {
        messageId: retrievedMessageId,
        visible,
      },
      error: ok ? "" : safeText(retrieval.error || "idempotent repost was not visible after retrieval", 500),
    },
    verification: {
      ok,
      visible: ok,
      expectedMessageId: sentMessageId,
      retrievedMessageId,
    },
    error: ok ? "" : "idempotent repost fallback did not verify visibility",
  };
}

function repairRecord(record, fixture) {
  const inspection = inspectFailure(record);
  const base = {
    messageId: record.messageId,
    sourceTaskId: record.sourceTaskId,
    sourceReviewId: record.sourceReviewId,
    target: record.target,
    before: {
      finalStatus: record.finalStatus,
      failureStage: record.failureStage,
      failureCode: record.failureCode,
      error: record.error,
      postedMessageId: record.postedMessageId,
      postHttpStatus: inspection.postHttpStatus,
      retrievalHttpStatus: inspection.retrievalHttpStatus,
    },
    inspection,
  };

  if (record.finalStatus === "delivered_verified" || record.failureStage === "none") {
    return {
      ...base,
      repairStatus: "not_needed",
      repairMethod: "none",
      after: {
        finalStatus: "delivered_verified",
        failureStage: "none",
        verification: { ok: true, visible: true },
      },
    };
  }

  if (record.failureStage !== "message_retrieval") {
    return {
      ...base,
      repairStatus: "not_applicable",
      repairMethod: "none",
      after: {
        finalStatus: "failed",
        failureStage: record.failureStage,
        failureCode: record.failureCode,
        error: record.error,
        verification: { ok: false, visible: false },
      },
    };
  }

  const repair = fixture.byMessageId.get(record.messageId);
  if (!repair) {
    return {
      ...base,
      repairStatus: "unconfigured",
      repairMethod: "none",
      after: {
        finalStatus: "failed",
        failureStage: "message_retrieval",
        failureCode: "repair_plan_missing",
        error: "No repair fixture was provided for this retrieval failure",
        verification: { ok: false, visible: false },
      },
    };
  }

  const scan = conversationScanRepair({ record, repair });
  if (scan.ok) {
    return {
      ...base,
      repairStatus: "repaired",
      repairMethod: scan.method,
      rootCause: repair.rootCause || inspection.rootCause,
      fixApplied:
        "Direct message retrieval returned a missing-read result after a successful post, so the repair verifies delivery through the conversation transcript read path.",
      conversationScan: scan,
      after: {
        finalStatus: "delivered_verified",
        failureStage: "none",
        postedMessageId: record.postedMessageId,
        verification: {
          ok: true,
          visible: true,
          method: scan.method,
          matchedMessageId: scan.matchedMessageId,
        },
      },
    };
  }

  const repost = idempotentRepostRepair({ record, repair });
  if (repost.ok) {
    return {
      ...base,
      repairStatus: "repaired",
      repairMethod: repost.method,
      rootCause: repair.rootCause || inspection.rootCause,
      fixApplied:
        "Conversation scan could not prove visibility, so the repair uses an idempotent repost with a stable key and verifies the replacement message.",
      conversationScan: scan,
      idempotentRepost: repost,
      after: {
        finalStatus: "delivered_verified",
        failureStage: "none",
        postedMessageId: repost.verification.expectedMessageId,
        verification: {
          ok: true,
          visible: true,
          method: repost.method,
          matchedMessageId: repost.verification.retrievedMessageId,
        },
      },
    };
  }

  return {
    ...base,
    repairStatus: "repair_failed",
    repairMethod: "conversation_scan_then_idempotent_repost",
    rootCause: repair.rootCause || inspection.rootCause,
    conversationScan: scan,
    idempotentRepost: repost,
    after: {
      finalStatus: "failed",
      failureStage: "message_retrieval",
      failureCode: "repair_failed",
      error: scan.error || repost.error,
      verification: { ok: false, visible: false },
    },
  };
}

function summarizeBefore(records) {
  const byFailureStage = {};
  let deliveredVerified = 0;
  for (const record of records) {
    if (record.finalStatus === "delivered_verified" || record.failureStage === "none") {
      deliveredVerified += 1;
    }
    const stage = record.failureStage || "none";
    byFailureStage[stage] = (byFailureStage[stage] || 0) + 1;
  }
  return {
    totalMessages: records.length,
    deliveredVerified,
    failed: records.length - deliveredVerified,
    byFailureStage,
  };
}

function summarizeAfter(repairedRecords) {
  const byFailureStage = {};
  const byRepairStatus = {};
  const byRepairMethod = {};
  let deliveredVerified = 0;
  for (const record of repairedRecords) {
    if (record.after?.finalStatus === "delivered_verified") deliveredVerified += 1;
    const stage = record.after?.failureStage || "none";
    byFailureStage[stage] = (byFailureStage[stage] || 0) + 1;
    byRepairStatus[record.repairStatus] = (byRepairStatus[record.repairStatus] || 0) + 1;
    byRepairMethod[record.repairMethod] = (byRepairMethod[record.repairMethod] || 0) + 1;
  }
  return {
    totalMessages: repairedRecords.length,
    deliveredVerified,
    failed: repairedRecords.length - deliveredVerified,
    repaired: repairedRecords.filter((record) => record.repairStatus === "repaired").length,
    byFailureStage,
    byRepairStatus,
    byRepairMethod,
  };
}

function discordSummary(report) {
  const lines = [
    "**Hive Chat delivery failure repair run**",
    `Generated by: @${report.generatedBy}`,
    `Source diagnostics: ${report.inputs.diagnostics}`,
    `Before: ${report.before.deliveredVerified}/${report.before.totalMessages} delivered + verified; failures=${report.before.failed}`,
    `After: ${report.after.deliveredVerified}/${report.after.totalMessages} delivered + verified; failures=${report.after.failed}`,
    `Repaired retrieval failures: ${report.after.repaired}`,
    "",
    "**Failure point**",
    "- Root pattern: successful post followed by direct message retrieval failure, usually HTTP 404 / missing read-path index.",
    "- Repair: conversation transcript scan fallback; if still absent, idempotent repost fallback with verification.",
    "",
    "**Records**",
  ];
  for (const record of report.records) {
    const handle = record.target?.handle ? `@${record.target.handle}` : "unknown";
    const result =
      record.repairStatus === "repaired"
        ? `repaired via ${record.repairMethod}`
        : `${record.repairStatus}; stage=${record.after.failureStage}`;
    lines.push(`- ${handle} (${record.messageId}): ${result}`);
  }
  lines.push("", "Mock repair harness only; no live Hive messages, funds, bans, or user-state mutations were executed.");
  return `${lines.join("\n")}\n`;
}

async function repair(options) {
  const diagnosticsPath = requireOption(options, "diagnostics");
  const fixturePath = requireOption(options, "repair-fixture");
  const outDir = requireOption(options, "out");
  const generatedAt = safeText(options["generated-at"] || new Date().toISOString(), 80);
  const generatedBy = safeText(options["generated-by"] || "grashnuk", 80).replace(/^@/, "");
  const diagnostics = await readJson(diagnosticsPath);
  const fixture = normalizeFixture(await readJson(fixturePath));
  const records = normalizeRecords(diagnostics);
  const repairedRecords = records.map((record) => repairRecord(record, fixture));
  const report = {
    ok: true,
    schema: REPAIR_SCHEMA,
    generatedAt,
    generatedBy,
    mode: "mock",
    inputs: {
      diagnostics: diagnosticsPath,
      repairFixture: fixturePath,
    },
    before: summarizeBefore(records),
    after: summarizeAfter(repairedRecords),
    records: repairedRecords,
  };

  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "repair_report.json");
  const summaryPath = path.join(outDir, "discord_summary.md");
  await writeJson(reportPath, report);
  await writeFile(summaryPath, discordSummary(report), "utf8");
  return {
    ok: true,
    schema: REPAIR_SCHEMA,
    outputDir: outDir,
    reportPath,
    summaryPath,
    before: report.before,
    after: report.after,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command !== "repair") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await repair(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
