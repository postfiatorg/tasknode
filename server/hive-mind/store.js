import { databaseEnabled, query } from "../db/pool.js";
import { COVERAGE_MANIFEST_SCHEMA_VERSION, PUBLIC_BRIEF_SCHEMA_VERSION } from "./constants.js";
import { sanitizeHashOnlyRefusalAuditRecord } from "./mnpi-firewall.js";

/**
 * Default seed coverage manifest & public briefs (strictly crypto protocols + perp-backed liquid megacap equities).
 * Used when no external `finance-hub-public` manifest has been loaded yet.
 */
export function createDefaultCoverageSeed() {
  const now = "2026-11-27T00:00:00Z";
  const manifest = {
    schema_version: COVERAGE_MANIFEST_SCHEMA_VERSION,
    generated_at: now,
    publication_version: 1,
    universe_policy: {
      allowed_asset_classes: ["crypto_protocol", "perp_megacap_equity"],
      exclude_non_perp_equities: true,
      public_safe_only: true,
    },
    assets: [
      {
        model_id: "SOL",
        ticker: "SOL",
        name: "Solana",
        asset_class: "crypto_protocol",
        perp_venues: ["hyperliquid", "binance", "bybit"],
        perp_liquidity_verified: true,
        area_tags: ["solana", "l1", "defi", "validators", "mev"],
        eligible_info_types: ["operator", "builder", "trader", "public_data_analyst"],
        interview_mode: "member_and_public",
        paid_interviews_enabled: true,
        equity_counsel_approved: false,
        public_brief_path: "public/briefs/SOL.json",
        status: "active",
        updated_at: now,
      },
      {
        model_id: "NVDA",
        ticker: "NVDA",
        name: "NVIDIA Corporation",
        asset_class: "perp_megacap_equity",
        perp_venues: ["hyperliquid", "ostium"],
        perp_liquidity_verified: true,
        area_tags: ["ai_compute", "gpus", "datacenter", "semiconductors"],
        eligible_info_types: ["operator", "builder", "customer", "trader", "public_data_analyst"],
        interview_mode: "member_and_public",
        paid_interviews_enabled: true,
        equity_counsel_approved: true,
        public_brief_path: "public/briefs/NVDA.json",
        status: "active",
        updated_at: now,
      },
    ],
  };

  const publicBriefs = {
    SOL: {
      schema_version: PUBLIC_BRIEF_SCHEMA_VERSION,
      index_scope: "public_safe",
      model_id: "SOL",
      ticker: "SOL",
      name: "Solana",
      asset_class: "crypto_protocol",
      generated_at: now,
      publication_version: 1,
      public_summary: "Solana is a high-throughput Layer 1 blockchain protocol with validator fee markets, liquid staking, and on-chain DEX activity.",
      area_tags: ["solana", "l1", "defi", "validators", "mev"],
      public_topics: [
        {
          topic_id: "validator_economics",
          title: "Validator priority fees and client adoption",
          description: "Publicly observable on-chain fee distribution, Firedancer adoption, and validator hardware economics.",
          observable_by: ["operator", "builder", "public_data_analyst"],
        },
        {
          topic_id: "dex_liquidity",
          title: "On-chain DEX and perpetual venue execution",
          description: "Observable liquidity depth, slippage, and routing shares across public Solana trading venues.",
          observable_by: ["trader", "builder", "public_data_analyst"],
        },
      ],
      public_questions: [
        {
          question_id: "sol_tri_1",
          prompt: "Which public Solana network surfaces (validator ops, protocol builds, or on-chain DEX data) do you directly observe?",
          phase: "triangulation",
          mnpi_safe_verified: true,
        },
        {
          question_id: "sol_probe_1",
          prompt: "What verifiable on-chain or validator telemetry signal suggests fee capture or client reliability is shifting?",
          phase: "public_probe",
          mnpi_safe_verified: true,
        },
      ],
      redaction_attestation: {
        contains_price_targets: false,
        contains_internal_estimates: false,
        contains_member_claims: false,
        contains_private_memory: false,
        leak_scan_passed: true,
        scanner_version: "p0-leak-scan-v1",
      },
    },
    NVDA: {
      schema_version: PUBLIC_BRIEF_SCHEMA_VERSION,
      index_scope: "public_safe",
      model_id: "NVDA",
      ticker: "NVDA",
      name: "NVIDIA Corporation",
      asset_class: "perp_megacap_equity",
      generated_at: now,
      publication_version: 1,
      public_summary: "NVIDIA designs accelerated computing GPUs, networking interconnect, and CUDA software infrastructure widely deployed across AI clusters.",
      area_tags: ["ai_compute", "gpus", "datacenter", "semiconductors"],
      public_topics: [
        {
          topic_id: "gpu_cloud_spot_pricing",
          title: "Public GPU cloud spot rental pricing and lead times",
          description: "Publicly posted cloud GPU rental rates, cluster availability, and inference workload migrations.",
          observable_by: ["operator", "customer", "public_data_analyst"],
        },
        {
          topic_id: "cuda_ecosystem_adoption",
          title: "Open-source inference stack and kernel ecosystem",
          description: "Observable open-source compiler, kernel, and framework adoption across AI engineering teams.",
          observable_by: ["builder", "operator", "public_data_analyst"],
        },
      ],
      public_questions: [
        {
          question_id: "nvda_tri_1",
          prompt: "Which public AI infrastructure surfaces (cloud GPU pricing, open-source CUDA tooling, or public benchmarks) do you observe directly?",
          phase: "triangulation",
          mnpi_safe_verified: true,
        },
        {
          question_id: "nvda_probe_1",
          prompt: "What publicly verifiable cluster utilization or rental-rate trend are you seeing, and what dated public release can test it?",
          phase: "public_probe",
          mnpi_safe_verified: true,
        },
      ],
      redaction_attestation: {
        contains_price_targets: false,
        contains_internal_estimates: false,
        contains_member_claims: false,
        contains_private_memory: false,
        leak_scan_passed: true,
        scanner_version: "p0-leak-scan-v1",
      },
    },
  };

  return { manifest, publicBriefs, memberBriefs: {}, baselines: {} };
}

