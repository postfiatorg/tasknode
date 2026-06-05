import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  embedTexts,
  jobsEffectiveEmbeddingModel,
  jobsEmbeddingDimensions,
  jobsEmbeddingModel,
  jobsEmbeddingProvider,
} from "../embedding-provider.js";
import {
  getAccountIdentityProfile,
  getAccountProfileVisibility,
  listDiscoverableAccountWalletIdentities,
} from "../runtime-store.js";
import { getLatestNetworkTaskProfile } from "./network-task-profile.js";
import { buildPublicProfileSnapshotInput, getLatestPublicProfileSnapshot } from "./profile-public.js";

export const recommendedConnectionsPromptVersion = "recommended_connections_v1";
const weeklyRefreshMs = 7 * 24 * 60 * 60 * 1000;
const maxCandidateCount = 50;
const maxRecommendations = 4;
const minRecommendations = 3;
const defaultDeepSeekBaseUrl = "https://api.deepseek.com";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestValue(value) {
  return sha256(stableJson(value));
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function vectorLiteral(vector = []) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function compactLine(value = "", max = 360) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function profileHandle(identity = {}) {
  return identity.hiveHandle ? `@${identity.hiveHandle}` : "";
}

function profileDisplay(identity = {}) {
  return safeText(identity.publicDisplayName || identity.displayName || profileHandle(identity), 100);
}

function profileVisibility(accountId = "") {
  return getAccountProfileVisibility({ accountId });
}

export function shouldIndexRecommendedConnectionProfile({ visibility = "public", discoverable = true } = {}) {
  return visibility !== "private" && discoverable !== false;
}

function deletedAccountId(accountId = "") {
  return String(accountId || "").startsWith("deleted_account_");
}

async function latestTaskWallet({ accountId = "" } = {}) {
  if (!useDatabase()) return "";
  const result = await query(
    `
      SELECT subject_wallet
      FROM task_projections
      WHERE account_id = $1
        AND subject_wallet <> ''
      ORDER BY updated_at DESC NULLS LAST,
               task_id DESC
      LIMIT 1
    `,
    [safeText(accountId, 180)]
  );
  return safeText(result.rows[0]?.subject_wallet, 120);
}

export function recommendedConnectionIdentityFromParts({
  accountId = "",
  identityProfile = null,
  walletIdentity = null,
  networkProfile = null,
  walletAddress = "",
} = {}) {
  const diagnosticTitle = safeText(
    networkProfile?.output?.profile_title ||
      networkProfile?.output?.profileTitle ||
      "",
    120
  );
  const hiveHandle = safeText(identityProfile?.hiveHandle || walletIdentity?.hiveHandle, 80);
  const displayName = safeText(
    identityProfile?.publicDisplayName ||
      identityProfile?.displayName ||
      walletIdentity?.displayName ||
      diagnosticTitle ||
      safeText(accountId, 24),
    120
  );
  return {
    accountId: safeText(accountId, 180),
    walletAddress: safeText(walletIdentity?.walletAddress || walletAddress, 120),
    displayName,
    hiveHandle,
    publicDisplayName: safeText(identityProfile?.publicDisplayName || walletIdentity?.publicDisplayName, 120),
    publicAliases: safeArray(identityProfile?.publicAliases || walletIdentity?.publicAliases),
    publicTrustBadges: safeArray(identityProfile?.publicTrustBadges || walletIdentity?.publicTrustBadges),
  };
}

async function recommendedConnectionTablesReady() {
  if (!useDatabase()) return false;
  const result = await query("SELECT to_regclass('public.recommended_connection_profiles') AS profile_table");
  return Boolean(result.rows[0]?.profile_table);
}

export async function recommendedConnectionProfileIsDiscoverable({ accountId = "" } = {}) {
  if (!await recommendedConnectionTablesReady()) return false;
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId || deletedAccountId(normalizedAccountId)) return false;
  const result = await query(
    `
      SELECT account_id
      FROM recommended_connection_profiles
      WHERE account_id = $1
        AND visibility = 'public'
        AND discoverable = true
        AND disabled_at IS NULL
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  return Boolean(result.rows[0]?.account_id);
}

async function listRecommendedConnectionCandidateAccountIds({ limit = 20 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit || 20), 1), 500);
  const result = await query(
    `
      SELECT account_id
      FROM (
        SELECT account_id,
               max(COALESCE(completed_at, created_at)) AS latest_profile_at
        FROM network_task_profiles
        WHERE status = 'completed'
          AND superseded_at IS NULL
          AND account_id <> ''
          AND account_id NOT LIKE 'deleted_account_%'
          AND output_text <> ''
        GROUP BY account_id
      ) profiles
      ORDER BY latest_profile_at DESC NULLS LAST,
               account_id ASC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return result.rows
    .map((row) => safeText(row.account_id, 180))
    .filter((accountId) => accountId && !deletedAccountId(accountId))
    .filter((accountId) => shouldIndexRecommendedConnectionProfile(profileVisibility(accountId)));
}

async function currentTaskContext({ accountId = "", limit = 8 } = {}) {
  if (!useDatabase()) return [];
  const result = await query(
    `
      SELECT task_id, title, description, task_kind, status, reward_offer_pft,
             reward_actual_pft, submission_requirement_text, updated_at
      FROM task_projections
      WHERE account_id = $1
        AND status IN (
          'proposed',
          'accepted',
          'submitted',
          'verification_requested',
          'verification_response_submitted'
        )
      ORDER BY
        CASE status
          WHEN 'accepted' THEN 1
          WHEN 'submitted' THEN 2
          WHEN 'verification_requested' THEN 3
          WHEN 'verification_response_submitted' THEN 4
          ELSE 5
        END,
        updated_at DESC,
        task_id DESC
      LIMIT $2
    `,
    [safeText(accountId, 180), Math.min(Math.max(Number(limit || 8), 1), 20)]
  );
  return result.rows.map((row) => ({
    taskId: safeText(row.task_id, 180),
    title: safeText(row.title, 240),
    description: safeText(row.description, 1200),
    kind: safeText(row.task_kind, 80),
    status: safeText(row.status, 80),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    submissionRequirement: safeText(row.submission_requirement_text, 600),
    updatedAt: toIso(row.updated_at),
  }));
}

function packetTextFromParts({
  identity = {},
  publicSnapshot = null,
  publicInput = null,
  networkProfile = null,
  tasks = [],
} = {}) {
  const role = publicSnapshot || {};
  const rewardTotals = safeObject(publicInput?.reward_totals);
  const skills = safeArray(role.skills).filter(Boolean).join(", ");
  const taskLines = safeArray(tasks).length
    ? tasks.map((task, index) => [
      `Task ${index + 1}: ${task.title || task.taskId}`,
      `Status: ${task.status}`,
      task.kind ? `Kind: ${task.kind}` : "",
      task.description ? `Description: ${compactLine(task.description, 700)}` : "",
      task.submissionRequirement ? `Completion signal: ${compactLine(task.submissionRequirement, 420)}` : "",
    ].filter(Boolean).join("\n")).join("\n\n")
    : "No current active task context.";

  return [
    "RECOMMENDED CONNECTION MEMBER PACKET",
    "",
    `Account: ${identity.accountId || ""}`,
    `Display: ${profileDisplay(identity) || "Unknown member"}`,
    profileHandle(identity) ? `Hive handle: ${profileHandle(identity)}` : "",
    role.roleTitle ? `Role: ${role.roleTitle}` : "",
    role.roleSummary ? `Role summary: ${role.roleSummary}` : "",
    skills ? `Skills: ${skills}` : "",
    rewardTotals.lifetimeRewardedTasks !== undefined
      ? `Lifetime rewarded tasks: ${Number(rewardTotals.lifetimeRewardedTasks || 0)}`
      : "",
    rewardTotals.trailing30dRewardedTasks !== undefined
      ? `Trailing 30 day rewarded tasks: ${Number(rewardTotals.trailing30dRewardedTasks || 0)}`
      : "",
    "",
    "Network Diagnostic Report",
    networkProfile?.outputText || "No completed Network Diagnostic Report.",
    "",
    "Current Useful Task Context",
    taskLines,
  ].filter((line) => line !== "").join("\n");
}

export async function buildRecommendedConnectionPacket({ accountId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, reason: "account_required" };
  if (deletedAccountId(normalizedAccountId)) return { ok: false, reason: "deleted_account" };
  const visibility = profileVisibility(normalizedAccountId);
  if (!shouldIndexRecommendedConnectionProfile(visibility)) {
    return { ok: false, reason: "profile_private", visibility };
  }

  const [networkProfile, publicSnapshot, publicInput, tasks] = await Promise.all([
    getLatestNetworkTaskProfile({ accountId: normalizedAccountId }),
    getLatestPublicProfileSnapshot({ accountId: normalizedAccountId }).catch(() => null),
    buildPublicProfileSnapshotInput({ accountId: normalizedAccountId }).catch(() => null),
    currentTaskContext({ accountId: normalizedAccountId }),
  ]);
  if (!networkProfile?.outputText) {
    return { ok: false, reason: "network_diagnostic_required", visibility };
  }
  const walletIdentity = listDiscoverableAccountWalletIdentities()
    .find((entry) => entry.accountId === normalizedAccountId) || null;
  const identityProfile = getAccountIdentityProfile({ accountId: normalizedAccountId });
  const identity = recommendedConnectionIdentityFromParts({
    accountId: normalizedAccountId,
    identityProfile,
    walletIdentity,
    networkProfile,
    walletAddress: await latestTaskWallet({ accountId: normalizedAccountId }),
  });

  const packetJson = {
    schema: "pf.profile.recommended_connection_packet.v1",
    account_id: normalizedAccountId,
    wallet_address: identity.walletAddress,
    display_name: identity.displayName || "",
    hive_handle: identity.hiveHandle || "",
    visibility: visibility.visibility,
    public_identity: {
      display_name: identity.displayName || "",
      hive_handle: identity.hiveHandle || "",
      public_aliases: identity.publicAliases || [],
      public_trust_badges: identity.publicTrustBadges || [],
    },
    public_profile_snapshot: {
      role_title: publicSnapshot?.roleTitle || "",
      role_summary: publicSnapshot?.roleSummary || "",
      skills: safeArray(publicSnapshot?.skills).slice(0, 8),
      archetype: publicSnapshot?.archetype || "",
      useful_to: publicSnapshot?.usefulTo || "",
    },
    reward_totals: safeObject(publicInput?.reward_totals),
    contribution_tier: safeObject(publicInput?.contribution_tier),
    network_diagnostic: {
      profile_id: networkProfile.id || "",
      source_packet_digest: networkProfile.sourcePacketDigest || "",
      title: networkProfile.output?.profile_title || networkProfile.output?.profileTitle || "",
      text: networkProfile.outputText || "",
      current_focus: safeArray(networkProfile.output?.current_focus),
      primary_contribution_ability: safeArray(networkProfile.output?.primary_contribution_ability),
      domain_expertise: safeArray(networkProfile.output?.domain_expertise),
      completed_at: networkProfile.completedAt || null,
    },
    current_tasks: safeArray(tasks).slice(0, 8),
  };
  const packetText = packetTextFromParts({
    identity,
    publicSnapshot,
    publicInput,
    networkProfile,
    tasks,
  });
  const packetDigest = digestValue(packetJson);
  return {
    ok: true,
    accountId: normalizedAccountId,
    identity,
    visibility,
    packetJson,
    packetText,
    packetDigest,
    networkProfile,
  };
}

async function deleteRecommendedConnectionProfile({ accountId = "", reason = "profile_private" } = {}) {
  if (!await recommendedConnectionTablesReady()) return { ok: false, skipped: true, reason: "tables_not_ready" };
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, reason: "account_required" };
  await transaction(async (client) => {
    await client.query("DELETE FROM recommended_connection_profiles WHERE account_id = $1", [normalizedAccountId]);
    await client.query(
      `
        UPDATE recommended_connections
        SET status = 'expired',
            updated_at = now()
        WHERE status = 'active'
          AND (target_account_id = $1 OR candidate_account_id = $1)
      `,
      [normalizedAccountId]
    );
  });
  return { ok: true, deleted: true, reason };
}

