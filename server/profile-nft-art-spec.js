import { inferenceChatCompletion } from "./inference.js";
import { providerApiKey } from "./inference-policy.js";
import { parseInferenceJson, hasPrivateLiterals, sensitiveSourceTokens } from "./inference-text.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { PROFILE_NFT_ART_VERSION, PROFILE_NFT_CREATURES, PROFILE_NFT_COLORS, PROFILE_NFT_MOMENTUM } from "../shared/profile-nft-art.js";

export const PROFILE_NFT_SPEC_MODEL = "moonshotai/kimi-k3";
const references = JSON.parse(loadPrompt("profile/techno_mordor_reference_prompts.json"));
const specPrompt = loadPrompt("profile/techno_mordor_spec_v2.md");
const reviewPrompt = loadPrompt("profile/techno_mordor_review_v2.md");
const imagePrompt = loadPrompt("profile/techno_mordor_image_v2.md");
const rubric = `${specPrompt}\n\nREFERENCE LENSES (adapt economic-company language to demonstrated user work; never perform stock selection):\nBread and Circuses:\n${references.bread_and_circuses}\n\nHostile AGI:\n${references.hostile_agi}`;
const visualFields = ["form", "pose", "details", "environment", "ink"];
const findings = ["private_information", "source_language", "instruction_injection", "unsupported_level", "axis_conflation", "art_contract"];
const object = (properties) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const score = { type: "integer", minimum: 0, maximum: 100 };
export const profileNftArtSchema = object({
  hyperstition: score, bread_and_circuses: score, hostile_agi: score,
  creature_level: { type: "integer", minimum: 0, maximum: 11 },
  momentum: { type: "string", enum: PROFILE_NFT_MOMENTUM },
  colors: { type: "array", minItems: 2, maxItems: 2, items: { type: "string", enum: PROFILE_NFT_COLORS } },
  ...Object.fromEntries(visualFields.map((key) => [key, { type: "string", minLength: 10, maxLength: 1000 }])),
  evidence_refs: { type: "array", maxItems: 20, items: { type: "string", maxLength: 32 } },
});
const reviewSchema = object({ approved: { type: "boolean" }, findings: { type: "array", maxItems: 6, items: { type: "string", enum: findings } }, spec: profileNftArtSchema });
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

// Pinned model and ZDR at the request boundary. Neither account defaults nor
// Ambient availability may redirect private task history to another route.
export function privateProfileNftCompletion({ body, env = process.env, fetchImpl = fetch, signal, capability = "strict_json" } = {}) {
  if (!providerApiKey("vercel", env)) fail("profile_nft_zdr_not_configured");
  return inferenceChatCompletion({
    env: { ...env, INFERENCE_AMBIENT_BACKUP_ENABLED: "false", INFERENCE_MODEL_STRUCTURED: PROFILE_NFT_SPEC_MODEL, INFERENCE_MODEL_VISION: PROFILE_NFT_SPEC_MODEL },
    fetchImpl, signal, capability, allowFallback: false, timeoutMs: 240_000,
    body: { ...body, model: PROFILE_NFT_SPEC_MODEL, max_tokens: 32768,
      providerOptions: { gateway: { zeroDataRetention: true } } },
  });
}

