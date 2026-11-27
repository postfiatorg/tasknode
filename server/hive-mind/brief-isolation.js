import {
  ALLOWED_ASSET_CLASSES,
  ELIGIBLE_INFO_TYPES,
  FORBIDDEN_PUBLIC_BRIEF_KEYS,
  FORBIDDEN_PUBLIC_CONTENT_PATTERNS,
  PUBLIC_BRIEF_SCHEMA_VERSION,
} from "./constants.js";

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const HTTPS_URL_RE = /^https:\/\/[^\s]{4,500}$/;

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_PUBLIC_BRIEF_KEYS.map((k) => k.toLowerCase()));
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "index_scope",
  "model_id",
  "ticker",
  "name",
  "asset_class",
  "generated_at",
  "publication_version",
  "public_summary",
  "area_tags",
  "public_topics",
  "public_questions",
  "public_context_links",
  "redaction_attestation",
]);

export function scanPublicSurfaceForLeaks(payload, pathPrefix = "root") {
  const violations = [];
  const visit = (value, currentPath) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const pattern of FORBIDDEN_PUBLIC_CONTENT_PATTERNS) {
        if (pattern.regex.test(value)) {
          violations.push({
            path: currentPath,
            code: `leak_${pattern.code}`,
          });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEY_SET.has(key.toLowerCase())) {
          violations.push({
            path: `${currentPath}.${key}`,
            code: `forbidden_key:${key}`,
          });
        }
        visit(entry, `${currentPath}.${key}`);
      }
    }
  };
  visit(payload, pathPrefix);
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function validatePublicAgentBrief(brief) {
  const errors = [];
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    return { ok: false, errors: ["public_brief_object_required"], violations: [] };
  }

  for (const key of Object.keys(brief)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unexpected_property:${key}`);
    }
  }

  if (brief.schema_version !== PUBLIC_BRIEF_SCHEMA_VERSION) {
    errors.push("invalid_schema_version");
  }
  if (brief.index_scope !== "public_safe") {
    errors.push("invalid_index_scope");
  }
  if (typeof brief.model_id !== "string" || !MODEL_ID_RE.test(brief.model_id)) {
    errors.push("invalid_model_id");
  }
  if (typeof brief.ticker !== "string" || !TICKER_RE.test(brief.ticker)) {
    errors.push("invalid_ticker");
  }
  if (typeof brief.name !== "string" || brief.name.length < 1 || brief.name.length > 120) {
    errors.push("invalid_name");
  }
  if (!ALLOWED_ASSET_CLASSES.includes(brief.asset_class)) {
    errors.push("invalid_asset_class");
  }
  if (typeof brief.generated_at !== "string" || !ISO_UTC_RE.test(brief.generated_at)) {
    errors.push("invalid_generated_at");
  }
  if (!Number.isInteger(brief.publication_version) || brief.publication_version < 1) {
    errors.push("invalid_publication_version");
  }
  if (typeof brief.public_summary !== "string" || brief.public_summary.length < 20 || brief.public_summary.length > 2000) {
    errors.push("invalid_public_summary");
  }
  if (!Array.isArray(brief.area_tags) || brief.area_tags.length < 1 || brief.area_tags.length > 24 ||
      brief.area_tags.some((t) => typeof t !== "string" || !TAG_RE.test(t))) {
    errors.push("invalid_area_tags");
  }

  if (!Array.isArray(brief.public_topics) || brief.public_topics.length < 1 || brief.public_topics.length > 16) {
    errors.push("invalid_public_topics");
  } else {
    brief.public_topics.forEach((topic, idx) => {
      if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
        errors.push(`invalid_public_topic:${idx}`);
        return;
      }
      const allowedTopicKeys = new Set(["topic_id", "title", "description", "observable_by"]);
      if (Object.keys(topic).some((k) => !allowedTopicKeys.has(k))) errors.push(`unexpected_topic_key:${idx}`);
      if (typeof topic.topic_id !== "string" || !TAG_RE.test(topic.topic_id)) errors.push(`invalid_topic_id:${idx}`);
      if (typeof topic.title !== "string" || topic.title.length < 3 || topic.title.length > 140) errors.push(`invalid_topic_title:${idx}`);
      if (typeof topic.description !== "string" || topic.description.length < 10 || topic.description.length > 600) errors.push(`invalid_topic_description:${idx}`);
      if (!Array.isArray(topic.observable_by) || topic.observable_by.length < 1 ||
          topic.observable_by.some((role) => !ELIGIBLE_INFO_TYPES.includes(role))) {
        errors.push(`invalid_topic_observable_by:${idx}`);
      }
    });
  }

  if (!Array.isArray(brief.public_questions) || brief.public_questions.length < 1 || brief.public_questions.length > 12) {
    errors.push("invalid_public_questions");
  } else {
    brief.public_questions.forEach((question, idx) => {
      if (!question || typeof question !== "object" || Array.isArray(question)) {
        errors.push(`invalid_public_question:${idx}`);
        return;
      }
      const allowedQKeys = new Set(["question_id", "prompt", "phase", "mnpi_safe_verified"]);
      if (Object.keys(question).some((k) => !allowedQKeys.has(k))) errors.push(`unexpected_question_key:${idx}`);
      if (typeof question.question_id !== "string" || !TAG_RE.test(question.question_id)) errors.push(`invalid_question_id:${idx}`);
      if (typeof question.prompt !== "string" || question.prompt.length < 10 || question.prompt.length > 500) errors.push(`invalid_question_prompt:${idx}`);
      if (!["triangulation", "public_probe"].includes(question.phase)) errors.push(`invalid_question_phase:${idx}`);
      if (question.mnpi_safe_verified !== true) errors.push(`question_not_mnpi_safe_verified:${idx}`);
    });
  }

  if (brief.public_context_links !== undefined) {
    if (!Array.isArray(brief.public_context_links) || brief.public_context_links.length > 20) {
      errors.push("invalid_public_context_links");
    } else {
      brief.public_context_links.forEach((link, idx) => {
        if (!link || typeof link !== "object" || typeof link.title !== "string" || !link.title ||
            typeof link.url !== "string" || !HTTPS_URL_RE.test(link.url)) {
          errors.push(`invalid_public_context_link:${idx}`);
        }
      });
    }
  }

  const att = brief.redaction_attestation;
  if (!att || typeof att !== "object" || Array.isArray(att)) {
    errors.push("missing_redaction_attestation");
  } else {
    const allowedAttKeys = new Set([
      "contains_price_targets",
      "contains_internal_estimates",
      "contains_member_claims",
      "contains_private_memory",
      "leak_scan_passed",
      "scanner_version",
    ]);
    if (Object.keys(att).some((k) => !allowedAttKeys.has(k))) errors.push("unexpected_redaction_attestation_key");
    if (att.contains_price_targets !== false) errors.push("attestation_contains_price_targets");
    if (att.contains_internal_estimates !== false) errors.push("attestation_contains_internal_estimates");
    if (att.contains_member_claims !== false) errors.push("attestation_contains_member_claims");
    if (att.contains_private_memory !== false) errors.push("attestation_contains_private_memory");
    if (att.leak_scan_passed !== true) errors.push("attestation_leak_scan_not_passed");
    if (typeof att.scanner_version !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(att.scanner_version)) {
      errors.push("invalid_scanner_version");
    }
  }

  const leakScan = scanPublicSurfaceForLeaks(brief, "agent_brief_public");
  if (!leakScan.ok) {
    errors.push(...leakScan.violations.map((v) => v.code));
  }

  return {
    ok: errors.length === 0 && leakScan.ok,
    errors,
    violations: leakScan.violations,
  };
}

/**
 * Strictly isolates Finance Hub member briefs from non-member contributors.
 * Non-members NEVER receive member open questions, internal targets, or pooled member claims.
 */
export function selectAgentBriefForContributor({
  isFinanceHubMember = false,
  publicBrief = null,
  memberBrief = null,
  interviewMode = "member_and_public",
} = {}) {
  if (!["public_only", "member_and_public"].includes(interviewMode)) {
    const error = new Error(`interview_mode_not_active:${interviewMode}`);
    error.status = 403;
    throw error;
  }

  const publicValidation = validatePublicAgentBrief(publicBrief);
  if (!publicValidation.ok) {
    const error = new Error(`public_agent_brief_invalid:${publicValidation.errors[0] || "leak_detected"}`);
    error.status = 500;
    error.details = publicValidation;
    throw error;
  }

  if (!isFinanceHubMember || interviewMode === "public_only" || !memberBrief) {
    // Deep-cloned strictly public-safe subset; zero member fields can exist here.
    const isolatedBrief = {
      accessTier: "public_only",
      modelId: publicBrief.model_id,
      ticker: publicBrief.ticker,
      name: publicBrief.name,
      assetClass: publicBrief.asset_class,
      publicSummary: publicBrief.public_summary,
      areaTags: [...publicBrief.area_tags],
      topics: publicBrief.public_topics.map((t) => ({
        topicId: t.topic_id,
        title: t.title,
        description: t.description,
        observableBy: [...t.observable_by],
      })),
      triangulationQuestions: publicBrief.public_questions
        .filter((q) => q.phase === "triangulation")
        .map((q) => ({ questionId: q.question_id, prompt: q.prompt })),
      probeQuestions: publicBrief.public_questions
        .filter((q) => q.phase === "public_probe")
        .map((q) => ({ questionId: q.question_id, prompt: q.prompt })),
      anonymizedPooledClaims: [],
    };
    const finalScan = scanPublicSurfaceForLeaks(isolatedBrief, "isolated_public_brief");
    if (!finalScan.ok) {
      const error = new Error(`public_brief_isolation_failed:${finalScan.violations[0]?.code || "leak"}`);
      error.status = 500;
      throw error;
    }
    return isolatedBrief;
  }

  // Finance Hub member receives member open questions and anonymized pooled claims.
  const memberOpenQuestions = Array.isArray(memberBrief.member_questions)
    ? memberBrief.member_questions.map((q, idx) => ({
        questionId: String(q?.question_id || `mq_${idx + 1}`),
        prompt: String(q?.prompt || "").trim(),
      })).filter((q) => q.prompt.length >= 10)
    : [];
  const anonymizedPooledClaims = Array.isArray(memberBrief.pooled_claims)
    ? memberBrief.pooled_claims.map((c, idx) => ({
        clusterId: String(c?.cluster_id || `cl_${idx + 1}`),
        stance: String(c?.stance || "refines"),
        summary: String(c?.summary || "").trim(),
      })).filter((c) => c.summary)
    : [];

  return {
    accessTier: "member",
    modelId: publicBrief.model_id,
    ticker: publicBrief.ticker,
    name: publicBrief.name,
    assetClass: publicBrief.asset_class,
    publicSummary: publicBrief.public_summary,
    memberContextSummary: String(memberBrief.member_summary || publicBrief.public_summary),
    areaTags: [...publicBrief.area_tags],
    topics: publicBrief.public_topics.map((t) => ({
      topicId: t.topic_id,
      title: t.title,
      description: t.description,
      observableBy: [...t.observable_by],
    })),
    triangulationQuestions: publicBrief.public_questions
      .filter((q) => q.phase === "triangulation")
      .map((q) => ({ questionId: q.question_id, prompt: q.prompt })),
    probeQuestions: memberOpenQuestions.length > 0
      ? memberOpenQuestions
      : publicBrief.public_questions
          .filter((q) => q.phase === "public_probe")
          .map((q) => ({ questionId: q.question_id, prompt: q.prompt })),
    anonymizedPooledClaims,
  };
}
