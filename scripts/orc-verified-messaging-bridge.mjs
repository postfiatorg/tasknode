#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DELIVERY_SCHEMA = "pf.orc.verified_hive_messaging_bridge.v1";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

function usage() {
  return `Usage:
  node scripts/orc-verified-messaging-bridge.mjs deliver --messages <messages.json> --contributors <contributors.json> --out <dir> [--mode mock] [--generated-by grashnuk] [--generated-at ISO] [--max-attempts 3] [--base-delay-ms 250] [--diagnostic]

Resolves Hive contributors by account id or wallet, posts a Hive Chat message through the selected transport, re-fetches the posted message, and writes a structured delivery log.

Modes:
  mock  Uses the local contributor fixture as the Hive Chat transport. This is the default and does not call live Hive Chat.

The mock transport records conversation lookup, post, retry, retrieval, and verification stages. It does not sign transactions, move funds, apply enforcement, ban users, or send live messages. Live Hive Chat sending must be wired through a separately reviewed connector.`;
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

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stableHash(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => safeText(part)).join("|"))
    .digest("hex")
    .slice(0, 20);
}

async function readJson(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeMessages(raw) {
  const messages = Array.isArray(raw) ? raw : raw.messages || raw.hiveMessages || raw.hiveChatMessages;
  if (!Array.isArray(messages)) {
    throw new Error("Messages JSON must be an array or contain messages[]/hiveMessages[]/hiveChatMessages[]");
  }
  return messages.map((message, index) => ({
    id: safeText(message.id || message.messageId || `message_${index + 1}`, 160),
    body: safeText(message.body || message.messageBody || message.text, 8000),
    recipientAccountId: safeText(message.recipientAccountId || message.accountId || message.metadata?.accountId, 180),
    recipientWalletAddress: safeText(
      message.recipientWalletAddress || message.walletAddress || message.metadata?.walletAddress,
      180
    ),
    metadata: message.metadata && typeof message.metadata === "object" ? message.metadata : {},
  }));
}

function normalizeContributors(raw) {
  const contributors = asArray(raw.contributors || raw.targets);
  const byAccount = new Map();
  const byWallet = new Map();
  for (const contributor of contributors) {
    const normalized = {
      id: safeText(contributor.id || contributor.handle || contributor.accountId || contributor.walletAddress, 180),
      handle: safeText(contributor.handle, 80).replace(/^@/, ""),
      accountId: safeText(contributor.accountId, 180),
      walletAddress: safeText(contributor.walletAddress, 180),
      conversationId: safeText(contributor.conversationId, 180),
      conversationTitle: safeText(contributor.conversationTitle || "Orc follow-up", 240),
      lookup: contributor.lookup && typeof contributor.lookup === "object" ? contributor.lookup : {},
      postPlan: asArray(contributor.postPlan || contributor.postAttempts),
      retrieval: contributor.retrieval && typeof contributor.retrieval === "object" ? contributor.retrieval : {},
    };
    if (normalized.accountId) byAccount.set(normalized.accountId, normalized);
    if (normalized.walletAddress) byWallet.set(normalized.walletAddress, normalized);
  }
  return { contributors, byAccount, byWallet };
}

function resolveContributor(message, registry) {
  if (message.recipientAccountId && registry.byAccount.has(message.recipientAccountId)) {
    return {
      method: "account_id",
      contributor: registry.byAccount.get(message.recipientAccountId),
    };
  }
  if (message.recipientWalletAddress && registry.byWallet.has(message.recipientWalletAddress)) {
    return {
      method: "wallet_address",
      contributor: registry.byWallet.get(message.recipientWalletAddress),
    };
  }
  return {
    method: "unresolved",
    contributor: null,
  };
}

function lookupConversation({ message, contributor, method }) {
  if (!contributor) {
    return {
      ok: false,
      method,
      httpStatus: null,
      durationMs: 0,
      failureCode: "contributor_not_found",
      error: `No contributor matched account ${message.recipientAccountId || "(none)"} wallet ${
        message.recipientWalletAddress || "(none)"
      }`,
    };
  }

  const lookup = contributor.lookup || {};
  const httpStatus = safeNumber(lookup.httpStatus, contributor.conversationId ? 200 : 404);
  const durationMs = safeNumber(lookup.durationMs, 8);
  if (lookup.ok === false || httpStatus >= 400) {
    return {
      ok: false,
      method,
      httpStatus,
      durationMs,
      failureCode: lookup.failureCode || "conversation_lookup_http_error",
      error: safeText(lookup.error || lookup.response?.error || "Hive conversation lookup failed", 500),
      target: contributorSummary(contributor),
      response: lookup.response || {},
    };
  }
  if (!contributor.conversationId) {
    return {
      ok: false,
      method,
      httpStatus: 404,
      durationMs,
      failureCode: "conversation_not_found",
      error: "Contributor resolved, but no Hive conversation id was available",
      target: contributorSummary(contributor),
      response: lookup.response || {},
    };
  }
  return {
    ok: true,
    method,
    httpStatus,
    durationMs,
    conversationId: contributor.conversationId,
    conversationTitle: contributor.conversationTitle,
    target: contributorSummary(contributor),
    response: {
      conversationId: contributor.conversationId,
      handle: contributor.handle,
      source: lookup.source || method,
    },
  };
}

function contributorSummary(contributor) {
  if (!contributor) return {};
  return {
    id: contributor.id,
    handle: contributor.handle,
    accountId: contributor.accountId,
    walletAddress: contributor.walletAddress,
    conversationId: contributor.conversationId,
  };
}

function defaultMessageId({ message, contributor, generatedAt }) {
  return `mock_hivemsg_${stableHash(message.id, contributor.accountId, contributor.walletAddress, generatedAt)}`;
}

function postAttemptFromPlan({ planEntry, message, contributor, generatedAt }) {
  const httpStatus = safeNumber(planEntry.httpStatus, 201);
  const ok = planEntry.ok !== false && httpStatus >= 200 && httpStatus < 300;
  const response = planEntry.response && typeof planEntry.response === "object" ? { ...planEntry.response } : {};
  if (ok && !response.messageId) {
    response.messageId = defaultMessageId({ message, contributor, generatedAt });
  }
  return {
    ok,
    httpStatus,
    durationMs: safeNumber(planEntry.durationMs, ok ? 18 : 25),
    response,
    error: ok ? "" : safeText(planEntry.error || response.error || "Hive Chat post failed", 500),
  };
}

function postWithRetry({ message, contributor, generatedAt, maxAttempts, baseDelayMs }) {
  const plan = contributor.postPlan.length ? contributor.postPlan : [{ httpStatus: 201, ok: true }];
  const attempts = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    const planEntry = plan[Math.min(index, plan.length - 1)] || {};
    const attempt = postAttemptFromPlan({ planEntry, message, contributor, generatedAt });
    const attemptNumber = index + 1;
    const willRetry = !attempt.ok && attemptNumber < maxAttempts;
    attempts.push({
      attempt: attemptNumber,
      ok: attempt.ok,
      httpStatus: attempt.httpStatus,
      durationMs: attempt.durationMs,
      retryScheduled: willRetry,
      nextBackoffMs: willRetry ? baseDelayMs * 2 ** index : 0,
      response: attempt.response,
      error: attempt.error,
    });
    if (attempt.ok) {
      return {
        ok: true,
        messageId: safeText(attempt.response.messageId, 180),
        attempts,
      };
    }
  }
  const lastAttempt = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    messageId: "",
    attempts,
    failureCode: "message_post_failed",
    error: safeText(lastAttempt.error || "All Hive Chat post attempts failed", 500),
  };
}

