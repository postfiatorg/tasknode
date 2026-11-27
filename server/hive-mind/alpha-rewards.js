import { randomUUID } from "node:crypto";
import { REWARD_BOUNDS } from "./constants.js";

function round4(value) {
  return Number(Number(value || 0).toFixed(4));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

/**
 * Computes the fast citation pool ($10-$50 USD equivalent) for an applied cluster.
 * Higher quality / contrarian / multi-contributor corroborated clusters approach $50.
 */
export function computeCitationPoolUsd({ cluster = {}, claims = [] } = {}) {
  const avgEvidence = claims.length > 0
    ? claims.reduce((sum, c) => sum + Number(c.evidenceScore || 50), 0) / claims.length
    : 50;
  const avgNovelty = claims.length > 0
    ? claims.reduce((sum, c) => sum + Number(c.noveltyScore || 50), 0) / claims.length
    : 50;
  const hasChallenge = claims.some((c) => c.stance === "challenges");
  const corroborated = cluster?.consensusStatus === "consensus" || new Set(claims.map((c) => c.accountId)).size >= 2;

  const qualityRatio = clamp(
    ((avgEvidence * 0.45) + (avgNovelty * 0.35) + (hasChallenge ? 12 : 0) + (corroborated ? 8 : 0)) / 100,
    0,
    1
  );
  const poolUsd = REWARD_BOUNDS.citationMinUsd +
    ((REWARD_BOUNDS.citationMaxUsd - REWARD_BOUNDS.citationMinUsd) * qualityRatio);
  return round4(clamp(poolUsd, REWARD_BOUNDS.citationMinUsd, REWARD_BOUNDS.citationMaxUsd));
}

/**
 * Computes the accelerated alpha bonus multiplier (2x-5x) for a verified checkable claim.
 * Highest multiplier (up to 5x) goes to novel, non-consensus contrarian `challenges`
 * that move model estimates materially closer to reported reality.
 */
export function computeAcceleratedAlphaMultiplier({
  stance = "refines",
  noveltyScore = 60,
  forecastAccuracyDelta = 0,
  isNonConsensus = false,
} = {}) {
  const baseByStance = stance === "challenges" ? 3.5 : stance === "refines" ? 2.5 : 2.0;
  const noveltyBonus = clamp((Number(noveltyScore || 0) - 50) / 50, 0, 1) * 0.5;
  const accuracyBonus = clamp(Number(forecastAccuracyDelta || 0) / 10, 0, 0.75);
  const contrarianBonus = stance === "challenges" && isNonConsensus ? 0.5 : 0;

  return round4(clamp(
    baseByStance + noveltyBonus + accuracyBonus + contrarianBonus,
    REWARD_BOUNDS.alphaMultiplierMin,
    REWARD_BOUNDS.alphaMultiplierMax
  ));
}

/**
 * Processes idempotent fast citation payouts ($10-$50 split proportionally across corroborated cluster)
 * when a model-host `proposal_applied` webhook confirms a CHANGELOG merge.
 */
export async function issueCitationPayoutsForAppliedProposal({
  store,
  proposal,
  pftPerUsd = REWARD_BOUNDS.defaultPftPerUsd,
  badgeCapsByAccount = {},
  sybilFlaggedAccounts = new Set(),
  now = new Date(),
} = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  const cluster = await store.getCluster(proposal.clusterId);
  const claims = (await store.listClaimsByCluster(proposal.clusterId))
    .filter((c) => !c.takedownAt && ["accepted", "verified"].includes(c.status));

  if (claims.length === 0) return { ok: true, entries: [], totalUsd: 0, totalPft: 0 };

  const poolUsd = computeCitationPoolUsd({ cluster, claims });
  const totalWeight = claims.reduce((sum, c) => sum + Math.max(0.25, Number(c.contributorWeight || 1.0)), 0);
  const entries = [];

  for (const claim of claims) {
    const idempotencyKey = `hive_mind:citation:${proposal.id}:${claim.id}`;
    const existing = await store.getRewardLedgerByIdempotencyKey(idempotencyKey);
    if (existing) {
      entries.push(existing);
      continue;
    }

    const shareRatio = round4(Math.max(0.25, Number(claim.contributorWeight || 1.0)) / totalWeight);
    const rawUsd = round4(poolUsd * shareRatio);
    const rawPft = round4(rawUsd * Number(pftPerUsd || REWARD_BOUNDS.defaultPftPerUsd));
    const badgeCapPft = Math.max(
      0,
      Number(badgeCapsByAccount[claim.accountId] ?? REWARD_BOUNDS.defaultExpertBadgeCapPft)
    );
    const priorAccountPft = await store.sumDisbursedPftForAccount(claim.accountId);
    const remainingCapPft = Math.max(0, round4(badgeCapPft - priorAccountPft));

    const isSybilFlagged = sybilFlaggedAccounts instanceof Set
      ? sybilFlaggedAccounts.has(claim.accountId)
      : Boolean(sybilFlaggedAccounts?.[claim.accountId]);

    const counselBlocked = claim.assetClass === "perp_megacap_equity" && claim.equityCounselApproved !== true;

    let status = "disbursed";
    let finalPft = Math.min(rawPft, remainingCapPft);
    let finalUsd = rawPft > 0 ? round4(rawUsd * (finalPft / rawPft)) : 0;
    let sybilReviewStatus = "clear";

    if (counselBlocked) {
      status = "blocked_counsel";
      finalPft = 0;
      finalUsd = 0;
    } else if (isSybilFlagged) {
      status = "blocked_sybil";
      sybilReviewStatus = "flagged";
      finalPft = 0;
      finalUsd = 0;
    } else if (remainingCapPft <= 0) {
      status = "blocked_cap";
      finalPft = 0;
      finalUsd = 0;
    }

    const entry = {
      id: `hmr_${randomUUID()}`,
      idempotencyKey,
      claimId: claim.id,
      clusterId: proposal.clusterId,
      proposalId: proposal.id,
      accountId: claim.accountId,
      modelId: claim.modelId,
      payoutType: "citation_fast",
      usdEquivalent: finalUsd,
      pftAmount: finalPft,
      multiplier: 1.0,
      clusterShareRatio: shareRatio,
      badgeCapAppliedPft: badgeCapPft,
      sybilReviewStatus,
      status,
      forecastAccuracyDelta: null,
      createdAt: timestamp,
    };

    await store.saveRewardLedgerEntry(entry);
    entries.push(entry);
  }

  return {
    ok: true,
    poolUsd,
    entries,
    totalUsd: round4(entries.reduce((s, e) => s + Number(e.usdEquivalent || 0), 0)),
    totalPft: round4(entries.reduce((s, e) => s + Number(e.pftAmount || 0), 0)),
  };
}

/**
 * Resolves a checkable claim against a real-world check event (`verified` | `falsified` | `unresolvable`).
 * - `verified` (and checkable === true): issues idempotent 2x-5x accelerated alpha bonus multiplier
 *   over the claim's citation payout (or base rate) and boosts contributor domain weight.
 * - Uncheckable claims NEVER earn an alpha bonus (prevents Sybil corroboration farming).
 * - `falsified`: pays ZERO further bonus and lowers contributor domain weight.
 */
export async function resolveCheckableClaimOutcome({
  store,
  claimId = "",
  outcome = "",
  checkEventRef = "",
  forecastAccuracyDelta = 0,
  isNonConsensus = false,
  pftPerUsd = REWARD_BOUNDS.defaultPftPerUsd,
  badgeCapsByAccount = {},
  sybilFlaggedAccounts = new Set(),
  now = new Date(),
} = {}) {
  if (!["verified", "falsified", "unresolvable"].includes(outcome)) {
    const error = new Error("claim_outcome_invalid");
    error.status = 400;
    throw error;
  }

  const claim = await store.getClaim(claimId);
  if (!claim) {
    const error = new Error("claim_not_found");
    error.status = 404;
    throw error;
  }

  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  const normalizedDelta = round4(Number(forecastAccuracyDelta || 0));

  // Prevent Sybil corroboration farming: uncheckable claims earn citation only, NEVER alpha bonus.
  if (outcome === "verified" && claim.checkable !== true) {
    return {
      ok: false,
      status: 409,
      error: "uncheckable_claim_citation_only",
      message: "Uncheckable claims are eligible for citation payout only and cannot receive check-event alpha bonuses.",
    };
  }

  const alreadyResolved = ["verified", "falsified", "unresolvable"].includes(claim.status);
  if (!alreadyResolved) {
    claim.status = outcome;
    claim.forecastAccuracyDelta = normalizedDelta;
    claim.updatedAt = timestamp;
    await store.saveClaim(claim);
  }

  // Update contributor domain track-record weight (only on first transition).
  const profile = await store.getContributorProfile(claim.accountId) || {
    accountId: claim.accountId,
    confirmed: false,
    confirmedAreas: [],
    confirmedInfoTypes: [],
    approvedSummary: "",
    attributionMode: claim.attributionMode,
    attributionLabel: claim.attributionLabel,
    domainWeight: 1.0,
    maxConcurrentInterviews: 3,
    verifiedClaimsCount: 0,
    falsifiedClaimsCount: 0,
  };

  if (!alreadyResolved) {
    if (outcome === "verified") {
      profile.verifiedClaimsCount = Number(profile.verifiedClaimsCount || 0) + 1;
      profile.domainWeight = round4(clamp(
        Number(profile.domainWeight ?? 1.0) + REWARD_BOUNDS.verifiedWeightBoost,
        REWARD_BOUNDS.minDomainWeight,
        REWARD_BOUNDS.maxDomainWeight
      ));
      await store.saveContributorProfile(profile);
    } else if (outcome === "falsified") {
      profile.falsifiedClaimsCount = Number(profile.falsifiedClaimsCount || 0) + 1;
      profile.domainWeight = round4(clamp(
        Number(profile.domainWeight ?? 1.0) - REWARD_BOUNDS.falsifiedWeightPenalty,
        REWARD_BOUNDS.minDomainWeight,
        REWARD_BOUNDS.maxDomainWeight
      ));
      await store.saveContributorProfile(profile);
    }
  }

  if (outcome === "falsified") {
    const idempotencyKey = `hive_mind:falsified:${claim.id}:${checkEventRef || claim.checkEventKey || "event"}`;
    const existing = await store.getRewardLedgerByIdempotencyKey(idempotencyKey);
    const entry = existing || {
      id: `hmr_${randomUUID()}`,
      idempotencyKey,
      claimId: claim.id,
      clusterId: claim.clusterId || "",
      proposalId: "",
      accountId: claim.accountId,
      modelId: claim.modelId,
      payoutType: "alpha_verified_bonus",
      usdEquivalent: 0,
      pftAmount: 0,
      multiplier: 0,
      clusterShareRatio: 1,
      badgeCapAppliedPft: 0,
      sybilReviewStatus: "clear",
      status: "zero_falsified",
      forecastAccuracyDelta: normalizedDelta,
      createdAt: timestamp,
    };
    if (!existing) await store.saveRewardLedgerEntry(entry);
    return {
      ok: true,
      outcome: "falsified",
      payout: entry,
      updatedDomainWeight: profile.domainWeight,
    };
  }

  if (outcome === "unresolvable") {
    return {
      ok: true,
      outcome: "unresolvable",
      payout: null,
      updatedDomainWeight: profile.domainWeight,
    };
  }

  // Verified checkable claim -> compute idempotent 2x-5x accelerated alpha bonus.
  const idempotencyKey = `hive_mind:alpha_bonus:${claim.id}:${checkEventRef || claim.checkEventKey || "verified"}`;
  const existing = await store.getRewardLedgerByIdempotencyKey(idempotencyKey);
  if (existing) {
    return {
      ok: true,
      outcome: "verified",
      idempotentReplay: true,
      payout: existing,
      updatedDomainWeight: profile.domainWeight,
    };
  }

  const citationEntries = (await store.listRewardLedgerEntries())
    .filter((e) => e.claimId === claim.id && e.payoutType === "citation_fast");
  const baseUsd = citationEntries.length > 0 && citationEntries[0].usdEquivalent > 0
    ? Number(citationEntries[0].usdEquivalent)
    : REWARD_BOUNDS.citationMinUsd;

  const multiplier = computeAcceleratedAlphaMultiplier({
    stance: claim.stance,
    noveltyScore: claim.noveltyScore,
    forecastAccuracyDelta: normalizedDelta,
    isNonConsensus,
  });

  const rawUsd = round4(baseUsd * multiplier);
  const rawPft = round4(rawUsd * Number(pftPerUsd || REWARD_BOUNDS.defaultPftPerUsd));
  const badgeCapPft = Math.max(
    0,
    Number(badgeCapsByAccount[claim.accountId] ?? REWARD_BOUNDS.defaultExpertBadgeCapPft)
  );
  const priorAccountPft = await store.sumDisbursedPftForAccount(claim.accountId);
  const remainingCapPft = Math.max(0, round4(badgeCapPft - priorAccountPft));

  const isSybilFlagged = sybilFlaggedAccounts instanceof Set
    ? sybilFlaggedAccounts.has(claim.accountId)
    : Boolean(sybilFlaggedAccounts?.[claim.accountId]);
  const counselBlocked = claim.assetClass === "perp_megacap_equity" && claim.equityCounselApproved !== true;

  let status = "disbursed";
  let finalPft = Math.min(rawPft, remainingCapPft);
  let finalUsd = rawPft > 0 ? round4(rawUsd * (finalPft / rawPft)) : 0;
  let sybilReviewStatus = "clear";

  if (counselBlocked) {
    status = "blocked_counsel";
    finalPft = 0;
    finalUsd = 0;
  } else if (isSybilFlagged) {
    status = "blocked_sybil";
    sybilReviewStatus = "flagged";
    finalPft = 0;
    finalUsd = 0;
  } else if (remainingCapPft <= 0) {
    status = "blocked_cap";
    finalPft = 0;
    finalUsd = 0;
  }

  const entry = {
    id: `hmr_${randomUUID()}`,
    idempotencyKey,
    claimId: claim.id,
    clusterId: claim.clusterId || "",
    proposalId: citationEntries[0]?.proposalId || "",
    accountId: claim.accountId,
    modelId: claim.modelId,
    payoutType: "alpha_verified_bonus",
    usdEquivalent: finalUsd,
    pftAmount: finalPft,
    multiplier,
    clusterShareRatio: citationEntries[0]?.clusterShareRatio || 1,
    badgeCapAppliedPft: badgeCapPft,
    sybilReviewStatus,
    status,
    forecastAccuracyDelta: normalizedDelta,
    createdAt: timestamp,
  };
  await store.saveRewardLedgerEntry(entry);

  return {
    ok: true,
    outcome: "verified",
    idempotentReplay: false,
    payout: entry,
    updatedDomainWeight: profile.domainWeight,
  };
}

/**
 * Operator Alpha & ROI Dashboard summary:
 * Tracks spend (USD & PFT), acceptance rate, verification rate, falsification rate,
 * cost per verified insight, average alpha multiplier, and post-citation forecast accuracy delta.
 */
export async function computeRoiDashboardSummary({ store, modelId = "" } = {}) {
  const allClaims = (await store.listAllClaims())
    .filter((c) => !modelId || c.modelId === modelId);
  const allLedger = (await store.listRewardLedgerEntries())
    .filter((e) => !modelId || e.modelId === modelId);
  const allProposals = (await store.listProposals())
    .filter((p) => !modelId || p.modelId === modelId);
  const refusalAuditCount = (await store.listMnpiRefusalAudits())
    .filter((r) => !modelId || r.modelId === modelId).length;

  const totalClaims = allClaims.length;
  const acceptedOrResolvedClaims = allClaims.filter((c) => ["accepted", "verified", "falsified"].includes(c.status));
  const verifiedClaims = allClaims.filter((c) => c.status === "verified");
  const falsifiedClaims = allClaims.filter((c) => c.status === "falsified");
  const resolvedCheckable = allClaims.filter((c) => ["verified", "falsified"].includes(c.status));

  const disbursed = allLedger.filter((e) => e.status === "disbursed");
  const citationDisbursed = disbursed.filter((e) => e.payoutType === "citation_fast");
  const alphaDisbursed = disbursed.filter((e) => e.payoutType === "alpha_verified_bonus");

  const totalSpendUsd = round4(disbursed.reduce((s, e) => s + Number(e.usdEquivalent || 0), 0));
  const totalSpendPft = round4(disbursed.reduce((s, e) => s + Number(e.pftAmount || 0), 0));
  const citationSpendUsd = round4(citationDisbursed.reduce((s, e) => s + Number(e.usdEquivalent || 0), 0));
  const alphaBonusSpendUsd = round4(alphaDisbursed.reduce((s, e) => s + Number(e.usdEquivalent || 0), 0));

  const acceptanceRate = totalClaims > 0 ? round4(acceptedOrResolvedClaims.length / totalClaims) : 0;
  const verificationRate = resolvedCheckable.length > 0
    ? round4(verifiedClaims.length / resolvedCheckable.length)
    : 0;
  const falsificationRate = resolvedCheckable.length > 0
    ? round4(falsifiedClaims.length / resolvedCheckable.length)
    : 0;

  const costPerVerifiedInsightUsd = verifiedClaims.length > 0
    ? round4(totalSpendUsd / verifiedClaims.length)
    : 0;
  const costPerVerifiedInsightPft = verifiedClaims.length > 0
    ? round4(totalSpendPft / verifiedClaims.length)
    : 0;

  const avgAlphaMultiplier = alphaDisbursed.length > 0
    ? round4(alphaDisbursed.reduce((s, e) => s + Number(e.multiplier || 0), 0) / alphaDisbursed.length)
    : 0;

  const deltas = resolvedCheckable
    .map((c) => Number(c.forecastAccuracyDelta))
    .filter((v) => Number.isFinite(v));
  const avgForecastAccuracyDelta = deltas.length > 0
    ? round4(deltas.reduce((s, v) => s + v, 0) / deltas.length)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    scopeModelId: modelId || "all",
    totals: {
      totalClaims,
      acceptedClaims: acceptedOrResolvedClaims.length,
      verifiedClaims: verifiedClaims.length,
      falsifiedClaims: falsifiedClaims.length,
      appliedProposals: allProposals.filter((p) => p.status === "applied").length,
      mnpiRefusalsLoggedHashOnly: refusalAuditCount,
    },
    spend: {
      totalSpendUsd,
      totalSpendPft,
      citationSpendUsd,
      alphaBonusSpendUsd,
      disbursedPayoutCount: disbursed.length,
      blockedPayoutCount: allLedger.filter((e) => e.status.startsWith("blocked_")).length,
    },
    efficiency: {
      acceptanceRate,
      verificationRate,
      falsificationRate,
      costPerVerifiedInsightUsd,
      costPerVerifiedInsightPft,
      avgAlphaMultiplier,
      avgForecastAccuracyDelta,
    },
  };
}
