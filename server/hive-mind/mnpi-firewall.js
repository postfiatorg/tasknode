import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ALLOWED_RELATIONSHIPS,
  EXCLUDED_RELATIONSHIPS,
} from "./constants.js";

// Deterministic MNPI / NDA / insider-disclosure classifiers (run in RAM BEFORE any storage or LLM call).
const MNPI_REFUSAL_RULES = Object.freeze([
  {
    code: "mnpi_unreleased_earnings_guidance",
    regex: /\b(?:unreleased|non[- ]?public|pre[- ]?announcement|upcoming|next\s+quarter(?:'s)?|q[1-4]\s*(?:preliminary|internal|unreleased))\b.{0,80}\b(?:earnings|revenue|eps|guidance|margins?|bookings|results|numbers|forecast|beat|miss)\b/i,
  },
  {
    code: "mnpi_earnings_leak_reverse",
    regex: /\b(?:earnings|revenue|eps|guidance|bookings|margins?)\b.{0,60}\b(?:before\s+(?:earnings|announcement|release|filing)|not\s+yet\s+(?:public|announced|disclosed)|still\s+embargoed|haven't\s+announced|will\s+beat\s+by|will\s+miss\s+by)\b/i,
  },
  {
    code: "mnpi_material_deal_ma",
    regex: /\b(?:unannounced|secret|confidential|non[- ]?public|upcoming)\b.{0,60}\b(?:acquisition|merger|m&a|buyout|takeover|partnership|term\s+sheet|listing|token\s+unlock|sec\s+subpoena|settlement|lawsuit)\b/i,
  },
  {
    code: "mnpi_insider_source_disclosure",
    regex: /\b(?:my\s+(?:friend|colleague|brother|sister|boss|manager|vp|cfo|ceo|contact)\s+(?:inside|at\s+the\s+company|works\s+there)|as\s+a\s+current\s+employee|i\s+work\s+(?:at|for)\s+[a-z0-9_-]+|from\s+(?:internal|private)\s+(?:slack|email|memo|board\s+deck|dashboard|crm|erp|salesforce|snowflake))\b/i,
  },
  {
    code: "nda_confidential_information",
    regex: /\b(?:under\s+(?:an?\s+)?nda|non[- ]?disclosure\s+agreement|bound\s+by\s+(?:nda|confidentiality)|confidential\s+(?:client|employer|vendor|supplier|internal)\s+(?:data|deck|report|pricing|contract|orders?)|off\s+the\s+record|do\s+not\s+share\s+publicly|strictly\s+confidential|material\s+non[- ]?public|mnpi)\b/i,
  },
  {
    code: "mnpi_internal_orderbook_pricing",
    regex: /\b(?:internal\s+(?:order\s*book|backlog|shipments?|yield\s+numbers|pricing\s+sheet|customer\s+churn)|saw\s+their\s+internal\s+(?:numbers|spreadsheet|deck|dashboard))\b/i,
  },
]);

// Redactable patterns (e.g., accidental personal email/phone or named internal contact without MNPI).
const REDACT_RULES = Object.freeze([
  {
    code: "redact_personal_email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    code: "redact_phone_number",
    regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    replacement: "[REDACTED_PHONE]",
  },
]);

// Prohibited agent question topics (non-MNPI guardrail on agent prompts/outputs).
const PROHIBITED_AGENT_QUESTION_PATTERNS = Object.freeze([
  { code: "asks_unreleased_earnings", regex: /\b(?:unreleased|upcoming|next\s+quarter)\s+(?:earnings|revenue|guidance|eps|numbers)\b/i },
  { code: "asks_confidential_deals", regex: /\b(?:secret|unannounced|confidential|internal)\s+(?:deals?|m&a|mergers?|acquisitions?|pricing|orders?|product\s+plans?|legal\s+matters?)\b/i },
  { code: "asks_nda_info", regex: /\b(?:under\s+nda|confidential\s+employer|client\s+confidential|inside\s+information|mnpi)\b/i },
]);

const DEFAULT_EPHEMERAL_SALT = randomBytes(32).toString("hex");
const DEFAULT_SALT_ID = "ephemeral_v1";

function resolveRefusalSalt(saltConfig = {}) {
  const secret = String(
    saltConfig.salt ||
    process.env.TASKNODE_HIVE_MIND_MNPI_SALT ||
    DEFAULT_EPHEMERAL_SALT
  );
  const saltId = String(
    saltConfig.saltId ||
    process.env.TASKNODE_HIVE_MIND_MNPI_SALT_ID ||
    (process.env.TASKNODE_HIVE_MIND_MNPI_SALT ? "env_v1" : DEFAULT_SALT_ID)
  ).slice(0, 64);
  return { secret, saltId };
}

export function computeSaltedRefusalHash(rawText, saltConfig = {}) {
  const { secret, saltId } = resolveRefusalSalt(saltConfig);
  const digest = createHash("sha256")
    .update(secret, "utf8")
    .update("\0", "utf8")
    .update(String(rawText ?? ""), "utf8")
    .digest("hex");
  return { saltedSha256: digest, saltId };
}

/**
 * Pre-interview relationship & no-MNPI attestation gate.
 * Blocks current employees, insiders, and NDA-bound parties before Phase 1 starts.
 */
export function evaluatePreInterviewAttestation({
  accountId = "",
  modelId = "",
  relationship = "",
  noMnpiAttested = false,
  noNdaViolationAttested = false,
  now = new Date(),
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  const normalizedRelationship = String(relationship || "").trim().toLowerCase();
  const timestamp = now instanceof Date ? now.toISOString() : String(now);

  if (!normalizedAccountId || !normalizedModelId) {
    const error = new Error("attestation_account_and_model_required");
    error.status = 400;
    throw error;
  }

  let blocked = false;
  let blockReason = "";

  if (EXCLUDED_RELATIONSHIPS.includes(normalizedRelationship)) {
    blocked = true;
    blockReason = `excluded_relationship:${normalizedRelationship}`;
  } else if (!ALLOWED_RELATIONSHIPS.includes(normalizedRelationship)) {
    blocked = true;
    blockReason = "invalid_relationship_declaration";
  } else if (noMnpiAttested !== true) {
    blocked = true;
    blockReason = "no_mnpi_attestation_required";
  } else if (noNdaViolationAttested !== true) {
    blocked = true;
    blockReason = "no_nda_violation_attestation_required";
  }

  const attestationHash = createHash("sha256")
    .update(JSON.stringify({
      accountId: normalizedAccountId,
      modelId: normalizedModelId,
      relationship: normalizedRelationship,
      noMnpiAttested: Boolean(noMnpiAttested),
      noNdaViolationAttested: Boolean(noNdaViolationAttested),
      blocked,
      timestamp,
    }))
    .digest("hex");

  return {
    ok: !blocked,
    record: Object.freeze({
      id: `att_${randomUUID()}`,
      accountId: normalizedAccountId,
      modelId: normalizedModelId,
      relationship: normalizedRelationship,
      noMnpiAttested: Boolean(noMnpiAttested),
      noNdaViolationAttested: Boolean(noNdaViolationAttested),
      blocked,
      blockReason,
      attestationHash,
      createdAt: timestamp,
    }),
  };
}

/**
 * Guardrail for AI company agent questions/prompts:
 * Ensures the agent never asks for unreleased earnings, guidance, deals, internal orders/pricing,
 * unreleased product plans, legal matters, or employer/client confidential information.
 */
export function screenAgentQuestion(questionText = "") {
  const text = String(questionText || "").trim();
  if (!text) return { ok: false, reasonCode: "empty_question" };
  for (const rule of PROHIBITED_AGENT_QUESTION_PATTERNS) {
    if (rule.regex.test(text)) {
      return { ok: false, reasonCode: rule.code };
    }
  }
  return { ok: true, reasonCode: "" };
}

/**
 * Strict In-Memory Pre-Storage MNPI & Confidentiality Firewall.
 *
 * Runs strictly in RAM before any DB write, chat history append, or LLM forwarding.
 * - On `refuse`: discards raw text immediately and returns ONLY a hash-only audit record
 *   containing (id, accountId, modelId, threadId, timestamp, reasonCode, saltedSha256, saltId).
 *   ZERO raw user text or transcript bytes are returned in the audit record or persisted.
 * - On `redact`: returns redacted preview for explicit user confirmation; raw text is NOT saved.
 * - On `pass`: message is safe to store and forward.
 */
export async function screenMessageInMemory({
  accountId = "",
  modelId = "",
  threadId = "",
  rawText = "",
  now = new Date(),
  saltConfig = {},
  extraClassifier = null,
} = {}) {
  const text = String(rawText ?? "");
  const timestamp = now instanceof Date ? now.toISOString() : String(now);

  // 1. Deterministic high-precision MNPI / NDA screening in RAM.
  let refusalReason = "";
  for (const rule of MNPI_REFUSAL_RULES) {
    if (rule.regex.test(text)) {
      refusalReason = rule.code;
      break;
    }
  }

  // 2. Optional zero-data-retention external classifier (can only tighten to refuse/redact).
  let extraRedactedText = null;
  let extraRedactReasons = [];
  if (!refusalReason && typeof extraClassifier === "function") {
    const verdict = await extraClassifier({ modelId, text });
    if (verdict?.decision === "refuse") {
      refusalReason = String(verdict.reasonCode || "mnpi_classifier_refused").slice(0, 80);
    } else if (verdict?.decision === "redact" && typeof verdict.redactedText === "string") {
      extraRedactedText = verdict.redactedText;
      extraRedactReasons = Array.isArray(verdict.reasons) ? verdict.reasons.map(String) : ["classifier_redacted"];
    }
  }

  // 3. Refuse immediately: hash-only audit record, ZERO raw text persisted or echoed.
  if (refusalReason) {
    const { saltedSha256, saltId } = computeSaltedRefusalHash(text, saltConfig);
    const auditRecord = Object.freeze({
      id: `mnpi_ref_${randomUUID()}`,
      accountId: String(accountId || "").trim(),
      modelId: String(modelId || "").trim(),
      threadId: String(threadId || "").trim(),
      reasonCode: refusalReason,
      saltedSha256,
      saltId,
      createdAt: timestamp,
    });
    return Object.freeze({
      decision: "refuse",
      reasonCode: refusalReason,
      auditRecord,
      userNotice: "Message refused by MNPI/confidentiality firewall. Content was discarded immediately and not stored.",
    });
  }

  // 4. Redaction check (PII / personal contact info): preview only, do NOT store raw text.
  let working = extraRedactedText !== null ? extraRedactedText : text;
  const redactReasons = [...extraRedactReasons];
  for (const rule of REDACT_RULES) {
    if (rule.regex.test(working)) {
      rule.regex.lastIndex = 0;
      working = working.replace(rule.regex, rule.replacement);
      redactReasons.push(rule.code);
    }
    rule.regex.lastIndex = 0;
  }
  if (redactReasons.length > 0) {
    return Object.freeze({
      decision: "redact",
      reasons: Object.freeze(redactReasons),
      redactedPreview: working.trim(),
      userNotice: "Personal or sensitive contact details were redacted. Review and confirm the redacted text to submit.",
    });
  }

  // 5. Clean pass.
  return Object.freeze({
    decision: "pass",
    sanitizedText: text.trim(),
  });
}

const ALLOWED_AUDIT_KEYS = new Set([
  "id",
  "accountId",
  "modelId",
  "threadId",
  "reasonCode",
  "saltedSha256",
  "saltId",
  "createdAt",
]);

/**
 * Enforces the hash-only compliance invariant at the storage boundary.
 * Rejects any object carrying unexpected fields so raw text can never sneak into audit persistence.
 */
export function sanitizeHashOnlyRefusalAuditRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("mnpi_audit_record_invalid");
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUDIT_KEYS.has(key)) {
      throw new Error(`mnpi_audit_forbidden_field:${key}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(record.saltedSha256 || ""))) {
    throw new Error("mnpi_audit_invalid_sha256");
  }
  return Object.freeze({
    id: String(record.id || "").trim(),
    accountId: String(record.accountId || "").trim(),
    modelId: String(record.modelId || "").trim(),
    threadId: String(record.threadId || "").trim(),
    reasonCode: String(record.reasonCode || "").trim(),
    saltedSha256: String(record.saltedSha256),
    saltId: String(record.saltId || "").trim(),
    createdAt: String(record.createdAt || new Date().toISOString()),
  });
}
