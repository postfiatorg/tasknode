import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { databaseEnabled } from "./db/pool.js";
import { classifyProfileNftGenerationFailure, profileNftGenerateStart } from "./profile-nft-generation.js";
import {
  claimBoardManagerLease,
  releaseBoardManagerLease,
} from "./repositories/board-manager.js";
import {
  createDailyProfileNftAward,
  countDailyProfileNftAwardSlots,
  failStaleRunningDailyProfileNftAwards,
  listDailyProfileNftBackfillSlots,
  listDailyProfileNftCandidates,
  markDailyProfileNftAwardFailed,
  markDailyProfileNftAwardGenerated,
  markDailyProfileNftAwardRunning,
  recordDailyProfileNftBackfillSkippedSlots,
  upsertDailyProfileNftWorkerHeartbeat,
  verifyDailyProfileNftBackfillSlot,
} from "./repositories/profile-nft-daily-awards.js";

const WORKER_SCOPE = "profile_nft_daily";
const DEFAULT_BATCH_LIMIT = 5;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 45 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_RUNNING_MS = 20 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const BACKFILL_MODE = "profile_nft_daily_backfill_v1";
const BACKFILL_MAX_ACCOUNTS = 41;

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

function dailyProfileNftDryRun(env = process.env) {
  return env.TASKNODE_PROFILE_NFT_DAILY_DRY_RUN === "true";
}

function dailyProfileNftForwardEnabled(env = process.env) {
  return env.TASKNODE_PROFILE_NFT_DAILY_FORWARD_ENABLED === "true";
}

function dailyProfileNftBackfillEnabled(env = process.env) {
  return env.TASKNODE_PROFILE_NFT_DAILY_BACKFILL_ENABLED === "true";
}

function retryDelayMs(attemptCount = 1, baseMs = DEFAULT_RETRY_BASE_MS) {
  const base = clampMs(baseMs, DEFAULT_RETRY_BASE_MS, { min: 1000, max: 30 * 60 * 1000 });
  return Math.min(base * (2 ** Math.min(Math.max(Number(attemptCount || 1) - 1, 0), 8)), 24 * 60 * 60 * 1000);
}

function normalizeIsoDate(value = "") {
  const text = safeText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || dateOnly(`${text}T00:00:00.000Z`) !== text) {
    throw new Error("profile_nft_daily_backfill_run_date_invalid");
  }
  return text;
}

