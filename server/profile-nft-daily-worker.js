import { hostname } from "node:os";
import { databaseEnabled } from "./db/pool.js";
import { profileNftGenerateStart } from "./profile-nft-generation.js";
import {
  claimBoardManagerLease,
  releaseBoardManagerLease,
} from "./repositories/board-manager.js";
import {
  createDailyProfileNftAward,
  failStaleRunningDailyProfileNftAwards,
  listDailyProfileNftCandidates,
  markDailyProfileNftAwardFailed,
  markDailyProfileNftAwardGenerated,
  markDailyProfileNftAwardRunning,
} from "./repositories/profile-nft-daily-awards.js";

const WORKER_SCOPE = "profile_nft_daily";
const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 45 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_RUNNING_MS = 20 * 60 * 1000;

let timer = null;
let initialTimer = null;
let running = false;

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
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

function dailyProfileNftWorkerEnabled(env = process.env) {
  return env.TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED === "true" && databaseEnabled();
}

export function buildDailyProfileNftGenerationPayload({ candidate = {}, runDate = dateOnly() } = {}) {
  const normalizedRunDate = dateOnly(runDate);
  const personalCompletedCount = Number(candidate.personalCompletedCount || 0);
  const networkCompletedCount = Number(candidate.networkCompletedCount || 0);
  const eligibilityReason = safeText(candidate.eligibilityReason, 120) ||
    (networkCompletedCount >= 1 ? "network_task_completed" : "personal_task_threshold");
  const contextDocument = [
    `Daily Profile NFT award date: ${normalizedRunDate}`,
    `Eligibility reason: ${eligibilityReason}`,
    `Completed personal tasks: ${personalCompletedCount}`,
    `Completed Network Tasks: ${networkCompletedCount}`,
    candidate.lastCompletedAt ? `Latest completed task at: ${candidate.lastCompletedAt}` : "",
    "Generate a profile NFT image that celebrates verified Task Node work without exposing private task text, wallet secrets, or raw evidence.",
  ].filter(Boolean).join("\n");
  const nftUserData = JSON.stringify(
    {
      schema: "pf.profile.daily_nft_award.v1",
      runDate: normalizedRunDate,
      account: {
        accountId: safeText(candidate.accountId, 180),
      },
      wallet: {
        status: candidate.walletAddress ? "linked" : "",
        address: safeText(candidate.walletAddress, 120),
      },
      eligibility: {
        reason: eligibilityReason,
        personalCompletedCount,
        networkCompletedCount,
        lastCompletedAt: candidate.lastCompletedAt || null,
      },
    },
    null,
    2
  );
  return {
    contextDocument,
    nftUserData,
    style: `Daily Task Node achievement badge for ${normalizedRunDate}.`,
    size: "1024x1024",
    quality: "high",
  };
}

export async function generateDailyProfileNft({ award, candidate = {}, runDate = dateOnly(), env = process.env } = {}) {
  const payload = buildDailyProfileNftGenerationPayload({ candidate, runDate });
  const walletAddress = safeText(candidate.walletAddress || award?.walletAddress, 120);
  const accountId = safeText(candidate.accountId || award?.accountId, 180);
  const result = await profileNftGenerateStart({
    method: "POST",
    payload,
    session: {
      accountId,
      displayName: "Task Node member",
      primaryProvider: "daily_profile_nft_worker",
    },
    state: {
      session: {
        accountId,
        displayName: "Task Node member",
        primaryProvider: "daily_profile_nft_worker",
        walletLink: {
          status: walletAddress ? "linked" : "not_linked",
          address: walletAddress,
        },
      },
      wallet: {
        pftWallet: {
          status: walletAddress ? "linked" : "not_linked",
          address: walletAddress,
        },
      },
      tasks: {
        rewarded: [],
      },
      context: {
        document: {
          body: payload.contextDocument,
        },
      },
    },
    env,
  });
  if (!result.body?.ok || !result.body?.nft?.id) {
    const error = new Error(result.body?.message || result.body?.error || "profile_nft_daily_generation_failed");
    error.status = result.status || 500;
    error.nft = result.body?.nft || null;
    throw error;
  }
  return result.body.nft;
}

