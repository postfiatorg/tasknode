import { createCipheriv, createHash, randomBytes, randomUUID, verify } from "node:crypto";
import {
  ATTRIBUTION_MODES,
  CLAIM_STANCES,
  DEFAULT_MAX_CONCURRENT_INTERVIEWS,
  DEFAULT_MAX_INTERVIEW_TOKENS,
  DEFAULT_MAX_INTERVIEW_TURNS,
  ELIGIBLE_INFO_TYPES,
  PILLAR2_CLAIM_PACKET_SCHEMA_VERSION,
  TRIANGULATION_ADVANCE_THRESHOLD,
} from "./constants.js";
import { scanPublicSurfaceForLeaks, selectAgentBriefForContributor } from "./brief-isolation.js";
import { buildSanitizedContributorBrief, evaluateContributorEligibility, validateCoverageAsset } from "./coverage-matcher.js";
import { evaluatePreInterviewAttestation, screenAgentQuestion, screenMessageInMemory } from "./mnpi-firewall.js";

function estimateTokens(text = "") {
  return Math.max(1, Math.ceil(String(text || "").trim().length / 4));
}

function normalizeCheckEventKey(checkEventDate = "", checkEventDescription = "") {
  const datePart = String(checkEventDate || "").trim().slice(0, 32);
  const descPart = String(checkEventDescription || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!datePart && !descPart) return "";
  return `${datePart}:${descPart}`;
}

/**
 * Verifies a contributor's client-side claim signature at submission time.
 * Supports Ed25519 (PEM or raw hex/base64 SPKI) or verified Pillar 6 / pseudonymous signature envelope.
 * Rejects unsigned claims or signatures with stale/missing submission timestamps.
 */
export function verifyClientClaimSignature({
  accountId = "",
  modelId = "",
  claimText = "",
  stance = "",
  clientSignature = null,
  now = new Date(),
  maxClockSkewMs = 15 * 60 * 1000,
} = {}) {
  if (!clientSignature || typeof clientSignature !== "object" || Array.isArray(clientSignature)) {
    return { ok: false, error: "client_signature_required" };
  }
  const scheme = String(clientSignature.scheme || "").trim().toLowerCase();
  const signerKey = String(clientSignature.publicKey || clientSignature.keyId || "").trim();
  const signatureValue = String(clientSignature.signature || "").trim();
  const signedAt = String(clientSignature.signedAt || "").trim();
  const identityType = String(clientSignature.identityType || "pseudonym").trim().toLowerCase();

  if (!signerKey || !signatureValue || !signedAt) {
    return { ok: false, error: "client_signature_incomplete" };
  }
  if (!["pillar6_identity", "pseudonymous_key", "handle_key", "pseudonym"].includes(identityType)) {
    return { ok: false, error: "client_signature_identity_type_invalid" };
  }
  const signedAtMs = Date.parse(signedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(signedAtMs) || Math.abs(nowMs - signedAtMs) > maxClockSkewMs) {
    return { ok: false, error: "client_signature_timestamp_out_of_window" };
  }

  const canonicalPayload = JSON.stringify({
    accountId: String(accountId || "").trim(),
    modelId: String(modelId || "").trim(),
    stance: String(stance || "").trim(),
    claimHash: createHash("sha256").update(String(claimText || ""), "utf8").digest("hex"),
    signedAt,
  });

  if (scheme === "ed25519") {
    try {
      const sigBuf = /^[0-9a-f]+$/i.test(signatureValue) && signatureValue.length === 128
        ? Buffer.from(signatureValue, "hex")
        : Buffer.from(signatureValue, "base64");
      const verified = verify(null, Buffer.from(canonicalPayload, "utf8"), signerKey, sigBuf);
      if (!verified) return { ok: false, error: "client_signature_ed25519_invalid" };
      return {
        ok: true,
        verifiedAt: new Date(nowMs).toISOString(),
        scheme,
        identityType,
        signerKeyDigest: createHash("sha256").update(signerKey, "utf8").digest("hex").slice(0, 24),
        claimDigest: createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
      };
    } catch {
      return { ok: false, error: "client_signature_ed25519_malformed" };
    }
  }

  // Deterministic client-bound SHA-256 commitment scheme (for browser/test clients without Ed25519 PEM).
  if (scheme === "client_sha256_v1") {
    const expected = createHash("sha256")
      .update(`${signerKey}:${canonicalPayload}`, "utf8")
      .digest("hex");
    if (signatureValue.toLowerCase() !== expected) {
      return { ok: false, error: "client_signature_digest_mismatch" };
    }
    return {
      ok: true,
      verifiedAt: new Date(nowMs).toISOString(),
      scheme,
      identityType,
      signerKeyDigest: createHash("sha256").update(signerKey, "utf8").digest("hex").slice(0, 24),
      claimDigest: createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
    };
  }

  return { ok: false, error: "client_signature_scheme_unsupported" };
}

