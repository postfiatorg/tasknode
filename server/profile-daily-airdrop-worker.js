import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { databaseEnabled, query } from "./db/pool.js";
import { runDailyAirdropScore } from "./profile-daily-airdrop.js";
import { issueLatestDailyAirdrop } from "./profile-daily-airdrop-issuance.js";
import {
  claimBoardManagerLease,
  completeBoardManagerRun,
  recordBoardManagerActionResult,
  releaseBoardManagerLease,
  startBoardManagerRun,
} from "./repositories/board-manager.js";
import { listDailyAirdropCandidateAccounts } from "./repositories/profile-daily-airdrop.js";

const WORKER_SCOPE = "daily_airdrop";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;

let timer = null;
let initialTimer = null;
let running = false;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function dateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function clampInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampMs(value, fallback, { min = 5000, max = 24 * 60 * 60 * 1000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function dailyAirdropWorkerEnabled(env = process.env) {
  return env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED === "true" && databaseEnabled();
}

function autoIssueEnabled(env = process.env) {
  return env.TASKNODE_DAILY_AIRDROP_AUTO_ISSUE !== "false";
}

function dailyAirdropWorkerRunMode(env = process.env) {
  return env.TASKNODE_DAILY_AIRDROP_WORKER_RUN_MODE === "dry_run" ? "dry_run" : "production";
}

function pftText(value = 0) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });
}

export function formatDailyAirdropSummary({
  totalPft = 0,
  userCount = 0,
  scoredCount = 0,
  failedCount = 0,
} = {}) {
  const base = `Dispensed ${pftText(totalPft)} PFT to ${Number(userCount || 0).toLocaleString("en-US")} ${Number(userCount || 0) === 1 ? "user" : "users"} as part of daily airdrop.`;
  const detail = [
    scoredCount ? `Scored ${Number(scoredCount).toLocaleString("en-US")} eligible ${Number(scoredCount) === 1 ? "account" : "accounts"}.` : "",
    failedCount ? `${Number(failedCount).toLocaleString("en-US")} ${Number(failedCount) === 1 ? "account failed" : "accounts failed"}.` : "",
  ].filter(Boolean).join(" ");
  return detail ? `${base} ${detail}` : base;
}

