import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  scanPublicSurfaceForLeaks,
  selectAgentBriefForContributor,
  validatePublicAgentBrief,
} from "./brief-isolation.js";
import {
  processInterviewMessage,
  startCompanyInterview,
  submitStructuredClaim,
} from "./company-agent.js";
import {
  buildSanitizedContributorBrief,
  evaluateContributorEligibility,
  matchContributorToCoverage,
  validateCoverageAsset,
  validateCoverageManifest,
} from "./coverage-matcher.js";
import {
  computeSaltedRefusalHash,
  evaluatePreInterviewAttestation,
  sanitizeHashOnlyRefusalAuditRecord,
  screenAgentQuestion,
  screenMessageInMemory,
} from "./mnpi-firewall.js";
import { createDefaultCoverageSeed, createHiveMindStore } from "./store.js";

function signClientSha256({ accountId, modelId, claimText, stance, publicKey = "pk_test", signedAt = new Date().toISOString() }) {
  const claimHash = createHash("sha256").update(String(claimText).trim(), "utf8").digest("hex");
  const canonicalPayload = JSON.stringify({ accountId, modelId, stance, claimHash, signedAt });
  const signature = createHash("sha256").update(`${publicKey}:${canonicalPayload}`, "utf8").digest("hex");
  return {
    scheme: "client_sha256_v1",
    identityType: "pseudonymous_key",
    publicKey,
    signature,
    signedAt,
  };
}

function makeExpertContributor(accountId, { isFinanceHubMember = false } = {}) {
  return {
    accountId,
    isFinanceHubMember,
    completedPersonalTasks: 24,
    expertAccess: {
      eligible: true,
      status: "verified",
      score: 88,
      personalTaskCount: 24,
      disqualifyingConcerns: [],
    },
    capabilityProfiles: [],
    blacklisted: false,
    suspended: false,
    sybilBlocked: false,
  };
}

describe("Pillar 10 — Coverage Matcher (Crypto + Perp-Backed Megacap Equities Only)", () => {
  it("accepts crypto protocols and verified perp-backed megacap equities, rejecting random non-perp equities", () => {
    const seed = createDefaultCoverageSeed();
    const manifestCheck = validateCoverageManifest(seed.manifest);
    assert.equal(manifestCheck.ok, true);
    assert.equal(manifestCheck.validAssets.length, 2);
    assert.equal(manifestCheck.rejectedAssets.length, 0);

    const randomEquity = {
      ...seed.manifest.assets[1],
      model_id: "ACME",
      ticker: "ACME",
      name: "Random Illiquid Small Cap Corp",
      asset_class: "small_cap_equity",
      perp_venues: [],
      perp_liquidity_verified: false,
      public_brief_path: "public/briefs/ACME.json",
    };
    const randomCheck = validateCoverageAsset(randomEquity);
    assert.equal(randomCheck.ok, false);
    assert.ok(randomCheck.errors.some((e) => e.startsWith("disallowed_asset_class:")));

    const noPerpEquity = {
      ...seed.manifest.assets[1],
      model_id: "NOPRP",
      ticker: "NOPRP",
      perp_venues: [],
      perp_liquidity_verified: false,
      public_brief_path: "public/briefs/NOPRP.json",
    };
    const noPerpCheck = validateCoverageAsset(noPerpEquity);
    assert.equal(noPerpCheck.ok, false);
    assert.ok(noPerpCheck.errors.includes("non_perp_equity_rejected"));
    assert.ok(noPerpCheck.errors.includes("unverified_perp_liquidity_equity_rejected"));

    const unapprovedPaidEquity = {
      ...seed.manifest.assets[1],
      model_id: "AAPL",
      ticker: "AAPL",
      paid_interviews_enabled: true,
      equity_counsel_approved: false,
      public_brief_path: "public/briefs/AAPL.json",
    };
    const counselCheck = validateCoverageAsset(unapprovedPaidEquity);
    assert.equal(counselCheck.ok, false);
    assert.ok(counselCheck.errors.includes("equity_paid_interview_requires_counsel_approval"));

    const mixedManifest = {
      ...seed.manifest,
      assets: [...seed.manifest.assets, randomEquity, noPerpEquity],
    };
    const contributor = makeExpertContributor("acct_non_member", { isFinanceHubMember: false });
    const profile = {
      accountId: "acct_non_member",
      confirmed: true,
      confirmedAreas: ["solana", "ai_compute"],
      confirmedInfoTypes: ["builder", "operator"],
      approvedSummary: "Infra operator tracking GPU cloud rates and Solana validators.",
      domainWeight: 1.2,
      verifiedClaimsCount: 2,
    };

    const matchResult = matchContributorToCoverage({
      contributor,
      profile,
      manifest: mixedManifest,
    });
    assert.equal(matchResult.ok, true);
    assert.equal(matchResult.rejectedAssetCount, 2);
    assert.deepEqual(matchResult.matches.map((m) => m.modelId).sort(), ["NVDA", "SOL"]);
    for (const match of matchResult.matches) {
      assert.equal(match.accessTier, "public_only");
    }
  });

  it("enforces eligibility (Expert badge or verified capability), confirmation gate, and zero Deep Memory leakage", () => {
    const unqualified = {
      accountId: "acct_newbie",
      completedPersonalTasks: 5,
      expertAccess: { eligible: false, status: "needs_tasks", score: 0, personalTaskCount: 5 },
      capabilityProfiles: [],
    };
    assert.equal(evaluateContributorEligibility(unqualified).eligible, false);

    const domainVerified = {
      accountId: "acct_cap",
      completedPersonalTasks: 4,
      expertAccess: { eligible: false },
      capabilityProfiles: [{ domain: "solana", verified: true }],
    };
    assert.equal(evaluateContributorEligibility(domainVerified).eligible, true);
    assert.equal(evaluateContributorEligibility(domainVerified).basis, "verified_capability_profile");

    const seed = createDefaultCoverageSeed();
    const unconfirmed = matchContributorToCoverage({
      contributor: domainVerified,
      profile: { confirmed: false, confirmedAreas: ["solana"], confirmedInfoTypes: ["builder"] },
      manifest: seed.manifest,
    });
    assert.equal(unconfirmed.ok, false);
    assert.equal(unconfirmed.reason, "knowledge_areas_confirmation_required");

    assert.throws(
      () => buildSanitizedContributorBrief({
        confirmed: true,
        confirmedAreas: ["solana"],
        confirmedInfoTypes: ["builder"],
        deepMemory: "PRIVATE DEEP MEMORY SECRET",
      }),
      /forbidden_private_contributor_field:deepMemory/
    );
  });
});