export async function refreshRecommendedConnectionProfile({ accountId = "", force = false } = {}) {
  if (!await recommendedConnectionTablesReady()) return { ok: false, skipped: true, reason: "tables_not_ready" };
  const packet = await buildRecommendedConnectionPacket({ accountId });
  if (!packet.ok) {
    if (packet.reason === "profile_private") {
      return deleteRecommendedConnectionProfile({ accountId, reason: packet.reason });
    }
    return packet;
  }

  const embeddingProvider = jobsEmbeddingProvider(process.env.TASKNODE_RECOMMENDED_CONNECTIONS_EMBEDDING_PROVIDER || "");
  const dimensions = jobsEmbeddingDimensions();
  const embeddingModel = jobsEffectiveEmbeddingModel({
    provider: embeddingProvider,
    model: process.env.TASKNODE_RECOMMENDED_CONNECTIONS_EMBEDDING_MODEL || jobsEmbeddingModel(),
  });
  const existing = await query(
    `
      SELECT account_id
      FROM recommended_connection_profiles
      WHERE account_id = $1
        AND packet_digest = $2
        AND embedding_model = $3
        AND embedding_dimensions = $4
        AND disabled_at IS NULL
    `,
    [packet.accountId, packet.packetDigest, embeddingModel, dimensions]
  );
  if (!force && existing.rows[0]) {
    return { ok: true, skipped: true, reason: "profile_index_current", accountId: packet.accountId };
  }

  const embeddingResult = await embedTexts([packet.packetText], {
    provider: embeddingProvider,
    model: embeddingModel,
    dimensions,
    batchSize: 1,
    timeoutMs: 15000,
  });
  const embedding = embeddingResult.embeddings[0];
  if (!embedding) throw new Error("recommended_connection_embedding_missing");

  await query(
    `
      INSERT INTO recommended_connection_profiles (
        account_id,
        wallet_address,
        display_name,
        hive_handle,
        visibility,
        discoverable,
        packet_json,
        packet_text,
        packet_digest,
        network_profile_id,
        network_profile_digest,
        embedding_model,
        embedding_dimensions,
        embedding_provider,
        embedding,
        generated_at,
        disabled_at
      )
      VALUES ($1, $2, $3, $4, 'public', true, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::vector, now(), NULL)
      ON CONFLICT (account_id) DO UPDATE
      SET wallet_address = EXCLUDED.wallet_address,
          display_name = EXCLUDED.display_name,
          hive_handle = EXCLUDED.hive_handle,
          visibility = EXCLUDED.visibility,
          discoverable = EXCLUDED.discoverable,
          packet_json = EXCLUDED.packet_json,
          packet_text = EXCLUDED.packet_text,
          packet_digest = EXCLUDED.packet_digest,
          network_profile_id = EXCLUDED.network_profile_id,
          network_profile_digest = EXCLUDED.network_profile_digest,
          embedding_model = EXCLUDED.embedding_model,
          embedding_dimensions = EXCLUDED.embedding_dimensions,
          embedding_provider = EXCLUDED.embedding_provider,
          embedding = EXCLUDED.embedding,
          generated_at = now(),
          disabled_at = NULL,
          updated_at = now()
    `,
    [
      packet.accountId,
      safeText(packet.identity.walletAddress, 120),
      safeText(packet.identity.displayName, 120),
      safeText(packet.identity.hiveHandle, 120),
      jsonValue(packet.packetJson),
      safeText(packet.packetText, 120_000),
      packet.packetDigest,
      safeText(packet.networkProfile.id, 180),
      safeText(packet.networkProfile.sourcePacketDigest, 180),
      embeddingResult.model,
      embeddingResult.dimensions,
      embeddingResult.provider,
      vectorLiteral(embedding),
    ]
  );

  return {
    ok: true,
    accountId: packet.accountId,
    packetDigest: packet.packetDigest,
    embeddingModel: embeddingResult.model,
    embeddingProvider: embeddingResult.provider,
    embeddingDimensions: embeddingResult.dimensions,
  };
}

