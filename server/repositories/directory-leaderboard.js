import { databaseEnabled, query } from "../db/pool.js";
import { listDiscoverableAccountWalletIdentities } from "./account-profiles.js";
import { listMachineOperatorDisclosures } from "./capability-profiles.js";
import {
  canonicalRewardedTaskProjectionSql,
  nonFixtureAirdropRunSql,
  nonFixtureProfileNftSql,
  nonFixtureRecommendedProfileSql,
} from "./task-projection-integrity.js";

const leaderboardLimit = Math.max(1, Number(process.env.DIRECTORY_LEADERBOARD_LIMIT || 200));
const leaderboardCacheMs = Math.max(0, Number(process.env.DIRECTORY_LEADERBOARD_CACHE_MS || 30_000));

let cachedBaseDocument = null;
let cachedBaseDocumentUntil = 0;

export const DIRECTORY_LEADERBOARD_RANK_FORMULA = {
  networkTaskWeight: Number(process.env.DIRECTORY_LEADERBOARD_NETWORK_TASK_WEIGHT || 3),
  personalTaskWeight: Number(process.env.DIRECTORY_LEADERBOARD_PERSONAL_TASK_WEIGHT || 1),
  rewardDivisor: Number(process.env.DIRECTORY_LEADERBOARD_REWARD_DIVISOR || 25_000),
  alignmentWeight: Number(process.env.DIRECTORY_LEADERBOARD_ALIGNMENT_WEIGHT || 1),
};