describe("Pillar 10 — Strict In-Memory Hash-Only MNPI Firewall (Adversarial Red-Team Proof)", () => {
  it("blocks excluded relationships at pre-interview attestation before Phase 1 starts", async () => {
    const store = createHiveMindStore();
    const seed = createDefaultCoverageSeed();
    const contributor = makeExpertContributor("acct_insider");
    await store.saveContributorProfile({
      accountId: "acct_insider",
      confirmed: true,
      confirmedAreas: ["ai_compute"],
      confirmedInfoTypes: ["operator"],
      approvedSummary: "Compute engineer.",
    });

    for (const badRel of ["current_employee", "insider_mnpi", "nda_bound", "board_advisor"]) {
      const startRes = await startCompanyInterview({
        store,
        contributor,
        asset: seed.manifest.assets[1],
        publicBrief: seed.publicBriefs.NVDA,
        relationship: badRel,
        noMnpiAttested: true,
        noNdaViolationAttested: true,
      });
      assert.equal(startRes.ok, false);
      assert.equal(startRes.status, 403);
      assert.equal(startRes.error, "attestation_blocked");
      assert.equal(startRes.reason, `excluded_relationship:${badRel}`);
    }

    const missingAtt = evaluatePreInterviewAttestation({
      accountId: "acct_obs",
      modelId: "NVDA",
      relationship: "public_observer",
      noMnpiAttested: false,
      noNdaViolationAttested: true,
    });
    assert.equal(missingAtt.ok, false);
    assert.equal(missingAtt.record.blockReason, "no_mnpi_attestation_required");
  });

  it("adversarially proves ZERO raw MNPI text or canary bytes persist to store, DB, responses, or logs", async () => {
    const store = createHiveMindStore();
    const seed = createDefaultCoverageSeed();
    const contributor = makeExpertContributor("acct_redteam");
    await store.saveContributorProfile({
      accountId: "acct_redteam",
      confirmed: true,
      confirmedAreas: ["ai_compute"],
      confirmedInfoTypes: ["customer"],
      approvedSummary: "Cloud GPU buyer.",
    });

    const started = await startCompanyInterview({
      store,
      contributor,
      asset: seed.manifest.assets[1],
      publicBrief: seed.publicBriefs.NVDA,
      relationship: "customer",
      noMnpiAttested: true,
      noNdaViolationAttested: true,
    });
    assert.equal(started.ok, true);

    const CANARY = "CANARY_MNPI_SECRET_99442211_PROJECT_TITAN";
    const rawMnpiPayload = `My friend inside the company showed me their internal board deck: unreleased Q4 earnings will beat by 42% (${CANARY}).`;
    const saltConfig = { salt: "test-isolated-salt-secret-value", saltId: "test_salt_v1" };

    const capturedLogs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args) => capturedLogs.push(JSON.stringify(args));
    console.warn = (...args) => capturedLogs.push(JSON.stringify(args));
    console.error = (...args) => capturedLogs.push(JSON.stringify(args));

    let response;
    try {
      response = await processInterviewMessage({
        store,
        interviewId: started.interview.id,
        accountId: "acct_redteam",
        rawMessage: rawMnpiPayload,
        saltConfig,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    assert.equal(response.ok, false);
    assert.equal(response.status, 422);
    assert.equal(response.decision, "refuse");
    assert.equal(response.error, "mnpi_firewall_refused");

    const expectedHash = computeSaltedRefusalHash(rawMnpiPayload, saltConfig);
    assert.equal(response.audit.saltedSha256, expectedHash.saltedSha256);
    assert.equal(response.audit.saltId, "test_salt_v1");

    const serializedStore = JSON.stringify(store.debugSnapshotForTests());
    const serializedResponse = JSON.stringify(response);
    const serializedLogs = capturedLogs.join("\n");

    for (const [label, blob] of [
      ["store", serializedStore],
      ["response", serializedResponse],
      ["logs", serializedLogs],
    ]) {
      assert.equal(blob.includes(CANARY), false, `CANARY leaked into ${label}!`);
      assert.equal(blob.includes("board deck"), false, `Raw MNPI phrase leaked into ${label}!`);
      assert.equal(blob.includes("beat by 42%"), false, `Raw MNPI numbers leaked into ${label}!`);
    }

    const msgs = await store.listInterviewMessages(started.interview.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "agent");

    const audits = await store.listMnpiRefusalAudits();
    assert.equal(audits.length, 1);
    assert.deepEqual(Object.keys(audits[0]).sort(), [
      "accountId",
      "createdAt",
      "id",
      "modelId",
      "reasonCode",
      "saltId",
      "saltedSha256",
      "threadId",
    ]);
    assert.throws(
      () => sanitizeHashOnlyRefusalAuditRecord({ ...audits[0], rawText: CANARY }),
      /mnpi_audit_forbidden_field:rawText/
    );

    const redactRes = await screenMessageInMemory({
      accountId: "acct_redteam",
      modelId: "NVDA",
      rawText: "Public cloud H100 spot rates dropped 8% on RunPod; contact me at analyst@example.com for the public chart.",
    });
    assert.equal(redactRes.decision, "redact");
    assert.equal(redactRes.redactedPreview.includes("analyst@example.com"), false);
    assert.equal(redactRes.redactedPreview.includes("[REDACTED_EMAIL]"), true);

    assert.equal(screenAgentQuestion("Can you share unreleased earnings numbers for next quarter?").ok, false);
    assert.equal(screenAgentQuestion("What public cloud GPU spot rates are you seeing this month?").ok, true);
  });
});

describe("Pillar 10 — Non-Member Zero-Target Leakage & Two-Phase Triangulating Agent", () => {
  it("rejects poisoned public briefs and guarantees zero gated price targets leak to non-members", async () => {
    const seed = createDefaultCoverageSeed();
    const store = createHiveMindStore();

    const poisonedBrief = {
      ...seed.publicBriefs.NVDA,
      public_summary: "NVIDIA has an internal price target of $420 with upside of +65% in ga-models.",
    };
    const poisonedCheck = validatePublicAgentBrief(poisonedBrief);
    assert.equal(poisonedCheck.ok, false);
    assert.ok(poisonedCheck.violations.length >= 2);
    assert.throws(
      () => selectAgentBriefForContributor({ isFinanceHubMember: false, publicBrief: poisonedBrief }),
      /public_agent_brief_invalid/
    );

    const SECRET_TARGET_SENTINEL = "$420_INTERNAL_PT_SENTINEL";
    await store.setMemberBrief("NVDA", {
      member_summary: `Gated member thesis with ${SECRET_TARGET_SENTINEL} and DCF upside +55%.`,
      member_questions: [
        {
          question_id: "mq_1",
          prompt: `Do public hyperscaler lead times support our ${SECRET_TARGET_SENTINEL} view on Blackwell ramp?`,
        },
      ],
      pooled_claims: [
        {
          cluster_id: "cl_secret_1",
          stance: "challenges",
          summary: "Member-only pooled claim: H200 spot rentals softened 12% across tier-2 clouds.",
        },
      ],
    });
    await store.setModelBaselineSnapshot("NVDA", {
      modelEstimateBefore: { metric: "dc_rev_yoy_pct", value: 48.0, internalTargetSentinel: SECRET_TARGET_SENTINEL },
      marketConsensusBefore: { metric: "dc_rev_yoy_pct", value: 44.0 },
    });

    const nonMember = makeExpertContributor("acct_public_expert", { isFinanceHubMember: false });
    await store.saveContributorProfile({
      accountId: "acct_public_expert",
      confirmed: true,
      confirmedAreas: ["ai_compute", "gpus"],
      confirmedInfoTypes: ["operator"],
      approvedSummary: "Operates public GPU clusters.",
    });

    const nmStart = await startCompanyInterview({
      store,
      contributor: nonMember,
      asset: seed.manifest.assets[1],
      publicBrief: seed.publicBriefs.NVDA,
      memberBrief: await store.getMemberBrief("NVDA"),
      relationship: "operator",
      noMnpiAttested: true,
      noNdaViolationAttested: true,
    });
    assert.equal(nmStart.ok, true);
    assert.equal(nmStart.interview.accessTier, "public_only");
    assert.equal(nmStart.interview.phase, "phase1_triangulation");

    const nmTurn = await processInterviewMessage({
      store,
      interviewId: nmStart.interview.id,
      accountId: "acct_public_expert",
      rawMessage: "I operate a 128-GPU cluster and track public cloud spot rental pricing across 6 providers daily. Public H100 spot prices fell 14% over the last 30 days on published dashboards.",
    });
    assert.equal(nmTurn.ok, true);
    assert.equal(nmTurn.phase, "phase2_targeted");
    assert.equal(nmTurn.phaseTransitioned, true);
    assert.equal(nmTurn.accessTier, "public_only");

    const claimText = "Public GPU cloud spot rental pricing for H100 clusters declined 14% MoM on published marketplaces.";
    const nmClaim = await submitStructuredClaim({
      store,
      interviewId: nmStart.interview.id,
      accountId: "acct_public_expert",
      claimText,
      infoType: "operator",
      stance: "challenges",
      evidenceMechanism: "Observed published hourly spot rates across 6 public GPU clouds over 30 days.",
      checkable: true,
      checkEventDate: "2026-12-20",
      checkEventDescription: "Q4 hyperscaler GPU pricing index release",
      attributionMode: "pseudonym",
      clientSignature: signClientSha256({
        accountId: "acct_public_expert",
        modelId: "NVDA",
        claimText,
        stance: "challenges",
      }),
    });
    assert.equal(nmClaim.ok, true);

    const nonMemberSurface = JSON.stringify({ nmStart, nmTurn, claimResponse: nmClaim.claim });
    assert.equal(nonMemberSurface.includes(SECRET_TARGET_SENTINEL), false);
    assert.equal(nonMemberSurface.includes("Member-only pooled claim"), false);
    assert.equal(nonMemberSurface.includes("modelEstimateBefore"), false);
    assert.equal(scanPublicSurfaceForLeaks({ nmStart, nmTurn, claim: nmClaim.claim }).ok, true);

    assert.equal(nmClaim.internalClaim.modelEstimateBefore.value, 48.0);
    assert.equal(nmClaim.internalClaim.marketConsensusBefore.value, 44.0);

    const member = makeExpertContributor("acct_hub_member", { isFinanceHubMember: true });
    await store.saveContributorProfile({
      accountId: "acct_hub_member",
      confirmed: true,
      confirmedAreas: ["ai_compute", "gpus"],
      confirmedInfoTypes: ["operator"],
      approvedSummary: "Hub member GPU infra operator.",
    });
    const mStart = await startCompanyInterview({
      store,
      contributor: member,
      asset: seed.manifest.assets[1],
      publicBrief: seed.publicBriefs.NVDA,
      memberBrief: await store.getMemberBrief("NVDA"),
      relationship: "operator",
      noMnpiAttested: true,
      noNdaViolationAttested: true,
    });
    assert.equal(mStart.ok, true);
    assert.equal(mStart.interview.accessTier, "member");

    const mTurn = await processInterviewMessage({
      store,
      interviewId: mStart.interview.id,
      accountId: "acct_hub_member",
      rawMessage: "I operate bare-metal AI clusters and observe public rental pricing and hyperscaler deployment lead times across 5 public cloud providers.",
    });
    assert.equal(mTurn.ok, true);
    assert.equal(mTurn.phase, "phase2_targeted");
    assert.ok(mTurn.agentMessage.content.includes("corroborate or challenge"));
  });
});
