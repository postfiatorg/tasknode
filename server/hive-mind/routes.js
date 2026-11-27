import { timingSafeEqual } from "node:crypto";
import {
  computeRoiDashboardSummary,
  issueCitationPayoutsForAppliedProposal,
  resolveCheckableClaimOutcome,
} from "./alpha-rewards.js";
import {
  buildContributorInsightsDocument,
  decideModelProposal,
  executeInstantMnpiTakedown,
  reviewAndClusterClaim,
  sweepProposalDeadlines,
  verifyModelHostWebhookSignature,
} from "./claim-reviewer.js";
import {
  processInterviewMessage,
  startCompanyInterview,
  submitStructuredClaim,
} from "./company-agent.js";
import {
  matchContributorToCoverage,
  validateCoverageManifest,
} from "./coverage-matcher.js";
import { getDefaultHiveMindStore } from "./store.js";

function bearerTokenFromRequest(req) {
  const header = String(req?.headers?.authorization || "").trim();
  const [scheme, token] = header.split(" ");
  if (String(scheme || "").toLowerCase() !== "bearer" || !token) return "";
  return token.trim();
}

function constantTimeMatch(left = "", right = "") {
  if (!left || !right) return false;
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function defaultResolveContributor(session = null) {
  if (!session?.accountId) return null;
  const isFinanceHubMember = Boolean(
    session.isFinanceHubMember ||
    (Array.isArray(session.validator?.bindings) && session.validator.bindings.length > 0)
  );
  return {
    accountId: session.accountId,
    isFinanceHubMember,
    completedPersonalTasks: Number(session.completedPersonalTasks ?? 20),
    expertAccess: session.expertAccess || {
      eligible: session.expertEligible !== false,
      status: session.expertEligible === false ? "needs_review" : "verified",
      score: Number(session.expertScore ?? 85),
      personalTaskCount: Number(session.completedPersonalTasks ?? 20),
      disqualifyingConcerns: [],
    },
    capabilityProfiles: Array.isArray(session.capabilityProfiles) ? session.capabilityProfiles : [],
    blacklisted: Boolean(session.blacklisted),
    suspended: Boolean(session.suspended),
    sybilBlocked: Boolean(session.sybilBlocked),
    isOperator: Boolean(session.isOperator || session.role === "operator"),
  };
}

export async function handleHiveMindRoute({
  json,
  readJson,
  req,
  res,
  session,
  url,
  store = null,
  resolveContributor = null,
  bridgeReadToken = "",
  webhookSecret = "",
  saltConfig = {},
} = {}) {
  if (!url?.pathname?.startsWith("/api/hive-mind")) return false;

  const activeStore = store || getDefaultHiveMindStore();
  const contributorResolver = resolveContributor || defaultResolveContributor;
  const resolvedBridgeToken = String(bridgeReadToken || process.env.TASKNODE_HIVE_MIND_BRIDGE_TOKEN || "");
  const resolvedWebhookSecret = String(webhookSecret || process.env.TASKNODE_HIVE_MIND_WEBHOOK_SECRET || "");

  // 1. Public-safe coverage universe (crypto protocols + perp-backed liquid megacap equities only).
  if (url.pathname === "/api/hive-mind/coverage") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const manifest = await activeStore.getCoverageManifest();
    const validation = validateCoverageManifest(manifest);
    json(res, 200, {
      ok: true,
      schemaVersion: manifest?.schema_version || "",
      publicationVersion: manifest?.publication_version || 1,
      assets: validation.validAssets,
      rejectedAssetCount: validation.rejectedAssets.length,
    });
    return true;
  }

  // 2. Public Contributor Insights feed (wrapped by instant <1s takedown filter).
  if (url.pathname === "/api/hive-mind/insights") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const modelId = String(url.searchParams.get("modelId") || "").trim();
    const doc = await buildContributorInsightsDocument({ store: activeStore, modelId });
    json(res, 200, { ok: true, ...doc });
    return true;
  }

  // 3. Research-host read-only pull of approved proposals (bearer service token).
  if (url.pathname === "/api/hive-mind/bridge/proposals") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const token = bearerTokenFromRequest(req);
    if (!resolvedBridgeToken || !constantTimeMatch(token, resolvedBridgeToken)) {
      json(res, 401, { ok: false, error: "hive_mind_bridge_unauthorized" });
      return true;
    }
    const approved = (await activeStore.listProposals())
      .filter((p) => p.status === "approved" && !p.takedownAt);
    const enriched = await Promise.all(approved.map(async (proposal) => ({
      proposal,
      cluster: await activeStore.getCluster(proposal.clusterId),
      claims: (await activeStore.listClaimsByCluster(proposal.clusterId))
        .filter((c) => !c.takedownAt)
        .map((c) => ({
          id: c.id,
          modelId: c.modelId,
          stance: c.stance,
          infoType: c.infoType,
          claimText: c.claimText,
          evidenceMechanism: c.evidenceMechanism,
          attributionMode: c.attributionMode,
          attributionLabel: c.attributionLabel,
          checkable: c.checkable,
          checkEventDate: c.checkEventDate,
          checkEventDescription: c.checkEventDescription,
        })),
    })));
    json(res, 200, { ok: true, proposals: enriched });
    return true;
  }

  // 4. Research-host signed webhook (`proposal_applied` -> unlocks idempotent fast citation payouts).
  if (url.pathname === "/api/hive-mind/bridge/webhook") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const payload = await readJson(req, 16_384);
    const validSig = verifyModelHostWebhookSignature({
      payload,
      signature: payload?.signature || "",
      secret: resolvedWebhookSecret,
    });
    if (!validSig) {
      json(res, 401, { ok: false, error: "hive_mind_webhook_signature_invalid" });
      return true;
    }
    const nonceFresh = await activeStore.consumeWebhookNonce(payload.nonce);
    if (!nonceFresh) {
      json(res, 409, { ok: false, error: "hive_mind_webhook_nonce_replayed" });
      return true;
    }
    const proposal = await activeStore.getProposal(payload.proposalId);
    if (!proposal || proposal.modelId !== payload.modelId) {
      json(res, 404, { ok: false, error: "proposal_not_found" });
      return true;
    }
    if (!["approved", "applied"].includes(proposal.status)) {
      json(res, 409, { ok: false, error: `proposal_not_approved:${proposal.status}` });
      return true;
    }
    const now = new Date();
    proposal.status = "applied";
    proposal.appliedCommitRef = String(payload.commitRef || "");
    proposal.appliedChangelogRef = String(payload.changelogRef || "");
    proposal.appliedAt = proposal.appliedAt || now.toISOString();
    proposal.updatedAt = now.toISOString();
    await activeStore.saveProposal(proposal);

    const citationPayouts = await issueCitationPayoutsForAppliedProposal({
      store: activeStore,
      proposal,
      now,
    });
    const insights = await buildContributorInsightsDocument({
      store: activeStore,
      modelId: proposal.modelId,
    });
    json(res, 200, {
      ok: true,
      proposal,
      citationPayouts,
      insightsCount: insights.count,
    });
    return true;
  }

  // All remaining routes require an authenticated session.
  if (!session?.accountId) {
    json(res, 401, { ok: false, error: "hive_mind_login_required", message: "Sign in to access Information Hive Mind." });
    return true;
  }

  const contributor = await contributorResolver(session);

  // 5. Private contributor knowledge-area & info-type profile confirmation.
  if (url.pathname === "/api/hive-mind/profile") {
    if (req.method === "GET") {
      const profile = await activeStore.getContributorProfile(session.accountId);
      json(res, 200, {
        ok: true,
        profile: profile || {
          accountId: session.accountId,
          confirmed: false,
          confirmedAreas: [],
          confirmedInfoTypes: [],
          approvedSummary: "",
          attributionMode: "pseudonym",
          attributionLabel: "",
          domainWeight: 1.0,
          maxConcurrentInterviews: 3,
          verifiedClaimsCount: 0,
          falsifiedClaimsCount: 0,
        },
      });
      return true;
    }
    if (req.method === "POST") {
      const payload = await readJson(req, 16_384);
      const existing = await activeStore.getContributorProfile(session.accountId);
      const updated = {
        accountId: session.accountId,
        confirmed: Boolean(payload.confirmed),
        confirmedAreas: Array.isArray(payload.confirmedAreas) ? payload.confirmedAreas : [],
        confirmedInfoTypes: Array.isArray(payload.confirmedInfoTypes) ? payload.confirmedInfoTypes : [],
        approvedSummary: String(payload.approvedSummary || "").trim().slice(0, 600),
        attributionMode: String(payload.attributionMode || existing?.attributionMode || "pseudonym"),
        attributionLabel: String(payload.attributionLabel || existing?.attributionLabel || "").trim().slice(0, 80),
        domainWeight: Number(existing?.domainWeight ?? 1.0),
        maxConcurrentInterviews: Number(payload.maxConcurrentInterviews || existing?.maxConcurrentInterviews || 3),
        verifiedClaimsCount: Number(existing?.verifiedClaimsCount || 0),
        falsifiedClaimsCount: Number(existing?.falsifiedClaimsCount || 0),
      };
      await activeStore.saveContributorProfile(updated);
      json(res, 200, { ok: true, profile: updated });
      return true;
    }
    json(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }

  // 6. Evidence-weighted coverage matching (private reasons visible only to caller).
  if (url.pathname === "/api/hive-mind/matches") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const manifest = await activeStore.getCoverageManifest();
    const profile = await activeStore.getContributorProfile(session.accountId);
    const activeInterviews = await activeStore.listActiveInterviewsForAccount(session.accountId);
    const result = matchContributorToCoverage({
      contributor,
      profile,
      manifest,
      activeInterviewModelIds: activeInterviews.map((i) => i.modelId),
      limit: Number(url.searchParams.get("limit") || 10),
    });
    json(res, result.ok ? 200 : 409, result);
    return true;
  }

  // 7. Start two-phase isolated company agent interview.
  if (url.pathname === "/api/hive-mind/interviews/start") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const payload = await readJson(req, 16_384);
    const manifest = await activeStore.getCoverageManifest();
    const asset = (manifest?.assets || []).find((a) => a.model_id === payload.modelId) || null;
    if (!asset) {
      json(res, 404, { ok: false, error: "coverage_asset_not_found" });
      return true;
    }
    const publicBrief = await activeStore.getPublicBrief(asset.model_id);
    const memberBrief = contributor?.isFinanceHubMember
      ? await activeStore.getMemberBrief(asset.model_id)
      : null;
    const result = await startCompanyInterview({
      store: activeStore,
      contributor,
      asset,
      publicBrief,
      memberBrief,
      relationship: payload.relationship,
      noMnpiAttested: payload.noMnpiAttested,
      noNdaViolationAttested: payload.noNdaViolationAttested,
      maxTurns: payload.maxTurns,
      maxTokens: payload.maxTokens,
    });
    json(res, result.status || (result.ok ? 201 : 400), result);
    return true;
  }

  // 8. Submit interview message (strict in-memory hash-only MNPI firewall -> Phase 1/2).
  if (url.pathname === "/api/hive-mind/interviews/message") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const payload = await readJson(req, 32_768);
    const result = await processInterviewMessage({
      store: activeStore,
      interviewId: payload.interviewId,
      accountId: session.accountId,
      rawMessage: payload.message,
      confirmRedacted: payload.confirmRedacted === true,
      saltConfig,
    });
    json(res, result.status || (result.ok ? 200 : 400), result);
    return true;
  }

  // 9. Submit client-signed structured claim + run reviewer clustering & proposal queue.
  if (url.pathname === "/api/hive-mind/claims") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const payload = await readJson(req, 32_768);
    const submitted = await submitStructuredClaim({
      store: activeStore,
      interviewId: payload.interviewId,
      accountId: session.accountId,
      claimText: payload.claimText,
      infoType: payload.infoType,
      stance: payload.stance,
      evidenceMechanism: payload.evidenceMechanism,
      checkable: payload.checkable === true,
      checkEventDate: payload.checkEventDate || "",
      checkEventDescription: payload.checkEventDescription || "",
      attributionMode: payload.attributionMode || "pseudonym",
      attributionLabel: payload.attributionLabel || "",
      clientSignature: payload.clientSignature,
      confirmRedacted: payload.confirmRedacted === true,
      saltConfig,
    });
    if (!submitted.ok) {
      json(res, submitted.status || 400, submitted);
      return true;
    }
    const modelOwner = await activeStore.getModelOwner(submitted.internalClaim.modelId);
    const reviewed = await reviewAndClusterClaim({
      store: activeStore,
      claim: submitted.internalClaim,
      modelOwnerAccountId: modelOwner,
    });
    json(res, 201, {
      ok: true,
      claim: submitted.claim,
      pillar2PacketId: submitted.pillar2PacketId,
      cluster: {
        id: reviewed.cluster.id,
        consensusStatus: reviewed.cluster.consensusStatus,
        weightedStance: reviewed.cluster.weightedStance,
        corroboratingAccountsCount: reviewed.cluster.corroboratingAccountsCount,
      },
      proposalId: reviewed.proposal.id,
    });
    return true;
  }

  // 10. List proposals for human model-owner / operator approval queue.
  if (url.pathname === "/api/hive-mind/proposals") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    await sweepProposalDeadlines({ store: activeStore });
    const modelId = String(url.searchParams.get("modelId") || "").trim();
    const proposals = (await activeStore.listProposals())
      .filter((p) => !modelId || p.modelId === modelId);
    json(res, 200, { ok: true, proposals });
    return true;
  }

  // 11. Human model-owner approve/reject decision (enforces COI guard).
  if (url.pathname === "/api/hive-mind/proposals/decide") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const payload = await readJson(req, 8192);
    const result = await decideModelProposal({
      store: activeStore,
      proposalId: payload.proposalId,
      actorAccountId: session.accountId,
      isOperator: Boolean(contributor?.isOperator),
      decision: payload.decision,
      changelogOverride: payload.changelogOverride || "",
    });
    json(res, 200, result);
    return true;
  }

  // 12. Resolve checkable claim outcome (`verified` | `falsified` | `unresolvable`).
  if (url.pathname === "/api/hive-mind/claims/resolve") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (!contributor?.isOperator) {
      json(res, 403, { ok: false, error: "hive_mind_operator_required" });
      return true;
    }
    const payload = await readJson(req, 8192);
    const result = await resolveCheckableClaimOutcome({
      store: activeStore,
      claimId: payload.claimId,
      outcome: payload.outcome,
      checkEventRef: payload.checkEventRef || "",
      forecastAccuracyDelta: payload.forecastAccuracyDelta || 0,
      isNonConsensus: payload.isNonConsensus === true,
    });
    json(res, result.ok ? 200 : result.status || 409, result);
    return true;
  }

  // 13. Instant (<1s) MNPI takedown endpoint.
  if (url.pathname === "/api/hive-mind/takedown") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (!contributor?.isOperator) {
      json(res, 403, { ok: false, error: "hive_mind_operator_required" });
      return true;
    }
    const payload = await readJson(req, 4096);
    const result = await executeInstantMnpiTakedown({
      store: activeStore,
      claimId: payload.claimId || "",
      proposalId: payload.proposalId || "",
      reasonCode: payload.reasonCode,
      actorAccountId: session.accountId,
    });
    json(res, 200, result);
    return true;
  }

  // 14. Operator Alpha & ROI Dashboard metrics.
  if (url.pathname === "/api/hive-mind/roi") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const modelId = String(url.searchParams.get("modelId") || "").trim();
    const summary = await computeRoiDashboardSummary({ store: activeStore, modelId });
    json(res, 200, { ok: true, roi: summary });
    return true;
  }

  json(res, 404, { ok: false, error: "hive_mind_route_not_found" });
  return true;
}