export async function refreshDiscoverableRecommendedConnectionProfiles({ limit = 20, force = false } = {}) {
  if (!await recommendedConnectionTablesReady()) return { ok: false, skipped: true, reason: "tables_not_ready" };
  const accountIds = await listRecommendedConnectionCandidateAccountIds({ limit });
  const results = [];
  for (const accountId of accountIds) {
    try {
      results.push(await refreshRecommendedConnectionProfile({ accountId, force }));
    } catch (error) {
      results.push({
        ok: false,
        accountId,
        reason: "profile_refresh_failed",
        error: safeText(error?.message || error, 1000),
      });
    }
  }
  return {
    ok: true,
    scanned: accountIds.length,
    indexedCount: results.filter((item) => item.ok && !item.skipped && !item.deleted).length,
    skippedCount: results.filter((item) => item.skipped || item.deleted).length,
    failedCount: results.filter((item) => item.ok === false && !item.skipped).length,
    results,
  };
}

function publicCandidate(row = {}) {
  const packet = safeObject(row.packet_json);
  const snapshot = safeObject(packet.public_profile_snapshot);
  const diagnostic = safeObject(packet.network_diagnostic);
  const distance = Number(row.distance ?? 0);
  return {
    accountId: row.account_id || "",
    displayName: row.display_name || packet.display_name || "",
    hiveHandle: row.hive_handle || packet.hive_handle || "",
    walletAddress: row.wallet_address || "",
    packetDigest: row.packet_digest || "",
    roleTitle: snapshot.role_title || diagnostic.title || "",
    roleSummary: snapshot.role_summary || "",
    skills: safeArray(snapshot.skills).slice(0, 6),
    networkDiagnosticText: diagnostic.text || row.packet_text || "",
    currentFocus: safeArray(diagnostic.current_focus).slice(0, 6),
    primaryContribution: safeArray(diagnostic.primary_contribution_ability).slice(0, 6),
    currentTasks: safeArray(packet.current_tasks).slice(0, 4),
    similarity: Number((1 - distance).toFixed(6)),
    distance,
  };
}