async function recordDailyAirdropAgentRun({
  runDate,
  candidates = [],
  scored = [],
  issued = [],
  failed = [],
  trigger = "daily_airdrop_worker",
  model = "",
  runMode = "production",
  dryRun = false,
} = {}) {
  const totalPft = issued.reduce((sum, item) => sum + Number(item.amountPft || 0), 0);
  const userCount = issued.length;
  const summary = formatDailyAirdropSummary({
    totalPft,
    userCount,
    scoredCount: scored.length,
    failedCount: failed.length,
  });
  const sourcePacket = {
    schema: "pf.hive.daily_airdrop.run_source.v1",
    generatedAt: new Date().toISOString(),
    runDate,
    runMode,
    candidateCount: candidates.length,
    scoredCount: scored.length,
    issuedCount: issued.length,
    failedCount: failed.length,
    totalPft,
    candidates: candidates.map((candidate) => ({
      accountId: candidate.accountId,
      rewardedTaskCount: candidate.rewardedTaskCount,
      rewardActualPft: candidate.rewardActualPft,
      lastRewardAt: candidate.lastRewardAt,
    })),
    issued: issued.map((item) => ({
      accountId: item.accountId,
      runId: item.runId,
      issuanceId: item.issuanceId,
      amountPft: item.amountPft,
      recipientWallet: item.recipientWallet,
      txHash: item.txHash,
      ledgerIndex: item.ledgerIndex,
    })),
    failed: failed.map((item) => ({
      accountId: item.accountId,
      error: safeText(item.error, 500),
    })),
  };
  if (!issued.length && !failed.length) {
    const existing = await latestDailyAirdropAgentRunForDate({ runDate });
    if (existing?.id) {
      return {
        ok: true,
        skipped: true,
        reason: "daily_airdrop_agent_audit_already_recorded",
        runId: existing.id,
        summary,
      };
    }
  }
  const start = await startBoardManagerRun({
    scope: "global_hive",
    managerId: "daily_airdrop_worker",
    trigger,
    sourcePacket: {
      ...sourcePacket,
      sourcePacketDigest: digestJson({ ...sourcePacket, generatedAt: "" }),
    },
    dryRun,
    model,
    reasoningEffort: "none",
    sessionMode: "worker",
  });
  const decision = {
    action: "daily_airdrop",
    target_type: "daily_airdrop",
    target_id: runDate,
    reason: summary,
    confidence: failed.length ? 0.75 : 1,
    decision_basis: {
      source_facts: [
        `${candidates.length} candidate ${candidates.length === 1 ? "account was" : "accounts were"} loaded for ${runDate}.`,
        `The worker scoring mode was ${runMode}.`,
        `${scored.length} candidate ${scored.length === 1 ? "account was" : "accounts were"} scored by the daily airdrop scorer.`,
        `${issued.length} payout ${issued.length === 1 ? "was" : "were"} submitted, totaling ${pftText(totalPft)} PFT.`,
        failed.length ? `${failed.length} candidate ${failed.length === 1 ? "failed" : "accounts failed"} during scoring or issuance.` : "No candidate failures were recorded.",
      ],
      tradeoffs: [
        autoIssueEnabled(process.env)
          ? "Auto-issuance was enabled, so positive scored runs were eligible for payment submission."
          : "Auto-issuance was disabled, so the worker recorded scoring without submitting payouts.",
      ],
      rejected_actions: [],
      risk_notes: failed.length
        ? ["Review failed accounts before retrying so duplicate or partial payout behavior is understood."]
        : [],
      next_check: failed.length
        ? "Open the daily airdrop action-result JSON and inspect failed account errors before retrying."
        : "If zero PFT was dispensed, inspect scored account rows to confirm they were ineligible or scored at 0 PFT.",
    },
    payload: {
      summary,
      next_steps: failed.length ? ["Review failed accounts before retrying so duplicate payouts are not sent."] : [],
      message_text: "",
      archive_reason: "",
      project: {},
      project_document: {},
      contributor: {},
      network_task: {},
    },
  };
  await completeBoardManagerRun({
    runId: start.run.id,
    decision,
    outputText: JSON.stringify(sourcePacket, null, 2),
  });
  await recordBoardManagerActionResult({
    runId: start.run.id,
    action: "daily_airdrop",
    targetType: "daily_airdrop",
    targetId: runDate,
    result: {
      executed: !dryRun,
      summary,
      runDate,
      totalPft,
      userCount,
      scoredCount: scored.length,
      failedCount: failed.length,
      issued,
      failed,
    },
  });
  return { ok: true, runId: start.run.id, summary };
}

async function latestDailyAirdropAgentRunForDate({ runDate } = {}) {
  if (!databaseEnabled()) return null;
  const result = await query(
    `SELECT id, completed_at
       FROM board_manager_runs
      WHERE manager_id = 'daily_airdrop_worker'
        AND selected_action = 'daily_airdrop'
        AND status = 'completed'
        AND decision_json->>'target_id' = $1
      ORDER BY completed_at DESC NULLS LAST, updated_at DESC, id DESC
      LIMIT 1`,
    [dateOnly(runDate)]
  );
  return result.rows[0] || null;
}

