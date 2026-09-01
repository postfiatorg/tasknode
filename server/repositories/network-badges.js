import { createHash } from "node:crypto";
import { githubCoreContributorAccess } from "../core-contributor-authorization.js";
import { databaseEnabled, query } from "../db/pool.js";
import { getAccountExpertReview, getAccountIdentityProfile } from "./account-profiles.js";
import { normalizeCapabilityType } from "./capability-profiles.js";
import { hasUsageCreditForSource } from "./chat-billing.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

function stableDigest(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function useDatabase() {
  return databaseEnabled();
}

function ensureDatabase() {
  if (useDatabase()) return;
  const error = new Error("network_badges_database_not_configured");
  error.status = 503;
  throw error;
}

export const networkBadgeCatalogVersion = "network_badges_v1";

export const networkBadgeDefinitions = Object.freeze({
  kol: {
    badgeId: "kol",
    label: "KOL",
    symbolKey: "megaphone",
    maxPayoutPft: 50000,
    rewardCaps: {
      amplification: 20000,
      amplification_x: 20000,
      public_announcement: 20000,
      article_distribution: 50000,
      medium_article: 50000,
    },
    allowedWorkTypes: ["amplification", "amplification_x", "public_announcement", "article_distribution", "medium_article"],
  },
  core_contributor: {
    badgeId: "core_contributor",
    label: "Core Contributor",
    symbolKey: "git_pull_request",
    maxPayoutPft: 30000,
    rewardCaps: {
      code_task: 30000,
      private_repo_code: 30000,
      core_repo_work: 30000,
      code_review: 30000,
      capability_gating_task: 30000,
    },
    allowedWorkTypes: ["code_task", "private_repo_code", "core_repo_work", "code_review", "capability_gating_task"],
  },
  expert: {
    badgeId: "expert",
    label: "Expert",
    symbolKey: "graduation_cap",
    maxPayoutPft: 30000,
    rewardCaps: {
      expert_bundle: 30000,
      domain_analysis: 30000,
      expert_review: 30000,
    },
    allowedWorkTypes: ["expert_bundle", "domain_analysis", "expert_review"],
  },
  project_leader: {
    badgeId: "project_leader",
    label: "Project Leader",
    symbolKey: "crown",
    maxPayoutPft: 30000,
    rewardCaps: {
      project_management: 30000,
      special_project_definition: 30000,
      open_source_project_definition: 30000,
    },
    allowedWorkTypes: ["project_management", "special_project_definition", "open_source_project_definition"],
  },
  qa_worker: {
    badgeId: "qa_worker",
    label: "QA Worker",
    symbolKey: "bug",
    maxPayoutPft: 5000,
    rewardCaps: {
      qa_report: 5000,
      product_qa: 5000,
      repro_packet: 5000,
    },
    allowedWorkTypes: ["qa_report", "product_qa", "repro_packet"],
  },
});

function badgeDefinition(badgeId = "") {
  return networkBadgeDefinitions[safeText(badgeId, 80)] || null;
}

function aliasForProvider(identityProfile = {}, provider = "") {
  const normalized = safeText(provider, 40).toLowerCase();
  const aliases = safeArray(identityProfile.aliases);
  const accepted = normalized === "x" ? ["x", "twitter"] : [normalized];
  return aliases.find((alias) => accepted.includes(safeText(alias.provider, 40).toLowerCase())) || null;
}

function linkedVerified(identityProfile = {}, provider = "") {
  const alias = aliasForProvider(identityProfile, provider);
  return Boolean(alias && alias.verified !== false);
}

function normalizeWorkType(value = "") {
  return safeText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function capForWorkType(definition = {}, workType = "") {
  const normalizedWorkType = normalizeWorkType(workType);
  return numeric(definition.rewardCaps?.[normalizedWorkType], numeric(definition.maxPayoutPft, 0));
}

export function projectBadgeRequirementRecord({
  projectId = "",
  workType = "",
  requiredBadgeId = "",
  capabilityType = "",
  scopeLabel = "",
  scopeDigest = "",
  maxPayoutOverridePft = 0,
  createdByAccountId = "",
} = {}) {
  const normalizedProjectId = safeText(projectId, 180);
  const normalizedWorkType = normalizeWorkType(workType);
  const normalizedBadgeId = safeText(requiredBadgeId, 80);
  const definition = badgeDefinition(normalizedBadgeId);
  if (!normalizedProjectId || !normalizedWorkType || !definition) {
    const error = new Error("network_project_badge_requirement_invalid");
    error.status = 400;
    throw error;
  }
  const normalizedCapabilityType = normalizeCapabilityType(capabilityType);
  const normalizedScopeDigest = safeText(scopeDigest, 80);
  return {
    id: `npbr_${stableDigest([
      normalizedProjectId,
      normalizedWorkType,
      normalizedBadgeId,
      normalizedCapabilityType,
      normalizedScopeDigest,
    ].join(":")).slice(0, 32)}`,
    projectId: normalizedProjectId,
    workType: normalizedWorkType,
    requiredBadgeId: normalizedBadgeId,
    capabilityType: normalizedCapabilityType,
    scopeLabel: safeText(scopeLabel, 180),
    scopeDigest: normalizedScopeDigest,
    maxPayoutOverridePft: numeric(maxPayoutOverridePft, 0),
    active: true,
    createdByAccountId: safeText(createdByAccountId, 180),
  };
}

export async function listProjectBadgeRequirements({ projectId = "", workType = "", includeInactive = false } = {}) {
  const normalizedProjectId = safeText(projectId, 180);
  const normalizedWorkType = normalizeWorkType(workType);
  if (!normalizedProjectId || !useDatabase()) return [];
  const result = await query(
    `
      SELECT
        id,
        project_id,
        work_type,
        required_badge_id,
        capability_type,
        scope_label,
        scope_digest,
        max_payout_override_pft::text AS max_payout_override_pft,
        active,
        created_by_account_id
      FROM network_project_badge_requirements
      WHERE project_id = $1
        AND ($2::text = '' OR work_type = $2)
        AND ($3::boolean = true OR active = true)
      ORDER BY active DESC, work_type ASC, required_badge_id ASC, updated_at DESC, id ASC
    `,
    [normalizedProjectId, normalizedWorkType, includeInactive === true]
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    workType: normalizeWorkType(row.work_type),
    requiredBadgeId: safeText(row.required_badge_id, 80),
    capabilityType: normalizeCapabilityType(row.capability_type),
    scopeLabel: safeText(row.scope_label, 180),
    scopeDigest: safeText(row.scope_digest, 80),
    maxPayoutOverridePft: numeric(row.max_payout_override_pft, 0),
    active: row.active === true,
    createdByAccountId: safeText(row.created_by_account_id, 180),
  }));
}