function retrievePostedMessage({ messageId, message, contributor }) {
  const retrieval = contributor.retrieval || {};
  const httpStatus = safeNumber(retrieval.httpStatus, 200);
  const durationMs = safeNumber(retrieval.durationMs, 10);
  const ok = retrieval.ok !== false && httpStatus >= 200 && httpStatus < 300;
  if (!ok) {
    return {
      ok: false,
      httpStatus,
      durationMs,
      failureCode: retrieval.failureCode || "message_retrieval_failed",
      error: safeText(retrieval.error || retrieval.response?.error || "Posted message was not retrievable", 500),
      response: retrieval.response || {},
    };
  }
  const response = retrieval.response && typeof retrieval.response === "object" ? { ...retrieval.response } : {};
  const retrievedMessage = {
    id: safeText(response.messageId || response.id || messageId, 180),
    conversationId: safeText(response.conversationId || contributor.conversationId, 180),
    visible: response.visible !== false && retrieval.visible !== false,
    bodyPreview: safeText(response.bodyPreview || message.body, 240),
  };
  return {
    ok: true,
    httpStatus,
    durationMs,
    response: retrievedMessage,
  };
}

function verifyRetrievedMessage({ expectedMessageId, retrieval }) {
  if (!retrieval.ok) {
    return {
      ok: false,
      visible: false,
      failureCode: retrieval.failureCode,
      error: retrieval.error,
    };
  }
  const retrievedId = safeText(retrieval.response?.id, 180);
  const visible = retrieval.response?.visible === true;
  const ok = visible && retrievedId === expectedMessageId;
  return {
    ok,
    visible,
    expectedMessageId,
    retrievedMessageId: retrievedId,
    failureCode: ok ? "" : "message_not_visible_or_mismatched",
    error: ok ? "" : "Posted message was retrieved but did not match the expected visible message id",
  };
}

