import { createHmac } from "node:crypto";
import { databaseEnabled, query } from "./db/pool.js";
import { listValidatorBindings } from "./repositories/validator-bindings.js";
import { activeBlacklistEntry } from "./value-accountability.js";
import { fetchL1Registry, l1RewardEligibility, registeredL1Validator } from "./l1-validator-identity.js";
import { loadLatestTop30Snapshot, lookupTop30Entitlement } from "./finance-hub-top30.js";

export const FINANCE_HUB_TIER = "finance_hub";
export const LEGACY_VALIDATOR_TIER = "validator";
export const PUBLIC_SAFE_TIER = "public_safe";
export const FINANCE_HUB_PROTECTED_INDICES = new Set(["ga-models", "goodbrief"]);

export const GOODBRIEF_SANDBOX_ATTR = "allow-scripts";
export const GOODBRIEF_SRCDOC_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'";

const VALIDATOR_GRACE_MS = 14 * 86_400_000;
const VALIDATOR_RAMP_IN_MS = 30 * 86_400_000;
const STALE_FEED_WINDOW_MS = 3600_000;

export function isFinanceHubProtectedIndex(indexId = "", index = null) {
  const normalized = String(indexId || "").trim();
  if (FINANCE_HUB_PROTECTED_INDICES.has(normalized)) return true;
  if (index?.tier === FINANCE_HUB_TIER || index?.tier === LEGACY_VALIDATOR_TIER) return true;
  return Boolean(index?.metadata?.wholeBundleDisabled === true);
}

export function allowedBasesForIndex(index = null, tier = "") {
  const raw = index?.metadata?.allowedBases ?? index?.metadata?.allowed_bases;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const effectiveTier = String(index?.tier || tier || "");
  if (effectiveTier === PUBLIC_SAFE_TIER) return ["public"];
  if (effectiveTier === FINANCE_HUB_TIER || effectiveTier === LEGACY_VALIDATOR_TIER) {
    return ["validator", "top30", "grace"];
  }
  return [];
}