export async function upsertProjectBadgeRequirement(input = {}) {
  ensureDatabase();
  const record = projectBadgeRequirementRecord(input);
  await query(
    `
      INSERT INTO network_project_badge_requirements (
        id,
        project_id,
        work_type,
        required_badge_id,
        capability_type,
        scope_label,
        scope_digest,
        max_payout_override_pft,
        active,
        created_by_account_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8::numeric, 0), true, $9, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        required_badge_id = EXCLUDED.required_badge_id,
        capability_type = EXCLUDED.capability_type,
        scope_label = EXCLUDED.scope_label,
        max_payout_override_pft = EXCLUDED.max_payout_override_pft,
        active = true,
        created_by_account_id = EXCLUDED.created_by_account_id,
        updated_at = now()
    `,
    [
      record.id,
      record.projectId,
      record.workType,
      record.requiredBadgeId,
      record.capabilityType,
      record.scopeLabel,
      record.scopeDigest,
      record.maxPayoutOverridePft,
      record.createdByAccountId,
    ]
  );
  return {
    ok: true,
    requirement: record,
    requirements: await listProjectBadgeRequirements({
      projectId: record.projectId,
      workType: record.workType,
      includeInactive: true,
    }),
  };
}

export async function disableProjectBadgeRequirement({
  id = "",
  projectId = "",
  workType = "",
  requiredBadgeId = "",
  capabilityType = "",
  scopeDigest = "",
} = {}) {
  ensureDatabase();
  const normalizedId = safeText(id, 180) || projectBadgeRequirementRecord({
    projectId,
    workType,
    requiredBadgeId,
    capabilityType,
    scopeDigest,
  }).id;
  const result = await query(
    `
      UPDATE network_project_badge_requirements
      SET active = false,
          updated_at = now()
      WHERE id = $1
      RETURNING project_id, work_type
    `,
    [normalizedId]
  );
  if (!result.rows[0]) {
    const error = new Error("network_project_badge_requirement_not_found");
    error.status = 404;
    throw error;
  }
  const row = result.rows[0];
  return {
    ok: true,
    id: normalizedId,
    requirements: await listProjectBadgeRequirements({
      projectId: row.project_id,
      workType: row.work_type,
      includeInactive: true,
    }),
  };
}