export function directoryLeaderboardScore({
  alignment = null,
  networkTasks = 0,
  personalTasks = 0,
  rewards = 0,
} = {}) {
  const network = numeric(networkTasks);
  const personal = numeric(personalTasks);
  const rewardPft = numeric(rewards);
  const alignmentScore = alignment === null || alignment === undefined ? 0 : numeric(alignment);
  const rewardDivisor = DIRECTORY_LEADERBOARD_RANK_FORMULA.rewardDivisor || 25_000;
  return Number((
    network * DIRECTORY_LEADERBOARD_RANK_FORMULA.networkTaskWeight +
    personal * DIRECTORY_LEADERBOARD_RANK_FORMULA.personalTaskWeight +
    (rewardDivisor > 0 ? rewardPft / rewardDivisor : 0) +
    alignmentScore * DIRECTORY_LEADERBOARD_RANK_FORMULA.alignmentWeight
  ).toFixed(6));
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function intValue(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateLabel(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = safeText(value, 40);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : text.slice(0, 10);
}

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeHandle(value = "") {
  return safeText(value, 120).replace(/^@+/, "");
}

function firstPublicAliasHandle(identity = {}) {
  const alias = (Array.isArray(identity.publicAliases) ? identity.publicAliases : [])
    .find((entry) => safeText(entry?.handle, 120));
  return normalizeHandle(alias?.handle || "");
}

function displayNameForIdentity(identity = {}, row = {}) {
  const handle = normalizeHandle(row.public_handle || identity.hiveHandle || firstPublicAliasHandle(identity));
  return safeText(
    identity.publicDisplayName ||
      row.identity_display_name ||
      identity.displayName ||
      (handle ? `@${handle}` : ""),
    120
  );
}

function handleForIdentity(identity = {}, row = {}) {
  const handle = normalizeHandle(row.public_handle || identity.hiveHandle || firstPublicAliasHandle(identity));
  if (handle) return handle;
  const display = safeText(identity.displayName || row.identity_display_name, 120);
  if (display.startsWith("@")) return normalizeHandle(display);
  return "";
}

function firstIdentityWallet(row = {}) {
  const wallets = safeArray(row.wallets_json);
  const active = wallets.find((wallet) => safeText(wallet?.status, 40) === "active" && safeText(wallet?.walletAddress, 160));
  const first = active || wallets.find((wallet) => safeText(wallet?.walletAddress, 160));
  return safeText(first?.walletAddress, 160);
}

function heroNftFromRow(row = {}) {
  const imageCid = safeText(row.hero_nft_image_cid, 180);
  const imageGatewayUrl = safeText(row.hero_nft_image_gateway_url, 500);
  if (!imageCid && !imageGatewayUrl) return null;
  return {
    imageCid,
    imageGatewayUrl,
  };
}

function publicIdentityMap(identities = []) {
  const result = new Map();
  for (const identity of identities) {
    const accountId = safeText(identity.accountId, 180);
    if (!accountId || accountId.startsWith("deleted_account_")) continue;
    result.set(accountId, identity);
  }
  return result;
}

async function recommendedProfilesReady() {
  if (!databaseEnabled()) return false;
  const result = await query("SELECT to_regclass('public.recommended_connection_profiles') AS profile_table");
  return Boolean(result.rows[0]?.profile_table);
}

export async function discoverableMemberProfileIds(accountIds = []) {
  if (!accountIds.length || !await recommendedProfilesReady()) return new Set();
  const result = await query(
    `
      SELECT account_id
      FROM recommended_connection_profiles profile
      WHERE profile.account_id = ANY($1::text[])
        AND profile.visibility = 'public'
        AND profile.discoverable = true
        AND profile.disabled_at IS NULL
        AND ${nonFixtureRecommendedProfileSql("profile")}
    `,
    [accountIds]
  );
  return new Set(result.rows.map((row) => safeText(row.account_id, 180)).filter(Boolean));
}

export async function queryDirectoryLeaderboardRows({
  accountIds = [],
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  if (!accountIds.length || !databaseReady) return [];
  const result = await queryImpl(
    `
      WITH candidates AS (
        SELECT unnest($1::text[]) AS account_id
      ),
      task_stats AS (
        SELECT p.account_id,
               COUNT(*) FILTER (
                 WHERE lower(COALESCE(p.task_kind, '')) = 'network'
               )::integer AS network_tasks,
               COUNT(*) FILTER (
                 WHERE lower(COALESCE(p.task_kind, '')) = 'personal'
               )::integer AS personal_tasks,
               COUNT(*)::integer AS tasks_rewarded,
               COALESCE(SUM(p.reward_actual_pft), 0)::text AS reward_pft,
               (ARRAY_AGG(p.subject_wallet ORDER BY p.updated_at DESC NULLS LAST, p.task_id DESC)
                 FILTER (WHERE p.subject_wallet <> ''))[1] AS latest_wallet
        FROM task_projections p
        WHERE p.account_id = ANY($1::text[])
          AND p.account_id <> ''
          AND ${canonicalRewardedTaskProjectionSql("p")}
        GROUP BY p.account_id
      ),
      latest_alignment AS (
        SELECT DISTINCT ON (account_id)
               account_id,
               alignment_score_7d::text AS alignment_score_7d,
               completed_at AS alignment_completed_at,
               run_date AS alignment_run_date
        FROM profile_daily_airdrop_runs run
        WHERE run.account_id = ANY($1::text[])
          AND run.status = 'completed'
          AND ${nonFixtureAirdropRunSql("run")}
        ORDER BY run.account_id, run.completed_at DESC NULLS LAST, run.updated_at DESC, run.created_at DESC
      )
      SELECT candidates.account_id,
             COALESCE(task_stats.network_tasks, 0)::integer AS network_tasks,
             COALESCE(task_stats.personal_tasks, 0)::integer AS personal_tasks,
             COALESCE(task_stats.tasks_rewarded, 0)::integer AS tasks_rewarded,
             COALESCE(task_stats.reward_pft, '0') AS reward_pft,
             COALESCE(task_stats.latest_wallet, '') AS latest_wallet,
             latest_alignment.alignment_score_7d,
             latest_alignment.alignment_completed_at,
             latest_alignment.alignment_run_date,
             ''::text AS identity_display_name,
             '[]'::jsonb AS wallets_json,
             COALESCE(hero_nft.image_cid, '') AS hero_nft_image_cid,
             COALESCE(hero_nft.image_gateway_url, '') AS hero_nft_image_gateway_url
      FROM candidates
      LEFT JOIN task_stats ON task_stats.account_id = candidates.account_id
      LEFT JOIN latest_alignment ON latest_alignment.account_id = candidates.account_id
      LEFT JOIN LATERAL (
        SELECT nft.image_cid, nft.image_gateway_url
        FROM profile_nfts nft
        WHERE nft.account_id = candidates.account_id
          AND lower(nft.status) IN ('minted', 'prepared', 'generated')
          AND ${nonFixtureProfileNftSql("nft")}
          AND (
            COALESCE(nft.image_gateway_url, '') <> ''
            OR COALESCE(nft.image_cid, '') <> ''
          )
        ORDER BY
          nft.selected DESC,
          nft.created_at DESC NULLS LAST,
          nft.updated_at DESC NULLS LAST,
          nft.id DESC
        LIMIT 1
      ) hero_nft ON true
      WHERE COALESCE(task_stats.tasks_rewarded, 0) > 0
      ORDER BY task_stats.reward_pft::numeric DESC, task_stats.tasks_rewarded DESC, candidates.account_id ASC
    `,
    [accountIds]
  );
  return result.rows;
}

async function buildBaseDocument() {
  const identities = await listDiscoverableAccountWalletIdentities();
  const identityByAccount = publicIdentityMap(identities);
  const accountIds = Array.from(identityByAccount.keys());
  const [rows, profileIds, operatorDisclosures] = await Promise.all([
    queryDirectoryLeaderboardRows({ accountIds }),
    discoverableMemberProfileIds(accountIds),
    listMachineOperatorDisclosures({ accountIds }).catch(() => ({})),
  ]);

  const operators = rows
    .map((row) => {
      const accountId = safeText(row.account_id, 180);
      const identity = identityByAccount.get(accountId) || {};
      const alignment = row.alignment_score_7d === null || row.alignment_score_7d === undefined
        ? null
        : Math.max(0, Math.min(100, Math.round(numeric(row.alignment_score_7d) * 100)));
      const networkTasks = intValue(row.network_tasks);
      const personalTasks = intValue(row.personal_tasks);
      const rewards = numeric(row.reward_pft);
      const handle = handleForIdentity(identity, row);
      const displayName = displayNameForIdentity(identity, row) || (handle ? `@${handle}` : "Task Node member");
      return {
        accountId,
        handle,
        displayName,
        wallet: safeText(identity.walletAddress, 160) || safeText(row.latest_wallet, 160) || firstIdentityWallet(row),
        networkTasks,
        personalTasks,
        rewards,
        alignment,
        alignmentCompletedAt: toIso(row.alignment_completed_at),
        alignmentRunDate: dateLabel(row.alignment_run_date),
        heroNft: heroNftFromRow(row),
        hasPublicProfile: profileIds.has(accountId),
        operatorDisclosure: operatorDisclosures[accountId] || null,
        tasksRewarded: intValue(row.tasks_rewarded),
        score: directoryLeaderboardScore({ alignment, networkTasks, personalTasks, rewards }),
      };
    })
    .sort((a, b) => (
      b.score - a.score ||
      b.networkTasks - a.networkTasks ||
      b.rewards - a.rewards ||
      a.handle.localeCompare(b.handle)
    ));

  const truncated = operators.length > leaderboardLimit;
  if (truncated) {
    console.warn(`directory_leaderboard_truncated count=${operators.length} limit=${leaderboardLimit}`);
  }
  const visibleOperators = operators.slice(0, leaderboardLimit);
  const totals = visibleOperators.reduce((acc, operator) => {
    acc.operators += 1;
    acc.tasksRewarded += operator.tasksRewarded;
    acc.pftDistributed = numeric(acc.pftDistributed + operator.rewards);
    return acc;
  }, {
    operators: 0,
    tasksRewarded: 0,
    pftDistributed: 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    rankFormula: {
      ...DIRECTORY_LEADERBOARD_RANK_FORMULA,
      label: "3x network tasks + personal tasks + rewards/25000 + alignment",
    },
    policy: {
      visibility: "public_discoverable_only",
    },
    totals,
    operators: visibleOperators,
    truncated,
    limit: leaderboardLimit,
  };
}

async function baseDocument() {
  const now = Date.now();
  if (cachedBaseDocument && cachedBaseDocumentUntil > now) return cachedBaseDocument;
  cachedBaseDocument = await buildBaseDocument();
  cachedBaseDocumentUntil = now + leaderboardCacheMs;
  return cachedBaseDocument;
}

export async function getDirectoryLeaderboardDocument({ viewerAccountId = "" } = {}) {
  const document = await baseDocument();
  const accountId = safeText(viewerAccountId, 180);
  return {
    ...document,
    operators: document.operators.map((operator) => ({
      ...operator,
      isYou: Boolean(accountId && operator.accountId === accountId),
    })),
  };
}
