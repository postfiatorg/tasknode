import {
  boolEnv,
  hour,
  intEnv,
  iso,
  minute,
  oldestAgeMs,
} from "./system-status-base.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export const PROFILE_NFT_DAILY_SCOPE = "profile_nft_daily";
export const PROFILE_NFT_MAX_ATTEMPTS_DEFAULT = 3;
export const PROFILE_NFT_STALE_RUNNING_DEFAULT_MS = 20 * minute;
export const PROFILE_NFT_TICK_WARNING_MS = 2 * hour;
export const PROFILE_NFT_TICK_STALE_MS = 6 * hour;
export const PROFILE_NFT_SUCCESS_WARNING_MS = 30 * hour;
export const PROFILE_NFT_SUCCESS_STALE_MS = 72 * hour;

export const PROFILE_NFT_AUTH_ERROR_MARKERS = [
  "openai_not_configured",
  "profile_nft_private_prompt_required",
  "401",
  "403",
  "unauthorized",
  "invalid api key",
  "incorrect api key",
  "authentication",
  "permission",
];

export function profileNftMaxAttempts(env = process.env) {
  return intEnv(env.TASKNODE_PROFILE_NFT_DAILY_MAX_ATTEMPTS, PROFILE_NFT_MAX_ATTEMPTS_DEFAULT, { min: 1, max: 20 });
}

export function profileNftStaleRunningMs(env = process.env) {
  return intEnv(env.TASKNODE_PROFILE_NFT_DAILY_STALE_RUNNING_MS, PROFILE_NFT_STALE_RUNNING_DEFAULT_MS, {
    min: minute,
    max: 24 * hour,
  });
}

export function profileNftGenerationGated(env = process.env, heartbeat = null) {
  if (heartbeat && (
    heartbeat.generationGated === true
    || heartbeat.generation_gated === true
    || heartbeat.generation_enabled === false
    || heartbeat.generationEnabled === false
    || heartbeat.dryRun === true
    || heartbeat.dry_run === true
  )) {
    return true;
  }
  const generationEnabled = String(env.TASKNODE_PROFILE_NFT_DAILY_GENERATION_ENABLED ?? "true").toLowerCase();
  if (generationEnabled === "false" || generationEnabled === "0" || generationEnabled === "off") return true;
  const dryRun = String(env.TASKNODE_PROFILE_NFT_DAILY_DRY_RUN || env.PROFILE_NFT_DAILY_DRY_RUN || "").toLowerCase();
  return dryRun === "true" || dryRun === "1" || dryRun === "yes";
}

export function normalizeProfileNftErrorCode(message = "", statusText = "") {
  const blob = `${statusText} ${message}`.toLowerCase();
  if (!blob.trim()) return "";
  if (blob.includes("openai_not_configured") || blob.includes("openai not configured")) return "openai_not_configured";
  if (blob.includes("profile_nft_private_prompt_required")) return "profile_nft_private_prompt_required";
  if (/\b401\b/.test(blob) || blob.includes("unauthorized") || blob.includes("invalid api key") || blob.includes("incorrect api key")) {
    return "provider_auth_failed";
  }
  if (/\b403\b/.test(blob) || blob.includes("permission")) return "provider_permission_denied";
  if (blob.includes("timeout") || blob.includes("aborted")) return "generation_timeout";
  if (blob.includes("pinata") || blob.includes("ipfs")) return "ipfs_pin_failed";
  if (blob.includes("interrupted") || blob.includes("server restarted")) return "generation_interrupted";
  if (blob.includes("lease")) return "worker_lease_unavailable";
  if (blob.includes("database") || blob.includes("query")) return "database_query_failed";
  return "profile_nft_generation_failed";
}

export function isPermanentProfileNftError(code = "", message = "") {
  const permanent = new Set([
    "openai_not_configured",
    "profile_nft_private_prompt_required",
    "provider_auth_failed",
    "provider_permission_denied",
  ]);
  if (permanent.has(code)) return true;
  const blob = `${code} ${message}`.toLowerCase();
  return PROFILE_NFT_AUTH_ERROR_MARKERS.some((marker) => blob.includes(marker));
}

export function safeIso(value) {
  return iso(value);
}

/**
 * Pure evaluator used by /api/system/status and unit-like smoke coverage.
 * Heartbeat/run fields are optional and Ghash-compatible:
 * lastTickAt|tickAt|finishedAt|completedAt|startedAt|heartbeatAt,
 * generationGated|generation_gated|dryRun|dry_run,
 * lastErrorCode|errorCode|lastError|errorMessage|error,
 * status.
 */
