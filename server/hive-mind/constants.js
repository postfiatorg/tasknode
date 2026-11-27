// Pillar 10 — Information Hive Mind locked constants & policy bounds.
// Derived from big_milestone/pillars/10-information-hive-mind.md and
// frozen Phase 0 schemas (coverage_manifest.v1, agent_brief_public.v1).

export const COVERAGE_MANIFEST_SCHEMA_VERSION = "finance-hub.coverage-manifest.v1";
export const PUBLIC_BRIEF_SCHEMA_VERSION = "finance-hub.agent-brief-public.v1";
export const PILLAR2_CLAIM_PACKET_SCHEMA_VERSION = "pf.hive-mind.claim-packet.v1";

export const ALLOWED_ASSET_CLASSES = Object.freeze([
  "crypto_protocol",
  "perp_megacap_equity",
]);

export const ELIGIBLE_INFO_TYPES = Object.freeze([
  "operator",
  "builder",
  "customer",
  "trader",
  "public_data_analyst",
]);

export const ALLOWED_INTERVIEW_MODES = Object.freeze([
  "disabled",
  "counsel_pending",
  "public_only",
  "member_and_public",
]);

export const ACTIVE_INTERVIEW_MODES = Object.freeze([
  "public_only",
  "member_and_public",
]);

export const EXCLUDED_RELATIONSHIPS = Object.freeze([
  "current_employee",
  "insider_mnpi",
  "nda_bound",
  "board_advisor",
  "executive_officer",
  "confidential_contractor",
]);

export const ALLOWED_RELATIONSHIPS = Object.freeze([
  "public_observer",
  "operator",
  "customer",
  "builder",
  "trader",
  "public_data_analyst",
  "former_employee_outside_nda",
]);

export const CLAIM_STANCES = Object.freeze([
  "confirms",
  "refines",
  "challenges",
]);

export const CLAIM_STATUSES = Object.freeze([
  "pending",
  "accepted",
  "rejected",
  "verified",
  "falsified",
  "unresolvable",
]);

export const ATTRIBUTION_MODES = Object.freeze([
  "handle",
  "hive_identity",
  "pseudonym",
]);

export const EXPERT_REQUIRED_PERSONAL_TASKS = 20;
export const EXPERT_MIN_SCORE = 80;

export const DEFAULT_MAX_CONCURRENT_INTERVIEWS = 3;
export const DEFAULT_MAX_INTERVIEW_TURNS = 8;
export const DEFAULT_MAX_INTERVIEW_TOKENS = 8000;
export const TRIANGULATION_ADVANCE_THRESHOLD = 60;

export const PROPOSAL_ESCALATION_DAYS = 7;
export const PROPOSAL_EXPIRY_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const REWARD_BOUNDS = Object.freeze({
  citationMinUsd: 10,
  citationMaxUsd: 50,
  alphaMultiplierMin: 2,
  alphaMultiplierMax: 5,
  defaultPftPerUsd: 10,
  defaultExpertBadgeCapPft: 30_000,
  minDomainWeight: 0.25,
  maxDomainWeight: 3.0,
  verifiedWeightBoost: 0.15,
  falsifiedWeightPenalty: 0.25,
});

// Forbidden keys in public-safe artifacts (from finance-hub-contracts-v1.md).
export const FORBIDDEN_PUBLIC_BRIEF_KEYS = Object.freeze([
  "price_target",
  "target_price",
  "upside",
  "upside_pct",
  "downside_pct",
  "fair_value",
  "dcf_value",
  "model_estimate",
  "model_estimate_before",
  "market_consensus_before",
  "eps_estimate",
  "revenue_estimate",
  "bull_case_target",
  "bear_case_target",
  "base_case_target",
  "member_questions",
  "open_model_questions",
  "pooled_claims",
  "contributor_claims",
  "content_key",
  "api_key",
  "secret",
  "private_key",
  "mnemonic",
  "deep_memory",
  "agent_brief_members",
]);

// Forbidden private contributor data keys that must never reach company agents or Finance Hub.
export const FORBIDDEN_CONTRIBUTOR_PRIVATE_KEYS = Object.freeze([
  "deepMemory",
  "deep_memory",
  "privateChat",
  "private_chat",
  "chatHistory",
  "chat_history",
  "contextDocs",
  "context_docs",
  "contextDocument",
  "context_document",
  "taskEvidence",
  "task_evidence",
  "rawTranscript",
  "raw_transcript",
]);

// Forbidden content patterns in public briefs and non-member agent responses.
export const FORBIDDEN_PUBLIC_CONTENT_PATTERNS = Object.freeze([
  { code: "price_target_mention", regex: /\b(?:price\s+target|target\s+price)\b/i },
  { code: "pt_dollar_mention", regex: /\bPT\s*(?:of|:)?\s*\$\s*\d/i },
  { code: "upside_downside_pct", regex: /\b(?:upside|downside)\s+(?:of\s+)?[+-]?\d+(?:\.\d+)?%/i },
  { code: "proprietary_model_forecast", regex: /\bour\s+model\s+(?:projects|estimates|forecasts|targets)\b/i },
  { code: "gated_index_reference", regex: /\b(?:ga-models|agent_brief_members)\b/i },
  { code: "private_key_material", regex: /BEGIN\s+[A-Z ]*PRIVATE\s+KEY/i },
  { code: "secret_token_sk", regex: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { code: "secret_token_ghp", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { code: "secret_token_slack", regex: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { code: "secret_token_aws", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "raw_html_tag", regex: /(?:<script|<iframe|<img\b|onerror\s*=|javascript:)/i },
]);