function processMessage({ message, registry, generatedAt, maxAttempts, baseDelayMs, diagnostic }) {
  const resolved = resolveContributor(message, registry);
  const conversationLookup = lookupConversation({
    message,
    contributor: resolved.contributor,
    method: resolved.method,
  });
  const base = {
    messageId: message.id,
    sourceTaskId: safeText(message.metadata?.sourceTaskId || message.sourceTaskId, 180),
    sourceReviewId: safeText(message.metadata?.sourceReviewId || message.sourceReviewId, 180),
    recipient: {
      accountId: message.recipientAccountId,
      walletAddress: message.recipientWalletAddress,
    },
    resolvedBy: resolved.method,
    target: contributorSummary(resolved.contributor),
    conversationLookup,
  };

  if (!conversationLookup.ok) {
    return {
      ...base,
      finalStatus: "failed",
      failureStage: "conversation_lookup",
      failureCode: conversationLookup.failureCode,
      error: conversationLookup.error,
      postAttempts: [],
      retrieval: {},
      verification: { ok: false, visible: false },
      diagnostics: diagnostic ? diagnosticsFor(base, "conversation_lookup") : undefined,
    };
  }

  const post = postWithRetry({
    message,
    contributor: resolved.contributor,
    generatedAt,
    maxAttempts,
    baseDelayMs,
  });
  if (!post.ok) {
    return {
      ...base,
      finalStatus: "failed",
      failureStage: "message_post",
      failureCode: post.failureCode,
      error: post.error,
      postAttempts: post.attempts,
      retrieval: {},
      verification: { ok: false, visible: false },
      diagnostics: diagnostic ? diagnosticsFor(base, "message_post") : undefined,
    };
  }

  const retrieval = retrievePostedMessage({
    messageId: post.messageId,
    message,
    contributor: resolved.contributor,
  });
  if (!retrieval.ok) {
    return {
      ...base,
      finalStatus: "failed",
      failureStage: "message_retrieval",
      failureCode: retrieval.failureCode,
      error: retrieval.error,
      postedMessageId: post.messageId,
      postAttempts: post.attempts,
      retrieval,
      verification: { ok: false, visible: false },
      diagnostics: diagnostic ? diagnosticsFor(base, "message_retrieval") : undefined,
    };
  }

  const verification = verifyRetrievedMessage({
    expectedMessageId: post.messageId,
    retrieval,
  });
  if (!verification.ok) {
    return {
      ...base,
      finalStatus: "failed",
      failureStage: "verification",
      failureCode: verification.failureCode,
      error: verification.error,
      postedMessageId: post.messageId,
      postAttempts: post.attempts,
      retrieval,
      verification,
      diagnostics: diagnostic ? diagnosticsFor(base, "verification") : undefined,
    };
  }

  return {
    ...base,
    finalStatus: "delivered_verified",
    failureStage: "none",
    failureCode: "",
    error: "",
    postedMessageId: post.messageId,
    postAttempts: post.attempts,
    retrieval,
    verification,
    diagnostics: diagnostic ? diagnosticsFor(base, "none") : undefined,
  };
}

function diagnosticsFor(base, failureStage) {
  return {
    failureStage,
    lookupMethod: base.resolvedBy,
    accountIdPresent: Boolean(base.recipient.accountId),
    walletAddressPresent: Boolean(base.recipient.walletAddress),
    conversationIdPresent: Boolean(base.target.conversationId),
  };
}