function normalizeRunDates(runDates = []) {
  const normalized = [...new Set(runDates.map(normalizeIsoDate))].sort();
  if (!normalized.length) throw new Error("profile_nft_daily_backfill_run_dates_required");
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function backfillSlotKey(slot = {}) {
  return `${safeText(slot.accountId, 180)}\u0000${dateOnly(slot.runDate)}`;
}

function manifestHash(payload) {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function backfillManifestPayload({ selectedAt, runDates, maxAccounts, slots, remainingSlots, snapshotDigest }) {
  return {
    schema: "tasknode.profile_nft_daily_backfill_manifest.v1",
    mode: BACKFILL_MODE,
    selectedAt,
    runDates,
    maxAccounts,
    slots,
    remainingSlots,
    selectedCount: slots.length,
    remainingCount: remainingSlots.length,
    snapshotDigest,
  };
}

function normalizeBackfillSlot(slot = {}, selectedAt = "", runDates = []) {
  const normalized = {
    accountId: safeText(slot.accountId, 180),
    walletAddress: safeText(slot.walletAddress, 120),
    runDate: normalizeIsoDate(slot.runDate),
    existingStateProof: safeText(slot.existingStateProof || "no_award_row", 80),
    eligibilityReason: safeText(slot.eligibilityReason, 120),
    personalCompletedCount: Number(slot.personalCompletedCount || 0),
    networkCompletedCount: Number(slot.networkCompletedCount || 0),
    lastCompletedAt: slot.lastCompletedAt || null,
    selectedAt,
    mode: BACKFILL_MODE,
  };
  if (!normalized.accountId || !runDates.includes(normalized.runDate)) {
    throw new Error("profile_nft_daily_backfill_slot_invalid");
  }
  return normalized;
}

function assertBackfillManifest(manifest = {}, expectedHash = "") {
  const runDates = normalizeRunDates(manifest.runDates);
  const maxAccounts = Number(manifest.maxAccounts);
  if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > BACKFILL_MAX_ACCOUNTS) throw new Error("profile_nft_daily_backfill_max_accounts_invalid");
  const payload = backfillManifestPayload({
    selectedAt: safeText(manifest.selectedAt, 80),
    runDates,
    maxAccounts,
    slots: Array.isArray(manifest.slots) ? manifest.slots : [],
    remainingSlots: Array.isArray(manifest.remainingSlots) ? manifest.remainingSlots : [],
    snapshotDigest: safeText(manifest.snapshotDigest, 80),
  });
  const hash = manifestHash(payload);
  if (manifest.mode !== BACKFILL_MODE || manifest.schema !== payload.schema || !expectedHash || expectedHash !== hash || manifest.manifestHash !== hash) {
    throw new Error("profile_nft_daily_backfill_manifest_hash_mismatch");
  }
  if (payload.slots.length < 1 || payload.slots.length > payload.maxAccounts) {
    throw new Error("profile_nft_daily_backfill_slot_count_invalid");
  }
  const selectedKeys = new Set(payload.slots.map(backfillSlotKey));
  const selectedAccounts = new Set(payload.slots.map((slot) => safeText(slot.accountId, 180)));
  const remainingKeys = new Set(payload.remainingSlots.map(backfillSlotKey));
  if (selectedKeys.size !== payload.slots.length || selectedAccounts.size !== payload.slots.length || remainingKeys.size !== payload.remainingSlots.length) {
    throw new Error("profile_nft_daily_backfill_manifest_duplicates");
  }
  for (const slot of [...payload.slots, ...payload.remainingSlots]) normalizeBackfillSlot(slot, payload.selectedAt, payload.runDates);
  return { payload, hash };
}

function sameSlotSet(expected = [], actual = []) {
  if (expected.length !== actual.length) return false;
  const expectedKeys = new Set(expected.map(backfillSlotKey));
  return actual.every((slot) => expectedKeys.has(backfillSlotKey(slot)));
}

export async function buildDailyProfileNftBackfillManifest({
  runDates = [],
  maxAccounts = BACKFILL_MAX_ACCOUNTS,
  selectedAt = new Date().toISOString(),
  personalTaskThreshold = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD || 3),
  networkTaskThreshold = Number(process.env.TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD || 1),
  dependencies = {},
} = {}) {
  const normalizedRunDates = normalizeRunDates(runDates);
  const safeMaxAccounts = Number(maxAccounts);
  if (!Number.isInteger(safeMaxAccounts) || safeMaxAccounts < 1 || safeMaxAccounts > BACKFILL_MAX_ACCOUNTS) {
    throw new Error("profile_nft_daily_backfill_max_accounts_invalid");
  }
  const listBackfillSlots = dependencies.listBackfillSlots || listDailyProfileNftBackfillSlots;
  const candidates = await listBackfillSlots({
    runDates: normalizedRunDates,
    personalTaskThreshold,
    networkTaskThreshold,
  });
  const normalizedCandidates = candidates
    .map((candidate) => normalizeBackfillSlot(candidate, selectedAt, normalizedRunDates))
    .sort((left, right) => left.accountId.localeCompare(right.accountId) || right.runDate.localeCompare(left.runDate));
  const selectedAccounts = new Set();
  const slots = [];
  for (const candidate of normalizedCandidates) {
    if (selectedAccounts.has(candidate.accountId) || slots.length >= safeMaxAccounts) continue;
    selectedAccounts.add(candidate.accountId);
    slots.push(candidate);
  }
  if (!slots.length) throw new Error("profile_nft_daily_backfill_no_missing_slots");
  const selectedKeys = new Set(slots.map(backfillSlotKey));
  const remainingSlots = normalizedCandidates.filter((candidate) => !selectedKeys.has(backfillSlotKey(candidate)));
  const snapshotDigest = manifestHash({ runDates: normalizedRunDates, slots: normalizedCandidates });
  const payload = backfillManifestPayload({ selectedAt, runDates: normalizedRunDates, maxAccounts: safeMaxAccounts, slots, remainingSlots, snapshotDigest });
  return { ...payload, manifestHash: manifestHash(payload) };
}

