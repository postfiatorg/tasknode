import assert from "node:assert/strict";
import { createPrivateProfileNftArtBrief, renderSanitizedProfileNftPrompt, validateProfileNftArtBrief } from "../server/profile-nft-privacy-gateway.js";
import { renderProfileNftImage } from "../server/profile-nft-image-provider.js";
import { reviewRenderedProfileNftImage } from "../server/profile-nft-image-review.js";

const approvedBrief = {
  approved: true,
  privacy_risk: "low",
  privacy_findings: [],
  archetype: "builder",
  action: "assembling",
  activity_themes: ["software_building", "community_coordination"],
  achievement_band: "established",
  visual_metaphors: ["bridge", "prism"],
  mood: "focused",
  palette: "emerald_coral",
  composition: "half_length_tool_portrait",
  style_tags: ["luminous_gouache", "graphic_novel"],
  setting: "botanical_laboratory",
  lighting: "dappled_daylight",
  materials: ["glass", "living_vines"],
};

const privatePacket = {
  project: "SecretProjectZephyr9081726354",
  wallet: "0x1234567890abcdef1234567890abcdef12345678",
  action: "Acquire 17.25 ETH before the private launch on 2026-08-19",
};
let ambientCalls = 0;
const ambientFetch = async (_url, init) => {
  ambientCalls += 1;
  const request = JSON.parse(init.body);
  assert.equal(request.model, "z-ai/glm-5.2");
  assert.ok(JSON.stringify(request.messages).includes("SecretProjectZephyr9081726354"));
  return new Response(JSON.stringify({ id: `ambient_${ambientCalls}`, model: request.model, choices: [{ message: { content: JSON.stringify(approvedBrief) } }] }), { status: 200 });
};

const rendered = await createPrivateProfileNftArtBrief({ sourcePacket: privatePacket, env: { AMBIENT_API_KEY: "ambient-test" }, fetchImpl: ambientFetch });
assert.equal(ambientCalls, 2);
assert.equal(rendered.source, "ambient_glm52_privacy_gateway");
assert.equal(rendered.promptDigest.length, 64);
assert.ok(!rendered.prompt.includes("SecretProjectZephyr"));
assert.ok(!rendered.prompt.includes("17.25"));
assert.ok(!rendered.prompt.includes("0x1234"));
assert.match(rendered.prompt, /one central invented builder work persona actively assembling/i);
assert.match(rendered.prompt, /never as the main subject or a central emblem/i);
assert.match(rendered.prompt, /Do not create a badge, seal, lighthouse emblem/i);
assert.match(rendered.prompt, /Composition variation key: [a-f0-9]{16}/i);

const alternatePrompt = renderSanitizedProfileNftPrompt({
  ...approvedBrief,
  action: "verifying",
  palette: "saffron_indigo",
  composition: "dynamic_three_quarter_figure",
  style_tags: ["color_woodcut"],
  setting: "alpine_signal_station",
  lighting: "golden_hour",
  materials: ["ink_and_paper", "painted_wood"],
}, { variationKey: "safevariation0001" });
assert.match(alternatePrompt, /actively verifying/i);
assert.match(alternatePrompt, /saffron_indigo/i);
assert.notEqual(alternatePrompt, rendered.prompt);

assert.throws(() => validateProfileNftArtBrief({ ...approvedBrief, privacy_findings: [privatePacket.wallet] }, JSON.stringify(privatePacket)), /privacy_mechanical_leak|privacy_source_overlap/);
assert.throws(() => validateProfileNftArtBrief({ ...approvedBrief, activity_themes: ["software_building", "software_building"] }, JSON.stringify(privatePacket)), /art_brief_invalid/);

let openAiRequest = null;
await renderProfileNftImage({
  prompt: rendered.prompt,
  model: "gpt-image-2",
  size: "1024x1024",
  quality: "high",
  outputFormat: "png",
  env: { PROFILE_NFT_OPENAI_API_KEY: "renderer-test" },
  fetchImpl: async (url, init) => {
    openAiRequest = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 });
  },
});
assert.equal(openAiRequest.url, "https://api.openai.com/v1/images/generations");
assert.deepEqual(Object.keys(openAiRequest.body).sort(), ["model", "n", "output_format", "prompt", "quality", "size"]);
assert.equal(openAiRequest.body.prompt, rendered.prompt);
assert.ok(!JSON.stringify(openAiRequest.body).includes("SecretProjectZephyr"));
assert.ok(!JSON.stringify(openAiRequest.body).includes("17.25"));

let reviewRequest = null;
const approvedReviewFetch = async (_url, init) => {
  reviewRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({
    id: "review_ok",
    model: reviewRequest.model,
    choices: [{ message: { content: JSON.stringify({ approved: true, privacy_violations: [], art_direction_violations: [] }) } }],
  }), { status: 200 });
};
await reviewRenderedProfileNftImage({
  imageBase64: "aW1hZ2U=",
  sanitizedPrompt: rendered.prompt,
  env: { AMBIENT_API_KEY: "ambient-test" },
  fetchImpl: approvedReviewFetch,
});
assert.ok(JSON.stringify(reviewRequest.messages).includes("central invented builder"));

await assert.rejects(
  reviewRenderedProfileNftImage({
    imageBase64: "aW1hZ2U=",
    sanitizedPrompt: alternatePrompt,
    env: { AMBIENT_API_KEY: "ambient-test" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        id: "review_reject",
        model: request.model,
        choices: [{ message: { content: JSON.stringify({ approved: false, privacy_violations: [], art_direction_violations: ["generic_or_stock", "no_clear_action"] }) } }],
      }), { status: 200 });
    },
  }),
  /profile_nft_generated_image_art_direction_rejected/
);

console.log(JSON.stringify({ ok: true, ambientCalls, promptDigest: rendered.promptDigest.slice(0, 12) }));
