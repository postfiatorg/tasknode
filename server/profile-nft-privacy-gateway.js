import { createHash } from "node:crypto";
import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";

const abstractionPrompt = loadPrompt("profile/profile_nft_privacy_abstraction_v1.md");
const reviewPrompt = loadPrompt("profile/profile_nft_privacy_review_v1.md");
const themes = ["software_building", "community_coordination", "research", "design", "operations", "education", "analysis"];
const archetypes = ["builder", "operator", "researcher", "auditor", "designer", "connector"];
const bands = ["emerging", "established", "advanced"];
const metaphors = ["bridge", "constellation", "compass", "forge", "lighthouse", "network", "workshop"];
const moods = ["focused", "curious", "resilient", "calm", "bold", "collaborative"];
const palettes = ["cool_neon", "warm_earth", "deep_space", "high_contrast", "soft_gradient", "monochrome_accent"];
const compositions = ["central_emblem", "layered_landscape", "abstract_portrait", "geometric_field", "symbolic_workspace"];
const styles = ["digital_illustration", "editorial", "geometric", "cinematic", "minimal", "surreal"];

function schema() {
  const enumArray = (values, maxItems = 3) => ({ type: "array", maxItems, items: { type: "string", enum: values } });
  return { type: "json_schema", json_schema: { name: "profile_nft_private_art_brief", strict: true, schema: {
    type: "object", additionalProperties: false,
    required: ["approved", "privacy_risk", "privacy_findings", "archetype", "activity_themes", "achievement_band", "visual_metaphors", "mood", "palette", "composition", "style_tags"],
    properties: {
      approved: { type: "boolean" }, privacy_risk: { type: "string", enum: ["low", "high"] },
      privacy_findings: { type: "array", maxItems: 5, items: { type: "string" } },
      archetype: { type: "string", enum: archetypes }, activity_themes: enumArray(themes),
      achievement_band: { type: "string", enum: bands }, visual_metaphors: enumArray(metaphors),
      mood: { type: "string", enum: moods }, palette: { type: "string", enum: palettes },
      composition: { type: "string", enum: compositions }, style_tags: enumArray(styles),
    },
  } } };
}

function parse(text = "") {
  const raw = String(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

function sensitiveSourceTokens(source = "") {
  return new Set((String(source).toLowerCase().match(/[a-z0-9][a-z0-9_-]{7,}/g) || [])
    .filter((token) => /\d/.test(token) || token.length >= 16));
}

export function validateProfileNftArtBrief(brief = {}, source = "") {
  if (!brief.approved || brief.privacy_risk !== "low") throw new Error("profile_nft_privacy_not_approved");
  const rendered = JSON.stringify(brief).toLowerCase();
  if (/https?:|0x[a-f0-9]{8,}|\b[a-f0-9]{32,}\b|@[a-z0-9_]+|\b\d+(?:\.\d+)?\s*(?:pft|usd|btc|eth)\b/i.test(rendered)) throw new Error("profile_nft_privacy_mechanical_leak");
  const overlap = [...sensitiveSourceTokens(source)].filter((token) => rendered.includes(token));
  if (overlap.length) throw new Error("profile_nft_privacy_source_overlap");
  return brief;
}

export function renderSanitizedProfileNftPrompt(brief = {}) {
  return [
    "Create a text-free, logo-free Task Node profile NFT illustration.",
    `Archetype: ${brief.archetype}. Broad themes: ${(brief.activity_themes || []).join(", ")}.`,
    `Achievement band: ${brief.achievement_band}. Metaphors: ${(brief.visual_metaphors || []).join(", ")}.`,
    `Mood: ${brief.mood}. Palette: ${brief.palette}. Composition: ${brief.composition}. Styles: ${(brief.style_tags || []).join(", ")}.`,
    "Do not include text, letters, numbers, usernames, logos, brands, wallets, QR codes, documents, source code, financial symbols, or recognizable people.",
  ].join(" ");
}

export async function createPrivateProfileNftArtBrief({ sourcePacket, env = process.env, fetchImpl = fetch } = {}) {
  const source = JSON.stringify(sourcePacket || {});
  const first = await ambientChatCompletion({ env, fetchImpl, capability: "strict_json", timeoutMs: 120_000, body: {
    model: env.PROFILE_NFT_PRIVACY_MODEL || AMBIENT_MODELS.structured,
    messages: [{ role: "system", content: abstractionPrompt }, { role: "user", content: source }],
    response_format: schema(), reasoning: { effort: "high", exclude: true }, temperature: 0,
  } });
  const candidate = parse(first.text);
  const second = await ambientChatCompletion({ env, fetchImpl, capability: "strict_json", timeoutMs: 120_000, body: {
    model: env.PROFILE_NFT_PRIVACY_MODEL || AMBIENT_MODELS.structured,
    messages: [{ role: "system", content: reviewPrompt }, { role: "user", content: JSON.stringify({ private_source: sourcePacket, candidate_brief: candidate }) }],
    response_format: schema(), reasoning: { effort: "high", exclude: true }, temperature: 0,
  } });
  const brief = validateProfileNftArtBrief(parse(second.text), source);
  const prompt = renderSanitizedProfileNftPrompt(brief);
  return {
    brief,
    prompt,
    promptDigest: createHash("sha256").update(prompt).digest("hex"),
    templateDigest: promptDigest(`${abstractionPrompt}\n${reviewPrompt}`),
    source: "ambient_glm52_privacy_gateway",
    unresolvedPlaceholders: [],
    metadata: { model: env.PROFILE_NFT_IMAGE_MODEL || "gpt-image-2", privacyModel: second.model },
  };
}