export function evaluateDailyProfileNftWorkerState({
  nowMs = Date.now(),
  env = process.env,
  enabled = null,
  generationGated = null,
  awardsQueryOk = true,
  awardsQueryError = "",
  heartbeatQueryOk = true,
  heartbeat = null,
  lease = null,
  counts = {},
  latestAward = null,
  latestSuccessAt = null,
  oldestRunningAt = null,
  permanentFailedCount = 0,
  retryableFailedCount = 0,
  pendingCount = 0,
  runningCount = 0,
  recentFailedCount = 0,
  maxAttempts = null,
  staleRunningMs = null,
  intervalMs = null,
} = {}) {
  const workerEnabled = enabled == null
    ? boolEnv(env.TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED)
    : Boolean(enabled);
  const gated = generationGated == null
    ? profileNftGenerationGated(env, heartbeat)
    : Boolean(generationGated);
  const attemptsCap = maxAttempts == null ? profileNftMaxAttempts(env) : Number(maxAttempts);
  const staleRunMs = staleRunningMs == null ? profileNftStaleRunningMs(env) : Number(staleRunningMs);
  const cadenceMs = intervalMs == null
    ? intEnv(env.TASKNODE_PROFILE_NFT_DAILY_INTERVAL_MS, hour, { min: minute })
    : Number(intervalMs);

  const hb = heartbeat && typeof heartbeat === "object" ? heartbeat : null;
  const lastTickStartedAt = safeIso(
    hb?.last_tick_started_at || hb?.lastTickStartedAt || hb?.startedAt || hb?.started_at || null
  );
  const lastTickEndedAt = safeIso(
    hb?.last_tick_finished_at || hb?.lastTickFinishedAt || hb?.finishedAt || hb?.completedAt || hb?.endedAt || null
  );
  const lastTickAt = safeIso(
    lastTickEndedAt
      || lastTickStartedAt
      || hb?.lastTickAt
      || hb?.tickAt
      || hb?.updated_at
      || hb?.updatedAt
      || null
  );
  const leaseHeartbeatAt = safeIso(lease?.heartbeat_at || lease?.heartbeatAt || null);
  const effectiveTickAt = lastTickAt || leaseHeartbeatAt;
  const heartbeatSuccessAt = safeIso(hb?.last_success_at || hb?.lastSuccessAt || null);
  const successAt = safeIso(latestSuccessAt || heartbeatSuccessAt);
  const oldestRunning = safeIso(oldestRunningAt);
  const latestErrorMessage = safeText(
    hb?.last_error_message
      || hb?.lastErrorMessage
      || hb?.lastError
      || hb?.errorMessage
      || hb?.error
      || latestAward?.error
      || awardsQueryError
      || "",
    1000
  );
  const latestErrorCode = safeText(
    hb?.last_error_code
      || hb?.lastErrorCode
      || hb?.errorCode
      || normalizeProfileNftErrorCode(latestErrorMessage, latestAward?.status || ""),
    120
  );
  const dbRetryable = Number(retryableFailedCount || 0);
  const dbPermanent = Number(permanentFailedCount || 0);
  // Award-table counts are authoritative for durable queues. Heartbeat tick
  // metrics may lag or zero out after an empty fresh tick; use max so heartbeat
  // zero cannot hide nonzero award backlog (and higher heartbeat remains visible).
  const hbRetryableRaw = hb?.retryable_count ?? hb?.retryableCount;
  const hbPermanentRaw = hb?.permanent_count ?? hb?.permanentCount;
  const hbRetryable = hbRetryableRaw == null || hbRetryableRaw === "" ? 0 : Number(hbRetryableRaw);
  const hbPermanent = hbPermanentRaw == null || hbPermanentRaw === "" ? 0 : Number(hbPermanentRaw);
  const mergedRetryable = Math.max(dbRetryable, Number.isFinite(hbRetryable) ? hbRetryable : 0);
  const mergedPermanent = Math.max(dbPermanent, Number.isFinite(hbPermanent) ? hbPermanent : 0);
  const currentRetryAwardId = safeText(hb?.current_retry_award_id || hb?.currentRetryAwardId || "", 180);
  const nextRetryAt = safeIso(hb?.next_retry_at || hb?.nextRetryAt || null);
  const candidateCount = Number(hb?.candidate_count ?? hb?.candidateCount ?? 0);
  const countsOut = {
    ...counts,
    pending: Number(pendingCount || counts.pending || 0),
    running: Number(runningCount || counts.running || 0),
    failed: Number(counts.failed || 0),
    generated: Number(counts.generated || 0),
    skipped: Number(counts.skipped || 0),
    retryableFailed: mergedRetryable,
    permanentFailed: mergedPermanent,
    staleRunning: 0,
    recentFailed: Number(recentFailedCount || 0),
    candidateCount: Number(candidateCount || 0),
    currentRetryAwardId,
    nextRetryAt,
  };
  if (oldestRunning && oldestAgeMs(oldestRunning, nowMs) > staleRunMs) {
    countsOut.staleRunning = Math.max(1, countsOut.running || 1);
  }

  const base = {
    id: "daily_profile_nft_worker",
    category: "memory",
    title: "Daily Profile NFT Worker",
    description: "Generates one claimable Profile NFT award per eligible account per UTC day.",
    owner: "worker:airdrop process",
    trigger: "interval timer with leased profile_nft_daily scope",
    cadence: `${cadenceMs}ms`,
    enabled: workerEnabled,
    generationGated: gated,
    generationEnabled: !gated,
    lastTickAt: effectiveTickAt,
    lastTickStartedAt,
    lastTickEndedAt: lastTickEndedAt || effectiveTickAt,
    lastSuccessAt: successAt,
    lastErrorCode: latestErrorCode,
    lastError: latestErrorMessage,
    counts: countsOut,
    maxAttempts: attemptsCap,
    staleRunningMs: staleRunMs,
    currentRetryAwardId,
    nextRetryAt,
    candidateCount,
    workerState: "unknown",
    reason: "",
  };

  if (!awardsQueryOk) {
    return {
      ...base,
      status: "critical",
      statusLabel: "Failing",
      workerState: "failing",
      reason: "database_query_failed",
      lastErrorCode: latestErrorCode || "database_query_failed",
      lastError: latestErrorMessage || "profile_nft_daily_awards query failed",
      lastRunAt: effectiveTickAt,
      staleAfterMs: PROFILE_NFT_TICK_STALE_MS,
      details: [
        "workerState=failing",
        "reason=database_query_failed",
        `enabled=${workerEnabled}`,
        `generationGated=${gated}`,
        !heartbeatQueryOk && "heartbeatQuery=failed_or_unavailable",
      ],
    };
  }

  if (!workerEnabled) {
    return {
      ...base,
      status: "disabled",
      statusLabel: "Disabled",
      workerState: "disabled",
      reason: "worker_disabled",
      lastRunAt: effectiveTickAt || successAt,
      staleAfterMs: null,
      details: [
        "workerState=disabled",
        "reason=TASKNODE_PROFILE_NFT_DAILY_WORKER_ENABLED is not true",
        `generationGated=${gated}`,
      ],
    };
  }

  const permanentFailure = isPermanentProfileNftError(latestErrorCode, latestErrorMessage)
    || (mergedPermanent > 0 && isPermanentProfileNftError(latestErrorCode, latestErrorMessage));
  if (permanentFailure) {
    return {
      ...base,
      status: "critical",
      statusLabel: "Failing",
      workerState: "failing",
      reason: latestErrorCode || "permanent_generation_failure",
      lastRunAt: effectiveTickAt || safeIso(latestAward?.updated_at || latestAward?.completed_at),
      staleAfterMs: PROFILE_NFT_SUCCESS_STALE_MS,
      details: [
        "workerState=failing",
        `reason=${latestErrorCode || "permanent_generation_failure"}`,
        `permanentFailed=${countsOut.permanentFailed}`,
        `retryableFailed=${countsOut.retryableFailed}`,
        `generationGated=${gated}`,
        successAt && `lastSuccess=${successAt}`,
      ],
    };
  }

  if (countsOut.staleRunning > 0) {
    return {
      ...base,
      status: "critical",
      statusLabel: "Stale running",
      workerState: "stale",
      reason: "stale_running_award",
      lastRunAt: oldestRunning || effectiveTickAt,
      staleAfterMs: staleRunMs,
      details: [
        "workerState=stale",
        "reason=stale_running_award",
        oldestRunning && `oldestRunning=${oldestRunning}`,
        `staleRunningMs=${staleRunMs}`,
        `generationGated=${gated}`,
        successAt && `lastSuccess=${successAt}`,
      ],
    };
  }

  const tickReference = effectiveTickAt;
  const successAgeMs = successAt ? oldestAgeMs(successAt, nowMs) : null;
  const tickAgeMs = tickReference ? oldestAgeMs(tickReference, nowMs) : null;

  if (gated) {
    // Gated generation is not healthy "producing NFTs"; operator-visible amber/ok with explicit state
    const gatedHealthyTick = tickAgeMs != null && tickAgeMs <= PROFILE_NFT_TICK_WARNING_MS;
    return {
      ...base,
      status: gatedHealthyTick ? "ok" : "warning",
      statusLabel: gatedHealthyTick ? "Generation gated" : "Gated / no recent tick",
      workerState: gatedHealthyTick ? "healthy" : "stale",
      reason: "generation_gated",
      lastRunAt: tickReference || successAt,
      staleAfterMs: PROFILE_NFT_TICK_STALE_MS,
      details: [
        `workerState=${gatedHealthyTick ? "healthy" : "stale"}`,
        "reason=generation_gated",
        "generationEnabled=false",
        tickReference && `lastTick=${tickReference}`,
        successAt && `lastSuccess=${successAt}`,
        "Note=worker may tick without producing images while gated",
      ],
    };
  }

  // No tick and no success information => stale once enabled long enough; "waiting" only if never had work but ticker not verified
  if (!tickReference && !successAt) {
    return {
      ...base,
      status: "warning",
      statusLabel: "No tick data",
      workerState: "stale",
      reason: "no_tick_or_success",
      lastRunAt: null,
      staleAfterMs: PROFILE_NFT_TICK_STALE_MS,
      details: [
        "workerState=stale",
        "reason=no_tick_or_success",
        "enabled=true",
        "Never treat enabled-only as healthy",
      ],
    };
  }

  if (tickAgeMs != null && tickAgeMs > PROFILE_NFT_TICK_STALE_MS) {
    return {
      ...base,
      status: "critical",
      statusLabel: "Stale",
      workerState: "stale",
      reason: "tick_stale",
      lastRunAt: tickReference,
      staleAfterMs: PROFILE_NFT_TICK_STALE_MS,
      details: [
        "workerState=stale",
        "reason=tick_stale",
        `lastTick=${tickReference}`,
        successAt && `lastSuccess=${successAt}`,
      ],
    };
  }

  if ((tickAgeMs != null && tickAgeMs > PROFILE_NFT_TICK_WARNING_MS)
    || (successAgeMs != null && successAgeMs > PROFILE_NFT_SUCCESS_WARNING_MS && successAgeMs <= PROFILE_NFT_SUCCESS_STALE_MS)) {
    return {
      ...base,
      status: "warning",
      statusLabel: successAgeMs != null && successAgeMs > PROFILE_NFT_SUCCESS_WARNING_MS ? "Success lagging" : "Tick lagging",
      workerState: "stale",
      reason: successAgeMs != null && successAgeMs > PROFILE_NFT_SUCCESS_WARNING_MS ? "success_lagging" : "tick_lagging",
      lastRunAt: tickReference || successAt,
      staleAfterMs: PROFILE_NFT_SUCCESS_STALE_MS,
      details: [
        "workerState=stale",
        `reason=${successAgeMs != null && successAgeMs > PROFILE_NFT_SUCCESS_WARNING_MS ? "success_lagging" : "tick_lagging"}`,
        tickReference && `lastTick=${tickReference}`,
        successAt && `lastSuccess=${successAt}`,
        countsOut.recentFailed > 0 && `recentFailed=${countsOut.recentFailed}`,
      ],
    };
  }

  if (successAgeMs != null && successAgeMs > PROFILE_NFT_SUCCESS_STALE_MS) {
    return {
      ...base,
      status: "critical",
      statusLabel: "Stale",
      workerState: "stale",
      reason: "success_stale",
      lastRunAt: tickReference || successAt,
      staleAfterMs: PROFILE_NFT_SUCCESS_STALE_MS,
      details: [
        "workerState=stale",
        "reason=success_stale",
        `lastSuccess=${successAt}`,
        tickReference && `lastTick=${tickReference}`,
      ],
    };
  }

  // Fresh tick and no permanent auth failure => healthy, even with zero pending (may wait for eligible)
  return {
    ...base,
    status: "ok",
    statusLabel: "Healthy",
    workerState: "healthy",
    reason: tickReference ? "fresh_tick" : "recent_success",
    lastRunAt: tickReference || successAt,
    staleAfterMs: PROFILE_NFT_SUCCESS_STALE_MS,
    details: [
      "workerState=healthy",
      `reason=${tickReference ? "fresh_tick" : "recent_success"}`,
      `enabled=true`,
      `generationGated=false`,
      tickReference && `lastTick=${tickReference}`,
      successAt && `lastSuccess=${successAt}`,
      countsOut.pending > 0 && `pending=${countsOut.pending}`,
      countsOut.retryableFailed > 0 && `retryableFailed=${countsOut.retryableFailed}`,
      !successAt && "No generated award yet; worker timer observed",
    ],
  };
}