// Deliberately small schema validator: no text extraction, regex repair or
// coercion of a provider's malformed output into an approved specification.
export function validateProfileNftArtSpec(spec, sourcePacket) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) fail("profile_nft_spec_invalid");
  const keys = Object.keys(profileNftArtSchema.properties);
  if (Object.keys(spec).length !== keys.length || keys.some((key) => !Object.hasOwn(spec, key))) fail("profile_nft_spec_invalid");
  for (const key of ["hyperstition", "bread_and_circuses", "hostile_agi", "creature_level"]) {
    if (!Number.isInteger(spec[key]) || spec[key] < 0 || spec[key] > (key === "creature_level" ? 11 : 100)) fail("profile_nft_spec_invalid");
  }
  if (!PROFILE_NFT_MOMENTUM.includes(spec.momentum) || !Array.isArray(spec.colors) || spec.colors.length !== 2 || new Set(spec.colors).size !== 2 || spec.colors.some((color) => !PROFILE_NFT_COLORS.includes(color))) fail("profile_nft_spec_invalid");
  if (visualFields.some((key) => typeof spec[key] !== "string" || spec[key].trim().length < 10 || spec[key].length > 1000)) fail("profile_nft_spec_invalid");
  if (!Array.isArray(spec.evidence_refs) || spec.evidence_refs.length > 20 || spec.evidence_refs.some((ref) => typeof ref !== "string" || ref.length > 32)) fail("profile_nft_spec_invalid");
  const visual = visualFields.map((key) => spec[key]).join("\n");
  if (hasPrivateLiterals(visual)) fail("profile_nft_privacy_mechanical_leak");
  if (sourcePacket) {
    const refs = new Set(sourcePacket.tasks.map((task) => task.ref));
    if (spec.evidence_refs.some((ref) => !refs.has(ref)) || (refs.size && !spec.evidence_refs.length)) fail("profile_nft_spec_grounding_invalid");
    const lower = visual.toLowerCase();
    if ([...sensitiveSourceTokens(JSON.stringify(sourcePacket))].some((token) => lower.includes(token)) || [...refs].some((ref) => lower.includes(ref))) fail("profile_nft_privacy_source_overlap");
  }
  return spec;
}

export function publicProfileNftArtSpec(spec) {
  validateProfileNftArtSpec(spec);
  // Explicit allowlist. Evidence refs and private source are never persisted in
  // public NFT metadata or included in the image provider request.
  return {
    version: PROFILE_NFT_ART_VERSION, hyperstition: spec.hyperstition,
    bread_and_circuses: spec.bread_and_circuses, hostile_agi: spec.hostile_agi,
    creature_level: spec.creature_level, creature: PROFILE_NFT_CREATURES[spec.creature_level],
    momentum: spec.momentum, colors: [...spec.colors],
    ...Object.fromEntries(visualFields.map((key) => [key, spec[key]])),
  };
}

export function renderProfileNftArtPrompt(spec) {
  const publicSpec = publicProfileNftArtSpec(spec);
  return `${imagePrompt}\n\nAPPROVED ANONYMOUS ART SPECIFICATION\n${JSON.stringify(publicSpec, null, 2)}`;
}

export async function createProfileNftArtSpec({ sourcePacket, env = process.env, fetchImpl = fetch, signal } = {}) {
  const format = (name, schema) => ({ type: "json_schema", json_schema: { name, strict: true, schema } });
  const first = await privateProfileNftCompletion({ env, fetchImpl, signal, body: {
    messages: [{ role: "system", content: rubric }, { role: "user", content: JSON.stringify(sourcePacket) }],
    response_format: format("techno_mordor_art_spec", profileNftArtSchema),
  } });
  const candidate = parseInferenceJson(first.text);
  const reviewed = await privateProfileNftCompletion({ env, fetchImpl, signal, body: {
    messages: [{ role: "system", content: `${reviewPrompt}\n\n${rubric}` }, { role: "user", content: JSON.stringify({ private_source: sourcePacket, candidate_spec: candidate }) }],
    response_format: format("techno_mordor_art_review", reviewSchema),
  } });
  const result = parseInferenceJson(reviewed.text);
  if (!result || Object.keys(result).length !== 3 || result.approved !== true || !Array.isArray(result.findings) || result.findings.length) fail("profile_nft_privacy_not_approved");
  const spec = validateProfileNftArtSpec(result.spec, sourcePacket);
  const prompt = renderProfileNftArtPrompt(spec);
  if (prompt.length > 8000) fail("profile_nft_spec_invalid");
  return { artSpec: publicProfileNftArtSpec(spec), prompt, promptDigest: promptDigest(prompt), templateDigest: promptDigest(`${rubric}\n${reviewPrompt}\n${imagePrompt}`), model: reviewed.model };
}