export async function runDailyProfileNftWorkerOnce({
  runDate = dateOnly(),
  batchLimit = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_BATCH_LIMIT || DEFAULT_BATCH_LIMIT),
  personalTaskThreshold = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD || 3),
  networkTaskThreshold = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD || 1),
  maxAttempts = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS),
  staleRunningMs = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_STALE_RUNNING_MS || DEFAULT_STALE_RUNNING_MS),
  trigger = "profile_nft_daily_worker",
  enabled = dailyProfileNftWorkerEnabled(process.env),
  useLease = true,
  env = process.env,
  logger = console,
  dependencies = {},
} = {}) {
  if (!enabled) {
    return { ok: true, skipped: true, reason: "profile_nft_daily_worker_disabled" };
  }
  const normalizedRunDate = dateOnly(runDate);
  const safeBatchLimit = clampInteger(batchLimit, DEFAULT_BATCH_LIMIT, { min: 1, max: 50 });
  const safePersonalTaskThreshold = clampInteger(personalTaskThreshold, 3, { min: 0, max: 1000 });
  const safeNetworkTaskThreshold = clampInteger(networkTaskThreshold, 1, { min: 1, max: 1000 });
  const safeMaxAttempts = clampInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, { min: 1, max: 20 });
  const safeStaleRunningMs = clampMs(staleRunningMs, DEFAULT_STALE_RUNNING_MS, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
  const managerId = `profile_nft_daily_worker_${hostname()}`;
  let lease = null;
  const failStaleRunning = dependencies.failStaleRunning || failStaleRunningDailyProfileNftAwards;
  const listCandidates = dependencies.listCandidates || listDailyProfileNftCandidates;
  const createAward = dependencies.createAward || createDailyProfileNftAward;
  const markRunning = dependencies.markRunning || markDailyProfileNftAwardRunning;
  const generateNft = dependencies.generateNft || generateDailyProfileNft;
  const markGenerated = dependencies.markGenerated || markDailyProfileNftAwardGenerated;
  const markFailed = dependencies.markFailed || markDailyProfileNftAwardFailed;

  try {
    if (useLease) {
      lease = await claimBoardManagerLease({
        scope: WORKER_SCOPE,
        managerId,
        ttlSeconds: 45 * 60,
        metadata: {
          trigger,
          runDate: normalizedRunDate,
          worker: "profile_nft_daily",
        },
      });
      if (!lease.ok) {
        return { ok: true, skipped: true, reason: "profile_nft_daily_worker_lease_unavailable", active: lease.active || null };
      }
    }

    const stale = await failStaleRunning({
      staleAfterMs: safeStaleRunningMs,
      error: "Daily Profile NFT generation was interrupted before completion.",
    });
    const candidates = await listCandidates({
      runDate: normalizedRunDate,
      personalTaskThreshold: safePersonalTaskThreshold,
      networkTaskThreshold: safeNetworkTaskThreshold,
      maxAttempts: safeMaxAttempts,
      limit: safeBatchLimit,
    });
    const generated = [];
    const failed = [];
    const skipped = [];

    for (const candidate of candidates) {
      let award = null;
      try {
        award = await createAward({
          runDate: normalizedRunDate,
          accountId: candidate.accountId,
          walletAddress: candidate.walletAddress,
          personalCompletedCount: candidate.personalCompletedCount,
          networkCompletedCount: candidate.networkCompletedCount,
          eligibilityReason: candidate.eligibilityReason,
          eligibilityJson: {
            trigger,
            lastCompletedAt: candidate.lastCompletedAt || null,
            thresholds: {
              personalTaskThreshold: safePersonalTaskThreshold,
              networkTaskThreshold: safeNetworkTaskThreshold,
            },
          },
        });
        if (!["pending", "failed"].includes(award.status)) {
          skipped.push({ accountId: candidate.accountId, awardId: award.id, status: award.status });
          continue;
        }
        const runningAward = await markRunning({ awardId: award.id });
        if (!runningAward) {
          skipped.push({ accountId: candidate.accountId, awardId: award.id, status: "not_claimed" });
          continue;
        }
        const nft = await generateNft({
          award: runningAward,
          candidate,
          runDate: normalizedRunDate,
          env,
        });
        const completed = await markGenerated({
          awardId: runningAward.id,
          profileNftId: nft.id,
        });
        generated.push({
          accountId: candidate.accountId,
          walletAddress: candidate.walletAddress,
          awardId: completed?.id || runningAward.id,
          profileNftId: nft.id,
        });
      } catch (error) {
        const message = error?.message || String(error);
        if (award?.id) {
          await markFailed({ awardId: award.id, error: message }).catch(() => null);
        }
        failed.push({
          accountId: candidate.accountId,
          awardId: award?.id || "",
          error: safeText(message, 500),
        });
        logger.warn?.("[profile-nft-daily-worker] account failed", candidate.accountId, message);
      }
    }

    return {
      ok: true,
      runDate: normalizedRunDate,
      candidateCount: candidates.length,
      generatedCount: generated.length,
      failedCount: failed.length,
      skippedCount: skipped.length,
      staleFailedCount: stale.failedCount || 0,
      generated,
      failed,
      skipped,
      summary: `Generated ${generated.length} daily profile NFT ${generated.length === 1 ? "award" : "awards"} for ${normalizedRunDate}.`,
    };
  } finally {
    if (useLease && lease?.ok) {
      await releaseBoardManagerLease({ scope: WORKER_SCOPE, managerId }).catch(() => null);
    }
  }
}

export function startDailyProfileNftWorker({ env = process.env, logger = console } = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  if (!dailyProfileNftWorkerEnabled(env)) return { started: false, reason: "disabled" };

  const intervalMs = clampMs(env.TASKNODE_PROFILE_NFT_DAILY_INTERVAL_MS, DEFAULT_INTERVAL_MS, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
  const initialDelayMs = clampMs(env.TASKNODE_PROFILE_NFT_DAILY_INITIAL_DELAY_MS, DEFAULT_INITIAL_DELAY_MS, {
    min: 1000,
    max: intervalMs,
  });
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDailyProfileNftWorkerOnce({
        env,
        logger,
        trigger: "profile_nft_daily_worker_tick",
      });
      if (!result.skipped && (result.generatedCount || result.failedCount)) {
        logger.info?.("[profile-nft-daily-worker]", result.summary);
      }
    } catch (error) {
      logger.error?.("[profile-nft-daily-worker] tick failed", error?.stack || error?.message || error);
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
