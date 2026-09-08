import { hasPrivateLiterals, parseInferenceJson } from "./inference-text.js";
import { loadPrompt, promptDigest } from "./prompt-registry.js";
import { privateProfileNftCompletion } from "./profile-nft-art-spec.js";

export const profileNftTitlePrompt = loadPrompt("profile/profile_nft_title_v1.md");
export const profileNftTitlePromptDigest = promptDigest(profileNftTitlePrompt);
export const profileNftTitleSchema = { type: "string", minLength: 3, maxLength: 80 };
const productTitles = new Set(["profile pic nft", "profile nft", "task node profile picture", "task node profile nft", "techno mordor"]);

export function validateProfileNftTitle(value) {
  if (typeof value !== "string") throw new Error("profile_nft_title_invalid");
  const title = value.trim();
  if (title.length < 3 || title.length > 80 || productTitles.has(title.toLowerCase()) ||
      [...title].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127) || hasPrivateLiterals(title)) {
    throw new Error("profile_nft_title_invalid");
  }
  return title;
}

// Compatibility for an image checkpoint made before naming was introduced.
// New renders get their title from the existing image review, without another call.
export async function generateProfileNftTitle({ artSpec, env = process.env, fetchImpl = fetch, signal } = {}) {
  const visual = Object.fromEntries(["creature", "creature_level", "hyperstition", "momentum", "colors", "form", "pose", "details", "environment", "ink"]
    .map((key) => [key, artSpec?.[key]]));
  const result = await privateProfileNftCompletion({ env, fetchImpl, signal, body: {
    messages: [{ role: "system", content: profileNftTitlePrompt }, { role: "user", content: JSON.stringify(visual) }],
    response_format: { type: "json_schema", json_schema: { name: "profile_nft_title", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["title"], properties: { title: profileNftTitleSchema },
    } } },
  } });
  const named = parseInferenceJson(result.text);
  if (!named || Object.keys(named).length !== 1) throw new Error("profile_nft_title_invalid");
  return { title: validateProfileNftTitle(named.title), model: result.model, titlePromptDigest: profileNftTitlePromptDigest };
}
