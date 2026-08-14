import { createHash } from "node:crypto";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";
import {
  buildPublicProfileSnapshotInput,
  completePublicProfileSnapshot,
  createPublicProfileSnapshotRun,
  failPublicProfileSnapshot,
  getCompletedPublicProfileSnapshotByFingerprint,
} from "./repositories/profile-public.js";

const PROMPT_PATH = "profile/public_profile_snapshot_v1.md";
const PROMPT_VERSION = "public_profile_snapshot_v1";
const DEFAULT_MODEL = AMBIENT_MODELS.fastText;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function fingerprintInput(packet = {}) {
  const { computed_at: _computedAt, ...rest } = packet || {};
  return rest;
}

function parseJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("public_profile_empty_model_output");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("public_profile_model_output_not_json");
  }
}

export function publicProfileResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "public_profile_snapshot",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          role_title: { type: "string" },
          role_summary: { type: "string" },
          skills: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: { type: "string" },
          },
          archetype: {
            type: "string",
            enum: ["Builder", "Operator", "Researcher", "Auditor", "Designer", "Connector"],
          },
          archetype_contrast: { type: "string" },
          useful_to: { type: "string" },
          data_caveat: { type: "string" },
        },
        required: [
          "role_title",
          "role_summary",
          "skills",
          "archetype",
          "archetype_contrast",
          "useful_to",
          "data_caveat",
        ],
      },
    },
  };
}

function normalizePublicProfileOutput(output = {}) {
  const allowedArchetypes = new Set(["Builder", "Operator", "Researcher", "Auditor", "Designer", "Connector"]);
  const skills = Array.isArray(output.skills)
    ? output.skills.map((skill) => safeText(skill, 80)).filter(Boolean).slice(0, 7)
    : [];
  return {
    role_title: safeText(output.role_title, 120),
    role_summary: safeText(output.role_summary, 1000),
    skills,
    archetype: allowedArchetypes.has(output.archetype) ? output.archetype : "Builder",
    archetype_contrast: safeText(output.archetype_contrast, 180),
    useful_to: safeText(output.useful_to, 400),
    data_caveat: safeText(output.data_caveat, 400),
  };
}

export async function generatePublicProfileWithOpenRouter({
  packet,
  promptText,
  model,
  env = process.env,
} = {}) {
  const result = await ambientChatCompletion({
    env,
    capability: "strict_json",
    body: {
      model,
      messages: [
        { role: "system", content: promptText },
        {
          role: "user",
          content: JSON.stringify(
            {
              public_profile_policy: {
                numeric_fields_are_deterministic: true,
                do_not_invent_counts_rewards_wallets_or_nfts: true,
                private_context_excluded: true,
              },
              public_profile_packet: packet,
            },
            null,
            2
          ),
        },
      ],
      reasoning: {
        effort: "none",
        exclude: true,
      },
      temperature: 0,
      max_tokens: 1400,
      response_format: publicProfileResponseFormat(),
    },
  });
  const body = result.body;
  const content = result.text;
  return {
    provider: "ambient",
    model: body?.model || model,
    responseId: body?.id || null,
    output: parseJsonObject(content),
    rawText: content,
    usage: body?.usage || {},
  };
}

export async function runPublicProfileSnapshot({
  accountId,
  model = process.env.TASKNODE_PUBLIC_PROFILE_MODEL || DEFAULT_MODEL,
  env = process.env,
} = {}) {
  const promptText = loadPrompt(PROMPT_PATH);
  const digest = promptDigest(promptText);
  const packet = await buildPublicProfileSnapshotInput({ accountId });
  const inputFingerprint = `sha256:${sha256(fingerprintInput(packet))}`;
  const existing = await getCompletedPublicProfileSnapshotByFingerprint({
    accountId,
    inputFingerprint,
    model,
    promptDigest: digest,
  });
  if (existing) {
    return {
      ok: true,
      skipped: true,
      reason: "public_profile_snapshot_already_current",
      snapshot: existing,
      packet,
      output: existing.output,
      provider: existing.provider,
      model: existing.model,
      responseId: null,
      inputFingerprint,
      promptDigest: existing.promptDigest || digest,
    };
  }
  const run = await createPublicProfileSnapshotRun({
    accountId,
    inputFingerprint,
    inputSnapshot: packet,
    provider: "ambient",
    model,
    promptVersion: PROMPT_VERSION,
    promptDigest: digest,
  });
  try {
    const response = await generatePublicProfileWithOpenRouter({
      packet,
      promptText,
      model,
      env,
    });
    const normalized = normalizePublicProfileOutput(response.output);
    const output = {
      ...normalized,
      response_id: response.responseId,
      usage: response.usage,
    };
    const snapshot = await completePublicProfileSnapshot({
      snapshotId: run.snapshotId,
      output,
      outputDigest: `sha256:${sha256(normalized)}`,
    });
    return {
      ok: true,
      snapshot,
      packet,
      output: normalized,
      provider: response.provider,
      model: response.model,
      responseId: response.responseId,
      inputFingerprint,
      promptDigest: digest,
    };
  } catch (error) {
    await failPublicProfileSnapshot({ snapshotId: run.snapshotId, errorMessage: error?.message || String(error) }).catch(() => null);
    throw error;
  }
}