export async function runDailyAirdropWorkerOnce({
  runDate = dateOnly(),
  lookbackDays = Number(process.env.TASKNODE_DAILY_AIRDROP_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS),
  batchLimit = Number(process.env.TASKNODE_DAILY_AIRDROP_WORKER_BATCH_LIMIT || DEFAULT_BATCH_LIMIT),
  maxDailyPft = Number(process.env.TASKNODE_DAILY_AIRDROP_MAX_PFT || 10000),
  model = process.env.TASKNODE_DAILY_AIRDROP_MODEL || "deepseek/deepseek-v4-pro",
  runMode = dailyAirdropWorkerRunMode(process.env),
  trigger = "daily_airdrop_worker",
  recordAgentRun = true,
  env = process.env,
  logger = console,
} = {}) {
  if (!dailyAirdropWorkerEnabled(env)) {
    return { ok: true, skipped: true, reason: "daily_airdrop_worker_disabled" };
  }
  const normalizedRunDate = dateOnly(runDate || new Date());
  const normalizedRunMode = runMode === "dry_run" ? "dry_run" : "production";

  const managerId = `daily_airdrop_worker_${hostname()}`;
  const lease = await claimBoardManagerLease({
    scope: WORKER_SCOPE,
    managerId,
    ttlSeconds: 45 * 60,
    metadata: {
      trigger,
      runDate: normalizedRunDate,
      worker: "profile_daily_airdrop",
    },
  });
  if (!lease.ok) {
    return { ok: true, skipped: true, reason: "daily_airdrop_worker_lease_unavailable", active: lease.active || null };
  }

  const candidates = [];
  const scored = [];
  const issued = [];
  const failed = [];
  try {
    candidates.push(...await listDailyAirdropCandidateAccounts({
      runDate: normalizedRunDate,
      lookbackDays,
      limit: clampInteger(batchLimit, DEFAULT_BATCH_LIMIT, { min: 1, max: 100 }),
    }));
    for (const candidate of candidates) {
      try {
        const score = await runDailyAirdropScore({
          accountId: candidate.accountId,
          runMode: normalizedRunMode,
          scenarioId: `daily_airdrop_worker:${normalizedRunDate}`,
          lookbackDays,
          maxDailyPft,
          model,
          env,
        });
        scored.push({
          accountId: candidate.accountId,
          runId: score.run.id,
          amountPft: Number(score.output.daily_airdrop_pft || 0),
          rewardedTaskCount: score.packet?.reward_totals?.rewarded_task_count || 0,
          rewardPaid7d: score.packet?.reward_totals?.total_reward_paid_pft || 0,
        });
        if (autoIssueEnabled(env) && Number(score.output.daily_airdrop_pft || 0) > 0) {
          const issuanceResult = await issueLatestDailyAirdrop({
            accountId: candidate.accountId,
            runId: score.run.id,
          });
          const issuance = issuanceResult.issuance || {};
          if (issuance.status === "submitted") {
            issued.push({
              accountId: candidate.accountId,
              runId: score.run.id,
              issuanceId: issuance.id,
              amountPft: Number(issuance.amountPft || score.output.daily_airdrop_pft || 0),
              recipientWallet: issuance.recipientWallet || "",
              txHash: issuance.txHash || "",
              ledgerIndex: issuance.ledgerIndex || null,
              alreadySubmitted: Boolean(issuanceResult.alreadySubmitted),
            });
          }
        }
      } catch (error) {
        failed.push({
          accountId: candidate.accountId,
          error: error?.message || String(error),
        });
        logger.warn?.("[daily-airdrop-worker] account failed", candidate.accountId, error?.message || error);
      }
    }
    const totalPft = issued.reduce((sum, item) => sum + Number(item.amountPft || 0), 0);
    const result = {
      ok: true,
      runDate: normalizedRunDate,
      runMode: normalizedRunMode,
      candidateCount: candidates.length,
      scoredCount: scored.length,
      issuedCount: issued.length,
      failedCount: failed.length,
      totalPft,
      candidates,
      scored,
      issued,
      failed,
      summary: formatDailyAirdropSummary({
        totalPft,
        userCount: issued.length,
        scoredCount: scored.length,
        failedCount: failed.length,
      }),
    };
    if (recordAgentRun) {
      result.agentRun = await recordDailyAirdropAgentRun({
        runDate: normalizedRunDate,
        candidates,
        scored,
        issued,
        failed,
        trigger,
        model,
        runMode: normalizedRunMode,
      });
    }
    return result;
  } finally {
    await releaseBoardManagerLease({ scope: WORKER_SCOPE, managerId }).catch(() => null);
  }
}

export function startDailyAirdropWorker({
  env = process.env,
  logger = console,
} = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  if (!dailyAirdropWorkerEnabled(env)) return { started: false, reason: "disabled" };

  const intervalMs = clampMs(env.TASKNODE_DAILY_AIRDROP_WORKER_INTERVAL_MS, DEFAULT_INTERVAL_MS, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
  const initialDelayMs = clampMs(env.TASKNODE_DAILY_AIRDROP_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS, {
    min: 1000,
    max: intervalMs,
  });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDailyAirdropWorkerOnce({
        env,
        logger,
        trigger: "daily_airdrop_worker_tick",
      });
      if (!result.skipped && (result.issuedCount || result.failedCount)) {
        logger.info?.("[daily-airdrop-worker]", result.summary);
      }
    } catch (error) {
      logger.error?.("[daily-airdrop-worker] tick failed", error?.stack || error?.message || error);
    } finally {
      running = false;
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    tick();
  }, initialDelayMs);
  initialTimer.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs, initialDelayMs };
}