export async function runDailyProfileNftBackfill({
  manifest = {},
  manifestHash: expectedHash = "",
  enabled = dailyProfileNftBackfillEnabled(process.env),
  dryRun = dailyProfileNftDryRun(process.env),
  env = process.env,
  logger = console,
  dependencies = {},
} = {}) {
  if (!enabled) return { ok: true, skipped: true, reason: "profile_nft_daily_backfill_disabled" };
  const { payload, hash } = assertBackfillManifest(manifest, expectedHash);
  const verifySlot = dependencies.verifyBackfillSlot || verifyDailyProfileNftBackfillSlot;
  const listBackfillSlots = dependencies.listBackfillSlots || listDailyProfileNftBackfillSlots;
  const countAwardSlots = dependencies.countAwardSlots || countDailyProfileNftAwardSlots;
  const recordSkippedSlots = dependencies.recordSkippedSlots || recordDailyProfileNftBackfillSkippedSlots;
  const allManifestSlots = [...payload.slots, ...payload.remainingSlots];
  const managerId = `profile_nft_daily_backfill_${hostname()}`;
  const claimLease = dependencies.claimLease || claimBoardManagerLease;
  const releaseLease = dependencies.releaseLease || releaseBoardManagerLease;
  let lease = null;
  let primaryError = null;
  try {
    lease = await claimLease({ scope: WORKER_SCOPE, managerId, ttlSeconds: 45 * 60, metadata: { mode: BACKFILL_MODE, manifestHash: hash } });
    if (!lease.ok) return { ok: true, skipped: true, reason: "profile_nft_daily_backfill_lease_unavailable", manifestHash: hash };
    const currentSnapshot = await listBackfillSlots({ runDates: payload.runDates, personalTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD || 3), networkTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD || 1) });
    const normalizedSnapshot = currentSnapshot.map((slot) => normalizeBackfillSlot(slot, payload.selectedAt, payload.runDates)).sort((left, right) => left.accountId.localeCompare(right.accountId) || right.runDate.localeCompare(left.runDate));
    if (!sameSlotSet(allManifestSlots, normalizedSnapshot) || manifestHash({ runDates: payload.runDates, slots: normalizedSnapshot }) !== payload.snapshotDigest) {
      return { ok: false, reason: "profile_nft_daily_backfill_snapshot_drift", manifestHash: hash, results: [] };
    }
  const existingCount = await countAwardSlots({ slots: allManifestSlots });
  if (existingCount === allManifestSlots.length) {
    return { ok: true, manifestHash: hash, alreadyApplied: true, selectedCount: payload.slots.length, skippedLedgerCount: payload.remainingSlots.length, results: [] };
  }
  if (existingCount > 0) {
    return { ok: false, reason: "profile_nft_daily_backfill_partial_manifest_state", manifestHash: hash, existingCount, expectedCount: allManifestSlots.length };
  }
  const results = [];
  for (const slot of payload.slots) {
    const candidate = await verifySlot({
      accountId: slot.accountId,
      runDate: slot.runDate,
      personalTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD || 3),
      networkTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD || 1),
    });
    if (!candidate || candidate.existingStateProof !== "no_award_row") {
      results.push({ accountId: slot.accountId, runDate: slot.runDate, status: "before_image_changed" });
      continue;
    }
    if (dryRun) {
      results.push({ accountId: slot.accountId, runDate: slot.runDate, status: "dry_run" });
      continue;
    }
    const result = await runDailyProfileNftWorkerOnce({
      runDate: slot.runDate,
      batchLimit: 1,
      trigger: `${BACKFILL_MODE}:${hash}`,
      enabled: true,
      forwardEnabled: true,
      allowHistoricalRunDate: true,
      dryRun: false,
      useLease: false,
      env,
      logger,
      dependencies: {
        ...dependencies,
        listCandidates: async () => [{ ...candidate, runDate: slot.runDate }],
      },
    });
    const generated = result.generated[0];
    const failure = result.failed[0];
    const skipped = result.skipped[0];
    results.push({
      accountId: slot.accountId,
      runDate: slot.runDate,
      status: generated ? "generated" : failure ? (failure.retryable ? "retry_wait" : "failed_permanent") : skipped ? skipped.status : "not_processed",
      awardId: generated?.awardId || failure?.awardId || skipped?.awardId || "",
      profileNftId: generated?.profileNftId || "",
      error: failure?.error || "",
      errorCode: failure?.errorCode || "",
      retryable: Boolean(failure?.retryable),
      nextRetryAt: failure?.nextRetryAt || null,
      reason: skipped?.status || "",
    });
  }
  if (dryRun) return { ok: true, dryRun: true, manifestHash: hash, selectedCount: payload.slots.length, skippedLedgerCount: 0, results };
  const currentRemaining = await listBackfillSlots({
    runDates: payload.runDates,
    personalTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_PERSONAL_TASK_THRESHOLD || 3),
    networkTaskThreshold: Number(env.TASKNODE_PROFILE_NFT_DAILY_NETWORK_TASK_THRESHOLD || 1),
  });
  if (currentRemaining.length !== payload.remainingSlots.length || !sameSlotSet(payload.remainingSlots, currentRemaining)) {
    return { ok: false, reason: "profile_nft_daily_backfill_remaining_slots_changed", manifestHash: hash, remainingCount: currentRemaining.length, expectedRemainingCount: payload.remainingSlots.length, results };
  }
  const skipped = await recordSkippedSlots({ slots: payload.remainingSlots, manifestHash: hash, mode: BACKFILL_MODE, reason: "Historical Daily Profile NFT slot intentionally skipped after approved one-slot backfill." });
  if (skipped.skippedCount !== payload.remainingSlots.length) {
    throw new Error("profile_nft_daily_backfill_skip_count_mismatch");
  }
  return { ok: true, manifestHash: hash, selectedCount: payload.slots.length, skippedLedgerCount: skipped.skippedCount, results };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (lease?.ok) {
      try {
        await releaseLease({ scope: WORKER_SCOPE, managerId });
      } catch (releaseError) {
        if (primaryError) {
          logger.error?.("[profile-nft-daily-worker] backfill lease release failed", releaseError?.message || releaseError);
        } else {
          // eslint-disable-next-line no-unsafe-finally -- a successful execution must surface lease-release failure.
          throw releaseError;
        }
      }
    }
  }
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
    error.code = result.body?.failure?.code || result.body?.error || "profile_nft_daily_generation_failed";
    error.retryable = result.body?.failure?.retryable;
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
  forwardEnabled = dailyProfileNftForwardEnabled(process.env),
  allowHistoricalRunDate = false,
  dryRun = dailyProfileNftDryRun(process.env),
  useLease = true,
  env = process.env,
  logger = console,
  dependencies = {},
} = {}) {
  const writeHeartbeat = dependencies.writeHeartbeat || upsertDailyProfileNftWorkerHeartbeat;
  if (!enabled) {
    await writeHeartbeat({ enabled: false, generationGated: false, dryRun, lastTickStartedAt: new Date().toISOString(), lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_worker_disabled", lastErrorMessage: "Daily Profile NFT worker is disabled.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 });
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
  const heartbeatBase = { enabled, generationGated: enabled && (dryRun || !forwardEnabled), dryRun };

  try {
    await writeHeartbeat({ ...heartbeatBase, lastTickStartedAt: new Date().toISOString(), lastTickFinishedAt: null, lastErrorCode: "", lastErrorMessage: "", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 });
    if (!allowHistoricalRunDate && normalizedRunDate !== dateOnly()) {
      await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_current_utc_day_only", lastErrorMessage: "Daily Profile NFT worker only creates awards for the current UTC day.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 });
      return { ok: true, skipped: true, reason: "profile_nft_daily_current_utc_day_only", runDate: normalizedRunDate };
    }
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
        await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_worker_lease_unavailable", lastErrorMessage: "Daily Profile NFT worker lease is unavailable.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 });
        return { ok: true, skipped: true, reason: "profile_nft_daily_worker_lease_unavailable", active: lease.active || null };
      }
    }

    const candidates = await listCandidates({
      runDate: normalizedRunDate,
      personalTaskThreshold: safePersonalTaskThreshold,
      networkTaskThreshold: safeNetworkTaskThreshold,
      maxAttempts: safeMaxAttempts,
      limit: safeBatchLimit,
    });
    if (dryRun) {
      await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_dry_run", lastErrorMessage: "Dry run: no award claim or generation performed.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: candidates.length });
      return { ok: true, dryRun: true, runDate: normalizedRunDate, candidateCount: candidates.length, generatedCount: 0, failedCount: 0, skippedCount: candidates.length, staleFailedCount: 0, generated: [], failed: [], skipped: candidates.map((candidate) => ({ accountId: candidate.accountId, status: "dry_run" })), summary: `Dry run found ${candidates.length} daily profile NFT candidates.` };
    }
    if (!forwardEnabled) {
      await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_forward_generation_disabled", lastErrorMessage: "Forward Daily Profile NFT generation is gated pending authorized backfill.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: candidates.length });
      return { ok: true, skipped: true, reason: "profile_nft_daily_forward_generation_disabled", runDate: normalizedRunDate, candidateCount: candidates.length };
    }
    const stale = await failStaleRunning({
      staleAfterMs: safeStaleRunningMs,
      error: "Daily Profile NFT generation was interrupted before completion.",
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
        if (!["pending", "retry_wait"].includes(award.status)) {
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
        const classification = classifyProfileNftGenerationFailure(error);
        const message = classification.message;
        let nextRetryAt = null;
        if (award?.id) {
          const persistedFailure = await markFailed({ awardId: award.id, error: message, errorCode: classification.code, retryable: error?.retryable ?? classification.retryable, maxAttempts: safeMaxAttempts, retryDelayMs: retryDelayMs(award.attemptCount || 1, Number(env.TASKNODE_PROFILE_NFT_DAILY_RETRY_BASE_MS || DEFAULT_RETRY_BASE_MS)) });
          nextRetryAt = persistedFailure?.nextAttemptAt || null;
        }
        failed.push({
          accountId: candidate.accountId,
          awardId: award?.id || "",
          error: safeText(message, 500),
          errorCode: classification.code,
          retryable: error?.retryable ?? classification.retryable,
          nextRetryAt,
        });
        logger.warn?.("[profile-nft-daily-worker] account failed", candidate.accountId, message);
      }
    }

    const retryableFailures = failed.filter((item) => item.retryable);
    const permanentFailures = failed.filter((item) => !item.retryable);
    await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastSuccessAt: generated.length ? new Date().toISOString() : null, lastErrorCode: failed[0]?.errorCode || "", lastErrorMessage: failed[0]?.error || "", retryableCount: retryableFailures.length, permanentCount: permanentFailures.length, currentRetryAwardId: retryableFailures[0]?.awardId || "", nextRetryAt: retryableFailures[0]?.nextRetryAt || null, candidateCount: candidates.length });

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
  } catch (error) {
    const classification = classifyProfileNftGenerationFailure(error);
    try {
      await writeHeartbeat({ ...heartbeatBase, lastTickFinishedAt: new Date().toISOString(), lastErrorCode: classification.code, lastErrorMessage: classification.message, retryableCount: classification.retryable ? 1 : 0, permanentCount: classification.retryable ? 0 : 1, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 });
    } catch (heartbeatError) {
      logger.error?.("[profile-nft-daily-worker] heartbeat write failed", heartbeatError?.message || heartbeatError);
    }
    throw error;
  } finally {
    if (useLease && lease?.ok) {
      await releaseBoardManagerLease({ scope: WORKER_SCOPE, managerId });
    }
  }
}

