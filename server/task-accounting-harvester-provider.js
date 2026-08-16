import crypto from "node:crypto";

import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { AMBIENT_MODELS, ambientConfigured, ambientFetchCompatibility } from "./ambient-inference.js";

const promptPath = "hive/task_accounting_harvester_v1.md";
const promptVersion = "task_accounting_harvester_v1";
const allowedActionStartPattern = /^(Open|Create|Add|Update|Implement|Publish|Write|Run|Configure|Remove|Merge|File|Investigate)\b/;
const forbiddenHandoffPattern =
  /\b(route|send|share|escalate)\b.{0,40}\b(to|with|owner|team|personnel|operator|project lead)\b/i;
const vagueReferencePattern =
  /\b(the|this) (report|memo|submission|friction report|stress test summary)\b|\b(reported|documented|submitted|proposed) (issues|gaps|findings|fixes|states|changes)\b|\b(three|3|two|2|2-5|2 to 5) (issues|gaps|fixes|changes|states)\b/i;
const evidenceChasePattern =
  /\b(add|fetch|recover|retrieve|request|ask|obtain|track down|chase)\b.{0,80}\b(full text|gist|screenshot|attachment|missing deliverable|missing artifact|submitted evidence|submission text|source packet|harvest packet|accounting packet|evidence packet)\b/i;
const followupMissingEvidencePattern =
  /\b(open|create|file)\b.{0,40}\b(follow-up task|qa bug|ticket|issue)\b.{0,120}\b(missing deliverable|missing artifact|missing evidence|not provided|not submitted|placeholder)\b/i;
const bugLikeCategoryPattern = /\b(bug|ux|ui|product|routing|workflow|regression|defect|issue)\b/i;
const bugLikeActionPattern = /\b(bug|ux|ui|product|routing|workflow|regression|defect|broken|stuck|wrong|fails?|missing|confusing)\b/i;
const paperworkOnlyBugActionPattern =
  /^(Create|File|Open|Write)\b.{0,80}\b(qa bug|bug ticket|ticket|tracker|tracker-ready|packet|document|report|memo)\b/i;

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configuredModel() {
  return (
    process.env.TASKNODE_TASK_ACCOUNTING_HARVESTER_MODEL ||
    process.env.TASK_ACCOUNTING_HARVESTER_MODEL ||
    AMBIENT_MODELS.structured
  );
}

export function taskAccountingHarvesterProviderConfigured() {
  return boolEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_PROVIDER_MOCK", false) || ambientConfigured();
}