async function candidateHasCapabilityRequirement({
  accountId = "",
  projectId = "",
  requirement = {},
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedProjectId = safeText(projectId || requirement.projectId, 180);
  const capabilityType = normalizeCapabilityType(requirement.capabilityType);
  if (!normalizedAccountId || !useDatabase()) return false;
  if (!capabilityType || capabilityType === "unspecified_capability") return true;
  const result = await query(
    `
      SELECT 1
      FROM board_manager_capability_profiles
      WHERE account_id = $1
        AND capability_type = $2
        AND status = 'verified'
        AND revoked_at IS NULL
        AND (
          expires_at IS NULL
          OR expires_at > now()
        )
        AND (
          $3::text = ''
          OR project_id = ''
          OR project_id = $3
        )
        AND (
          $4::text = ''
          OR scope_digest = $4
        )
      LIMIT 1
    `,
    [
      normalizedAccountId,
      capabilityType,
      normalizedProjectId,
      safeText(requirement.scopeDigest, 80),
    ]
  ).catch(() => ({ rows: [] }));
  return Boolean(result.rows[0]);
}

function projectionBadge(definition = {}, evidence = {}) {
  return {
    badgeId: definition.badgeId,
    label: definition.label,
    symbolKey: definition.symbolKey || "",
    status: "verified",
    eligible: true,
    allowedWorkTypes: safeArray(definition.allowedWorkTypes),
    rewardCaps: safeObject(definition.rewardCaps),
    maxPayoutPft: numeric(definition.maxPayoutPft, 0),
    evidence,
  };
}

function publicBadgeFromDefinition({
  definition = {},
  status = "verified",
  selectedDefault = false,
  verifiedAt = "",
  expiresAt = "",
  source = "projection",
} = {}) {
  return {
    badgeId: safeText(definition.badgeId || definition.badge_id, 80),
    label: safeText(definition.label, 120),
    symbolKey: safeText(definition.symbolKey || definition.symbol_key, 80),
    status: safeText(status, 80) || "verified",
    selectedDefault: Boolean(selectedDefault),
    verifiedAt: safeText(verifiedAt, 80),
    expiresAt: safeText(expiresAt, 80),
    maxPayoutPft: numeric(definition.maxPayoutPft || definition.max_payout_pft, 0),
    allowedWorkTypes: safeArray(definition.allowedWorkTypes || definition.allowed_work_types_json).map((item) => safeText(item, 120)).filter(Boolean),
    rewardCaps: safeObject(definition.rewardCaps || definition.payout_policy_json),
    publicDescription: safeText(definition.publicDescription || definition.public_description, 500),
    source,
  };
}

function publicBadgeFromDurableRow(row = {}) {
  return publicBadgeFromDefinition({
    definition: {
      badgeId: row.badge_id,
      label: row.label,
      symbolKey: row.symbol_key,
      maxPayoutPft: row.max_payout_pft,
      allowedWorkTypes: row.allowed_work_types_json,
      rewardCaps: row.payout_policy_json,
      publicDescription: row.public_description,
    },
    status: row.status,
    selectedDefault: row.selected_default,
    verifiedAt: row.updated_at,
    expiresAt: row.expires_at,
    source: "account_network_badges",
  });
}

function projectionBadgeFromDurableRow(row = {}) {
  const definition = {
    badgeId: row.badge_id,
    label: row.label,
    symbolKey: row.symbol_key,
    maxPayoutPft: row.max_payout_pft,
    allowedWorkTypes: row.allowed_work_types_json,
    rewardCaps: row.payout_policy_json,
  };
  return projectionBadge(definition, {
    source: "account_network_badges",
    evidence: safeObject(row.evidence_json),
    metrics: safeObject(row.validated_metrics_json),
    verifiedAt: row.updated_at,
    expiresAt: row.expires_at,
  });
}

async function listDurableProjectionBadges({ accountId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId || !useDatabase()) return [];
  const result = await query(
    `
      SELECT
        badge.badge_id,
        badge.status,
        badge.selected_default,
        badge.expires_at,
        badge.updated_at,
        badge.evidence_json,
        badge.validated_metrics_json,
        definition.label,
        definition.symbol_key,
        definition.max_payout_pft::text AS max_payout_pft,
        definition.payout_policy_json,
        definition.allowed_work_types_json
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      WHERE badge.account_id = $1
        AND badge.status = 'verified'
        AND definition.active = true
        AND badge.revoked_at IS NULL
        AND (badge.expires_at IS NULL OR badge.expires_at > now())
      ORDER BY badge.selected_default DESC, badge.updated_at DESC, badge.badge_id ASC
    `,
    [normalizedAccountId]
  ).catch(() => ({ rows: [] }));
  return result.rows.map(projectionBadgeFromDurableRow).filter((badge) => badge.badgeId);
}

async function listDurablePublicBadges({ accountId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId || !useDatabase()) return [];
  const result = await query(
    `
      SELECT
        badge.badge_id,
        badge.status,
        badge.selected_default,
        badge.public_visible,
        badge.expires_at,
        badge.updated_at,
        definition.label,
        definition.symbol_key,
        definition.public_description,
        definition.max_payout_pft::text AS max_payout_pft,
        definition.payout_policy_json,
        definition.allowed_work_types_json
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      WHERE badge.account_id = $1
        AND badge.status = 'verified'
        AND badge.public_visible = true
        AND definition.active = true
        AND badge.revoked_at IS NULL
        AND (badge.expires_at IS NULL OR badge.expires_at > now())
      ORDER BY badge.selected_default DESC, badge.updated_at DESC, badge.badge_id ASC
    `,
    [normalizedAccountId]
  ).catch(() => ({ rows: [] }));
  return result.rows.map(publicBadgeFromDurableRow).filter((badge) => badge.badgeId);
}

async function completedPersonalTaskCount(accountId = "") {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId || !useDatabase()) return 0;
  const result = await query(
    `
      SELECT count(*)::int AS total
      FROM task_projections
      WHERE account_id = $1
        AND lower(task_kind) = 'personal'
        AND lower(status) IN ('completed', 'reward_decided', 'rewarded', 'paid')
    `,
    [normalizedAccountId]
  ).catch(() => ({ rows: [] }));
  return Math.max(0, Math.round(Number(result.rows[0]?.total || 0) || 0));
}