async function topRecommendedConnectionCandidates({ accountId = "", limit = maxCandidateCount } = {}) {
  if (!await recommendedConnectionTablesReady()) return { ok: false, skipped: true, reason: "tables_not_ready", candidates: [] };
  const normalizedAccountId = safeText(accountId, 180);
  const target = await query(
    `
      SELECT *
      FROM recommended_connection_profiles
      WHERE account_id = $1
        AND discoverable = true
        AND visibility = 'public'
        AND disabled_at IS NULL
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  const targetProfile = target.rows[0] || null;
  if (!targetProfile) {
    return { ok: false, reason: "target_profile_not_indexed", candidates: [] };
  }
  const normalizedLimit = Math.min(Math.max(Number(limit || maxCandidateCount), 1), maxCandidateCount);
  const result = await query(
    `
      SELECT candidate.*,
             candidate.embedding <=> target.embedding AS distance
      FROM recommended_connection_profiles candidate
      CROSS JOIN recommended_connection_profiles target
      WHERE target.account_id = $1
        AND candidate.account_id <> target.account_id
        AND candidate.discoverable = true
        AND candidate.visibility = 'public'
        AND candidate.disabled_at IS NULL
        AND candidate.embedding_model = target.embedding_model
        AND candidate.embedding_dimensions = target.embedding_dimensions
      ORDER BY candidate.embedding <=> target.embedding ASC,
               candidate.generated_at DESC,
               candidate.account_id ASC
      LIMIT $2
    `,
    [normalizedAccountId, normalizedLimit]
  );
  return {
    ok: true,
    targetProfile: publicCandidate(targetProfile),
    candidates: result.rows.map(publicCandidate),
  };
}

function latestRunFresh(run = null) {
  const completedAt = Date.parse(run?.completed_at || run?.completedAt || "");
  return Number.isFinite(completedAt) && Date.now() - completedAt < weeklyRefreshMs;
}

function publicConnection(row = {}) {
  const snapshot = safeObject(row.candidate_snapshot);
  const candidateAccountId = row.candidate_account_id || snapshot.accountId || "";
  return {
    id: row.id || "",
    runId: row.run_id || "",
    accountId: candidateAccountId,
    displayName: snapshot.displayName || "",
    hiveHandle: snapshot.hiveHandle || "",
    walletAddress: row.candidate_wallet_address || snapshot.walletAddress || "",
    profilePath: candidateAccountId
      ? `/api/profile/member?accountId=${encodeURIComponent(candidateAccountId)}`
      : "",
    roleTitle: snapshot.roleTitle || "",
    roleSummary: snapshot.roleSummary || "",
    rank: Number(row.rank || 0),
    reason: row.reason || "",
    suggestedFirstAction: row.suggested_first_action || "",
    sharedContext: row.shared_context || "",
    complementaryValue: row.complementary_value || "",
    riskOrUncertainty: row.risk_or_uncertainty || "",
    supportingSignals: safeArray(row.supporting_signals),
    score: Number(row.score || 0),
    expiresAt: toIso(row.expires_at),
    createdAt: toIso(row.created_at),
  };
}

export async function getRecommendedConnectionsState({ accountId = "" } = {}) {
  if (!await recommendedConnectionTablesReady()) {
    return { ok: true, available: false, status: "vector_tables_not_ready", recommendations: [] };
  }
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, status: 401, error: "recommended_connections_login_required" };
  const visibility = profileVisibility(normalizedAccountId);
  if (!shouldIndexRecommendedConnectionProfile(visibility)) {
    return {
      ok: true,
      available: true,
      status: "profile_private",
      visibility,
      recommendations: [],
      refresh: { allowed: false, reason: "profile_private" },
    };
  }
  const rows = await query(
    `
      SELECT connections.*,
             candidate_profiles.wallet_address AS candidate_wallet_address
      FROM recommended_connections connections
      LEFT JOIN recommended_connection_profiles candidate_profiles
        ON candidate_profiles.account_id = connections.candidate_account_id
       AND candidate_profiles.visibility = 'public'
       AND candidate_profiles.discoverable = true
       AND candidate_profiles.disabled_at IS NULL
      WHERE connections.target_account_id = $1
        AND connections.status = 'active'
        AND connections.expires_at > now()
      ORDER BY connections.rank ASC, connections.created_at DESC, connections.id ASC
      LIMIT $2
    `,
    [normalizedAccountId, maxRecommendations]
  );
  const latestRun = await query(
    `
      SELECT *
      FROM recommended_connection_runs
      WHERE target_account_id = $1
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  const run = latestRun.rows[0] || null;
  return {
    ok: true,
    available: true,
    status: rows.rows.length ? "ready" : run?.status === "failed" ? "failed" : "empty",
    visibility,
    recommendations: rows.rows.map(publicConnection),
    run: run ? {
      id: run.id,
      status: run.status,
      provider: run.provider,
      model: run.model,
      candidateCount: Number(run.candidate_count || 0),
      completedAt: toIso(run.completed_at),
      lastError: run.last_error || "",
    } : null,
    refresh: {
      allowed: true,
      stale: !latestRunFresh(run),
      weeklyFresh: latestRunFresh(run),
    },
  };
}

export function parseRecommendedConnectionsJson(text = "", candidates = []) {
  const raw = String(text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("recommended_connections_invalid_json");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const candidateIds = new Set(candidates.map((candidate) => candidate.accountId));
  return safeArray(parsed.recommendations)
    .map((entry, index) => {
      const candidateAccountId = safeText(entry.candidate_account_id || entry.account_id || entry.accountId, 180);
      return {
        candidateAccountId,
        rank: Math.max(1, Number(entry.rank || index + 1)),
        reason: safeText(entry.reason, 900),
        suggestedFirstAction: safeText(entry.suggested_first_action || entry.suggestedFirstAction, 500),
        sharedContext: safeText(entry.shared_context || entry.sharedContext, 500),
        complementaryValue: safeText(entry.complementary_value || entry.complementaryValue, 500),
        riskOrUncertainty: safeText(entry.risk_or_uncertainty || entry.riskOrUncertainty, 500),
        supportingSignals: safeArray(entry.supporting_signals || entry.supportingSignals)
          .map((item) => safeText(item, 180))
          .filter(Boolean)
          .slice(0, 5),
        score: Math.max(0, Math.min(1, Number(entry.score || 0))),
      };
    })
    .filter((entry) => (
      entry.candidateAccountId &&
      candidateIds.has(entry.candidateAccountId) &&
      entry.reason &&
      entry.suggestedFirstAction
    ))
    .slice(0, maxRecommendations);
}

export function deterministicRecommendedConnections({ candidates = [] } = {}) {
  return safeArray(candidates)
    .slice(0, maxRecommendations)
    .map((candidate, index) => ({
      candidateAccountId: candidate.accountId,
      rank: index + 1,
      reason: `${candidate.displayName || "This member"} has overlapping Task Node work and a completed Network Diagnostic Report that matches the current profile packet.`,
      suggestedFirstAction: "Review their current focus and ask for one concrete contribution on the shared product surface.",
      sharedContext: safeArray(candidate.currentFocus)[0] || candidate.roleTitle || "Shared Task Node context.",
      complementaryValue: safeArray(candidate.primaryContribution)[0] || "Can add useful review or implementation judgment.",
      riskOrUncertainty: "This is a deterministic fallback until DeepSeek reranking is available.",
      supportingSignals: [
        candidate.roleTitle || "Completed Network Diagnostic Report",
        candidate.skills?.[0] || "Discoverable public profile",
        candidate.currentTasks?.[0]?.title || "Recent task context",
      ].filter(Boolean).slice(0, 3),
      score: Math.max(0, Number(candidate.similarity || 0)),
    }));
}

function recommendationPromptPayload({ target = {}, candidates = [] } = {}) {
  return {
    schema: "pf.profile.recommended_connections_rerank_input.v1",
    objective: "Choose the 3-4 Task Node members most useful for the target member to know or work with next.",
    target,
    candidate_count: candidates.length,
    candidates: candidates.map((candidate, index) => ({
      rank_from_vector_search: index + 1,
      account_id: candidate.accountId,
      display_name: candidate.displayName,
      hive_handle: candidate.hiveHandle,
      role_title: candidate.roleTitle,
      role_summary: candidate.roleSummary,
      skills: candidate.skills,
      vector_similarity: candidate.similarity,
      network_diagnostic_report: candidate.networkDiagnosticText,
      current_focus: candidate.currentFocus,
      primary_contribution_ability: candidate.primaryContribution,
      current_tasks: candidate.currentTasks,
    })),
  };
}

async function callDeepSeekRecommendedConnections({
  prompt,
  target,
  candidates,
  fetchImpl = fetch,
} = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK || "";
  if (!apiKey) {
    return {
      provider: "deterministic_fallback",
      model: "deterministic-recommended-connections-v1",
      recommendations: deterministicRecommendedConnections({ candidates }),
      output: { recommendations: deterministicRecommendedConnections({ candidates }) },
      usage: {},
    };
  }
  const model = process.env.TASKNODE_RECOMMENDED_CONNECTIONS_MODEL ||
    process.env.DEEPSEEK_CHAT_MODEL ||
    "deepseek-v4-pro";
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || defaultDeepSeekBaseUrl).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(10_000, Number(process.env.TASKNODE_RECOMMENDED_CONNECTIONS_TIMEOUT_MS || 90_000)));
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(recommendationPromptPayload({ target, candidates })) },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("recommended_connections_deepseek_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `DeepSeek recommended connections HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const content = body?.choices?.[0]?.message?.content || "";
  return {
    provider: "deepseek",
    model: body?.model || model,
    recommendations: parseRecommendedConnectionsJson(content, candidates),
    output: body,
    usage: body?.usage || {},
  };
}