function compactString(value, max = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 32)}\n...[truncated ${text.length - max + 32} chars]`;
}

function evidenceOutline(sourcePacket = {}) {
  const interestingLine =
    /^(#{1,5}\s+|[-*]\s+`?issue\b|[-*]\s+`?finding\b|issue\s+\d+|finding\s+\d+|\d+\.\s+|severity:|observed:|expected(?: behavior)?:|actual(?: behavior)?:|impact:|proposed fix:|recommended action:|screenshot:|screenshots:)/i;
  const lines = [];
  const seen = new Set();
  for (const event of Array.isArray(sourcePacket?.taskEvents) ? sourcePacket.taskEvents : []) {
    const chunks = [
      event?.verificationAsk,
      event?.verificationReason,
      event?.rewardReason,
      event?.rewardFeedback,
      event?.evidenceText,
      event?.evidenceNotes,
    ].filter(Boolean);
    for (const chunk of chunks) {
      const rawLines = String(chunk || "").split(/\r?\n/);
      for (let i = 0; i < rawLines.length; i += 1) {
        const line = rawLines[i].trim();
        if (!line || !interestingLine.test(line)) continue;
        const window = [line];
        for (let offset = 1; offset <= 2 && i + offset < rawLines.length; offset += 1) {
          const next = rawLines[i + offset].trim();
          if (next) window.push(next);
        }
        const item = window.join(" ").slice(0, 700);
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(item);
        if (lines.join("\n").length > 14000) return lines.join("\n");
      }
    }
  }
  return lines.join("\n");
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Task accounting harvester returned empty content");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Task accounting harvester returned non-JSON content");
  }
}

function normalizeClassification(value, requiresAction) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "requires_action") return "requires_action";
  if (normalized === "no_action") return "no_action";
  return requiresAction ? "requires_action" : "no_action";
}

function normalizeResult(payload) {
  const requiresAction = Boolean(
    payload?.requires_action ?? payload?.requiresAction ?? payload?.action_required,
  );
  const classification = normalizeClassification(payload?.classification, requiresAction);
  const actionRequired = classification === "requires_action" || requiresAction;
  const confidence = Number(payload?.confidence);
  return {
    schema: "pf.task_node.task_accounting_harvest.v1",
    classification: actionRequired ? "requires_action" : "no_action",
    requires_action: actionRequired,
    action_category: actionRequired
      ? String(payload?.action_category || payload?.actionCategory || "follow_up").slice(0, 80)
      : "none",
    assessment_summary: String(payload?.assessment_summary || payload?.summary || "").slice(0, 3000),
    suggested_action: actionRequired
      ? String(payload?.suggested_action || payload?.suggestedAction || "").slice(0, 6000)
      : String(payload?.suggested_action || payload?.suggestedAction || "No follow-up action required.").slice(0, 6000),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    raw: payload,
  };
}

function validateHarvesterResult(result = {}) {
  if (!result.requires_action) return result;
  const action = String(result.suggested_action || "").trim();
  if (!action) {
    throw new Error("Task accounting harvester suggested_action is required for requires_action rows");
  }
  if (!allowedActionStartPattern.test(action)) {
    throw new Error(
      "Task accounting harvester suggested_action must start with Open, Create, Add, Update, Implement, Publish, Write, Run, Configure, Remove, Merge, File, or Investigate",
    );
  }
  const forbidden = action.match(forbiddenHandoffPattern);
  if (forbidden) {
    throw new Error(`Task accounting harvester suggested_action contains handoff phrasing: ${forbidden[0]}`);
  }
  const vague = action.match(vagueReferencePattern);
  if (vague) {
    throw new Error(
      `Task accounting harvester suggested_action uses vague source-reference wording instead of naming the actual finding: ${vague[0]}`,
    );
  }
  const evidenceChase = action.match(evidenceChasePattern) || action.match(followupMissingEvidencePattern);
  if (evidenceChase) {
    throw new Error(
      `Task accounting harvester suggested_action chases missing contributor evidence instead of naming a concrete product/system action: ${evidenceChase[0]}`,
    );
  }
  const bugLike = bugLikeCategoryPattern.test(result.action_category || "") || bugLikeActionPattern.test(action);
  const paperworkOnly = action.match(paperworkOnlyBugActionPattern);
  if (bugLike && paperworkOnly) {
    throw new Error(
      `Task accounting harvester suggested_action turns a product defect into paperwork instead of investigation/fix work: ${paperworkOnly[0]}`,
    );
  }
  return result;
}

function mockHarvest(sourcePacket = {}) {
  const proposal = [
    sourcePacket?.task?.title,
    sourcePacket?.task?.proposal,
    sourcePacket?.task?.submissionRequirement,
    sourcePacket?.reward?.actualPft,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const actionPattern =
    /\b(bug|broken|fix|feature|request|release|announce|community|communication|routing|reward|accounting|audit|security|sybil|fraud|ux|ui|workflow|stuck|latency|performance|regression)\b/;
  const requiresAction = actionPattern.test(proposal);
  return normalizeResult({
    classification: requiresAction ? "requires_action" : "no_action",
    requires_action: requiresAction,
    action_category: requiresAction ? "product_or_protocol_follow_up" : "none",
    assessment_summary: requiresAction
      ? "Mock harvester detected follow-up signals in the rewarded task packet."
      : "Mock harvester found the rewarded task self-contained with no separate follow-up signal.",
    suggested_action: requiresAction
      ? "Investigate the stale reward accounting display, reproduce the affected surface, and implement the product fix or provide not-a-bug evidence if the current product no longer reproduces it."
      : "Mark harvested with no further action.",
    confidence: 0.72,
  });
}

function responseSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "task_accounting_harvest",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "schema",
          "classification",
          "requires_action",
          "action_category",
          "assessment_summary",
          "suggested_action",
          "confidence",
        ],
        properties: {
          schema: { type: "string", const: "pf.task_node.task_accounting_harvest.v1" },
          classification: { type: "string", enum: ["requires_action", "no_action"] },
          requires_action: { type: "boolean" },
          action_category: { type: "string", maxLength: 80 },
          assessment_summary: { type: "string", maxLength: 3000 },
          suggested_action: { type: "string", maxLength: 6000 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  };
}

function requestMessages({ prompt, sourcePacket, correction = "" }) {
  const outline = evidenceOutline(sourcePacket);
  const messages = [
    {
      role: "system",
      content: prompt,
    },
    {
      role: "user",
      content: `The following task proposal and reward were granted.\n\nEVIDENCE_OUTLINE:\n${compactString(
        outline || "No extracted evidence outline available.",
        16000,
      )}\n\nSOURCE_PACKET:\n${compactString(
        sourcePacket,
        numericEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_SOURCE_PACKET_CHARS", 64000),
      )}`,
    },
  ];
  if (correction) {
    messages.push({
      role: "user",
      content: `Your previous JSON violated the required suggested_action contract: ${correction}. Return corrected JSON only. If the only possible action is to chase missing contributor evidence, classify the row as no_action. Otherwise the corrected suggested_action must start with one allowed concrete verb and name a concrete product/system artifact or change.`,
    });
  }
  return messages;
}

export async function runTaskAccountingHarvestCall({ sourcePacket, fetchImpl = fetch } = {}) {
  const prompt = await loadPrompt(promptPath);
  const promptHash = promptDigest(prompt);
  const model = configuredModel();
  const provider = "ambient";
  if (boolEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_PROVIDER_MOCK", false)) {
    const result = mockHarvest(sourcePacket);
    return {
      result,
      provider: "mock",
      model,
      promptVersion,
      promptHash,
      durationMs: 1,
      usageJson: null,
      rawResponseJson: { mocked: true, result },
    };
  }

  if (!ambientConfigured()) {
    throw new Error("AMBIENT_API_KEY is required for task accounting harvester");
  }

  const started = Date.now();
  const maxAttempts = numericEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_PROVIDER_ATTEMPTS", 3);
  let correction = "";
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, Math.min(5, maxAttempts)); attempt += 1) {
    const timeoutMs = numericEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_TIMEOUT_MS", 120000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("task accounting harvester timed out")), timeoutMs);
    const body = {
      model,
      temperature: 0,
      max_tokens: numericEnv("TASKNODE_TASK_ACCOUNTING_HARVESTER_MAX_TOKENS", 2500),
      response_format: responseSchema(),
      usage: { include: true },
      metadata: {
        app: "tasknodeofficial",
        worker: "task_accounting_harvester",
        prompt_version: promptVersion,
        task_id: sourcePacket?.task?.taskId || "",
        attempt,
      },
      messages: requestMessages({ prompt, sourcePacket, correction }),
    };

    let response;
    try {
      response = await ambientFetchCompatibility(fetchImpl, "", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, { capability: "strict_json", timeoutMs });
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Date.now() - started;
    const rawText = await response.text();
    let rawResponseJson = null;
    try {
      rawResponseJson = JSON.parse(rawText);
    } catch {
      rawResponseJson = { rawText: rawText.slice(0, 4000) };
    }
    if (!response.ok) {
      const detail = rawResponseJson?.error?.message || rawText.slice(0, 600);
      throw new Error(`Task accounting harvester provider failed (${response.status}): ${detail}`);
    }

    const content = rawResponseJson?.choices?.[0]?.message?.content;
    const contentText = Array.isArray(content)
      ? content.map((part) => part?.text || part?.content || "").join("")
      : content;
    try {
      const parsed = extractJson(contentText);
      const result = validateHarvesterResult(normalizeResult(parsed));
      const requestId =
        rawResponseJson?.id ||
        rawResponseJson?.request_id ||
        crypto.createHash("sha256").update(rawText).digest("hex").slice(0, 24);
      return {
        result,
        provider,
        model,
        promptVersion,
        promptHash,
        providerRequestId: requestId,
        durationMs,
        usageJson: { ...(rawResponseJson?.usage || {}), validationAttempts: attempt },
        rawResponseJson,
      };
    } catch (error) {
      lastError = error;
      correction = error?.message || String(error);
    }
  }
  throw lastError || new Error("Task accounting harvester provider returned invalid output");
}