export async function activeFinanceHubSuspension(accountId = "", queryImpl = query) {
  const id = String(accountId || "").trim();
  if (!id || (!databaseEnabled() && queryImpl === query)) return null;
  const result = await queryImpl(
    `SELECT id, account_id, reason_code, reason, created_at, expires_at
       FROM finance_hub_suspensions
      WHERE account_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

const VALIDATOR_ACCESS_FIELDS = "access_state, recorded_at, expires_at";

/** Last authorized state recorded for a binding by a fresh Pillar 3 decision (null when none). */
export async function readRecordedValidatorAccess(binding = {}, queryImpl = query) {
  const bindingId = String(binding?.id || "");
  if (!bindingId || (!databaseEnabled() && queryImpl === query)) return null;
  const result = await queryImpl(
    `SELECT ${VALIDATOR_ACCESS_FIELDS} FROM finance_hub_validator_access WHERE binding_id = $1`,
    [bindingId]
  );
  return result.rows[0] || null;
}

export async function recordValidatorAccess(binding = {}, state = {}, queryImpl = query) {
  const bindingId = String(binding?.id || "");
  if (!bindingId || (!databaseEnabled() && queryImpl === query)) return;
  await queryImpl(
    `INSERT INTO finance_hub_validator_access (binding_id, access_state, recorded_at, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (binding_id) DO UPDATE
       SET access_state = EXCLUDED.access_state, recorded_at = EXCLUDED.recorded_at, expires_at = EXCLUDED.expires_at`,
    [bindingId, state.access_state, state.recorded_at, state.expires_at ?? null]
  );
}

function registryRowForBinding(registry, binding) {
  try {
    return registeredL1Validator(registry, {
      validatorId: binding.validator_id,
      publicKey: binding.ml_dsa_public_key,
      chainId: binding.chain_id,
    });
  } catch (error) {
    // Pillar 3: falling out of the registry enters `lapsed` (14-day grace), so an
    // inactive row with the binding's current key may still carry a lapse grace.
    if (error?.message !== "l1_validator_inactive") return null;
    const row = registry.validators.find((item) => item.validator_id === binding.validator_id);
    return row?.ml_dsa_public_key === binding.ml_dsa_public_key ? row : null;
  }
}

function isoOrNull(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Evaluates Pillar 3 active-liveness state for an account's validator bindings.
 * Every grant comes from a fresh registry decision or from a state recorded by one:
 * - Fresh active/pending (or eligible, or within a 30-day ramp-in from a recorded
 *   `bound_at`): basis `validator`; records `active`, preservable for 14 days.
 * - Fresh lapse: basis `grace` until a fixed end taken from the feed (`grace_ends_at`
 *   or `lapsed_at` + 14 days), else the recorded grace, else 14 days after the last
 *   recorded active state. A lapse with no recorded start is refused.
 * - Stale (> 3600s) or unreachable feed: only an unexpired recorded `active` or
 *   `lapsed` state is preserved; a recorded `revoked`, no record, or a failed
 *   lookup is refused. Binding age never creates access.
 * - Legacy devnet/testnet bindings remain valid until `FINANCE_HUB_LEGACY_VALIDATOR_SUNSET=true`.
 */
export async function evaluateValidatorFinanceHubState({
  bindings = [],
  loadL1Registry = fetchL1Registry,
  readRecordedState = readRecordedValidatorAccess,
  recordState = recordValidatorAccess,
  now = new Date(),
  env = process.env,
} = {}) {
  if (!Array.isArray(bindings) || !bindings.length) {
    return { ok: false, basis: null, validatorState: "none", graceEndsAt: null, feedStale: false };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();
  const legacySunset = env.FINANCE_HUB_LEGACY_VALIDATOR_SUNSET === "true";

  let bestGrace = null;
  const offerGrace = (graceEndsAt, feedStale) => {
    if (!graceEndsAt || Date.parse(graceEndsAt) <= nowMs) return;
    if (!bestGrace || Date.parse(graceEndsAt) > Date.parse(bestGrace.graceEndsAt)) {
      bestGrace = { ok: true, basis: "grace", validatorState: "lapsed", graceEndsAt, feedStale };
    }
  };
  let registryPromise = null;
  const getRegistry = () => {
    if (!registryPromise) {
      registryPromise = Promise.resolve()
        .then(() => loadL1Registry({ now: nowDate }))
        .then((registry) => ({ ok: true, registry }))
        .catch((error) => ({ ok: false, error }));
    }
    return registryPromise;
  };
  const readRecorded = (binding) => Promise.resolve()
    .then(() => readRecordedState(binding))
    .then((state) => ({ ok: true, state: state || null }))
    .catch(() => ({ ok: false, state: null }));
  const record = (binding, state) => Promise.resolve()
    .then(() => recordState(binding, state))
    .then(() => true)
    .catch(() => false);

  for (const binding of bindings) {
    if (binding?.revoked_at) continue;
    const network = String(binding?.network || "");

    if (network !== "l1-devnet") {
      if (!legacySunset) {
        return { ok: true, basis: "validator", validatorState: "active_legacy", graceEndsAt: null, feedStale: false };
      }
      continue;
    }

    // Explicit Pillar 3 state if attached to the binding / registry projection.
    const explicitState = String(binding.p3_access_state || binding.access_state || "").toLowerCase();
    if (explicitState === "active" || explicitState === "pending") {
      return { ok: true, basis: "validator", validatorState: explicitState, graceEndsAt: null, feedStale: false };
    }
    if (explicitState === "lapsed") {
      offerGrace(isoOrNull(binding.grace_ends_at), false);
      continue;
    }
    if (explicitState === "revoked") continue;

    const loaded = await getRegistry();
    const registry = loaded.ok ? loaded.registry : null;
    const feedAgeMs = nowMs - Date.parse(registry?.generated_at || "");
    if (!loaded.ok || !Number.isFinite(feedAgeMs) || feedAgeMs > STALE_FEED_WINDOW_MS) {
      // A stale or unreachable feed preserves only the last recorded authorized state.
      const recorded = await readRecorded(binding);
      const expiresAt = isoOrNull(recorded.state?.expires_at);
      if (!expiresAt || Date.parse(expiresAt) <= nowMs) continue;
      if (recorded.state.access_state === "active") {
        return { ok: true, basis: "validator", validatorState: "stale_feed_preserved", graceEndsAt: null, feedStale: true };
      }
      if (recorded.state.access_state === "lapsed") offerGrace(expiresAt, true);
      continue;
    }

    const row = registryRowForBinding(registry, binding);
    const rowState = String(row?.access_state || "").toLowerCase();
    const revoke = () => record(binding, { access_state: "revoked", recorded_at: nowIso, expires_at: null });
    if (!row || rowState === "revoked") {
      await revoke();
      continue;
    }

    let authorized = false;
    if (row.active === true && (rowState === "active" || rowState === "pending")) {
      authorized = rowState;
    } else if (row.active === true && rowState !== "lapsed") {
      // Derive eligibility from Pillar 3 uptime/participation + 30-day Day-0 ramp-in
      // counted from a recorded binding time.
      const eligibility = l1RewardEligibility(row, nowDate, env);
      const boundAtMs = Date.parse(binding.bound_at || binding.boundAt || "");
      const withinRampIn = Number.isFinite(boundAtMs) && boundAtMs <= nowMs && nowMs - boundAtMs <= VALIDATOR_RAMP_IN_MS;
      if (eligibility.eligible) authorized = "active";
      else if (!eligibility.available && withinRampIn) authorized = "pending";
    }
    if (authorized) {
      await record(binding, {
        access_state: "active",
        recorded_at: nowIso,
        expires_at: new Date(nowMs + VALIDATOR_GRACE_MS).toISOString(),
      });
      return { ok: true, basis: "validator", validatorState: authorized, graceEndsAt: null, feedStale: false };
    }

    // Lapsed (out of the registry, below threshold, or past ramp-in without history):
    // grace runs from a fixed, recorded start and is never re-issued per request.
    const lapsedAtMs = Date.parse(row.lapsed_at || "");
    let graceEndsAt = isoOrNull(row.grace_ends_at)
      || (Number.isFinite(lapsedAtMs) ? new Date(lapsedAtMs + VALIDATOR_GRACE_MS).toISOString() : null);
    if (!graceEndsAt) {
      const recorded = await readRecorded(binding);
      const recordedAtMs = Date.parse(recorded.state?.recorded_at || "");
      if (recorded.state?.access_state === "lapsed") graceEndsAt = isoOrNull(recorded.state.expires_at);
      else if (recorded.state?.access_state === "active" && Number.isFinite(recordedAtMs)) {
        graceEndsAt = new Date(recordedAtMs + VALIDATOR_GRACE_MS).toISOString();
      }
    }
    if (!graceEndsAt || Date.parse(graceEndsAt) <= nowMs) {
      await revoke();
      continue;
    }
    await record(binding, { access_state: "lapsed", recorded_at: nowIso, expires_at: graceEndsAt });
    offerGrace(graceEndsAt, false);
  }

  if (bestGrace) return bestGrace;
  return { ok: false, basis: null, validatorState: "revoked", graceEndsAt: null, feedStale: false };
}

/**
 * Unified Pillar 9 access gate (`accountMeetsTier("finance_hub")`).
 * Always fails closed on missing account, active blacklist, active suspension,
 * unknown tier, or publication `allowed_bases` mismatch.
 */
export async function evaluateFinanceHubAccess({
  accountId = "",
  tier = FINANCE_HUB_TIER,
  index = null,
  now = new Date(),
  env = process.env,
  getBlacklist = activeBlacklistEntry,
  getSuspension = activeFinanceHubSuspension,
  getValidatorBindings = listValidatorBindings,
  loadL1Registry = fetchL1Registry,
  readValidatorAccess = readRecordedValidatorAccess,
  recordValidatorAccessState = recordValidatorAccess,
  getTop30Snapshot = loadLatestTop30Snapshot,
} = {}) {
  const allowedBases = allowedBasesForIndex(index, tier);

  if (tier === PUBLIC_SAFE_TIER) {
    if (!allowedBases.includes("public")) {
      return {
        ok: false,
        reason: "publication_basis_not_allowed",
        basis: null,
        validatorState: null,
        entitlementState: null,
        rank: null,
        snapshotAt: null,
        graceEndsAt: null,
        walletAddress: "",
      };
    }
    return {
      ok: true,
      reason: "",
      basis: "public",
      validatorState: null,
      entitlementState: "public_safe",
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  if (tier !== FINANCE_HUB_TIER && tier !== LEGACY_VALIDATOR_TIER) {
    return {
      ok: false,
      reason: "unsupported_tier",
      basis: null,
      validatorState: null,
      entitlementState: null,
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  const normalizedId = String(accountId || "").trim();
  if (!normalizedId) {
    return {
      ok: false,
      reason: "not_signed_in",
      basis: null,
      validatorState: null,
      entitlementState: null,
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  // Fail closed on blacklist or Finance Hub operator suspension; a lookup that
  // fails is "unavailable", never "no restriction".
  const unavailable = Symbol("unavailable");
  const [blacklisted, suspended] = await Promise.all([
    Promise.resolve().then(() => getBlacklist({ accountId: normalizedId })).catch(() => unavailable),
    Promise.resolve().then(() => getSuspension(normalizedId)).catch(() => unavailable),
  ]);
  if (blacklisted === unavailable || suspended === unavailable) {
    return {
      ok: false,
      reason: "access_check_unavailable",
      basis: null,
      validatorState: null,
      entitlementState: "unavailable",
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }
  if (blacklisted) {
    return {
      ok: false,
      reason: "account_blacklisted",
      basis: null,
      validatorState: null,
      entitlementState: "blacklisted",
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }
  if (suspended) {
    return {
      ok: false,
      reason: "finance_hub_suspended",
      basis: null,
      validatorState: null,
      entitlementState: "suspended",
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  // 1. Check Active Pillar 3 Validator state first.
  const bindings = await getValidatorBindings(normalizedId);
  const validatorResult = await evaluateValidatorFinanceHubState({
    bindings,
    loadL1Registry,
    readRecordedState: readValidatorAccess,
    recordState: recordValidatorAccessState,
    now,
    env,
  });

  if (validatorResult.ok && validatorResult.basis === "validator") {
    if (!allowedBases.includes("validator")) {
      return {
        ok: false,
        reason: "publication_basis_not_allowed",
        basis: "validator",
        validatorState: validatorResult.validatorState,
        entitlementState: "validator",
        rank: null,
        snapshotAt: null,
        graceEndsAt: null,
        walletAddress: "",
      };
    }
    return {
      ok: true,
      reason: "",
      basis: "validator",
      validatorState: validatorResult.validatorState,
      entitlementState: "validator",
      rank: null,
      snapshotAt: null,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  // 2. Check Daily Top-30 non-validator snapshot (including rank 31-35 hysteresis + 7d grace).
  const snapshot = await Promise.resolve(getTop30Snapshot()).catch(() => null);
  const top30 = lookupTop30Entitlement(snapshot, normalizedId, now);

  if (top30.ok && top30.basis === "top30") {
    if (!allowedBases.includes("top30")) {
      return {
        ok: false,
        reason: "publication_basis_not_allowed",
        basis: "top30",
        validatorState: validatorResult.validatorState,
        entitlementState: top30.entitlementState,
        rank: top30.rank,
        snapshotAt: top30.snapshotAt,
        graceEndsAt: null,
        walletAddress: "",
      };
    }
    return {
      ok: true,
      reason: "",
      basis: "top30",
      validatorState: validatorResult.validatorState,
      entitlementState: top30.entitlementState,
      rank: top30.rank,
      snapshotAt: top30.snapshotAt,
      graceEndsAt: null,
      walletAddress: "",
    };
  }

  // 3. Grace window (either lapsed Pillar 3 validator 14d grace or Top-30 7d grace).
  const graceCandidate = validatorResult.ok && validatorResult.basis === "grace"
    ? {
        basis: "grace",
        validatorState: validatorResult.validatorState,
        entitlementState: "validator_grace_14d",
        rank: top30.rank,
        snapshotAt: top30.snapshotAt,
        graceEndsAt: validatorResult.graceEndsAt,
      }
    : top30.ok && top30.basis === "grace"
      ? {
          basis: "grace",
          validatorState: validatorResult.validatorState,
          entitlementState: top30.entitlementState,
          rank: top30.rank,
          snapshotAt: top30.snapshotAt,
          graceEndsAt: top30.graceEndsAt,
        }
      : null;

  if (graceCandidate) {
    if (!allowedBases.includes("grace")) {
      return {
        ok: false,
        reason: "publication_basis_not_allowed",
        ...graceCandidate,
        walletAddress: "",
      };
    }
    return {
      ok: true,
      reason: "",
      ...graceCandidate,
      walletAddress: "",
    };
  }

  return {
    ok: false,
    reason: tier === LEGACY_VALIDATOR_TIER ? "validator_required" : "finance_hub_access_required",
    basis: null,
    validatorState: validatorResult.validatorState,
    entitlementState: top30.entitlementState,
    rank: top30.rank,
    snapshotAt: top30.snapshotAt,
    graceEndsAt: top30.graceEndsAt,
    walletAddress: "",
  };
}

/**
 * Deterministic, unforgeable per-user watermark hook for Finance Hub responses.
 */
export function buildFinanceHubWatermark({
  accountId = "",
  basis = "",
  indexId = "",
  filePath = "",
  issuedAt = new Date(),
  secret = process.env.FINANCE_HUB_WATERMARK_SECRET || process.env.SESSION_SECRET || "tasknode-finance-hub-wm-v1",
} = {}) {
  const day = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString().slice(0, 10);
  const id = createHmac("sha256", String(secret))
    .update(`pf.fh.wm.v1\n${accountId}\n${basis}\n${day}`)
    .digest("hex")
    .slice(0, 16);
  const requestDigest = createHmac("sha256", String(secret))
    .update(`pf.fh.req.v1\n${id}\n${indexId}\n${filePath}`)
    .digest("hex")
    .slice(0, 12);
  const watermarkId = `fh-${id}-${requestDigest}`;
  return {
    watermarkId,
    accountTag: id,
    basis,
    day,
    headerName: "x-finance-hub-watermark",
    headerValue: watermarkId,
    metaTag: `<meta name="pf-fh-wm" content="${watermarkId}">`,
  };
}

export function injectHtmlWatermark(htmlBuffer, watermark) {
  if (!watermark?.watermarkId) return htmlBuffer;
  const text = Buffer.isBuffer(htmlBuffer) ? htmlBuffer.toString("utf8") : String(htmlBuffer || "");
  if (!/<head[^>]*>/i.test(text)) return htmlBuffer;
  const stamped = text.replace(/<head([^>]*)>/i, `<head$1>${watermark.metaTag}`);
  return Buffer.from(stamped, "utf8");
}

function escapeAttr(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Prepares Goodbrief HTML for rendering inside `<iframe sandbox="allow-scripts">`
 * via `srcdoc` with zero network exfiltration (`connect-src 'none'`) and zero
 * origin access (no `allow-same-origin`).
 */
export function prepareGoodbriefSrcDoc(rawHtml = "", { watermarkId = "", title = "Goodbrief" } = {}) {
  let html = String(rawHtml || "");
  // Strip dangerous tags that could redirect, nest frames, or attempt external fetches.
  html = html
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?https?:[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "");

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(GOODBRIEF_SRCDOC_CSP)}">`;
  const wmMeta = watermarkId ? `<meta name="pf-fh-wm" content="${escapeAttr(watermarkId)}">` : "";
  const wmFooter = watermarkId
    ? `<div data-pf-fh-wm="${escapeAttr(watermarkId)}" style="margin-top:24px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2);font:11px/1.4 monospace;opacity:.45;user-select:none;">Post Fiat Finance Hub · ${escapeAttr(watermarkId)}</div>`
    : "";

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${cspMeta}${wmMeta}`);
    if (wmFooter) {
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${wmFooter}</body>`) : `${html}${wmFooter}`;
    }
    return html;
  }

  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta}${wmMeta}<title>${escapeAttr(title)}</title></head><body>${html}${wmFooter}</body></html>`;
}

/**
 * Per-account Finance Hub rate limiter + unusual-scrape detector + audit hook.
 */
export function createFinanceHubAccessGuard({
  maxRequestsPerWindow = 180,
  windowMs = 60_000,
  scrapeWindowMs = 5 * 60_000,
  scrapeUniqueFilesThreshold = 120,
  onAccessLog = null,
  onScrapeAlert = (alert) => console.warn("finance_hub_scrape_anomaly", JSON.stringify(alert)),
} = {}) {
  const windows = new Map();
  const scrapeWindows = new Map();

  return function checkAndRecord({ accountId = "", indexId = "", filePath = "", basis = "", watermarkId = "", nowMs = Date.now() }) {
    const id = String(accountId || "").trim();
    if (!id) return { allowed: true, scrapeAlerted: false };

    let rate = windows.get(id);
    if (!rate || nowMs - rate.startedAt >= windowMs) {
      rate = { startedAt: nowMs, count: 0 };
      windows.set(id, rate);
    }
    rate.count += 1;
    if (rate.count > maxRequestsPerWindow) {
      const retryAfterSeconds = Math.max(1, Math.ceil((rate.startedAt + windowMs - nowMs) / 1000));
      return { allowed: false, retryAfterSeconds, scrapeAlerted: false };
    }

    let scrape = scrapeWindows.get(id);
    if (!scrape || nowMs - scrape.startedAt >= scrapeWindowMs) {
      scrape = { startedAt: nowMs, files: new Set(), alerted: false };
      scrapeWindows.set(id, scrape);
    }
    scrape.files.add(`${indexId}:${filePath}`);
    let scrapeAlerted = false;
    if (!scrape.alerted && scrape.files.size >= scrapeUniqueFilesThreshold) {
      scrape.alerted = true;
      scrapeAlerted = true;
      onScrapeAlert?.({
        accountId: id,
        indexId,
        uniqueFiles: scrape.files.size,
        windowMs: scrapeWindowMs,
        watermarkId,
        at: new Date(nowMs).toISOString(),
      });
    }

    onAccessLog?.({
      accountId: id,
      indexId,
      filePath,
      basis,
      watermarkId,
      at: new Date(nowMs).toISOString(),
    });

    return { allowed: true, scrapeAlerted };
  };
}