/**
 * Emits an encrypted Pillar 2 claim packet (AES-256-GCM envelope).
 * Strictly excludes interview transcripts, raw chat history, and Deep Memory.
 */
export function buildEncryptedPillar2ClaimPacket({
  claim,
  encryptionKeyHex = "",
  now = new Date(),
} = {}) {
  const keyBuf = /^[a-f0-9]{64}$/i.test(String(encryptionKeyHex || ""))
    ? Buffer.from(encryptionKeyHex, "hex")
    : createHash("sha256")
        .update(String(process.env.TASKNODE_HIVE_MIND_PACKET_KEY || "tasknode-hive-mind-pillar2-dev-key"), "utf8")
        .digest();
  const iv = randomBytes(12);
  const packetBody = {
    schemaVersion: PILLAR2_CLAIM_PACKET_SCHEMA_VERSION,
    claimId: claim.id,
    modelId: claim.modelId,
    ticker: claim.ticker,
    assetClass: claim.assetClass,
    attributionMode: claim.attributionMode,
    attributionLabel: claim.attributionLabel,
    infoType: claim.infoType,
    stance: claim.stance,
    claimText: claim.claimText,
    evidenceMechanism: claim.evidenceMechanism,
    checkable: Boolean(claim.checkable),
    checkEventDate: claim.checkEventDate || "",
    checkEventDescription: claim.checkEventDescription || "",
    clientSignature: claim.clientSignature,
    submittedAt: claim.createdAt,
    // Transcript explicitly excluded by contract.
    transcriptIncluded: false,
  };
  const plaintext = Buffer.from(JSON.stringify(packetBody), "utf8");
  const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const contentHash = createHash("sha256").update(plaintext).digest("hex");

  return {
    id: `p2pkt_${randomUUID()}`,
    claimId: claim.id,
    modelId: claim.modelId,
    schemaVersion: PILLAR2_CLAIM_PACKET_SCHEMA_VERSION,
    envelope: {
      algorithm: "aes-256-gcm",
      ivBase64: iv.toString("base64"),
      authTagBase64: authTag.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      contentSha256: contentHash,
      transcriptIncluded: false,
    },
    createdAt: now instanceof Date ? now.toISOString() : String(now),
  };
}

/**
 * Evaluates Phase 1 triangulation quality from the contributor's sanitized response.
 * Scores direct observation vantage point (operator/builder/customer/trader/public_data_analyst)
 * and verifiable public/market evidence signals.
 */
export function evaluateTriangulationTurn({ messageText = "", brief = {}, observedRoles = [] } = {}) {
  const lower = String(messageText || "").toLowerCase();
  const roleSignals = {
    operator: /\b(run|operate|validator|node|infra|deploy|latency|uptime|cluster|fleet)\b/i,
    builder: /\b(build|sdk|api|contract|protocol|github|integrate|developer|repo|code)\b/i,
    customer: /\b(use|customer|buyer|procurement|enterprise|pricing|subscription|renewal|seats)\b/i,
    trader: /\b(perp|funding|open\s+interest|orderbook|liquidity|volume|basis|spread|market\s+maker)\b/i,
    public_data_analyst: /\b(on-chain|dune|filing|10-k|10-q|public\s+data|explorer|telemetry|cohort|benchmark)\b/i,
  };

  const detectedRoles = new Set(observedRoles);
  for (const [role, regex] of Object.entries(roleSignals)) {
    if (regex.test(lower)) detectedRoles.add(role);
  }

  let score = 0;
  if (messageText.length >= 40) score += 20;
  if (messageText.length >= 100) score += 15;
  if (detectedRoles.size >= 1) score += 25;
  if (/\d+(?:\.\d+)?%?/.test(messageText)) score += 15; // concrete quantitative public observation
  if (/\b(public|on-chain|observed|measured|tested|verified|documented|filing|docs|explorer|perp)\b/i.test(lower)) {
    score += 15;
  }
  const matchedTopics = (brief.topics || []).filter((t) =>
    lower.includes(t.topicId.replace(/[_-]+/g, " ")) ||
    t.title.toLowerCase().split(/\s+/).some((w) => w.length >= 5 && lower.includes(w))
  );
  if (matchedTopics.length > 0) score += 10;

  return {
    scoreDelta: Math.min(100, score),
    detectedRoles: [...detectedRoles].filter((r) => ELIGIBLE_INFO_TYPES.includes(r)),
  };
}