async function qaWorkerEligible(accountId = "") {
  return hasUsageCreditForSource({
    accountId,
    source: "ethereum_deposit",
    metadata: { asset: "USDC" },
  }).catch(() => false);
}

function projectionFromBadges({
  accountId = "",
  walletAddress = "",
  badges = [],
  source = "runtime_projection",
} = {}) {
  const safeBadges = safeArray(badges);
  const allowedWorkTypes = [...new Set(safeBadges.flatMap((badge) => badge.allowedWorkTypes))].sort();
  const rewardCaps = Object.fromEntries(
    safeBadges.flatMap((badge) => Object.entries(badge.rewardCaps || {}))
  );
  return {
    schema: "pf.task_node.network_badge_projection.v1",
    catalogVersion: networkBadgeCatalogVersion,
    accountId: safeText(accountId, 180),
    walletAddress: safeText(walletAddress, 120),
    verifiedBadges: safeBadges,
    verifiedBadgeIds: safeBadges.map((badge) => badge.badgeId),
    defaultBadge: safeBadges[0]?.badgeId || "",
    allowedWorkTypes,
    rewardCaps,
    source,
    enforcement: "executor_required",
  };
}

export async function networkBadgeProjectionForAccount({
  accountId = "",
  walletAddress = "",
  preferDurable = true,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  const identityProfile = normalizedAccountId ? await getAccountIdentityProfile({ accountId: normalizedAccountId }) || {} : {};
  const githubAlias = aliasForProvider(identityProfile, "github");
  const githubAccess = githubCoreContributorAccess(
    githubAlias?.username ||
      githubAlias?.metrics?.coreContributorAccess?.username ||
      githubAlias?.metrics?.coreContributorAccess?.matchedHandle ||
      ""
  );
  const githubBadge = githubAlias &&
    githubAlias.verified !== false &&
    githubAccess.sanctioned &&
    githubAccess.scopeRecorded
    ? projectionBadge(networkBadgeDefinitions.core_contributor, {
      provider: "github",
      handle: safeText(githubAccess.username || githubAccess.matchedHandle, 120),
      proofMethod: githubAccess.proofMethod,
    })
    : null;

  if (preferDurable) {
    const durableBadges = await listDurableProjectionBadges({ accountId: normalizedAccountId });
    if (durableBadges.length) {
      const currentBadges = durableBadges.filter((badge) => {
        if (badge.badgeId !== "core_contributor") return true;
        const source = safeText(badge.evidence?.evidence?.source, 120);
        return source !== "runtime_projection_refresh" || Boolean(githubBadge);
      });
      if (githubBadge && !currentBadges.some((badge) => badge.badgeId === "core_contributor")) {
        currentBadges.push(githubBadge);
      }
      return projectionFromBadges({
        accountId: normalizedAccountId,
        walletAddress: normalizedWallet,
        badges: currentBadges,
        source: githubBadge ? "account_network_badges_plus_current_authorization" : "account_network_badges",
      });
    }
  }
  const badges = [];

  const xAlias = aliasForProvider(identityProfile, "x");
  const xFollowers = Number(xAlias?.metrics?.followersCount);
  if (xAlias && xAlias.verified !== false && Number.isFinite(xFollowers) && xFollowers >= 5000) {
    badges.push(projectionBadge(networkBadgeDefinitions.kol, {
      provider: "x",
      handle: safeText(xAlias.username, 120),
      profileUrl: safeText(xAlias.profileUrl, 500),
      followersCount: xFollowers,
      proofMethod: "x_public_metrics",
    }));
  }

  if (githubBadge) {
    badges.push(githubBadge);
  }

  const projectLeaderAccess = safeObject(identityProfile.projectLeaderAccess);
  if (projectLeaderAccess.eligible === true) {
    badges.push(projectionBadge(networkBadgeDefinitions.project_leader, {
      handle: safeText(projectLeaderAccess.matchedHandle || projectLeaderAccess.handle, 120),
      proofMethod: safeText(projectLeaderAccess.proofMethod || "backend_hive_handle_allowlist", 120),
    }));
  }

  const qaLinked = linkedVerified(identityProfile, "telegram") && linkedVerified(identityProfile, "discord");
  if (qaLinked && await qaWorkerEligible(normalizedAccountId)) {
    badges.push(projectionBadge(networkBadgeDefinitions.qa_worker, {
      proofMethod: "telegram_discord_usdc_top_up",
    }));
  }

  const expertReview = normalizedAccountId ? await getAccountExpertReview({ accountId: normalizedAccountId }) || {} : {};
  const expertPersonalTasks = await completedPersonalTaskCount(normalizedAccountId);
  const expertScore = Number(expertReview.score || 0);
  if (
    expertPersonalTasks >= 20 &&
    safeText(expertReview.topic, 160) &&
    Number.isFinite(expertScore) &&
    expertScore >= 80 &&
    safeArray(expertReview.disqualifyingConcerns).length === 0
  ) {
    badges.push(projectionBadge(networkBadgeDefinitions.expert, {
      topic: safeText(expertReview.topic, 160),
      score: expertScore,
      personalTaskCount: expertPersonalTasks,
      proofMethod: "glm52_last_20_personal_tasks",
    }));
  }

  return projectionFromBadges({
    accountId: normalizedAccountId,
    walletAddress: normalizedWallet,
    badges,
    source: "runtime_projection",
  });
}

export async function buildBadgeEligibilityForCandidates(candidates = []) {
  const projected = [];
  for (const candidate of safeArray(candidates)) {
    const projection = await networkBadgeProjectionForAccount({
      accountId: candidate.accountId || candidate.account_id,
      walletAddress: candidate.walletAddress || candidate.wallet_address,
    });
    projected.push({
      accountId: projection.accountId,
      walletAddress: projection.walletAddress,
      verifiedBadges: projection.verifiedBadgeIds,
      defaultBadge: projection.defaultBadge,
      allowedWorkTypes: projection.allowedWorkTypes,
      rewardCaps: projection.rewardCaps,
      badgeDetails: projection.verifiedBadges.map((badge) => ({
        badgeId: badge.badgeId,
        label: badge.label,
        maxPayoutPft: badge.maxPayoutPft,
        allowedWorkTypes: badge.allowedWorkTypes,
      })),
    });
  }
  return {
    schema: "pf.task_node.badge_eligibility.v1",
    catalogVersion: networkBadgeCatalogVersion,
    enforcement: "executor_required",
    candidateCount: projected.length,
    badgeEligibleCandidateCount: projected.filter((item) => item.verifiedBadges.length > 0).length,
    candidates: projected,
  };
}

export async function publicNetworkBadgesForAccount({
  accountId = "",
  walletAddress = "",
} = {}) {
  const durable = await listDurablePublicBadges({ accountId });
  if (durable.length) {
    return {
      schema: "pf.task_node.public_network_badges.v1",
      catalogVersion: networkBadgeCatalogVersion,
      source: "account_network_badges",
      badges: durable,
    };
  }
  const projection = await networkBadgeProjectionForAccount({ accountId, walletAddress });
  const projectedBadges = projection.verifiedBadges
    .filter((badge) => badge.badgeId)
    .map((badge) => publicBadgeFromDefinition({
      definition: badge,
      status: "verified",
      selectedDefault: badge.badgeId === projection.defaultBadge,
      source: "runtime_projection",
    }));
  return {
    schema: "pf.task_node.public_network_badges.v1",
    catalogVersion: networkBadgeCatalogVersion,
    source: "runtime_projection",
    badges: projectedBadges,
  };
}

export async function assertNetworkTaskBadgeEligibility({
  accountId = "",
  walletAddress = "",
  projectId = "",
  workType = "",
  taskWorkType = "",
  requiredBadgeId = "",
  operatingBadgeId = "",
  requestedRewardMinPft = 0,
  requestedRewardMaxPft = 0,
} = {}) {
  const normalizedRequiredBadge = safeText(requiredBadgeId, 80);
  const normalizedOperatingBadge = safeText(operatingBadgeId, 80);
  const normalizedWorkType = normalizeWorkType(workType || taskWorkType);
  if (!normalizedRequiredBadge || !normalizedOperatingBadge || !normalizedWorkType) {
    const error = new Error("network_task_missing_badge_metadata");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_missing_badge_metadata",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
    };
    throw error;
  }
  if (normalizedRequiredBadge !== normalizedOperatingBadge) {
    const error = new Error("network_task_badge_metadata_mismatch");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_badge_metadata_mismatch",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
    };
    throw error;
  }

  const definition = badgeDefinition(normalizedRequiredBadge);
  if (!definition) {
    const error = new Error("network_task_unsupported_required_badge");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_unsupported_required_badge",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
    };
    throw error;
  }

  const projection = await networkBadgeProjectionForAccount({ accountId, walletAddress });
  const badge = projection.verifiedBadges.find((item) => item.badgeId === normalizedRequiredBadge);
  if (!badge) {
    const error = new Error("network_task_candidate_missing_badge");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_candidate_missing_badge",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      candidate_badges: projection.verifiedBadgeIds,
      work_type: normalizedWorkType,
    };
    throw error;
  }

  if (!safeArray(badge.allowedWorkTypes).includes(normalizedWorkType)) {
    const error = new Error("network_task_work_type_not_allowed_for_badge");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_work_type_not_allowed_for_badge",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      candidate_badges: projection.verifiedBadgeIds,
      work_type: normalizedWorkType,
      allowed_work_types: badge.allowedWorkTypes,
    };
    throw error;
  }

  const projectRequirements = await listProjectBadgeRequirements({
    projectId,
    workType: normalizedWorkType,
  });
  const matchingProjectRequirements = projectRequirements.filter((requirement) =>
    requirement.requiredBadgeId === normalizedRequiredBadge
  );
  if (projectRequirements.length && !matchingProjectRequirements.length) {
    const error = new Error("network_task_project_badge_requirement_mismatch");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_project_badge_requirement_mismatch",
      project_id: safeText(projectId, 180),
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
      allowed_project_badges: projectRequirements.map((requirement) => requirement.requiredBadgeId),
    };
    throw error;
  }

  const scopedCapabilityRequirement = matchingProjectRequirements.find((requirement) =>
    requirement.capabilityType && requirement.capabilityType !== "unspecified_capability"
  );
  if (
    scopedCapabilityRequirement &&
    !(await candidateHasCapabilityRequirement({
      accountId,
      projectId,
      requirement: scopedCapabilityRequirement,
    }))
  ) {
    const error = new Error("network_task_missing_scoped_capability");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_missing_scoped_capability",
      project_id: safeText(projectId, 180),
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
      capability_type: scopedCapabilityRequirement.capabilityType,
      scope_label: scopedCapabilityRequirement.scopeLabel,
      scope_digest: scopedCapabilityRequirement.scopeDigest,
    };
    throw error;
  }

  const cap = matchingProjectRequirements
    .map((requirement) => requirement.maxPayoutOverridePft)
    .filter((value) => value > 0)
    .reduce((current, override) => current > 0 ? Math.min(current, override) : override, capForWorkType(badge, normalizedWorkType));
  const rewardMin = numeric(requestedRewardMinPft, 0);
  const rewardMax = numeric(requestedRewardMaxPft, 0);
  if (cap > 0 && (rewardMax > cap || rewardMin > cap)) {
    const error = new Error("network_task_reward_exceeds_badge_cap");
    error.status = 422;
    error.decision = {
      eligible: false,
      block_reason: "network_task_reward_exceeds_badge_cap",
      required_badge_id: normalizedRequiredBadge,
      operating_badge_id: normalizedOperatingBadge,
      work_type: normalizedWorkType,
      badge_reward_cap_pft: cap,
      requested_reward_min_pft: rewardMin,
      requested_reward_max_pft: rewardMax,
    };
    throw error;
  }

  return {
    schema: "pf.task_node.network_task_badge_eligibility_decision.v1",
    eligible: true,
    required_badge_id: normalizedRequiredBadge,
    operating_badge_id: normalizedOperatingBadge,
    work_type: normalizedWorkType,
    badge_reward_cap_pft: cap,
    project_badge_requirement: matchingProjectRequirements[0] || null,
    candidate_badges: projection.verifiedBadgeIds,
    badge,
    projection,
  };
}