function summarize(records) {
  const byStatus = {};
  const byFailureStage = {};
  for (const record of records) {
    byStatus[record.finalStatus] = (byStatus[record.finalStatus] || 0) + 1;
    byFailureStage[record.failureStage] = (byFailureStage[record.failureStage] || 0) + 1;
  }
  return {
    totalMessages: records.length,
    deliveredVerified: byStatus.delivered_verified || 0,
    failed: records.length - (byStatus.delivered_verified || 0),
    byStatus,
    byFailureStage,
    retriedMessages: records.filter((record) => record.postAttempts?.length > 1).length,
  };
}

function discordSummary(report) {
  const lines = [
    "**Verified Orc Hive messaging bridge mock run**",
    `Task: ${report.taskId}`,
    `Generated by: @${report.generatedBy}`,
    `Mode: ${report.mode}`,
    `Messages: ${report.summary.totalMessages}`,
    `Delivered + verified: ${report.summary.deliveredVerified}`,
    `Failed: ${report.summary.failed}`,
    `Retried messages: ${report.summary.retriedMessages}`,
    "",
    "**Failure stages**",
  ];
  for (const [stage, count] of Object.entries(report.summary.byFailureStage)) {
    lines.push(`- ${stage}: ${count}`);
  }
  lines.push("", "**Contributor results**");
  for (const record of report.records) {
    const handle = record.target?.handle ? `@${record.target.handle}` : "unknown";
    const attempts = record.postAttempts?.length || 0;
    const result = record.finalStatus === "delivered_verified" ? "verified" : `${record.failureStage}/${record.failureCode}`;
    lines.push(`- ${handle} (${record.messageId}): ${result}; post attempts=${attempts}`);
  }
  lines.push("", "Mock mode only; no live Hive messages, funds, bans, or enforcement actions were executed.");
  return `${lines.join("\n")}\n`;
}

async function deliver(options) {
  const mode = safeText(options.mode || "mock").toLowerCase();
  if (mode !== "mock") {
    throw new Error("Only --mode mock is enabled; live Hive Chat sending requires a separately reviewed connector.");
  }

  const messagesPath = requireOption(options, "messages");
  const contributorsPath = requireOption(options, "contributors");
  const outDir = requireOption(options, "out");
  const generatedAt = safeText(options["generated-at"] || new Date().toISOString());
  const generatedBy = safeText(options["generated-by"] || "grashnuk").replace(/^@/, "");
  const maxAttempts = Math.max(1, Math.min(safeNumber(options["max-attempts"], DEFAULT_MAX_ATTEMPTS), 8));
  const baseDelayMs = Math.max(1, safeNumber(options["base-delay-ms"], DEFAULT_BASE_DELAY_MS));
  const diagnostic = options.diagnostic === true || options.diagnostic === "true";

  const messages = normalizeMessages(await readJson(messagesPath));
  const registry = normalizeContributors(await readJson(contributorsPath));
  const records = messages.map((message) =>
    processMessage({
      message,
      registry,
      generatedAt,
      maxAttempts,
      baseDelayMs,
      diagnostic,
    })
  );
  const report = {
    ok: true,
    schema: DELIVERY_SCHEMA,
    taskId: safeText(options["task-id"] || "task_c6a991a7ef8956a53c3b593e93cbc2a1"),
    generatedAt,
    generatedBy,
    mode,
    retryPolicy: {
      maxAttempts,
      baseDelayMs,
      backoff: "exponential_without_sleep_in_mock_mode",
    },
    inputs: {
      messages: messagesPath,
      contributors: contributorsPath,
    },
    summary: summarize(records),
    records,
  };

  await mkdir(outDir, { recursive: true });
  const deliveryLogPath = path.join(outDir, "delivery_log.json");
  const discordSummaryPath = path.join(outDir, "discord_summary.md");
  await writeJson(deliveryLogPath, report);
  await writeFile(discordSummaryPath, discordSummary(report), "utf8");
  return {
    ok: true,
    schema: DELIVERY_SCHEMA,
    taskId: report.taskId,
    mode,
    outputDir: outDir,
    deliveryLogPath,
    discordSummaryPath,
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
