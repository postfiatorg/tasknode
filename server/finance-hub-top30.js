import { databaseEnabled, query, transaction } from "./db/pool.js";
import {
  DIRECTORY_LEADERBOARD_RANK_FORMULA,
  directoryLeaderboardScore,
} from "./repositories/directory-leaderboard.js";
import { alignmentByAccountSql, alignmentScore0To100 } from "./repositories/alignment-score.js";
import { canonicalRewardedTaskProjectionSql } from "./repositories/task-projection-integrity.js";

export const TOP30_SNAPSHOT_SCHEMA_VERSION = "finance-hub.top30-snapshot.v1";
export const TOP30_SEAT_COUNT = 30;
export const TOP30_KEEP_UNTIL_RANK = 35;
export const TOP30_GRACE_DAYS = 7;
export const TOP30_GRACE_COOLDOWN_DAYS = 30;

const DAY_MS = 86_400_000;

function toUtcIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeInt(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function safeNum(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Number(parsed.toFixed(6))) : 0;
}

function safeAlignment(value = 0) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, Number(parsed.toFixed(6))));
}

function normalizeAccountId(value = "") {
  return String(value || "").trim().slice(0, 180);
}

function snapshotIdFor(iso) {
  return `top30-${iso.replace(/:/g, "-")}`;
}

function compareCandidates(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (right.network_tasks !== left.network_tasks) return right.network_tasks - left.network_tasks;
  if (right.rewards_pft !== left.rewards_pft) return right.rewards_pft - left.rewards_pft;
  if (left.account_id < right.account_id) return -1;
  if (left.account_id > right.account_id) return 1;
  return 0;
}

function previousEntriesMap(previousSnapshot) {
  const map = new Map();
  if (!previousSnapshot || !Array.isArray(previousSnapshot.entries)) return map;
  for (const entry of previousSnapshot.entries) {
    const id = normalizeAccountId(entry?.account_id);
    if (id) map.set(id, entry);
  }
  return map;
}

function normalizeCooldownMap(cooldownHistory, previousEntries) {
  const map = new Map();
  if (cooldownHistory instanceof Map) {
    for (const [key, value] of cooldownHistory.entries()) {
      if (key && value) map.set(normalizeAccountId(key), toUtcIso(value));
    }
  } else if (cooldownHistory && typeof cooldownHistory === "object") {
    for (const [key, value] of Object.entries(cooldownHistory)) {
      if (key && value) map.set(normalizeAccountId(key), toUtcIso(value));
    }
  }
  for (const [id, entry] of previousEntries.entries()) {
    if (entry?.grace_cooldown_until) {
      const existing = map.get(id);
      if (!existing || Date.parse(entry.grace_cooldown_until) > Date.parse(existing)) {
        map.set(id, toUtcIso(entry.grace_cooldown_until));
      }
    }
  }
  return map;
}

/**
 * Pure deterministic Top-30 daily snapshot engine matching
 * `schemas/finance-hub/top30_snapshot.v1.schema.json`.
 *
 * Policy (locked in Pillar 9 & Contract C3):
 * - Uses the exact `directory-leaderboard.js` formula.
 * - Includes ALL non-blacklisted, non-suspended accounts (private included).
 * - Excludes active validators so they never crowd out the 30 contributor seats.
 * - Tie-break: score DESC, network_tasks DESC, rewards_pft DESC, account_id ASC.
 * - Rank 1..30: `seated_top30` (`access_basis = "top30"`).
 * - Rank 31..35: `retained_hysteresis_31_35` (`access_basis = "top30"`) ONLY if
 *   previously entitled (`access_basis = "top30"` in previous snapshot).
 * - Rank >= 36: `grace_7d` (`access_basis = "grace"`) if continuing an active
 *   unexpired grace window OR newly dropping from `top30` with no active 30-day
 *   cooldown (`grace_cooldown_until = grace_started_at + 30d`).
 */