function candidateSnapshot(candidate = {}) {
  return {
    accountId: candidate.accountId,
    displayName: candidate.displayName,
    hiveHandle: candidate.hiveHandle,
    walletAddress: candidate.walletAddress,
    roleTitle: candidate.roleTitle,
    roleSummary: candidate.roleSummary,
    skills: candidate.skills,
    similarity: candidate.similarity,
  };
}

export async function refreshRecommendedConnections({
  accountId = "",
  force = false,
  refreshCandidateProfiles = true,
  trigger = "profile_page",
  prompt = "",
  promptDigest = "",
  fetchImpl = fetch,
} = {}) {
  if (!await recommendedConnectionTablesReady()) {
    return { ok: false, status: 503, error: "recommended_connections_vector_store_not_ready" };
  }
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, status: 401, error: "recommended_connections_login_required" };
  const visibility = profileVisibility(normalizedAccountId);
  if (!shouldIndexRecommendedConnectionProfile(visibility)) {
    await deleteRecommendedConnectionProfile({ accountId: normalizedAccountId, reason: "profile_private" });
    return { ok: true, status: "profile_private", recommendations: [] };
  }

  if (refreshCandidateProfiles) {
    await refreshDiscoverableRecommendedConnectionProfiles({
      limit: Number(process.env.TASKNODE_RECOMMENDED_CONNECTIONS_PROFILE_REFRESH_LIMIT || 80),
    });
  }
  await refreshRecommendedConnectionProfile({ accountId: normalizedAccountId });

  const latest = await query(
    `
      SELECT *
      FROM recommended_connection_runs
      WHERE target_account_id = $1
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  if (!force && latestRunFresh(latest.rows[0] || null)) {
    return {
      ...(await getRecommendedConnectionsState({ accountId: normalizedAccountId })),
      refreshed: false,
      reason: "weekly_run_current",
    };
  }

  const candidateState = await topRecommendedConnectionCandidates({ accountId: normalizedAccountId });
  if (!candidateState.ok) return { ok: false, status: 409, error: candidateState.reason || "recommended_connection_candidates_unavailable" };
  const target = candidateState.targetProfile;
  const candidates = candidateState.candidates.slice(0, maxCandidateCount);
  const runId = `recconnrun_${randomUUID()}`;
  const run = await query(
    `
      INSERT INTO recommended_connection_runs (
        id,
        target_account_id,
        status,
        trigger,
        target_packet_digest,
        candidate_count,
        candidate_profile_ids,
        provider,
        model,
        prompt_version,
        prompt_digest
      )
      VALUES ($1, $2, 'processing', $3, $4, $5, $6::jsonb, '', '', $7, $8)
      RETURNING *
    `,
    [
      runId,
      normalizedAccountId,
      safeText(trigger, 120),
      safeText(target.packetDigest, 180),
      candidates.length,
      JSON.stringify(candidates.map((candidate) => candidate.accountId)),
      recommendedConnectionsPromptVersion,
      safeText(promptDigest, 180),
    ]
  );

  try {
    const result = candidates.length
      ? await callDeepSeekRecommendedConnections({ prompt, target, candidates, fetchImpl })
      : {
        provider: "skipped",
        model: "no-candidates",
        recommendations: [],
        output: { recommendations: [] },
        usage: {},
      };
    const recommendations = result.recommendations.length >= minRecommendations
      ? result.recommendations
      : [
        ...result.recommendations,
        ...deterministicRecommendedConnections({ candidates })
          .filter((entry) => !result.recommendations.some((existing) => existing.candidateAccountId === entry.candidateAccountId)),
      ].slice(0, maxRecommendations);
    await transaction(async (client) => {
      await client.query(
        `
          UPDATE recommended_connections
          SET status = 'expired',
              updated_at = now()
          WHERE target_account_id = $1
            AND status = 'active'
        `,
        [normalizedAccountId]
      );
      await client.query(
        `
          UPDATE recommended_connection_runs
          SET status = 'completed',
              provider = $2,
              model = $3,
              output_json = $4::jsonb,
              usage_json = $5::jsonb,
              completed_at = now(),
              updated_at = now()
          WHERE id = $1
        `,
        [runId, result.provider, result.model, jsonValue(result.output), jsonValue(result.usage)]
      );
      for (const [index, recommendation] of recommendations.entries()) {
        const candidate = candidates.find((item) => item.accountId === recommendation.candidateAccountId);
        if (!candidate) continue;
        await client.query(
          `
            INSERT INTO recommended_connections (
              id,
              run_id,
              target_account_id,
              candidate_account_id,
              rank,
              reason,
              suggested_first_action,
              shared_context,
              complementary_value,
              risk_or_uncertainty,
              supporting_signals,
              candidate_snapshot,
              score,
              expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, now() + interval '7 days')
          `,
          [
            `recconn_${randomUUID()}`,
            runId,
            normalizedAccountId,
            recommendation.candidateAccountId,
            index + 1,
            recommendation.reason,
            recommendation.suggestedFirstAction,
            recommendation.sharedContext,
            recommendation.complementaryValue,
            recommendation.riskOrUncertainty,
            JSON.stringify(recommendation.supportingSignals),
            JSON.stringify(candidateSnapshot(candidate)),
            recommendation.score,
          ]
        );
      }
    });
  } catch (error) {
    await query(
      `
        UPDATE recommended_connection_runs
        SET status = 'failed',
            last_error = $2,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [run.rows[0]?.id || runId, safeText(error?.message || error, 1000)]
    );
    throw error;
  }

  return {
    ...(await getRecommendedConnectionsState({ accountId: normalizedAccountId })),
    refreshed: true,
  };
}

