import {
  ACTIVE_INTERVIEW_MODES,
  ALLOWED_ASSET_CLASSES,
  ALLOWED_INTERVIEW_MODES,
  COVERAGE_MANIFEST_SCHEMA_VERSION,
  DEFAULT_MAX_CONCURRENT_INTERVIEWS,
  ELIGIBLE_INFO_TYPES,
  EXPERT_MIN_SCORE,
  EXPERT_REQUIRED_PERSONAL_TASKS,
  FORBIDDEN_CONTRIBUTOR_PRIVATE_KEYS,
} from "./constants.js";
import { scanPublicSurfaceForLeaks } from "./brief-isolation.js";

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VENUE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const BRIEF_PATH_RE = /^public\/briefs\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;

const ALLOWED_MANIFEST_KEYS = new Set([
  "schema_version",
  "generated_at",
  "publication_version",
  "universe_policy",
  "assets",
]);

const ALLOWED_ASSET_KEYS = new Set([
  "model_id",
  "ticker",
  "name",
  "asset_class",
  "perp_venues",
  "perp_liquidity_verified",
  "area_tags",
  "eligible_info_types",
  "interview_mode",
  "paid_interviews_enabled",
  "equity_counsel_approved",
  "public_brief_path",
  "status",
  "updated_at",
]);

const PRIVATE_KEY_SET = new Set(FORBIDDEN_CONTRIBUTOR_PRIVATE_KEYS.map((k) => k.toLowerCase()));

export function validateCoverageAsset(asset) {
  const errors = [];
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    return { ok: false, errors: ["asset_object_required"] };
  }
  for (const key of Object.keys(asset)) {
    if (!ALLOWED_ASSET_KEYS.has(key)) errors.push(`unexpected_asset_property:${key}`);
  }
  if (typeof asset.model_id !== "string" || !MODEL_ID_RE.test(asset.model_id)) errors.push("invalid_model_id");
  if (typeof asset.ticker !== "string" || !TICKER_RE.test(asset.ticker)) errors.push("invalid_ticker");
  if (typeof asset.name !== "string" || asset.name.length < 1 || asset.name.length > 120) errors.push("invalid_name");

  // Locked scope rule: strictly crypto protocols and perp-backed liquid megacap equities.
  if (!ALLOWED_ASSET_CLASSES.includes(asset.asset_class)) {
    errors.push(`disallowed_asset_class:${String(asset.asset_class || "missing")}`);
  }

  if (!Array.isArray(asset.perp_venues) || asset.perp_venues.length > 16 ||
      asset.perp_venues.some((v) => typeof v !== "string" || !VENUE_RE.test(v)) ||
      new Set(asset.perp_venues).size !== asset.perp_venues.length) {
    errors.push("invalid_perp_venues");
  }
  if (typeof asset.perp_liquidity_verified !== "boolean") errors.push("invalid_perp_liquidity_verified");

  // Perp-backed equity enforcement: MUST have >= 1 perp venue AND perp_liquidity_verified === true.
  if (asset.asset_class === "perp_megacap_equity") {
    if (!Array.isArray(asset.perp_venues) || asset.perp_venues.length < 1) {
      errors.push("non_perp_equity_rejected");
    }
    if (asset.perp_liquidity_verified !== true) {
      errors.push("unverified_perp_liquidity_equity_rejected");
    }
    if (asset.paid_interviews_enabled === true) {
      if (asset.equity_counsel_approved !== true) {
        errors.push("equity_paid_interview_requires_counsel_approval");
      }
      if (!ACTIVE_INTERVIEW_MODES.includes(asset.interview_mode)) {
        errors.push("equity_paid_interview_requires_active_mode");
      }
    }
  }

  if (!Array.isArray(asset.area_tags) || asset.area_tags.length < 1 || asset.area_tags.length > 24 ||
      asset.area_tags.some((t) => typeof t !== "string" || !TAG_RE.test(t)) ||
      new Set(asset.area_tags).size !== asset.area_tags.length) {
    errors.push("invalid_area_tags");
  }

  if (!Array.isArray(asset.eligible_info_types) || asset.eligible_info_types.length < 1 ||
      asset.eligible_info_types.some((t) => !ELIGIBLE_INFO_TYPES.includes(t)) ||
      new Set(asset.eligible_info_types).size !== asset.eligible_info_types.length) {
    errors.push("invalid_eligible_info_types");
  }

  if (!ALLOWED_INTERVIEW_MODES.includes(asset.interview_mode)) errors.push("invalid_interview_mode");
  if (typeof asset.paid_interviews_enabled !== "boolean") errors.push("invalid_paid_interviews_enabled");
  if (typeof asset.equity_counsel_approved !== "boolean") errors.push("invalid_equity_counsel_approved");
  if (typeof asset.public_brief_path !== "string" || !BRIEF_PATH_RE.test(asset.public_brief_path)) {
    errors.push("invalid_public_brief_path");
  }
  if (!["active", "added", "deprecated"].includes(asset.status)) errors.push("invalid_status");
  if (typeof asset.updated_at !== "string" || !ISO_UTC_RE.test(asset.updated_at)) errors.push("invalid_updated_at");

  const leakScan = scanPublicSurfaceForLeaks(asset, `coverage_asset:${asset.model_id || "unknown"}`);
  if (!leakScan.ok) {
    errors.push(...leakScan.violations.map((v) => v.code));
  }

  return { ok: errors.length === 0, errors };
}

