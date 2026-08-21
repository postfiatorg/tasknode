import { createHash, randomUUID } from "node:crypto";

import { databaseEnabled, query } from "../db/pool.js";
import { accountWalletCloudFacts } from "../runtime-store.js";
import { getAccount } from "./accounts.js";
import {
  getAccountIdentityProfile,
  listAccountIdentityProfiles,
  listPublicAccountWalletIdentities,
} from "./account-profiles.js";
import { getLinkedWallet } from "./account-wallets.js";
import {
  nonFixtureRecommendedProfileSql,
  nonFixtureTaskProjectionSql,
} from "./task-projection-integrity.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function hashReference(value = "") {
  const text = safeText(value, 2000);
  if (!text) return "";
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function normalizeHandle(value = "") {
  return safeText(value, 120).replace(/^@+/, "").toLowerCase();
}

function normalizeSince(value = "") {
  const text = safeText(value, 80).toLowerCase();
  if (!text) return null;
  if (text === "today") {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
  if (text === "yesterday") {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString();
  }
  const relative = text.match(/^(\d+)([hdw])$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "h" ? amount * 60 * 60 * 1000 : unit === "w" ? amount * 7 * 24 * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - ms).toISOString();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function userObservabilitySince(value = "") {
  return normalizeSince(value);
}

async function safeQuery(sql, params = []) {
  if (!databaseEnabled()) return [];
  try {
    const result = await query(sql, params);
    return result.rows;
  } catch {
    return [];
  }
}

function providerSnapshots(identityProfile = {}) {
  return safeArray(identityProfile.aliases).map((alias) => ({
    provider: safeText(alias.provider, 80),
    username: safeText(alias.username || alias.handle, 180),
    displayName: safeText(alias.displayName, 180),
    status: safeText(alias.status || "linked", 80),
    linkedAt: alias.linkedAt || null,
    public: alias.visibility === "public",
    verified: alias.verified === true,
  }));
}

async function identityProfileSnapshot(accountId = "") {
  const profile = await getAccountIdentityProfile({ accountId }) || null;
  const account = await getAccount(accountId) || null;
  return {
    accountId: safeText(accountId, 180),
    publicHandle: safeText(profile?.hiveHandle, 120),
    displayName: safeText(profile?.displayName || account?.displayName, 180),
    publicDisplayName: safeText(profile?.publicDisplayName, 180),
    profileVisibility: safeText(profile?.profileVisibility || account?.profileVisibility || "", 80),
    providers: providerSnapshots(profile || {}),
  };
}

async function runtimeWalletsForAccount(accountId = "") {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return [];
  const rows = [];
  const activeWallet = await getLinkedWallet({ accountId: normalizedAccountId });
  if (activeWallet?.address) {
    rows.push({
      walletAddress: safeText(activeWallet.address, 120),
      role: "user",
      status: activeWallet.status === "linked" ? "active" : safeText(activeWallet.status || "unknown", 80),
      source: "runtime-store.accountWallets",
      linkedAt: activeWallet.linkedAt || null,
      updatedAt: activeWallet.updatedAt || null,
      lastHotSyncAt: null,
      lastFullSyncAt: null,
    });
  }
  const facts = accountWalletCloudFacts({ accountId: normalizedAccountId });
  for (const event of safeArray(facts.authEvents)) {
    const walletAddress = safeText(event?.metadata?.walletAddress, 120);
    if (!walletAddress) continue;
    rows.push({
      walletAddress,
      role: "user",
      status: String(event.eventType || "").includes("delinked") ? "historical" : "historical",
      source: `runtime-store.authEvents.${safeText(event.eventType, 80)}`,
      linkedAt: event.metadata?.linkedAt || null,
      updatedAt: event.createdAt || null,
      lastHotSyncAt: null,
      lastFullSyncAt: null,
    });
  }
  return rows;
}

async function postgresWalletsForAccount({ accountId = "", walletAddress = "" } = {}) {
  const rows = [];
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  const syncRows = await safeQuery(
    `
      SELECT account_id, wallet_address, role, status, last_hot_sync_at, last_archive_sync_at, updated_at
      FROM pftl_sync_wallets
      WHERE role = 'user'
        AND (
          ($1::text <> '' AND account_id = $1)
          OR ($2::text <> '' AND wallet_address = $2)
        )
      ORDER BY status ASC, last_hot_sync_at DESC NULLS LAST, wallet_address ASC
      LIMIT 50
    `,
    [normalizedAccountId, normalizedWallet]
  );
  for (const row of syncRows) {
    rows.push({
      accountId: safeText(row.account_id, 180),
      walletAddress: safeText(row.wallet_address, 120),
      role: safeText(row.role || "user", 80),
      status: row.status === "active" ? "active" : "historical",
      source: "pftl_sync_wallets",
      linkedAt: null,
      updatedAt: toIso(row.updated_at),
      lastHotSyncAt: toIso(row.last_hot_sync_at),
      lastFullSyncAt: toIso(row.last_archive_sync_at),
    });
  }
  const projectionRows = await safeQuery(
    `
      SELECT account_id, subject_wallet AS wallet_address, max(updated_at) AS updated_at, count(*)::int AS task_count
      FROM task_projections
      WHERE subject_wallet <> ''
        AND ${nonFixtureTaskProjectionSql("task_projections")}
        AND (
          ($1::text <> '' AND account_id = $1)
          OR ($2::text <> '' AND subject_wallet = $2)
        )
      GROUP BY account_id, subject_wallet
      ORDER BY max(updated_at) DESC
      LIMIT 50
    `,
    [normalizedAccountId, normalizedWallet]
  );
  for (const row of projectionRows) {
    rows.push({
      accountId: safeText(row.account_id, 180),
      walletAddress: safeText(row.wallet_address, 120),
      role: "user",
      status: "historical",
      source: "task_projections",
      linkedAt: null,
      updatedAt: toIso(row.updated_at),
      taskCount: Number(row.task_count || 0),
      lastHotSyncAt: null,
      lastFullSyncAt: null,
    });
  }
  return rows;
}

function mergeWalletRows(rows = []) {
  const byAddress = new Map();
  for (const row of rows) {
    const walletAddress = safeText(row.walletAddress || row.wallet_address, 120);
    if (!walletAddress) continue;
    const existing = byAddress.get(walletAddress) || {};
    const status = existing.status === "active" || row.status === "active" ? "active" : safeText(row.status || existing.status || "historical", 80);
    const sources = new Set(safeArray(existing.sources));
    if (existing.source) sources.add(existing.source);
    if (row.source) sources.add(row.source);
    byAddress.set(walletAddress, {
      ...existing,
      ...row,
      walletAddress,
      role: safeText(row.role || existing.role || "user", 80),
      status,
      sources: [...sources].filter(Boolean),
      source: safeText(row.source || existing.source, 160),
      lastHotSyncAt: row.lastHotSyncAt || existing.lastHotSyncAt || null,
      lastFullSyncAt: row.lastFullSyncAt || existing.lastFullSyncAt || null,
      updatedAt: row.updatedAt || existing.updatedAt || null,
    });
  }
  return [...byAddress.values()].sort((left, right) => {
    if (left.status === "active" && right.status !== "active") return -1;
    if (left.status !== "active" && right.status === "active") return 1;
    return String(left.walletAddress).localeCompare(String(right.walletAddress));
  });
}

async function identityMatchCandidates({ handle = "", provider = "", providerUsername = "" } = {}) {
  const needle = normalizeHandle(handle || providerUsername);
  const normalizedProvider = safeText(provider, 80).toLowerCase();
  if (!needle) return [];
  const matches = [];
  const [profiles, walletIdentities] = await Promise.all([
    listAccountIdentityProfiles(),
    listPublicAccountWalletIdentities(),
  ]);
  for (const profile of profiles) {
    const values = [
      profile.accountId,
      profile.hiveHandle,
      profile.displayName,
      profile.publicDisplayName,
      ...safeArray(profile.aliases)
        .filter((alias) => !normalizedProvider || safeText(alias.provider, 80).toLowerCase() === normalizedProvider)
        .flatMap((alias) => [alias.username, alias.displayName, alias.provider]),
      ...safeArray(profile.publicAliases).flatMap((alias) => [alias.handle, alias.label, alias.provider]),
    ];
    if (values.some((value) => normalizeHandle(value) === needle || normalizeHandle(value).includes(needle))) {
      matches.push({
        accountId: safeText(profile.accountId, 180),
        hiveHandle: safeText(profile.hiveHandle, 120),
        displayName: safeText(profile.displayName, 180),
        publicDisplayName: safeText(profile.publicDisplayName, 180),
        source: "app_accounts",
      });
    }
  }
  for (const identity of walletIdentities) {
    const values = [
      identity.accountId,
      identity.walletAddress,
      identity.displayName,
      identity.hiveHandle,
      identity.publicDisplayName,
      ...safeArray(identity.publicAliases).flatMap((alias) => [alias.handle, alias.label, alias.provider]),
    ];
    if (values.some((value) => normalizeHandle(value) === needle || normalizeHandle(value).includes(needle))) {
      matches.push({
        accountId: safeText(identity.accountId, 180),
        walletAddress: safeText(identity.walletAddress, 120),
        hiveHandle: safeText(identity.hiveHandle, 120),
        displayName: safeText(identity.displayName, 180),
        publicDisplayName: safeText(identity.publicDisplayName, 180),
        source: "account_linked_wallets",
      });
    }
  }
  const byKey = new Map();
  for (const match of matches) {
    byKey.set(`${match.accountId}:${match.walletAddress || ""}:${match.source}`, match);
  }
  return [...byKey.values()];
}

async function postgresAccountMatches({ walletAddress = "", handle = "" } = {}) {
  const normalizedWallet = safeText(walletAddress, 120);
  const normalizedHandle = normalizeHandle(handle);
  const matches = [];
  if (normalizedWallet) {
    const rows = await safeQuery(
      `
        SELECT account_id, wallet_address, source
        FROM (
          SELECT account_id, wallet_address, 'pftl_sync_wallets' AS source
          FROM pftl_sync_wallets
          WHERE wallet_address = $1
          UNION ALL
	          SELECT account_id, subject_wallet AS wallet_address, 'task_projections' AS source
	          FROM task_projections
	          WHERE subject_wallet = $1
	            AND ${nonFixtureTaskProjectionSql("task_projections")}
	          UNION ALL
          SELECT candidate_account_id AS account_id, candidate_wallet_address AS wallet_address, 'network_task_allocations' AS source
          FROM network_task_allocations
          WHERE candidate_wallet_address = $1
        ) AS account_matches
        WHERE account_id <> ''
        LIMIT 50
      `,
      [normalizedWallet]
    );
    for (const row of rows) {
      matches.push({
        accountId: safeText(row.account_id, 180),
        walletAddress: safeText(row.wallet_address, 120),
        source: safeText(row.source, 120),
      });
    }
  }
  if (normalizedHandle) {
    const rows = await safeQuery(
      `
        SELECT account_id, wallet_address, hive_handle, display_name, 'recommended_connection_profiles' AS source
        FROM recommended_connection_profiles
        WHERE (
          lower(hive_handle) = $1
          OR lower(display_name) LIKE '%' || $1 || '%'
        )
          AND ${nonFixtureRecommendedProfileSql("recommended_connection_profiles")}
        LIMIT 20
      `,
      [normalizedHandle]
    );
    for (const row of rows) {
      matches.push({
        accountId: safeText(row.account_id, 180),
        walletAddress: safeText(row.wallet_address, 120),
        hiveHandle: safeText(row.hive_handle, 120),
        displayName: safeText(row.display_name, 180),
        source: safeText(row.source, 120),
      });
    }
  }
  const byKey = new Map();
  for (const match of matches) byKey.set(`${match.accountId}:${match.walletAddress || ""}:${match.source}`, match);
  return [...byKey.values()];
}

export async function resolveUserIdentityVector({
  handle = "",
  accountId = "",
  walletAddress = "",
  provider = "",
  providerUsername = "",
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  const repositoryMatches = await identityMatchCandidates({ handle, provider, providerUsername });
  const postgresMatches = await postgresAccountMatches({ walletAddress: normalizedWallet, handle: handle || providerUsername });
  const candidateAccountIds = new Set();
  if (normalizedAccountId) candidateAccountIds.add(normalizedAccountId);
  for (const match of [...repositoryMatches, ...postgresMatches]) {
    if (match.accountId) candidateAccountIds.add(match.accountId);
  }

  let resolvedAccountId = normalizedAccountId;
  if (!resolvedAccountId && candidateAccountIds.size === 1) {
    resolvedAccountId = [...candidateAccountIds][0];
  }

  if (!normalizedAccountId && candidateAccountIds.size > 1) {
    return {
      ok: false,
      error: "identity_ambiguous",
      selector: { handle: safeText(handle, 120), accountId: normalizedAccountId, walletAddress: normalizedWallet, provider: safeText(provider, 80), providerUsername: safeText(providerUsername, 180) },
      matches: [...repositoryMatches, ...postgresMatches],
      identity: null,
    };
  }

  if (!resolvedAccountId && !normalizedWallet) {
    const matches = [...repositoryMatches, ...postgresMatches];
    return {
      ok: false,
      error: "identity_not_resolved",
      selector: { handle: safeText(handle, 120), accountId: normalizedAccountId, walletAddress: normalizedWallet, provider: safeText(provider, 80), providerUsername: safeText(providerUsername, 180) },
      matches,
      identity: null,
    };
  }

  if (!resolvedAccountId && normalizedWallet) {
    const walletOnly = {
      accountId: "",
      publicHandle: "",
      displayName: "",
      publicDisplayName: "",
      profileVisibility: "",
      providers: [],
      wallets: mergeWalletRows([
        { walletAddress: normalizedWallet, role: "user", status: "unknown", source: "selector.wallet" },
        ...await postgresWalletsForAccount({ walletAddress: normalizedWallet }),
      ]),
    };
    return {
      ok: true,
      warning: "wallet_scoped_identity_only",
      selector: { handle: safeText(handle, 120), accountId: "", walletAddress: normalizedWallet },
      matches: [...repositoryMatches, ...postgresMatches],
      identity: walletOnly,
    };
  }

  const profile = await identityProfileSnapshot(resolvedAccountId);
  const wallets = mergeWalletRows([
    ...await runtimeWalletsForAccount(resolvedAccountId),
    ...await postgresWalletsForAccount({ accountId: resolvedAccountId, walletAddress: normalizedWallet }),
    normalizedWallet ? { walletAddress: normalizedWallet, role: "user", status: "unknown", source: "selector.wallet" } : null,
  ].filter(Boolean));

  return {
    ok: true,
    selector: {
      handle: safeText(handle, 120),
      accountId: normalizedAccountId,
      walletAddress: normalizedWallet,
      provider: safeText(provider, 80),
      providerUsername: safeText(providerUsername, 180),
    },
    matches: [...repositoryMatches, ...postgresMatches],
    identity: {
      ...profile,
      wallets,
    },
  };
}

export function identitySnapshotForEvent(identity = {}) {
  return {
    accountId: safeText(identity.accountId, 180),
    publicHandle: safeText(identity.publicHandle, 120),
    displayName: safeText(identity.displayName, 180),
    providerCount: safeArray(identity.providers).length,
    providers: safeArray(identity.providers).map((provider) => ({
      provider: provider.provider,
      public: provider.public === true,
      verified: provider.verified === true,
      status: provider.status || "linked",
    })),
    wallets: safeArray(identity.wallets).map((wallet) => ({
      walletAddress: wallet.walletAddress,
      role: wallet.role || "user",
      status: wallet.status || "unknown",
      sources: wallet.sources || [wallet.source].filter(Boolean),
    })),
  };
}

export async function recordUserObservabilityEvent(event = {}, { bestEffort = true } = {}) {
  if (process.env.TASKNODE_USER_OBSERVABILITY_DISABLED === "true") {
    return { ok: false, skipped: true, reason: "user_observability_disabled" };
  }
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured" };
  }

  const accountId = safeText(event.accountId || event.account_id, 180);
  const walletAddress = safeText(event.walletAddress || event.wallet_address, 120);
  const profile = accountId ? await identityProfileSnapshot(accountId) : {};
  const publicHandle = safeText(event.publicHandle || event.public_handle || profile.publicHandle, 120);
  const identitySnapshot = safeObject(event.identitySnapshot || event.identity_snapshot_json);
  const row = {
    id: safeText(event.id, 180) || `uobs_${randomUUID()}`,
    occurredAt: toIso(event.occurredAt || event.occurred_at) || new Date().toISOString(),
    eventType: safeText(event.eventType || event.event_type, 160),
    eventVersion: Math.max(1, Number(event.eventVersion || event.event_version || 1)),
    accountId,
    publicHandle,
    walletAddress,
    walletScope: safeText(event.walletScope || event.wallet_scope, 80),
    provider: safeText(event.provider, 80),
    providerUserIdHash: safeText(event.providerUserIdHash || event.provider_user_id_hash || (event.providerUserId ? hashReference(event.providerUserId) : ""), 180),
    sessionIdHash: safeText(event.sessionIdHash || event.session_id_hash || (event.sessionId ? hashReference(event.sessionId) : ""), 180),
    requestId: safeText(event.requestId || event.request_id, 180),
    taskId: safeText(event.taskId || event.task_id, 180),
    conversationId: safeText(event.conversationId || event.conversation_id, 180),
    projectId: safeText(event.projectId || event.project_id, 180),
    allocationId: safeText(event.allocationId || event.allocation_id, 180),
    generationJobId: safeText(event.generationJobId || event.generation_job_id, 180),
    modelRunId: safeText(event.modelRunId || event.model_run_id, 180),
    txHash: safeText(event.txHash || event.tx_hash, 240),
    cid: safeText(event.cid, 240),
    sourceSurface: safeText(event.sourceSurface || event.source_surface, 120),
    sourceRoute: safeText(event.sourceRoute || event.source_route, 240),
    resultStatus: safeText(event.resultStatus || event.result_status, 120),
    reasonCode: safeText(event.reasonCode || event.reason_code, 180),
    identitySnapshot: Object.keys(identitySnapshot).length
      ? identitySnapshot
      : identitySnapshotForEvent({ ...profile, wallets: walletAddress ? [{ walletAddress, status: "unknown", role: "user" }] : [] }),
    decision: safeObject(event.decision || event.decision_json),
    metrics: safeObject(event.metrics || event.metrics_json),
    metadata: safeObject(event.metadata || event.metadata_json),
    privacyClass: safeText(event.privacyClass || event.privacy_class || "internal", 80) || "internal",
    retentionUntil: toIso(event.retentionUntil || event.retention_until),
  };

  if (!row.eventType) {
    const error = new Error("user_observability_event_type_required");
    if (bestEffort) return { ok: false, error: error.message };
    throw error;
  }

  try {
    await query(
      `
        INSERT INTO user_observability_events (
          id, occurred_at, event_type, event_version, account_id, public_handle,
          wallet_address, wallet_scope, provider, provider_user_id_hash,
          session_id_hash, request_id, task_id, conversation_id, project_id,
          allocation_id, generation_job_id, model_run_id, tx_hash, cid,
          source_surface, source_route, result_status, reason_code,
          identity_snapshot_json, decision_json, metrics_json, metadata_json,
          privacy_class, retention_until
        )
        VALUES (
          $1, $2::timestamptz, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25::jsonb, $26::jsonb, $27::jsonb, $28::jsonb,
          $29, $30::timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        row.id,
        row.occurredAt,
        row.eventType,
        row.eventVersion,
        row.accountId,
        row.publicHandle,
        row.walletAddress,
        row.walletScope,
        row.provider,
        row.providerUserIdHash,
        row.sessionIdHash,
        row.requestId,
        row.taskId,
        row.conversationId,
        row.projectId,
        row.allocationId,
        row.generationJobId,
        row.modelRunId,
        row.txHash,
        row.cid,
        row.sourceSurface,
        row.sourceRoute,
        row.resultStatus,
        row.reasonCode,
        jsonValue(row.identitySnapshot),
        jsonValue(row.decision),
        jsonValue(row.metrics),
        jsonValue(row.metadata),
        ["public", "internal", "sensitive_reference", "security"].includes(row.privacyClass) ? row.privacyClass : "internal",
        row.retentionUntil,
      ]
    );
    return { ok: true, id: row.id, eventType: row.eventType };
  } catch (error) {
    if (bestEffort) return { ok: false, error: error?.message || String(error) };
    throw error;
  }
}

export async function listUserObservabilityEvents({
  accountId = "",
  walletAddress = "",
  eventType = "",
  since = "",
  limit = 50,
  includeSecurity = false,
} = {}) {
  if (!databaseEnabled()) return [];
  const normalizedSince = normalizeSince(since);
  const rows = await safeQuery(
    `
      SELECT *
      FROM user_observability_events
      WHERE ($1::text = '' OR account_id = $1)
        AND ($2::text = '' OR wallet_address = $2)
        AND ($3::text = '' OR event_type = $3)
        AND ($4::timestamptz IS NULL OR occurred_at >= $4::timestamptz)
        AND ($5::boolean = true OR privacy_class <> 'security')
      ORDER BY occurred_at DESC, id DESC
      LIMIT $6
    `,
    [
      safeText(accountId, 180),
      safeText(walletAddress, 120),
      safeText(eventType, 160),
      normalizedSince,
      includeSecurity === true,
      Math.min(Math.max(Number(limit || 50), 1), 500),
    ]
  );
  return rows.map((row) => ({
    id: row.id,
    occurredAt: toIso(row.occurred_at),
    eventType: row.event_type,
    accountId: row.account_id,
    publicHandle: row.public_handle,
    walletAddress: row.wallet_address,
    walletScope: row.wallet_scope,
    requestId: row.request_id,
    taskId: row.task_id,
    projectId: row.project_id,
    allocationId: row.allocation_id,
    generationJobId: row.generation_job_id,
    resultStatus: row.result_status,
    reasonCode: row.reason_code,
    sourceSurface: row.source_surface,
    sourceRoute: row.source_route,
    decision: row.decision_json || {},
    metrics: row.metrics_json || {},
    metadata: row.metadata_json || {},
    privacyClass: row.privacy_class,
  }));
}

export function networkTaskCapacityDecision({ eligibility = {}, metrics = {} } = {}) {
  const blockers = safeArray(eligibility?.capacity?.blockers);
  const walletOutstandingCount = Number(metrics.walletOutstandingCount ?? metrics.wallet_outstanding_count ?? (blockers.length ? blockers.length : 0));
  const walletPendingGenerationCount = Number(metrics.walletPendingGenerationCount ?? metrics.wallet_pending_generation_count ?? 0);
  const accountOutstandingCount = Number(metrics.accountOutstandingCount ?? metrics.account_outstanding_count ?? walletOutstandingCount);
  const accountPendingGenerationCount = Number(metrics.accountPendingGenerationCount ?? metrics.account_pending_generation_count ?? 0);
  const accountOnlyPendingCount = Number(metrics.accountOnlyPendingCount ?? metrics.account_only_pending_count ?? 0);
  const eligible = eligibility.status === "available_for_routing" && eligibility?.capacity?.available !== false;
  const capacityScopeUsed = accountOnlyPendingCount > 0
    ? "account"
    : eligibility.walletAddress
      ? "wallet"
      : "account";
  const blockReason = eligible
    ? ""
    : accountOnlyPendingCount > 0
      ? "account_has_pending_network_task"
      : walletOutstandingCount > 0 || blockers.length > 0
        ? "wallet_has_outstanding_network_task"
        : safeText(eligibility.status || "network_task_not_eligible", 120);
  return {
    schema: "pf.task_node.network_task_eligibility.v1",
    capacity_scope_used: capacityScopeUsed,
    eligible,
    status: safeText(eligibility.status || "", 120),
    block_reason: blockReason,
    wallet_outstanding_count: walletOutstandingCount,
    wallet_pending_generation_count: walletPendingGenerationCount,
    account_outstanding_count: accountOutstandingCount,
    account_pending_generation_count: accountPendingGenerationCount,
    account_only_pending_count: accountOnlyPendingCount,
    blockers: blockers.map((blocker) => ({
      task_id: safeText(blocker.taskId || blocker.task_id, 180),
      request_id: safeText(blocker.requestId || blocker.request_id, 180),
      allocation_id: safeText(blocker.allocationId || blocker.allocation_id, 180),
      generation_job_id: safeText(blocker.generationJobId || blocker.generation_job_id, 180),
      project_id: safeText(blocker.projectId || blocker.project_id, 180),
      state: safeText(blocker.state, 80),
      source: safeText(blocker.source, 80),
      updated_at: blocker.updatedAt || blocker.updated_at || null,
    })),
  };
}

export async function recordNetworkTaskCapacityEvent({
  eligibility = {},
  metrics = {},
  sourceRoute = "server/repositories/network-tasks.js::getNetworkTaskEligibility",
} = {}) {
  const decision = networkTaskCapacityDecision({ eligibility, metrics });
  return recordUserObservabilityEvent({
    eventType: "user.network_task.capacity_checked",
    accountId: eligibility.accountId || "",
    walletAddress: eligibility.walletAddress || "",
    walletScope: eligibility.walletAddress ? "candidate_wallet" : "unknown",
    sourceSurface: "tasks",
    sourceRoute,
    resultStatus: eligibility.status || "",
    reasonCode: decision.block_reason || "",
    decision,
    metrics: {
      gateCount: safeArray(eligibility.gates).length,
      blockerCount: safeArray(eligibility?.capacity?.blockers).length,
      ...safeObject(metrics),
    },
    metadata: {
      label: eligibility.label || "",
      nextAction: eligibility.nextAction || "",
      profileStatus: eligibility.profile?.status || "",
      walletSynced: eligibility.wallet?.synced === true,
    },
  });
}

export async function recordChatTurnObservability({
  accountId = "",
  conversationId = "",
  mode = "",
  provider = "",
  model = "",
  responseId = "",
  modelRunId = "",
  user = null,
  assistant = null,
  usage = {},
  ledgerEntry = null,
  sourceRoute = "server/repositories/chat-billing.js::appendChatTurn",
  sourceSurface = "chat",
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, skipped: true, reason: "missing_account" };
  const userBodyLength = String(user?.body || "").length;
  const assistantBodyLength = String(assistant?.body || "").length;
  const attachments = safeArray(user?.attachments);
  const common = {
    accountId: normalizedAccountId,
    conversationId,
    modelRunId,
    sourceSurface,
    sourceRoute,
    metadata: {
      mode: safeText(mode, 80),
      provider: safeText(provider, 80),
      model: safeText(model, 180),
      responseId: safeText(responseId, 240),
      userMessageId: safeText(user?.id, 180),
      assistantMessageId: safeText(assistant?.id, 180),
    },
  };
  const results = await Promise.allSettled([
    recordUserObservabilityEvent({
      ...common,
      eventType: "user.chat.message_sent",
      resultStatus: "sent",
      metrics: {
        messageCharacterCount: userBodyLength,
        attachmentCount: attachments.length,
        attachmentBytes: attachments.reduce((sum, attachment) => sum + Number(attachment?.size || 0), 0),
      },
    }),
    recordUserObservabilityEvent({
      ...common,
      eventType: "user.chat.model_run_completed",
      resultStatus: "completed",
      responseId,
      metrics: {
        inputTokens: Number(usage?.inputTokens || 0),
        outputTokens: Number(usage?.outputTokens || 0),
        totalTokens: Number(usage?.totalTokens || 0),
        webSearchCalls: Number(usage?.webSearchCalls || 0),
        toolCostUsd: Number(usage?.toolCostUsd || 0),
        costUsd: Number(usage?.costUsd || ledgerEntry?.amountUsd || 0),
        assistantCharacterCount: assistantBodyLength,
      },
    }),
  ]);
  return {
    ok: results.every((result) => result.status === "fulfilled" && result.value?.ok !== false),
    results: results.map((result) => result.status === "fulfilled" ? result.value : { ok: false, error: result.reason?.message || String(result.reason) }),
  };
}

export async function recordChatFailureObservability({
  accountId = "",
  conversationId = "",
  mode = "",
  provider = "",
  model = "",
  error = "",
  status = "",
  sourceRoute = "server/product-contracts.js::chatSend",
  sourceSurface = "chat",
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) return { ok: false, skipped: true, reason: "missing_account" };
  const reasonCode = safeText(error?.message || error || "chat_provider_error", 180);
  return recordUserObservabilityEvent({
    eventType: "user.chat.model_run_failed",
    accountId: normalizedAccountId,
    conversationId,
    sourceSurface,
    sourceRoute,
    resultStatus: "failed",
    reasonCode,
    metadata: {
      mode: safeText(mode, 80),
      provider: safeText(provider || error?.provider, 80),
      model: safeText(model, 180),
      status: safeText(status || error?.status, 80),
    },
  });
}

export async function recordBillingCreditAppliedEvent({
  entry = null,
  sourceRoute = "server/repositories/chat-billing.js::appendUsageCredit",
} = {}) {
  if (!entry || entry.idempotentReplay) return { ok: false, skipped: true, reason: "no_new_credit_entry" };
  const source = safeText(entry.source, 120);
  return recordUserObservabilityEvent({
    eventType: "user.billing.credit_applied",
    accountId: entry.accountId || "",
    conversationId: entry.conversationId || "",
    modelRunId: entry.modelRunId || "",
    sourceSurface: source === "ethereum_deposit" ? "billing_top_up" : "billing",
    sourceRoute,
    resultStatus: "credited",
    reasonCode: source,
    metrics: {
      amountUsd: Number(entry.amountUsd || 0),
      inputTokens: Number(entry.inputTokens || 0),
      outputTokens: Number(entry.outputTokens || 0),
      totalTokens: Number(entry.totalTokens || 0),
    },
    metadata: {
      ledgerEntryId: safeText(entry.id, 180),
      kind: safeText(entry.kind, 80),
      source,
      uniqueKey: safeText(entry.uniqueKey, 180),
      asset: safeText(entry.metadata?.asset, 40),
      depositAccountId: safeText(entry.metadata?.depositAccountId, 180),
    },
  });
}