/**
 * In-memory Hive Mind store with strict hash-only MNPI audit enforcement.
 * Also supports optional PostgreSQL write-through when `persistToDb` is enabled.
 */
export function createHiveMindStore({ seed = null, persistToDb = false } = {}) {
  const initial = seed || createDefaultCoverageSeed();
  let coverageManifest = initial.manifest;
  const publicBriefs = new Map(Object.entries(initial.publicBriefs || {}));
  const memberBriefs = new Map(Object.entries(initial.memberBriefs || {}));
  const baselines = new Map(Object.entries(initial.baselines || {}));
  const modelOwners = new Map(Object.entries(initial.modelOwners || {}));

  const profiles = new Map();
  const attestations = new Map();
  const mnpiRefusalAudits = [];
  const interviews = new Map();
  const interviewMessages = [];
  const clusters = new Map();
  const claims = new Map();
  const proposals = new Map();
  const rewardLedger = new Map();
  const rewardLedgerByKey = new Map();
  const pillar2Packets = new Map();
  const webhookNonces = new Set();

  const shouldPersistDb = () => Boolean(persistToDb) && databaseEnabled();

  return {
    getCoverageManifest: async () => coverageManifest,
    setCoverageManifest: async (manifest) => { coverageManifest = manifest; },
    getPublicBrief: async (modelId) => publicBriefs.get(modelId) || null,
    setPublicBrief: async (modelId, brief) => { publicBriefs.set(modelId, brief); },
    getMemberBrief: async (modelId) => memberBriefs.get(modelId) || null,
    setMemberBrief: async (modelId, brief) => { memberBriefs.set(modelId, brief); },
    getModelBaselineSnapshot: async (modelId) => baselines.get(modelId) || null,
    setModelBaselineSnapshot: async (modelId, snapshot) => { baselines.set(modelId, snapshot); },
    getModelOwner: async (modelId) => modelOwners.get(modelId) || "",
    setModelOwner: async (modelId, ownerAccountId) => { modelOwners.set(modelId, ownerAccountId); },

    getContributorProfile: async (accountId) => profiles.get(accountId) || null,
    saveContributorProfile: async (profile) => {
      profiles.set(profile.accountId, { ...profile });
      if (shouldPersistDb()) {
        await query(
          `INSERT INTO hive_mind_contributor_profiles
            (account_id, confirmed, confirmed_areas_json, confirmed_info_types_json, approved_summary,
             attribution_mode, attribution_label, domain_weight, max_concurrent_interviews,
             verified_claims_count, falsified_claims_count, updated_at)
           VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,now())
           ON CONFLICT (account_id) DO UPDATE SET
             confirmed = EXCLUDED.confirmed,
             confirmed_areas_json = EXCLUDED.confirmed_areas_json,
             confirmed_info_types_json = EXCLUDED.confirmed_info_types_json,
             approved_summary = EXCLUDED.approved_summary,
             attribution_mode = EXCLUDED.attribution_mode,
             attribution_label = EXCLUDED.attribution_label,
             domain_weight = EXCLUDED.domain_weight,
             max_concurrent_interviews = EXCLUDED.max_concurrent_interviews,
             verified_claims_count = EXCLUDED.verified_claims_count,
             falsified_claims_count = EXCLUDED.falsified_claims_count,
             updated_at = now()`,
          [
            profile.accountId,
            Boolean(profile.confirmed),
            JSON.stringify(profile.confirmedAreas || []),
            JSON.stringify(profile.confirmedInfoTypes || []),
            String(profile.approvedSummary || ""),
            String(profile.attributionMode || "pseudonym"),
            String(profile.attributionLabel || ""),
            Number(profile.domainWeight ?? 1.0),
            Number(profile.maxConcurrentInterviews || 3),
            Number(profile.verifiedClaimsCount || 0),
            Number(profile.falsifiedClaimsCount || 0),
          ]
        );
      }
      return profile;
    },

    saveAttestation: async (record) => {
      attestations.set(record.id, { ...record });
      if (shouldPersistDb()) {
        await query(
          `INSERT INTO hive_mind_attestations
            (id, account_id, model_id, relationship, no_mnpi_attested, no_nda_violation_attested,
             blocked, block_reason, attestation_hash, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            record.id, record.accountId, record.modelId, record.relationship,
            record.noMnpiAttested, record.noNdaViolationAttested,
            record.blocked, record.blockReason, record.attestationHash, record.createdAt,
          ]
        );
      }
      return record;
    },

    // STRICT HASH-ONLY COMPLIANCE LOG: rejects any raw text or unexpected keys!
    recordMnpiRefusalAudit: async (record) => {
      const safeRecord = sanitizeHashOnlyRefusalAuditRecord(record);
      mnpiRefusalAudits.push(safeRecord);
      if (shouldPersistDb()) {
        await query(
          `INSERT INTO hive_mind_mnpi_refusal_audit
            (id, account_id, model_id, thread_id, reason_code, salted_sha256, salt_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            safeRecord.id, safeRecord.accountId, safeRecord.modelId, safeRecord.threadId,
            safeRecord.reasonCode, safeRecord.saltedSha256, safeRecord.saltId, safeRecord.createdAt,
          ]
        );
      }
      return safeRecord;
    },
    listMnpiRefusalAudits: async () => [...mnpiRefusalAudits],

    getInterview: async (id) => interviews.get(id) || null,
    saveInterview: async (interview) => {
      interviews.set(interview.id, interview);
      return interview;
    },
    listActiveInterviewsForAccount: async (accountId) =>
      [...interviews.values()].filter((i) => i.accountId === accountId && i.status === "active"),
    appendInterviewMessage: async (message) => {
      interviewMessages.push({ ...message });
      return message;
    },
    listInterviewMessages: async (interviewId) =>
      interviewMessages.filter((m) => m.interviewId === interviewId),

    getCluster: async (id) => clusters.get(id) || null,
    saveCluster: async (cluster) => {
      clusters.set(cluster.id, { ...cluster });
      return cluster;
    },
    listClustersByModel: async (modelId) =>
      [...clusters.values()].filter((c) => c.modelId === modelId),

    getClaim: async (id) => claims.get(id) || null,
    saveClaim: async (claim) => {
      claims.set(claim.id, { ...claim });
      return claim;
    },
    listAllClaims: async () => [...claims.values()],
    listClaimsByModel: async (modelId) =>
      [...claims.values()].filter((c) => c.modelId === modelId),
    listClaimsByCluster: async (clusterId) =>
      [...claims.values()].filter((c) => c.clusterId === clusterId),
    listClaimsByAccountAndModel: async (accountId, modelId) =>
      [...claims.values()].filter((c) => c.accountId === accountId && c.modelId === modelId),

    getProposal: async (id) => proposals.get(id) || null,
    getProposalByClusterId: async (clusterId) =>
      [...proposals.values()].find((p) => p.clusterId === clusterId) || null,
    saveProposal: async (proposal) => {
      proposals.set(proposal.id, { ...proposal });
      return proposal;
    },
    listProposals: async () => [...proposals.values()],

    getRewardLedgerByIdempotencyKey: async (key) => rewardLedgerByKey.get(key) || null,
    saveRewardLedgerEntry: async (entry) => {
      if (rewardLedgerByKey.has(entry.idempotencyKey)) {
        return rewardLedgerByKey.get(entry.idempotencyKey);
      }
      rewardLedger.set(entry.id, { ...entry });
      rewardLedgerByKey.set(entry.idempotencyKey, { ...entry });
      return entry;
    },
    listRewardLedgerEntries: async () => [...rewardLedger.values()],
    sumDisbursedPftForAccount: async (accountId) =>
      [...rewardLedger.values()]
        .filter((e) => e.accountId === accountId && e.status === "disbursed")
        .reduce((sum, e) => sum + Number(e.pftAmount || 0), 0),

    savePillar2Packet: async (packet) => {
      pillar2Packets.set(packet.claimId, { ...packet });
      return packet;
    },
    getPillar2PacketByClaimId: async (claimId) => pillar2Packets.get(claimId) || null,

    consumeWebhookNonce: async (nonce) => {
      const key = String(nonce || "").trim();
      if (!key || webhookNonces.has(key)) return false;
      webhookNonces.add(key);
      return true;
    },

    // Diagnostic snapshot for adversarial tests verifying ZERO raw MNPI text persistence.
    debugSnapshotForTests: () => ({
      profiles: [...profiles.values()],
      attestations: [...attestations.values()],
      mnpiRefusalAudits: [...mnpiRefusalAudits],
      interviews: [...interviews.values()],
      interviewMessages: [...interviewMessages],
      clusters: [...clusters.values()],
      claims: [...claims.values()],
      proposals: [...proposals.values()],
      rewardLedger: [...rewardLedger.values()],
      pillar2Packets: [...pillar2Packets.values()],
    }),
  };
}

let sharedDefaultStore = null;
export function getDefaultHiveMindStore() {
  if (!sharedDefaultStore) {
    sharedDefaultStore = createHiveMindStore({ persistToDb: true });
  }
  return sharedDefaultStore;
}
