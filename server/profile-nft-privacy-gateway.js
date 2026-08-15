import { createHash, randomBytes } from "node:crypto";
import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";

const abstractionPrompt = loadPrompt("profile/profile_nft_privacy_abstraction_v1.md");
const reviewPrompt = loadPrompt("profile/profile_nft_privacy_review_v1.md");
const themes = ["software_building", "community_coordination", "research", "design", "operations", "education", "analysis"];
const archetypes = ["builder", "operator", "researcher", "auditor", "designer", "connector"];
const bands = ["emerging", "established", "advanced"];
const actions = ["assembling", "calibrating", "charting", "directing", "forging", "inspecting", "negotiating", "researching", "routing", "teaching", "verifying"];
const metaphors = ["bridge", "compass", "forge", "loom", "prism", "root_system", "sail", "signal_fire", "telescope", "wayfinder"];
const moods = ["focused", "curious", "resilient", "calm", "bold", "collaborative"];
const palettes = ["cobalt_amber", "copper_azure", "emerald_coral", "jade_magenta", "pearl_graphite", "saffron_indigo", "teal_rose", "violet_cyan"];
const compositions = ["close_action_portrait", "dynamic_three_quarter_figure", "full_figure_workspace", "half_length_tool_portrait"];
const styles = ["anime_key_art", "art_nouveau", "cinematic_concept_art", "color_woodcut", "graphic_novel", "luminous_gouache", "oil_painting", "retro_futurist", "stained_glass", "surreal_editorial"];
const settings = ["alpine_signal_station", "botanical_laboratory", "civic_atrium", "desert_foundry", "luminous_archive", "oceanic_observatory", "orbital_workshop", "rainlit_studio"];
const lighting = ["aurora_rim_light", "dappled_daylight", "golden_hour", "moonlit_volumetric", "prismatic_studio", "soft_overcast", "torchlit_warmth"];
const materials = ["brushed_metal", "ceramic", "glass", "ink_and_paper", "living_vines", "painted_wood", "stone", "woven_fiber"];

function schema() {
  const enumArray = (values, maxItems = 3) => ({ type: "array", maxItems, items: { type: "string", enum: values } });
  return { type: "json_schema", json_schema: { name: "profile_nft_private_art_brief", strict: true, schema: {
    type: "object", additionalProperties: false,
    required: ["approved", "privacy_risk", "privacy_findings", "archetype", "action", "activity_themes", "achievement_band", "visual_metaphors", "mood", "palette", "composition", "style_tags", "setting", "lighting", "materials"],
    properties: {
      approved: { type: "boolean" }, privacy_risk: { type: "string", enum: ["low", "high"] },
      privacy_findings: { type: "array", maxItems: 5, items: { type: "string" } },
      archetype: { type: "string", enum: archetypes }, action: { type: "string", enum: actions }, activity_themes: enumArray(themes),
      achievement_band: { type: "string", enum: bands }, visual_metaphors: enumArray(metaphors),
      mood: { type: "string", enum: moods }, palette: { type: "string", enum: palettes },
      composition: { type: "string", enum: compositions }, style_tags: enumArray(styles, 2),
      setting: { type: "string", enum: settings }, lighting: { type: "string", enum: lighting }, materials: enumArray(materials, 3),
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
  const requiredSelections = [
    ["archetype", archetypes], ["action", actions], ["achievement_band", bands], ["mood", moods],
    ["palette", palettes], ["composition", compositions], ["setting", settings], ["lighting", lighting],
  ];
  if (requiredSelections.some(([field, allowed]) => !allowed.includes(brief[field]))) throw new Error("profile_nft_art_brief_invalid");
  const arraySelections = [
    ["activity_themes", themes], ["visual_metaphors", metaphors], ["style_tags", styles], ["materials", materials],
  ];
  if (arraySelections.some(([field, allowed]) => !Array.isArray(brief[field]) || !brief[field].length || new Set(brief[field]).size !== brief[field].length || brief[field].some((value) => !allowed.includes(value)))) {
    throw new Error("profile_nft_art_brief_invalid");
  }
  return brief;
}

export function renderSanitizedProfileNftPrompt(brief = {}, { variationKey = "" } = {}) {
  return [
    "Create a square, high-detail, text-free and logo-free Task Node profile NFT illustration.",
    `Show one central invented ${brief.archetype} work persona actively ${brief.action}; the head, torso, hands, tool, and action must read clearly at avatar size.`,
    `Use a ${brief.composition} in a ${brief.setting}. Broad themes: ${(brief.activity_themes || []).join(", ")}. Achievement band: ${brief.achievement_band}.`,
    `Use ${(brief.visual_metaphors || []).join(", ")} only as supporting visual language, never as the main subject or a central emblem.`,
    `Mood: ${brief.mood}. Full-spectrum palette: ${brief.palette}. Lighting: ${brief.lighting}. Materials: ${(brief.materials || []).join(", ")}. Art direction: ${(brief.style_tags || []).join(", ")}.`,
    "Make the character, action, palette, setting, and material treatment visually specific and memorable. Prefer rich illustration, tactile texture, precise lighting, and a strong silhouette.",
    "Do not create a badge, seal, lighthouse emblem, flowchart, diagram, dashboard collage, generic mascot, stock avatar, corporate clipart, or glossy 3D toy render.",
    "Do not include text, letters, numbers, usernames, logos, brands, wallets, QR codes, documents, source code, financial symbols, or recognizable people.",
    variationKey ? `Composition variation key: ${variationKey}. Do not render the key.` : "",
  ].filter(Boolean).join(" ");
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
  const prompt = renderSanitizedProfileNftPrompt(brief, { variationKey: randomBytes(8).toString("hex") });
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