function safeSelectPrompt(candidates = [], index = 0, fallbackPrompt = "") {
  const ordered = [
    ...(Array.isArray(candidates) ? candidates.slice(index) : []),
    ...(Array.isArray(candidates) ? candidates.slice(0, index) : []),
  ];
  for (const candidate of ordered) {
    const prompt = typeof candidate === "string" ? candidate : candidate?.prompt || "";
    if (screenAgentQuestion(prompt).ok) return prompt;
  }
  if (screenAgentQuestion(fallbackPrompt).ok) return fallbackPrompt;
  return "Based strictly on public or direct market-participant observations, what verifiable signal are you tracking?";
}

/**
 * Starts a strictly isolated two-phase company research interview.
 * Enforces:
 *   1. Validated coverage asset (crypto protocol or verified perp-backed megacap equity).
 *   2. Contributor eligibility (Expert badge or verified capability profile — open to non-members!).
 *   3. User-confirmed knowledge areas & sanitized contributor brief (zero Deep Memory).
 *   4. Pre-interview relationship & no-MNPI attestation (blocks employees/insiders/NDA-bound).
 *   5. Concurrent interview cap.
 *   6. Strict public vs member brief isolation (non-members NEVER see price targets or member questions).
 */
export async function startCompanyInterview({
  store,
  contributor = {},
  profile = null,
  asset = null,
  publicBrief = null,
  memberBrief = null,
  relationship = "",
  noMnpiAttested = false,
  noNdaViolationAttested = false,
  maxTurns = DEFAULT_MAX_INTERVIEW_TURNS,
  maxTokens = DEFAULT_MAX_INTERVIEW_TOKENS,
  now = new Date(),
} = {}) {
  const assetCheck = validateCoverageAsset(asset);
  if (!assetCheck.ok) {
    const error = new Error(`coverage_asset_rejected:${assetCheck.errors[0]}`);
    error.status = 400;
    throw error;
  }

  const eligibility = evaluateContributorEligibility(contributor);
  if (!eligibility.eligible) {
    const error = new Error(`contributor_not_eligible:${eligibility.reason}`);
    error.status = 403;
    throw error;
  }

  const resolvedProfile = profile || await store.getContributorProfile(contributor.accountId);
  const sanitizedBrief = buildSanitizedContributorBrief(resolvedProfile, { relationship });

  // Concurrent interview cap.
  const activeInterviews = await store.listActiveInterviewsForAccount(contributor.accountId);
  const maxConcurrent = Math.max(
    1,
    Math.min(10, Number(resolvedProfile?.maxConcurrentInterviews || DEFAULT_MAX_CONCURRENT_INTERVIEWS))
  );
  if (activeInterviews.length >= maxConcurrent) {
    const error = new Error("concurrent_interview_cap_reached");
    error.status = 429;
    throw error;
  }

  // Pre-interview attestation gate (always persisted for compliance audit).
  const attestation = evaluatePreInterviewAttestation({
    accountId: contributor.accountId,
    modelId: asset.model_id,
    relationship,
    noMnpiAttested,
    noNdaViolationAttested,
    now,
  });
  await store.saveAttestation(attestation.record);
  if (!attestation.ok) {
    return {
      ok: false,
      status: 403,
      error: "attestation_blocked",
      reason: attestation.record.blockReason,
      attestation: attestation.record,
    };
  }

  // Strict member vs non-member brief isolation.
  const isolatedBrief = selectAgentBriefForContributor({
    isFinanceHubMember: Boolean(contributor.isFinanceHubMember),
    publicBrief,
    memberBrief,
    interviewMode: asset.interview_mode,
  });

  const openingPrompt = safeSelectPrompt(
    isolatedBrief.triangulationQuestions,
    0,
    `What public or direct market-participant signals around ${asset.name} (${asset.ticker}) can you observe firsthand?`
  );

  // Final defense-in-depth leak scan for non-member responses.
  if (isolatedBrief.accessTier === "public_only") {
    const leakCheck = scanPublicSurfaceForLeaks({ openingPrompt, isolatedBrief }, "interview_start_public");
    if (!leakCheck.ok) {
      const error = new Error(`non_member_leak_blocked:${leakCheck.violations[0]?.code || "leak"}`);
      error.status = 500;
      throw error;
    }
  }

  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  const paidInterviewEligible = asset.paid_interviews_enabled === true &&
    (asset.asset_class !== "perp_megacap_equity" || asset.equity_counsel_approved === true);

  const interview = {
    id: `hmi_${randomUUID()}`,
    threadId: `fat_${randomUUID()}`,
    accountId: contributor.accountId,
    modelId: asset.model_id,
    ticker: asset.ticker,
    assetClass: asset.asset_class,
    accessTier: isolatedBrief.accessTier,
    phase: "phase1_triangulation",
    attestationId: attestation.record.id,
    sanitizedBrief,
    isolatedBrief,
    triangulationScore: 0,
    observedRoles: [...sanitizedBrief.confirmedInfoTypes],
    turnCount: 0,
    maxTurns: Math.max(2, Math.min(16, Number(maxTurns) || DEFAULT_MAX_INTERVIEW_TURNS)),
    tokenCount: estimateTokens(openingPrompt),
    maxTokens: Math.max(500, Math.min(32_000, Number(maxTokens) || DEFAULT_MAX_INTERVIEW_TOKENS)),
    paidInterviewEligible,
    equityCounselApproved: asset.equity_counsel_approved === true,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await store.saveInterview(interview);
  await store.appendInterviewMessage({
    id: `fam_${randomUUID()}`,
    threadId: interview.threadId,
    interviewId: interview.id,
    role: "agent",
    phase: "phase1_triangulation",
    content: openingPrompt,
    createdAt: timestamp,
  });

  return {
    ok: true,
    status: 201,
    interview: {
      id: interview.id,
      threadId: interview.threadId,
      modelId: interview.modelId,
      ticker: interview.ticker,
      assetClass: interview.assetClass,
      accessTier: interview.accessTier,
      phase: interview.phase,
      paidInterviewEligible: interview.paidInterviewEligible,
      maxTurns: interview.maxTurns,
      maxTokens: interview.maxTokens,
      publicSummary: isolatedBrief.publicSummary,
      topics: isolatedBrief.topics,
    },
    agentMessage: {
      role: "agent",
      phase: "phase1_triangulation",
      content: openingPrompt,
    },
  };
}

/**
 * Processes a contributor interview message through the in-memory MNPI firewall FIRST,
 * then advances Phase 1 (triangulation) -> Phase 2 (targeted questions on bounded open gaps).
 *
 * CRITICAL SECURITY INVARIANT:
 * If `screenMessageInMemory` returns `refuse`:
 * - ZERO raw user text is written to messages, interviews, DB, disk, or logs.
 * - ONLY the salted SHA-256 hash + timestamp + reason code is saved to `mnpiRefusalAudit`.
 */
export async function processInterviewMessage({
  store,
  interviewId = "",
  accountId = "",
  rawMessage = "",
  confirmRedacted = false,
  saltConfig = {},
  extraClassifier = null,
  now = new Date(),
} = {}) {
  const interview = await store.getInterview(interviewId);
  if (!interview) {
    const error = new Error("interview_not_found");
    error.status = 404;
    throw error;
  }
  if (interview.accountId !== accountId) {
    const error = new Error("interview_forbidden");
    error.status = 403;
    throw error;
  }
  if (interview.status !== "active") {
    const error = new Error(`interview_not_active:${interview.status}`);
    error.status = 409;
    throw error;
  }

  // 1. STRICT IN-MEMORY MNPI FIREWALL — runs BEFORE any storage, turn increment, or LLM call!
  const screening = await screenMessageInMemory({
    accountId,
    modelId: interview.modelId,
    threadId: interview.threadId,
    rawText: rawMessage,
    now,
    saltConfig,
    extraClassifier,
  });

  if (screening.decision === "refuse") {
    // Store ONLY the hash-only compliance audit record. ZERO raw user text persisted anywhere!
    await store.recordMnpiRefusalAudit(screening.auditRecord);
    return {
      ok: false,
      status: 422,
      decision: "refuse",
      error: "mnpi_firewall_refused",
      reasonCode: screening.reasonCode,
      message: screening.userNotice,
      audit: {
        id: screening.auditRecord.id,
        reasonCode: screening.auditRecord.reasonCode,
        saltedSha256: screening.auditRecord.saltedSha256,
        saltId: screening.auditRecord.saltId,
        createdAt: screening.auditRecord.createdAt,
      },
    };
  }

  if (screening.decision === "redact" && confirmRedacted !== true) {
    // Do NOT persist raw text; return redacted preview for explicit user confirmation.
    return {
      ok: false,
      status: 202,
      decision: "redact",
      requiresConfirmation: true,
      reasons: screening.reasons,
      redactedPreview: screening.redactedPreview,
      message: screening.userNotice,
    };
  }

  const safeText = screening.decision === "redact" ? screening.redactedPreview : screening.sanitizedText;
  if (!safeText) {
    const error = new Error("interview_message_empty");
    error.status = 400;
    throw error;
  }

  // 2. Enforce bounded turns & token budget.
  const msgTokens = estimateTokens(safeText);
  if (interview.turnCount >= interview.maxTurns || interview.tokenCount + msgTokens > interview.maxTokens) {
    interview.status = "completed";
    interview.phase = "completed";
    interview.updatedAt = now instanceof Date ? now.toISOString() : String(now);
    await store.saveInterview(interview);
    return {
      ok: false,
      status: 409,
      error: "interview_budget_exhausted",
      message: "Interview turn or token cap reached. Submit your structured claim to conclude.",
    };
  }

  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  await store.appendInterviewMessage({
    id: `fam_${randomUUID()}`,
    threadId: interview.threadId,
    interviewId: interview.id,
    role: "user",
    phase: interview.phase,
    content: safeText,
    screeningResult: screening.decision === "redact" ? "redacted_confirmed" : "pass",
    createdAt: timestamp,
  });

  interview.turnCount += 1;
  interview.tokenCount += msgTokens;

  // 3. Phase 1 triangulation -> Phase 2 targeted probing.
  const brief = interview.isolatedBrief;
  let agentReply = "";
  let phaseTransitioned = false;

  if (interview.phase === "phase1_triangulation") {
    const tri = evaluateTriangulationTurn({
      messageText: safeText,
      brief,
      observedRoles: interview.observedRoles,
    });
    interview.triangulationScore = Math.min(100, interview.triangulationScore + tri.scoreDelta);
    interview.observedRoles = tri.detectedRoles;

    if (interview.triangulationScore >= TRIANGULATION_ADVANCE_THRESHOLD) {
      interview.phase = "phase2_targeted";
      phaseTransitioned = true;
      const probe = safeSelectPrompt(
        brief.probeQuestions,
        0,
        `Focusing strictly on public evidence for ${interview.ticker}, what concrete data point or checkable event backs your view?`
      );
      if (interview.accessTier === "member" && brief.anonymizedPooledClaims?.length > 0) {
        const pooled = brief.anonymizedPooledClaims[0];
        agentReply = `${probe} Additionally, an anonymized contributor cluster currently ${pooled.stance}: "${pooled.summary}". Do your independent observations corroborate or challenge this?`;
      } else {
        agentReply = probe;
      }
    } else {
      agentReply = safeSelectPrompt(
        brief.triangulationQuestions,
        interview.turnCount,
        `To calibrate your vantage point on ${interview.ticker}, which public metrics, products, or market venues do you directly observe?`
      );
    }
  } else {
    const probeIndex = Math.max(0, interview.turnCount - 1);
    agentReply = safeSelectPrompt(
      brief.probeQuestions,
      probeIndex,
      `What dated public check event (on-chain metric, release, or public filing) can objectively verify or falsify this claim on ${interview.ticker}?`
    );
  }

  // Defense-in-depth: verify agent reply passes MNPI question filter AND non-member anti-leak scan.
  if (!screenAgentQuestion(agentReply).ok) {
    agentReply = `Please share only public or direct market-participant evidence for ${interview.ticker} and specify a dated public check event.`;
  }
  if (interview.accessTier === "public_only") {
    const replyLeak = scanPublicSurfaceForLeaks({ agentReply }, "phase2_public_reply");
    if (!replyLeak.ok) {
      agentReply = `Please share verifiable public observations for ${interview.ticker} and a dated public check event to formalize your claim.`;
    }
  }

  interview.tokenCount += estimateTokens(agentReply);
  interview.updatedAt = timestamp;
  await store.saveInterview(interview);

  await store.appendInterviewMessage({
    id: `fam_${randomUUID()}`,
    threadId: interview.threadId,
    interviewId: interview.id,
    role: "agent",
    phase: interview.phase,
    content: agentReply,
    createdAt: timestamp,
  });

  return {
    ok: true,
    status: 200,
    decision: screening.decision,
    phase: interview.phase,
    phaseTransitioned,
    accessTier: interview.accessTier,
    triangulationScore: interview.triangulationScore,
    observedRoles: interview.observedRoles,
    turnCount: interview.turnCount,
    maxTurns: interview.maxTurns,
    agentMessage: {
      role: "agent",
      phase: interview.phase,
      content: agentReply,
    },
  };
}

/**
 * Extracts and stores a client-signed structured claim from an active interview.
 * Enforces:
 *   - Client signature verified AT submission time (never offline later).
 *   - In-memory MNPI firewall screening on claim text & evidence mechanism.
 *   - Anti-hedging check: same account cannot submit opposing stances on same (modelId, checkEventKey).
 *   - Snapshots `model_estimate_before` & `market_consensus_before` internally at submission time
 *     (never returned to non-member contributors!).
 *   - Emits encrypted Pillar 2 claim packet (excluding raw transcripts).
 */
export async function submitStructuredClaim({
  store,
  interviewId = "",
  accountId = "",
  claimText = "",
  infoType = "",
  stance = "",
  evidenceMechanism = "",
  checkable = false,
  checkEventDate = "",
  checkEventDescription = "",
  attributionMode = "pseudonym",
  attributionLabel = "",
  clientSignature = null,
  modelEstimateBefore = null,
  marketConsensusBefore = null,
  confirmRedacted = false,
  saltConfig = {},
  extraClassifier = null,
  now = new Date(),
} = {}) {
  const interview = await store.getInterview(interviewId);
  if (!interview) {
    const error = new Error("interview_not_found");
    error.status = 404;
    throw error;
  }
  if (interview.accountId !== accountId) {
    const error = new Error("interview_forbidden");
    error.status = 403;
    throw error;
  }
  if (!CLAIM_STANCES.includes(stance)) {
    const error = new Error("claim_stance_invalid");
    error.status = 400;
    throw error;
  }
  if (!ELIGIBLE_INFO_TYPES.includes(infoType)) {
    const error = new Error("claim_info_type_invalid");
    error.status = 400;
    throw error;
  }
  if (!ATTRIBUTION_MODES.includes(attributionMode)) {
    const error = new Error("claim_attribution_mode_invalid");
    error.status = 400;
    throw error;
  }

  // 1. In-memory MNPI screening BEFORE verifying/persisting anything.
  const combinedRaw = `${String(claimText || "")}\n${String(evidenceMechanism || "")}`;
  const screening = await screenMessageInMemory({
    accountId,
    modelId: interview.modelId,
    threadId: interview.threadId,
    rawText: combinedRaw,
    now,
    saltConfig,
    extraClassifier,
  });

  if (screening.decision === "refuse") {
    await store.recordMnpiRefusalAudit(screening.auditRecord);
    return {
      ok: false,
      status: 422,
      decision: "refuse",
      error: "mnpi_firewall_refused",
      reasonCode: screening.reasonCode,
      message: screening.userNotice,
      audit: {
        id: screening.auditRecord.id,
        reasonCode: screening.auditRecord.reasonCode,
        saltedSha256: screening.auditRecord.saltedSha256,
        saltId: screening.auditRecord.saltId,
        createdAt: screening.auditRecord.createdAt,
      },
    };
  }
  if (screening.decision === "redact" && confirmRedacted !== true) {
    return {
      ok: false,
      status: 202,
      decision: "redact",
      requiresConfirmation: true,
      reasons: screening.reasons,
      redactedPreview: screening.redactedPreview,
      message: screening.userNotice,
    };
  }

  // 2. Verify client-side signature AT submission time.
  const sigCheck = verifyClientClaimSignature({
    accountId,
    modelId: interview.modelId,
    claimText: String(claimText || "").trim(),
    stance,
    clientSignature,
    now,
  });
  if (!sigCheck.ok) {
    const error = new Error(sigCheck.error);
    error.status = 400;
    throw error;
  }

  // 3. Anti-hedging rule: reject contradictory stances by same account on same company + check event.
  const checkEventKey = normalizeCheckEventKey(checkEventDate, checkEventDescription);
  if (checkEventKey) {
    const existing = await store.listClaimsByAccountAndModel(accountId, interview.modelId);
    const conflicting = existing.find((c) =>
      c.checkEventKey === checkEventKey &&
      c.stance !== stance &&
      c.status !== "rejected"
    );
    if (conflicting) {
      return {
        ok: false,
        status: 409,
        error: "anti_hedging_contradictory_stance_blocked",
        message: "Submitting contradictory stances on the same company and check event is prohibited.",
        conflictingClaimId: conflicting.id,
      };
    }
  }

  const profile = await store.getContributorProfile(accountId);
  const contributorWeight = Math.max(0.25, Math.min(3.0, Number(profile?.domainWeight ?? 1.0)));
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  const resolvedLabel = String(attributionLabel || profile?.attributionLabel || "").trim() ||
    (attributionMode === "pseudonym" ? `verified-pseudonym-${accountId.slice(-6)}` : accountId);

  // Snapshot objective alpha baseline at submission time (internal only; never returned to non-members).
  const baselineSnapshot = await store.getModelBaselineSnapshot(interview.modelId);
  const estimateBefore = modelEstimateBefore || baselineSnapshot?.modelEstimateBefore || {};
  const consensusBefore = marketConsensusBefore || baselineSnapshot?.marketConsensusBefore || {};

  const claim = {
    id: `hmc_${randomUUID()}`,
    interviewId: interview.id,
    modelId: interview.modelId,
    ticker: interview.ticker,
    assetClass: interview.assetClass,
    accountId,
    attributionMode,
    attributionLabel: resolvedLabel,
    claimText: String(claimText || "").trim(),
    infoType,
    stance,
    evidenceMechanism: String(evidenceMechanism || "").trim(),
    clientSignature: {
      ...sigCheck,
      signedAt: clientSignature.signedAt,
    },
    modelEstimateBefore: estimateBefore,
    marketConsensusBefore: consensusBefore,
    checkable: Boolean(checkable && checkEventKey),
    checkEventKey,
    checkEventDate: String(checkEventDate || "").trim(),
    checkEventDescription: String(checkEventDescription || "").trim(),
    screeningResult: screening.decision === "redact" ? "redacted_confirmed" : "pass",
    attestationId: interview.attestationId,
    paidInterviewEligible: interview.paidInterviewEligible === true,
    equityCounselApproved: interview.equityCounselApproved === true,
    clusterId: null,
    noveltyScore: 0,
    evidenceScore: 0,
    checkabilityScore: 0,
    contributorWeight,
    status: "pending",
    forecastAccuracyDelta: null,
    takedownAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await store.saveClaim(claim);

  // Emit encrypted Pillar 2 claim packet (transcripts strictly excluded).
  const pillar2Packet = buildEncryptedPillar2ClaimPacket({ claim, now });
  await store.savePillar2Packet(pillar2Packet);

  // Return public-safe claim view to non-members (NEVER expose snapshotted model_estimate_before!).
  const safeClaimResponse = {
    id: claim.id,
    interviewId: claim.interviewId,
    modelId: claim.modelId,
    ticker: claim.ticker,
    stance: claim.stance,
    infoType: claim.infoType,
    checkable: claim.checkable,
    checkEventDate: claim.checkEventDate,
    checkEventDescription: claim.checkEventDescription,
    attributionMode: claim.attributionMode,
    attributionLabel: claim.attributionLabel,
    status: claim.status,
    createdAt: claim.createdAt,
  };

  return {
    ok: true,
    status: 201,
    claim: safeClaimResponse,
    internalClaim: claim,
    pillar2PacketId: pillar2Packet.id,
  };
}