export function computeTop30Snapshot({
  candidates = [],
  previousSnapshot = null,
  activeValidatorAccountIds = new Set(),
  blacklistedOrSuspendedAccountIds = new Set(),
  cooldownHistory = new Map(),
  now = new Date(),
  status = "active",
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const snapshotAt = toUtcIso(nowDate);
  const snapshotDateUtc = snapshotAt.slice(0, 10);

  const validators = activeValidatorAccountIds instanceof Set
    ? activeValidatorAccountIds
    : new Set(activeValidatorAccountIds || []);
  const blocked = blacklistedOrSuspendedAccountIds instanceof Set
    ? blacklistedOrSuspendedAccountIds
    : new Set(blacklistedOrSuspendedAccountIds || []);

  const prevByAccount = previousEntriesMap(previousSnapshot);
  const cooldowns = normalizeCooldownMap(cooldownHistory, prevByAccount);

  let excludedActiveValidators = 0;
  let excludedBlacklistedOrSuspended = 0;
  const seenAccounts = new Set();
  const eligible = [];

  for (const raw of candidates || []) {
    const accountId = normalizeAccountId(raw?.account_id ?? raw?.accountId);
    if (!accountId || accountId.startsWith("deleted_account_") || seenAccounts.has(accountId)) continue;
    seenAccounts.add(accountId);

    if (blocked.has(accountId) || raw?.blacklisted === true || raw?.suspended === true) {
      excludedBlacklistedOrSuspended += 1;
      continue;
    }
    if (validators.has(accountId) || raw?.is_active_validator === true || raw?.isActiveValidator === true) {
      excludedActiveValidators += 1;
      continue;
    }

    const networkTasks = safeInt(raw?.network_tasks ?? raw?.networkTasks);
    const personalTasks = safeInt(raw?.personal_tasks ?? raw?.personalTasks);
    const rewardsPft = safeNum(raw?.rewards_pft ?? raw?.rewards ?? raw?.reward_pft);
    const alignmentScore = safeAlignment(raw?.alignment_score ?? raw?.alignment);
    const score = directoryLeaderboardScore({
      networkTasks,
      personalTasks,
      rewards: rewardsPft,
      alignment: alignmentScore,
    });

    eligible.push({
      account_id: accountId,
      network_tasks: networkTasks,
      personal_tasks: personalTasks,
      rewards_pft: rewardsPft,
      alignment_score: alignmentScore,
      score,
      is_public_profile: Boolean(raw?.is_public_profile ?? raw?.isPublicProfile ?? false),
    });
  }

  eligible.sort(compareCandidates);

  const entries = [];
  const cooldownUpdates = new Map();
  let seatedCount = 0;
  let hysteresisRetainedCount = 0;
  let graceCount = 0;

  for (let idx = 0; idx < eligible.length; idx += 1) {
    const row = eligible[idx];
    const rank = idx + 1;
    const prev = prevByAccount.get(row.account_id) || null;
    const previousRank = Number.isInteger(prev?.rank) ? prev.rank : null;
    const wasTop30Entitled = prev?.access_basis === "top30";
    const wasInGrace = prev?.entitlement_state === "grace_7d" && prev?.access_basis === "grace";
    const existingCooldown = cooldowns.get(row.account_id) || null;
    const activeCooldown = existingCooldown && Date.parse(existingCooldown) > nowMs ? existingCooldown : null;

    if (rank <= TOP30_SEAT_COUNT) {
      seatedCount += 1;
      entries.push({
        ...row,
        rank,
        is_active_validator: false,
        access_basis: "top30",
        entitlement_state: "seated_top30",
        previous_rank: previousRank,
        grace_started_at: null,
        grace_ends_at: null,
        grace_cooldown_until: activeCooldown,
      });
      continue;
    }

    if (rank <= TOP30_KEEP_UNTIL_RANK) {
      if (wasTop30Entitled) {
        hysteresisRetainedCount += 1;
        entries.push({
          ...row,
          rank,
          is_active_validator: false,
          access_basis: "top30",
          entitlement_state: "retained_hysteresis_31_35",
          previous_rank: previousRank,
          grace_started_at: null,
          grace_ends_at: null,
          grace_cooldown_until: activeCooldown,
        });
      }
      continue;
    }

    // Rank >= 36: check continuing grace window first, then new grace entry subject to 30d cooldown.
    if (wasInGrace && prev.grace_ends_at && Date.parse(prev.grace_ends_at) > nowMs) {
      graceCount += 1;
      const graceStartedAt = toUtcIso(prev.grace_started_at);
      const graceEndsAt = toUtcIso(prev.grace_ends_at);
      const graceCooldownUntil = toUtcIso(
        prev.grace_cooldown_until || new Date(Date.parse(graceStartedAt) + TOP30_GRACE_COOLDOWN_DAYS * DAY_MS)
      );
      entries.push({
        ...row,
        rank,
        is_active_validator: false,
        access_basis: "grace",
        entitlement_state: "grace_7d",
        previous_rank: previousRank,
        grace_started_at: graceStartedAt,
        grace_ends_at: graceEndsAt,
        grace_cooldown_until: graceCooldownUntil,
      });
      continue;
    }

    if (wasTop30Entitled && !activeCooldown) {
      graceCount += 1;
      const graceStartedAt = snapshotAt;
      const graceEndsAt = toUtcIso(new Date(nowMs + TOP30_GRACE_DAYS * DAY_MS));
      const graceCooldownUntil = toUtcIso(new Date(nowMs + TOP30_GRACE_COOLDOWN_DAYS * DAY_MS));
      cooldownUpdates.set(row.account_id, {
        graceStartedAt,
        graceEndsAt,
        graceCooldownUntil,
      });
      entries.push({
        ...row,
        rank,
        is_active_validator: false,
        access_basis: "grace",
        entitlement_state: "grace_7d",
        previous_rank: previousRank,
        grace_started_at: graceStartedAt,
        grace_ends_at: graceEndsAt,
        grace_cooldown_until: graceCooldownUntil,
      });
    }
  }

  const snapshot = {
    schema_version: TOP30_SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: snapshotIdFor(snapshotAt),
    snapshot_date_utc: snapshotDateUtc,
    snapshot_at: snapshotAt,
    status: status === "fallback_retained" ? "fallback_retained" : "active",
    formula: {
      label: "3x network tasks + personal tasks + rewards/25000 + alignment",
      network_task_weight: DIRECTORY_LEADERBOARD_RANK_FORMULA.networkTaskWeight,
      personal_task_weight: DIRECTORY_LEADERBOARD_RANK_FORMULA.personalTaskWeight,
      reward_divisor: DIRECTORY_LEADERBOARD_RANK_FORMULA.rewardDivisor,
      alignment_weight: DIRECTORY_LEADERBOARD_RANK_FORMULA.alignmentWeight,
      tie_break_order: ["score_desc", "network_tasks_desc", "rewards_desc", "account_id_asc"],
    },
    policy: {
      seat_count: TOP30_SEAT_COUNT,
      keep_until_rank: TOP30_KEEP_UNTIL_RANK,
      grace_days: TOP30_GRACE_DAYS,
      grace_cooldown_days: TOP30_GRACE_COOLDOWN_DAYS,
      exclude_active_validators: true,
      include_private_accounts: true,
      exclude_blacklisted: true,
      exclude_suspended: true,
    },
    summary: {
      eligible_non_validator_accounts: eligible.length,
      excluded_active_validators: excludedActiveValidators,
      excluded_blacklisted_or_suspended: excludedBlacklistedOrSuspended,
      seated_count: seatedCount,
      hysteresis_retained_count: hysteresisRetainedCount,
      grace_count: graceCount,
    },
    entries: entries.slice(0, 200),
  };

  return { snapshot, cooldownUpdates };
}

export function lookupTop30Entitlement(snapshot, accountId = "", now = new Date()) {
  const id = normalizeAccountId(accountId);
  if (!id || !snapshot || !Array.isArray(snapshot.entries)) {
    return {
      ok: false,
      basis: null,
      entitlementState: null,
      rank: null,
      snapshotAt: snapshot?.snapshot_at || null,
      graceEndsAt: null,
      graceCooldownUntil: null,
    };
  }
  const entry = snapshot.entries.find((item) => item?.account_id === id);
  if (!entry) {
    return {
      ok: false,
      basis: null,
      entitlementState: null,
      rank: null,
      snapshotAt: snapshot.snapshot_at || null,
      graceEndsAt: null,
      graceCooldownUntil: null,
    };
  }
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (entry.entitlement_state === "grace_7d") {
    const endsMs = Date.parse(entry.grace_ends_at || "");
    if (!Number.isFinite(endsMs) || endsMs <= nowMs) {
      return {
        ok: false,
        basis: null,
        entitlementState: "grace_expired",
        rank: entry.rank ?? null,
        snapshotAt: snapshot.snapshot_at || null,
        graceEndsAt: entry.grace_ends_at || null,
        graceCooldownUntil: entry.grace_cooldown_until || null,
      };
    }
    return {
      ok: true,
      basis: "grace",
      entitlementState: "grace_7d",
      rank: entry.rank ?? null,
      snapshotAt: snapshot.snapshot_at || null,
      graceEndsAt: entry.grace_ends_at,
      graceCooldownUntil: entry.grace_cooldown_until || null,
    };
  }
  if (entry.access_basis === "top30") {
    return {
      ok: true,
      basis: "top30",
      entitlementState: entry.entitlement_state,
      rank: entry.rank ?? null,
      snapshotAt: snapshot.snapshot_at || null,
      graceEndsAt: null,
      graceCooldownUntil: entry.grace_cooldown_until || null,
    };
  }
  return {
    ok: false,
    basis: null,
    entitlementState: null,
    rank: entry.rank ?? null,
    snapshotAt: snapshot.snapshot_at || null,
    graceEndsAt: null,
    graceCooldownUntil: null,
  };
}

export async function loadLatestTop30Snapshot(queryImpl = query) {
  if (!databaseEnabled() && queryImpl === query) return null;
  const result = await queryImpl(
    `SELECT snapshot_json FROM finance_hub_top30_snapshots
      ORDER BY snapshot_at DESC LIMIT 1`
  );
  return result.rows[0]?.snapshot_json || null;
}

export async function loadGraceCooldownHistory(queryImpl = query) {
  if (!databaseEnabled() && queryImpl === query) return new Map();
  const result = await queryImpl(
    `SELECT account_id, grace_cooldown_until
       FROM finance_hub_grace_cooldowns
      WHERE grace_cooldown_until > now()`
  );
  const map = new Map();
  for (const row of result.rows) {
    if (row.account_id && row.grace_cooldown_until) {
      map.set(row.account_id, new Date(row.grace_cooldown_until).toISOString());
    }
  }
  return map;
}

export async function loadTop30SnapshotInputs(queryImpl = query) {
  if (!databaseEnabled() && queryImpl === query) {
    return {
      candidates: [],
      activeValidatorAccountIds: new Set(),
      blacklistedOrSuspendedAccountIds: new Set(),
    };
  }
  const [accountsRes, validatorsRes, blockedRes] = await Promise.all([
    queryImpl(
      `SELECT account_id,
              COALESCE(account_json->>'profileVisibility', 'public') <> 'private' AS is_public_profile
         FROM app_accounts
        WHERE account_id IS NOT NULL AND account_id <> ''
          AND account_id NOT LIKE 'deleted_account_%'`
    ),
    queryImpl(
      `SELECT DISTINCT account_id
         FROM validator_bindings
        WHERE revoked_at IS NULL AND account_id IS NOT NULL`
    ),
    queryImpl(
      `SELECT account_id FROM account_blacklist WHERE status = 'active'
       UNION
       SELECT account_id FROM finance_hub_suspensions
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
    ),
  ]);

  const accountIds = accountsRes.rows.map((row) => row.account_id);
  const visibilityByAccount = new Map(accountsRes.rows.map((row) => [row.account_id, Boolean(row.is_public_profile)]));

  if (!accountIds.length) {
    return {
      candidates: [],
      activeValidatorAccountIds: new Set(validatorsRes.rows.map((r) => r.account_id)),
      blacklistedOrSuspendedAccountIds: new Set(blockedRes.rows.map((r) => r.account_id)),
    };
  }

  const statsRes = await queryImpl(
    `WITH candidates AS (
       SELECT unnest($1::text[]) AS account_id
     ),
     task_stats AS (
       SELECT p.account_id,
              COUNT(*) FILTER (WHERE lower(COALESCE(p.task_kind, '')) = 'network')::integer AS network_tasks,
              COUNT(*) FILTER (WHERE lower(COALESCE(p.task_kind, '')) = 'personal')::integer AS personal_tasks,
              COUNT(*)::integer AS tasks_rewarded,
              COALESCE(SUM(p.reward_actual_pft), 0)::text AS reward_pft
         FROM task_projections p
        WHERE p.account_id = ANY($1::text[])
          AND p.account_id <> ''
          AND ${canonicalRewardedTaskProjectionSql("p")}
        GROUP BY p.account_id
     ),
     latest_alignment AS (${alignmentByAccountSql("$1")})
     SELECT c.account_id,
            COALESCE(t.network_tasks, 0)::integer AS network_tasks,
            COALESCE(t.personal_tasks, 0)::integer AS personal_tasks,
            COALESCE(t.reward_pft, '0') AS reward_pft,
            latest_alignment.alignment_score
       FROM candidates c
       LEFT JOIN task_stats t ON t.account_id = c.account_id
       LEFT JOIN latest_alignment ON latest_alignment.account_id = c.account_id
      WHERE COALESCE(t.tasks_rewarded, 0) > 0`,
    [accountIds]
  );

  const candidates = statsRes.rows.map((row) => ({
    account_id: row.account_id,
    network_tasks: safeInt(row.network_tasks),
    personal_tasks: safeInt(row.personal_tasks),
    rewards_pft: safeNum(row.reward_pft),
    alignment_score: alignmentScore0To100(row.alignment_score) ?? 0,
    is_public_profile: visibilityByAccount.get(row.account_id) ?? false,
  }));

  return {
    candidates,
    activeValidatorAccountIds: new Set(validatorsRes.rows.map((r) => r.account_id)),
    blacklistedOrSuspendedAccountIds: new Set(blockedRes.rows.map((r) => r.account_id)),
  };
}

export async function saveTop30Snapshot({ snapshot, cooldownUpdates = new Map() } = {}) {
  if (!databaseEnabled()) return snapshot;
  return transaction(async (client) => {
    await client.query(
      `INSERT INTO finance_hub_top30_snapshots
         (snapshot_id, snapshot_date_utc, snapshot_at, status, snapshot_json)
       VALUES ($1, $2::date, $3::timestamptz, $4, $5::jsonb)
       ON CONFLICT (snapshot_id) DO UPDATE SET
         status = EXCLUDED.status,
         snapshot_json = EXCLUDED.snapshot_json`,
      [
        snapshot.snapshot_id,
        snapshot.snapshot_date_utc,
        snapshot.snapshot_at,
        snapshot.status,
        JSON.stringify(snapshot),
      ]
    );
    for (const [accountId, cd] of cooldownUpdates.entries()) {
      await client.query(
        `INSERT INTO finance_hub_grace_cooldowns
           (account_id, grace_started_at, grace_ends_at, grace_cooldown_until, updated_at)
         VALUES ($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, now())
         ON CONFLICT (account_id) DO UPDATE SET
           grace_started_at = EXCLUDED.grace_started_at,
           grace_ends_at = EXCLUDED.grace_ends_at,
           grace_cooldown_until = EXCLUDED.grace_cooldown_until,
           updated_at = now()`,
        [accountId, cd.graceStartedAt, cd.graceEndsAt, cd.graceCooldownUntil]
      );
    }
    return snapshot;
  });
}

/**
 * Daily UTC snapshot job runner with fail-safe retention:
 * if candidate computation fails, retains the last good snapshot with
 * `status = "fallback_retained"` and triggers `alertOperator`.
 */
export async function runDailyTop30SnapshotJob({
  loadInputs = loadTop30SnapshotInputs,
  loadPreviousSnapshot = loadLatestTop30Snapshot,
  loadCooldowns = loadGraceCooldownHistory,
  persistSnapshot = saveTop30Snapshot,
  alertOperator = (event) => console.error("finance_hub_top30_snapshot_alert", JSON.stringify(event)),
  now = new Date(),
  dryRun = false,
} = {}) {
  const previousSnapshot = await loadPreviousSnapshot().catch(() => null);
  try {
    const [inputs, cooldownHistory] = await Promise.all([loadInputs(), loadCooldowns()]);
    const { snapshot, cooldownUpdates } = computeTop30Snapshot({
      candidates: inputs.candidates,
      previousSnapshot,
      activeValidatorAccountIds: inputs.activeValidatorAccountIds,
      blacklistedOrSuspendedAccountIds: inputs.blacklistedOrSuspendedAccountIds,
      cooldownHistory,
      now,
      status: "active",
    });
    if (!dryRun) await persistSnapshot({ snapshot, cooldownUpdates });
    return { ok: true, retainedFallback: false, snapshot };
  } catch (error) {
    const reason = String(error?.message || error || "top30_snapshot_failed").slice(0, 300);
    alertOperator({
      code: "finance_hub_top30_snapshot_failed",
      reason,
      retainedSnapshotId: previousSnapshot?.snapshot_id || null,
      at: toUtcIso(now),
    });
    if (previousSnapshot) {
      const retained = { ...previousSnapshot, status: "fallback_retained" };
      if (!dryRun) {
        await persistSnapshot({ snapshot: retained, cooldownUpdates: new Map() }).catch(() => {});
      }
      return { ok: false, retainedFallback: true, error: reason, snapshot: retained };
    }
    return { ok: false, retainedFallback: false, error: reason, snapshot: null };
  }
}
