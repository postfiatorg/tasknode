import assert from "node:assert/strict";
import { createPrivateProfileNftArtBrief, validateProfileNftArtBrief } from "../server/profile-nft-privacy-gateway.js";
import { renderProfileNftImage } from "../server/profile-nft-image-provider.js";

const approvedBrief = {
  approved: true,
  privacy_risk: "low",
  privacy_findings: [],
  archetype: "builder",
  activity_themes: ["software_building", "community_coordination"],
  achievement_band: "established",
  visual_metaphors: ["bridge", "constellation"],
  mood: "focused",
  palette: "deep_space",
  composition: "central_emblem",
  style_tags: ["digital_illustration", "geometric"],
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

assert.throws(() => validateProfileNftArtBrief({ ...approvedBrief, privacy_findings: [privatePacket.wallet] }, JSON.stringify(privatePacket)), /privacy_mechanical_leak|privacy_source_overlap/);

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

console.log(JSON.stringify({ ok: true, ambientCalls, promptDigest: rendered.promptDigest.slice(0, 12) }));