export async function refreshStaleRecommendedConnections({
  limit = 1,
  prompt = "",
  promptDigest = "",
  fetchImpl = fetch,
} = {}) {
  if (!await recommendedConnectionTablesReady()) {
    return { ok: false, skipped: true, reason: "tables_not_ready", processed: [] };
  }
  const normalizedLimit = Math.min(Math.max(Number(limit || 1), 1), 20);
  const result = await query(
    `
      SELECT profiles.account_id
      FROM recommended_connection_profiles profiles
      LEFT JOIN LATERAL (
        SELECT completed_at
        FROM recommended_connection_runs runs
        WHERE runs.target_account_id = profiles.account_id
          AND runs.status = 'completed'
        ORDER BY runs.completed_at DESC NULLS LAST, runs.created_at DESC, runs.id DESC
        LIMIT 1
      ) latest ON true
      WHERE profiles.discoverable = true
        AND profiles.visibility = 'public'
        AND profiles.disabled_at IS NULL
        AND (
          latest.completed_at IS NULL
          OR latest.completed_at < now() - interval '7 days'
        )
      ORDER BY latest.completed_at ASC NULLS FIRST,
               profiles.generated_at ASC,
               profiles.account_id ASC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  const processed = [];
  for (const row of result.rows) {
    try {
      processed.push(await refreshRecommendedConnections({
        accountId: row.account_id,
        force: false,
        refreshCandidateProfiles: false,
        trigger: "recommended_connections_worker",
        prompt,
        promptDigest,
        fetchImpl,
      }));
    } catch (error) {
      processed.push({
        ok: false,
        accountId: row.account_id,
        error: safeText(error?.message || error, 1000),
      });
    }
  }
  return {
    ok: true,
    scanned: result.rows.length,
    processed,
    refreshedCount: processed.filter((item) => item.ok && item.refreshed).length,
    failedCount: processed.filter((item) => item.ok === false).length,
  };
}

export async function recordRecommendedConnectionEvent({
  accountId = "",
  candidateAccountId = "",
  connectionId = "",
  eventType = "",
  metadata = {},
} = {}) {
  if (!await recommendedConnectionTablesReady()) return { ok: false, skipped: true, reason: "tables_not_ready" };
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedCandidate = safeText(candidateAccountId, 180);
  const normalizedEvent = safeText(eventType, 80);
  if (!normalizedAccountId || !normalizedCandidate || !normalizedEvent) {
    return { ok: false, status: 400, error: "recommended_connection_event_invalid" };
  }
  const result = await query(
    `
      INSERT INTO recommended_connection_events (
        id,
        target_account_id,
        candidate_account_id,
        connection_id,
        event_type,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id
    `,
    [
      `recconnevent_${randomUUID()}`,
      normalizedAccountId,
      normalizedCandidate,
      safeText(connectionId, 180),
      normalizedEvent,
      jsonValue(metadata),
    ]
  );
  return { ok: true, id: result.rows[0]?.id || "" };
}
