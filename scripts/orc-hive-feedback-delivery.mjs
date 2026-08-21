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