export function startDailyProfileNftWorker({ env = process.env, logger = console } = {}) {
  if (timer || initialTimer) return { started: false, reason: "already_started" };
  if (!dailyProfileNftWorkerEnabled(env)) {
    void upsertDailyProfileNftWorkerHeartbeat({ enabled: false, generationGated: false, dryRun: dailyProfileNftDryRun(env), lastTickStartedAt: new Date().toISOString(), lastTickFinishedAt: new Date().toISOString(), lastErrorCode: "profile_nft_daily_worker_disabled", lastErrorMessage: "Daily Profile NFT worker is disabled.", retryableCount: 0, permanentCount: 0, currentRetryAwardId: "", nextRetryAt: null, candidateCount: 0 }).catch((error) => logger.error?.("[profile-nft-daily-worker] disabled heartbeat failed", error?.message || error));
    return { started: false, reason: "disabled" };
  }

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

function cliOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

async function runDailyProfileNftWorkerCli() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log("Usage: node server/profile-nft-daily-worker.js backfill-manifest --run-dates YYYY-MM-DD,... --max-accounts 1..41 --output PATH | backfill-execute --manifest PATH --sha256 HASH [--dry-run]");
    return;
  }
  if (command === "backfill-manifest") {
    const output = cliOption(args, "--output");
    if (!output) throw new Error("profile_nft_daily_backfill_output_required");
    const manifest = await buildDailyProfileNftBackfillManifest({ runDates: cliOption(args, "--run-dates").split(",").filter(Boolean), maxAccounts: Number(cliOption(args, "--max-accounts")) });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, output, manifestHash: manifest.manifestHash, selectedCount: manifest.selectedCount, remainingCount: manifest.remainingCount }));
    return;
  }
  if (command === "backfill-execute") {
    if (process.env.TASKNODE_PROFILE_NFT_DAILY_BACKFILL_ENABLED !== "true") throw new Error("profile_nft_daily_backfill_disabled");
    const manifestPath = cliOption(args, "--manifest");
    const expectedHash = cliOption(args, "--sha256");
    if (!manifestPath || !expectedHash) throw new Error("profile_nft_daily_backfill_manifest_and_sha256_required");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const result = await runDailyProfileNftBackfill({ manifest, manifestHash: expectedHash, dryRun: args.includes("--dry-run") });
    const results = result.results || [];
    const failureRows = results.filter((item) => ["retry_wait", "failed_permanent"].includes(item.status));
    console.log(JSON.stringify({ ok: result.ok, dryRun: Boolean(result.dryRun), manifestHash: result.manifestHash || expectedHash, generationCount: results.filter((item) => item.status === "generated").length, failureCount: failureRows.length, retryableFailureCount: failureRows.filter((item) => item.retryable).length, permanentFailureCount: failureRows.filter((item) => !item.retryable).length, results }));
    return;
  }
  throw new Error("profile_nft_daily_worker_cli_command_invalid");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDailyProfileNftWorkerCli().catch((error) => {
    console.error(error?.code || error?.message || "profile_nft_daily_worker_cli_failed");
    process.exitCode = 1;
  });
}