export function validateCoverageManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest_object_required"], validAssets: [], rejectedAssets: [] };
  }
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) errors.push(`unexpected_manifest_property:${key}`);
  }
  if (manifest.schema_version !== COVERAGE_MANIFEST_SCHEMA_VERSION) errors.push("invalid_schema_version");
  if (typeof manifest.generated_at !== "string" || !ISO_UTC_RE.test(manifest.generated_at)) errors.push("invalid_generated_at");
  if (!Number.isInteger(manifest.publication_version) || manifest.publication_version < 1) errors.push("invalid_publication_version");

  const policy = manifest.universe_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push("missing_universe_policy");
  } else {
    const allowedPolicyKeys = new Set(["allowed_asset_classes", "exclude_non_perp_equities", "public_safe_only"]);
    if (Object.keys(policy).some((k) => !allowedPolicyKeys.has(k))) errors.push("unexpected_universe_policy_key");
    if (policy.exclude_non_perp_equities !== true) errors.push("exclude_non_perp_equities_must_be_true");
    if (policy.public_safe_only !== true) errors.push("public_safe_only_must_be_true");
    const classes = Array.isArray(policy.allowed_asset_classes) ? [...policy.allowed_asset_classes].sort() : [];
    const expected = [...ALLOWED_ASSET_CLASSES].sort();
    if (classes.length !== expected.length || classes.some((c, i) => c !== expected[i])) {
      errors.push("allowed_asset_classes_must_match_locked_scope");
    }
  }

  const validAssets = [];
  const rejectedAssets = [];
  if (!Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 500) {
    errors.push("invalid_assets_array");
  } else {
    for (const asset of manifest.assets) {
      const check = validateCoverageAsset(asset);
      if (check.ok) {
        validAssets.push(asset);
      } else {
        rejectedAssets.push({
          model_id: asset?.model_id || "unknown",
          ticker: asset?.ticker || "",
          errors: check.errors,
        });
      }
    }
    if (rejectedAssets.length > 0) {
      errors.push(`rejected_assets:${rejectedAssets.length}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    validAssets,
    rejectedAssets,
  };
}

/**
 * Checks whether a Task Node user is eligible to participate in Pillar 10 interviews.
 * Open to ANY Expert-badged or domain-verified contributor (NOT restricted to Finance Hub members).
 */
export function evaluateContributorEligibility(contributor = {}) {
  if (!contributor?.accountId) {
    return { eligible: false, basis: "none", reason: "account_required" };
  }
  if (contributor.blacklisted === true || contributor.suspended === true) {
    return { eligible: false, basis: "none", reason: "account_restricted" };
  }
  if (contributor.sybilBlocked === true) {
    return { eligible: false, basis: "none", reason: "sybil_blocked" };
  }

  const expert = contributor.expertAccess || {};
  const personalTaskCount = Number(expert.personalTaskCount ?? contributor.completedPersonalTasks ?? 0);
  const expertScore = Number(expert.score ?? 0);
  const disqualifying = Array.isArray(expert.disqualifyingConcerns) ? expert.disqualifyingConcerns : [];
  const hasExpertBadge = expert.eligible === true || (
    expert.status === "verified" &&
    personalTaskCount >= EXPERT_REQUIRED_PERSONAL_TASKS &&
    expertScore >= EXPERT_MIN_SCORE &&
    disqualifying.length === 0
  );

  if (hasExpertBadge) {
    return {
      eligible: true,
      basis: "expert_badge",
      reason: "verified_expert_badge",
      isFinanceHubMember: Boolean(contributor.isFinanceHubMember),
    };
  }

  const verifiedCapabilities = (Array.isArray(contributor.capabilityProfiles) ? contributor.capabilityProfiles : [])
    .filter((profile) => profile && (profile.verified === true || profile.status === "verified"));
  if (verifiedCapabilities.length > 0) {
    return {
      eligible: true,
      basis: "verified_capability_profile",
      reason: "verified_capability_profile",
      isFinanceHubMember: Boolean(contributor.isFinanceHubMember),
      verifiedDomains: verifiedCapabilities.map((c) => String(c.domain || c.capabilityType || "").toLowerCase()).filter(Boolean),
    };
  }

  return {
    eligible: false,
    basis: "none",
    reason: "expert_badge_or_verified_capability_required",
  };
}

/**
 * Builds a strictly sanitized contributor brief for company agents.
 * Guarantees ZERO Deep Memory, private chat, context docs, or task evidence leak through.
 */
export function buildSanitizedContributorBrief(profile = {}, { relationship = "" } = {}) {
  if (!profile || typeof profile !== "object") {
    throw new Error("contributor_profile_required");
  }
  // Reject attempts to smuggle forbidden private surfaces into the brief input.
  for (const key of Object.keys(profile)) {
    if (PRIVATE_KEY_SET.has(key.toLowerCase())) {
      throw new Error(`forbidden_private_contributor_field:${key}`);
    }
  }
  if (profile.confirmed !== true) {
    const error = new Error("contributor_areas_not_confirmed");
    error.status = 409;
    throw error;
  }

  const confirmedAreas = (Array.isArray(profile.confirmedAreas) ? profile.confirmedAreas : [])
    .map((tag) => String(tag || "").trim().toLowerCase())
    .filter((tag) => TAG_RE.test(tag));
  const confirmedInfoTypes = (Array.isArray(profile.confirmedInfoTypes) ? profile.confirmedInfoTypes : [])
    .map((t) => String(t || "").trim().toLowerCase())
    .filter((t) => ELIGIBLE_INFO_TYPES.includes(t));

  return Object.freeze({
    confirmedAreas: Object.freeze([...new Set(confirmedAreas)]),
    confirmedInfoTypes: Object.freeze([...new Set(confirmedInfoTypes)]),
    declaredRelationship: String(relationship || "").trim().toLowerCase(),
    approvedSummary: String(profile.approvedSummary || "").trim().slice(0, 600),
  });
}

function cosineSimilarity(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]) || 0;
    const b = Number(right[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

/**
 * Matches an eligible contributor against a validated coverage manifest.
 * Strictly filters to covered crypto protocols + perp-backed liquid megacap equities,
 * requires user-confirmed knowledge areas, respects concurrent-interview caps & rotation,
 * and computes private match reasons visible only to the contributor.
 */
export function matchContributorToCoverage({
  contributor = {},
  profile = {},
  manifest = null,
  activeInterviewModelIds = [],
  recentInterviewModelIds = [],
  assetEmbeddings = {},
  contributorEmbedding = null,
  limit = 10,
} = {}) {
  const eligibility = evaluateContributorEligibility(contributor);
  if (!eligibility.eligible) {
    return {
      ok: false,
      eligible: false,
      reason: eligibility.reason,
      matches: [],
      rejectedAssetCount: 0,
    };
  }

  if (profile?.confirmed !== true) {
    return {
      ok: false,
      eligible: true,
      reason: "knowledge_areas_confirmation_required",
      matches: [],
      rejectedAssetCount: 0,
    };
  }

  // Validate manifest policy & strictly filter assets.
  const manifestValidation = validateCoverageManifest(manifest);
  const validAssets = manifestValidation.validAssets;
  const rejectedAssetCount = manifestValidation.rejectedAssets.length;

  // Fail closed if manifest top-level policy itself is invalid (e.g. allows non-perp equities).
  const policyErrors = manifestValidation.errors.filter((e) => !e.startsWith("rejected_assets:"));
  if (policyErrors.length > 0) {
    return {
      ok: false,
      eligible: true,
      reason: `invalid_coverage_manifest:${policyErrors[0]}`,
      matches: [],
      rejectedAssetCount,
    };
  }

  const maxConcurrent = Math.max(
    1,
    Math.min(10, Number(profile.maxConcurrentInterviews || DEFAULT_MAX_CONCURRENT_INTERVIEWS))
  );
  const activeSet = new Set(activeInterviewModelIds);
  const recentSet = new Set(recentInterviewModelIds);
  const concurrentCapReached = activeSet.size >= maxConcurrent;

  const confirmedAreaSet = new Set(
    (Array.isArray(profile.confirmedAreas) ? profile.confirmedAreas : [])
      .map((t) => String(t || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const confirmedInfoSet = new Set(
    (Array.isArray(profile.confirmedInfoTypes) ? profile.confirmedInfoTypes : [])
      .map((t) => String(t || "").trim().toLowerCase())
      .filter((t) => ELIGIBLE_INFO_TYPES.includes(t))
  );

  const completedTasks = Math.max(0, Number(contributor.completedPersonalTasks ?? contributor.expertAccess?.personalTaskCount ?? 0));
  const verifiedClaims = Math.max(0, Number(profile.verifiedClaimsCount ?? 0));
  const domainWeight = Math.max(0.25, Math.min(3.0, Number(profile.domainWeight ?? 1.0)));
  const evidenceMultiplier = (1 + Math.min(0.4, completedTasks / 100) + Math.min(0.6, verifiedClaims * 0.1)) * domainWeight;

  const scored = [];
  for (const asset of validAssets) {
    if (asset.status === "deprecated") continue;
    if (asset.interview_mode === "disabled") continue;

    // Asset-class & perp-backing double-check (defense in depth).
    if (!ALLOWED_ASSET_CLASSES.includes(asset.asset_class)) continue;
    if (asset.asset_class === "perp_megacap_equity" && (asset.perp_venues.length < 1 || !asset.perp_liquidity_verified)) {
      continue;
    }

    const matchedTags = asset.area_tags.filter((tag) => confirmedAreaSet.has(tag));
    const matchedInfoTypes = asset.eligible_info_types.filter((t) => confirmedInfoSet.has(t));
    const embeddingSim = contributorEmbedding && assetEmbeddings[asset.model_id]
      ? cosineSimilarity(contributorEmbedding, assetEmbeddings[asset.model_id])
      : 0;

    if (matchedTags.length === 0 && embeddingSim < 0.35) continue;

    const tagScore = matchedTags.length / Math.max(1, Math.min(asset.area_tags.length, 4));
    const infoTypeScore = matchedInfoTypes.length > 0 ? 0.25 : 0;
    const rawScore = (tagScore * 0.65) + (embeddingSim * 0.35) + infoTypeScore;
    const rotationFactor = recentSet.has(asset.model_id) ? 0.75 : 1.0;
    const finalScore = Number((rawScore * evidenceMultiplier * rotationFactor).toFixed(4));

    const interviewActive = ACTIVE_INTERVIEW_MODES.includes(asset.interview_mode);
    const paidEligible = asset.paid_interviews_enabled === true &&
      (asset.asset_class !== "perp_megacap_equity" || asset.equity_counsel_approved === true) &&
      interviewActive;

    const accessTier = eligibility.isFinanceHubMember && asset.interview_mode === "member_and_public"
      ? "member"
      : "public_only";

    scored.push({
      modelId: asset.model_id,
      ticker: asset.ticker,
      name: asset.name,
      assetClass: asset.asset_class,
      perpVenues: [...asset.perp_venues],
      interviewMode: asset.interview_mode,
      interviewActive,
      paidInterviewEligible: paidEligible,
      equityCounselApproved: asset.equity_counsel_approved,
      accessTier,
      publicBriefPath: asset.public_brief_path,
      score: finalScore,
      alreadyActive: activeSet.has(asset.model_id),
      canStartInterview: interviewActive && !activeSet.has(asset.model_id) && !concurrentCapReached,
      // Private match reasons — only returned to the authenticated contributor.
      privateMatchReasons: {
        matchedTags,
        matchedInfoTypes,
        embeddingSimilarity: Number(embeddingSim.toFixed(4)),
        evidenceMultiplier: Number(evidenceMultiplier.toFixed(4)),
        rotatedRecently: recentSet.has(asset.model_id),
      },
    });
  }

  scored.sort((a, b) => b.score - a.score || a.modelId.localeCompare(b.modelId));

  return {
    ok: true,
    eligible: true,
    eligibilityBasis: eligibility.basis,
    concurrentCapReached,
    activeInterviewCount: activeSet.size,
    maxConcurrentInterviews: maxConcurrent,
    rejectedAssetCount,
    matches: scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 10))),
  };
}
