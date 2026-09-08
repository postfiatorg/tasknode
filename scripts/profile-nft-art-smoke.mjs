import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProfileNftArtSpec, renderProfileNftArtPrompt, validateProfileNftArtSpec, privateProfileNftCompletion } from "../server/profile-nft-art-spec.js";
import { renderProfileNftImage } from "../server/profile-nft-image-provider.js";
import { reviewRenderedProfileNftImage } from "../server/profile-nft-image-review.js";
import { classifyProfileNftGenerationFailure } from "../server/profile-nft-failures.js";
import { metadataForNft } from "../server/profile-nft-mint.js";
import { generateProfileNftTitle, validateProfileNftTitle } from "../server/profile-nft-title.js";

const spec = JSON.parse(await readFile(new URL("./profile-nft-art-fixture.json", import.meta.url)));
const sourcePacket = { tasks: [{ ref: "work_1", title: "Delivered SecretProjectZephyr9081726354", description: "Private completion evidence" }], metrics: { completed_tasks: 3 } };
const env = { VERCEL_AI_GATEWAY_API_KEY: "fixture-vercel", AMBIENT_API_KEY: "fixture-ambient", INFERENCE_MODEL_STRUCTURED: "zai/glm-5.3", INFERENCE_MODEL_VISION: "zai/glm-5.3-flash" };
let calls = 0;
const respond = (content) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const fetchImpl = async (url, init) => {
  calls++;
  assert.ok(url.startsWith("https://ai-gateway.vercel.sh/"));
  const request = JSON.parse(init.body);
  assert.equal(request.model, "moonshotai/kimi-k3");
  assert.equal(request.max_tokens, 32768);
  assert.equal(request.providerOptions.gateway.zeroDataRetention, true);
  assert.ok(JSON.stringify(request.messages).includes(sourcePacket.tasks[0].title));
  return respond(calls === 1 ? spec : { approved: true, findings: [], spec });
};
const prepared = await createProfileNftArtSpec({ sourcePacket, env, fetchImpl });
assert.equal(calls, 2);
assert.equal(prepared.artSpec.creature, "Wyvern");
assert.equal(prepared.artSpec.version, "techno-mordor-v2");
for (const value of ["SecretProject", "work_1", "Private completion evidence", "evidence_refs"]) assert.equal(prepared.prompt.includes(value), false);
assert.equal(Object.hasOwn(prepared.artSpec, "evidence_refs"), false);
assert.ok(prepared.prompt.length > 2000);
for (const [hyperstition, creature_level] of [[1,0],[95,2],[30,8],[100,11]]) {
  assert.equal(validateProfileNftArtSpec({ ...spec, hyperstition, creature_level }).creature_level, creature_level);
}
for (const patch of [{ hyperstition: 101 }, { creature_level: 12 }, { creature_level: "6" }, { colors: ["red","red"] }, { colors: ["cyan","green"] }, { evidence_refs: ["task_other_account"] }, { accountId: "private" }]) {
  assert.throws(() => validateProfileNftArtSpec({ ...spec, ...patch }, sourcePacket));
}
for (const leak of ["SecretProjectZephyr9081726354", "https://private.example/document", "@private_handle", "work_1"]) {
  assert.throws(() => validateProfileNftArtSpec({ ...spec, details: `Render the identifier ${leak} on the creature.` }, sourcePacket));
}
let rejectedCalls = 0;
await assert.rejects(createProfileNftArtSpec({ sourcePacket, env, fetchImpl: async () => respond(++rejectedCalls === 1 ? spec : { approved: false, findings: ["instruction_injection"], spec }) }), { message: "profile_nft_privacy_not_approved" });
let contradictoryCalls = 0;
await assert.rejects(createProfileNftArtSpec({ sourcePacket, env, fetchImpl: async () => respond(++contradictoryCalls === 1 ? spec : { approved: true, findings: ["source_language"], spec }) }), { message: "profile_nft_privacy_not_approved" });
let failoverCalls = 0;
await assert.rejects(privateProfileNftCompletion({ env, body: { messages: [{ role: "user", content: "fixture" }] }, fetchImpl: async () => { failoverCalls++; return new Response("{}", { status: 503 }); } }));
assert.equal(failoverCalls, 1, "ZDR failures must never call Ambient");
assert.throws(() => privateProfileNftCompletion({ env: { AMBIENT_API_KEY: "fixture" }, body: {} }), { message: "profile_nft_zdr_not_configured" });
let imageRequests = 0;
await renderProfileNftImage({ prompt: prepared.prompt, size: "1024x1024", quality: "high", outputFormat: "png", env: { PROFILE_NFT_OPENAI_API_KEY: "fixture-image" }, fetchImpl: async (url, init) => {
  imageRequests++;
  assert.equal(url, "https://api.openai.com/v1/images/generations");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ["model","n","output_format","prompt","quality","size"]);
  assert.equal(body.prompt, renderProfileNftArtPrompt(spec));
  assert.equal(init.body.includes("SecretProject"), false);
  return new Response(JSON.stringify({ data: [{ b64_json: "fixture" }] }));
} });
assert.equal(imageRequests, 1);
let namedReviewCalls = 0;
const reviewedImage = await reviewRenderedProfileNftImage({ imageBase64: "fixture", env, fetchImpl: async (_url, init) => {
  namedReviewCalls++;
  const body = JSON.parse(init.body);
  assert.equal(body.model, "moonshotai/kimi-k3");
  assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
  assert.ok(body.response_format.json_schema.schema.required.includes("title"));
  return respond({ approved: true, privacy_violations: [], art_direction_violations: [], title: "The Folded Circuit" });
} });
assert.equal(namedReviewCalls, 1, "Naming must share the image review call");
assert.equal(reviewedImage.title, "The Folded Circuit");
const unnamedReview = await reviewRenderedProfileNftImage({ imageBase64: "fixture", env, fetchImpl: async () => respond({ approved: true, privacy_violations: [], art_direction_violations: [], title: "Profile Pic NFT" }) });
assert.equal(unnamedReview.title, "", "An invalid name must trigger naming recovery, not discard an approved image");
await assert.rejects(reviewRenderedProfileNftImage({ imageBase64: "fixture", env, fetchImpl: async () => respond({ approved: "true", privacy_violations: [], art_direction_violations: [], title: "The Folded Circuit" }) }));
for (const title of [undefined, "", "ab", "x".repeat(81), "Profile Pic NFT", "Task Node Profile Picture", "Techno Mordor", "Contact @private_handle", "https://private.example/name", "Hidden\nTitle"]) {
  assert.throws(() => validateProfileNftTitle(title), { message: "profile_nft_title_invalid" });
}
const legacyTitle = await generateProfileNftTitle({ artSpec: { ...prepared.artSpec, accountId: "private_account", evidence_refs: ["work_private"], private_source: "private source" }, env, fetchImpl: async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.model, "moonshotai/kimi-k3");
  assert.equal(body.providerOptions.gateway.zeroDataRetention, true);
  for (const privateValue of ["private_account", "work_private", "private source"]) assert.equal(init.body.includes(privateValue), false);
  return respond({ title: "Keeper of the Bent Wing" });
} });
assert.equal(legacyTitle.title, "Keeper of the Bent Wing");
const failure = classifyProfileNftGenerationFailure({ status: 503, message: "SecretProjectZephyr9081726354 api_key=private" });
assert.equal(JSON.stringify(failure).includes("private"), false);
assert.equal(failure.retryable, true);
assert.equal(classifyProfileNftGenerationFailure({ status: 401 }).retryable, false);
const minted = metadataForNft({ title: reviewedImage.title, metadataJson: { art: prepared.artSpec }, imageCid: "fixture" });
assert.equal(minted.name, reviewedImage.title);
assert.equal(minted.attributes.find((trait) => trait.trait_type === "Creature").value, "Wyvern");
assert.equal(minted.art.hyperstition, 74);
console.log(JSON.stringify({ ok: true, checks: ["Kimi K3 pinned", "ZDR request", "no Ambient fallback", "independent axes", "typed schema rejection", "privacy and injection rejection", "OpenAI allowlist", "vision review", "safe errors", "mint traits"] }));
