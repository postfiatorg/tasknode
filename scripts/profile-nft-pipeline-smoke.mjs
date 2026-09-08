import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { databaseEnabled, query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { profileNftGenerateStart } from "../server/profile-nft-generation.js";
import { profileNftTaskSource } from "../server/profile-nft-task-source.js";
import { runProfileNftRenderWorkerOnce } from "../server/profile-nft-render-worker.js";
import { publicProfileNftArtSpec, renderProfileNftArtPrompt } from "../server/profile-nft-art-spec.js";
import { readStoredProfileNftThumbnail } from "../server/profile-nft-thumbnails.js";
import { promptDigest } from "../server/prompt-registry.js";
import { claimProfileNftRenderJob, withProfileNftRenderClaim, completeProfileNftRenderJob, renewProfileNftRenderClaim } from "../server/repositories/profile-nft-render-jobs.js";
import { createGeneratedProfileNft, getProfileNft, getPublicProfileHeroNft, setSelectedProfileNft } from "../server/repositories/profile-nfts.js";
import { listDailyProfileNftCandidates, createDailyProfileNftAward, markDailyProfileNftAwardRunning } from "../server/repositories/profile-nft-daily-awards.js";
import { metadataForNft } from "../server/profile-nft-mint.js";

assert.ok(databaseEnabled(), "Run against an isolated fixture database");
assert.ok(new URL(process.env.DATABASE_URL).pathname.includes("tasknode_nft_"), "Dedicated NFT fixture DB required");
const prefix = `nft_pipeline_${randomUUID()}`;
const ids = ["zero","two","mixed","personal","network","rejected","with_art"].map((name) => `${prefix}_${name}`);
const [zero,two,mixed,personal,network,rejected,withArt] = ids;
const spec = JSON.parse(await readFile(new URL("./profile-nft-art-fixture.json", import.meta.url)));
const prompt = renderProfileNftArtPrompt(spec);
const prepared = { artSpec: publicProfileNftArtSpec(spec), prompt, promptDigest: promptDigest(prompt), templateDigest: "fixture_template" };
try {
  await migrateDatabase();
  for (const [accountId,kinds] of [[two,["personal","personal"]],[mixed,["personal","network","alpha"]],[personal,["personal","personal","personal"]],[network,["network","network","network"]],[rejected,["personal","personal","personal"]],[withArt,["personal","personal","personal"]]]) {
    for (const [i,kind] of kinds.entries()) await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,request_id,status,title,description,task_kind,reward_actual_pft,last_event_at)
      VALUES($1,$2,'','', 'rewarded',$3,'Private canonical task evidence',$4,$5,now())`, [`${accountId}_${i}`,accountId,`${accountId} delivered item ${i}`,kind,accountId===rejected && i===2 ? 0 : 100]);
  }
  await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,request_id,status,title,task_kind,reward_actual_pft,source)
    VALUES($1,$2,'','','rewarded','Fixture must not qualify','personal',100,'directory_polish_local_fixture')`, [`${two}_fixture`,two]);
  const old = await createGeneratedProfileNft({ accountId: withArt, imageCid: "old_selected_art" });
  await setSelectedProfileNft({ accountId: withArt, nftId: old.id });
  const candidates = await listDailyProfileNftCandidates({ limit: 100 });
  assert.deepEqual(candidates.map((row) => row.accountId).filter((id) => ids.includes(id)).sort(), [mixed,personal,network,withArt].sort());
  assert.ok(candidates.findIndex((row) => row.accountId === mixed) < candidates.findIndex((row) => row.accountId === withArt));
  assert.equal(candidates.find((row) => row.accountId === mixed).walletAddress, "");
  assert.equal(candidates.some((row) => row.accountId === zero || row.accountId === rejected), false);
  const source = await profileNftTaskSource({ accountId: mixed });
  assert.equal(source.tasks.length, 3);
  assert.equal(source.metrics.completed_tasks, 3);
  assert.equal(source.metrics.completed_last_7_days, 3);
  assert.equal(Object.hasOwn(source, "accountId"), false);
  assert.equal(JSON.stringify(source).includes(personal), false);
  const award = await createDailyProfileNftAward({ accountId: withArt, personalCompletedCount: 3 });
  await markDailyProfileNftAwardRunning({ awardId: award.id });
  const request = { method: "POST", session: { accountId: withArt }, payload: { nftUserData: "FORGED_HISTORY", contextDocument: "FORGED_PRIVATE_CONTEXT", creature_level: 11 } };
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  let results;
  try {
    globalThis.fetch = async () => { networkCalls++; throw new Error("request_path_must_not_call_provider"); };
    results = await Promise.all([profileNftGenerateStart({ ...request, awardId: award.id }),profileNftGenerateStart(request)]);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(networkCalls, 0);
  assert.ok(results.every((result) => result.status === 202), JSON.stringify(results));
  assert.equal(results[0].body.nft.id, results[1].body.nft.id);
  assert.equal(results.filter((result) => result.body.reused).length, 1);
  const nftId = results[0].body.nft.id;
  assert.equal((await query("SELECT * FROM profile_nft_render_jobs WHERE profile_nft_id=$1", [nftId])).rowCount, 1);
  assert.equal((await query("SELECT status,profile_nft_id FROM profile_nft_daily_awards WHERE id=$1", [award.id])).rows[0].status, "rendering");
  assert.equal((await query("SELECT profile_nft_id FROM profile_nft_daily_awards WHERE id=$1", [award.id])).rows[0].profile_nft_id, nftId);
  let preparations = 0;
  const deps = {
    prepare: async ({ sourcePacket }) => { preparations++; assert.equal(sourcePacket.metrics.completed_tasks, 3); assert.equal(JSON.stringify(sourcePacket).includes("FORGED"), false); return prepared; },
    render: async () => { throw Object.assign(new Error("temporary image outage"), { status: 503 }); },
    review: async () => ({ approved: true, title: "The Folded Circuit", model: "moonshotai/kimi-k3", titlePromptDigest: "title_fixture" }),
    name: async () => { throw new Error("New renders must be named in image review"); },
    pin: async () => ({ cid: "fixture_generated_art", sizeBytes: 32, sha256: "fixture_sha" }),
  };
  const first = await runProfileNftRenderWorkerOnce({ deps });
  assert.equal(first.ok, false);
  const saved = (await query("SELECT * FROM profile_nft_render_jobs WHERE profile_nft_id=$1", [nftId])).rows[0];
  assert.equal(saved.status, "queued");
  assert.equal(saved.art_spec.version, "techno-mordor-v2");
  assert.equal(saved.style_preference, "");
  await query("UPDATE profile_nft_render_jobs SET available_at=now() WHERE id=$1", [saved.id]);
  deps.render = async ({ prompt: received }) => { assert.equal(received,prompt); return { data: [{ b64_json: (await sharp({ create: { width: 512, height: 512, channels: 3, background: "#537449" } }).png().toBuffer()).toString("base64") }] }; };
  assert.equal((await runProfileNftRenderWorkerOnce({ deps })).ok, true);
  assert.equal(preparations, 1, "Retry must reuse the approved spec");
  const nft = await getProfileNft({ accountId: withArt, nftId });
  assert.equal(nft.status, "generated");
  assert.equal(nft.title, "The Folded Circuit");
  assert.equal(metadataForNft(nft).name, nft.title);
  assert.equal(nft.metadataJson.naming.promptDigest, "title_fixture");
  assert.equal(nft.metadataJson.art.creature, "Wyvern");
  const thumbnail = await readStoredProfileNftThumbnail({ cid: nft.imageCid, size: 96, format: "webp" });
  assert.equal(thumbnail.cache, "render_checkpoint");
  assert.equal((await sharp(thumbnail.bytes).metadata()).width, 96);
  assert.equal((await query("SELECT status FROM profile_nft_daily_awards WHERE id=$1", [award.id])).rows[0].status,"generated");
  assert.equal((await getPublicProfileHeroNft({ accountId: withArt })).id, old.id, "Automatic artwork must preserve a chosen PFP");
  // Recover after the durable image checkpoint without changing its name or image.
  await query("UPDATE profile_nft_render_jobs SET status='queued',available_at=now() WHERE id=$1", [saved.id]);
  deps.render = async () => { throw new Error("Checkpoint recovery must not regenerate artwork"); };
  deps.review = async () => { throw new Error("Checkpoint recovery must not rename artwork"); };
  assert.equal((await runProfileNftRenderWorkerOnce({ deps })).ok, true);
  assert.equal((await getProfileNft({ accountId: withArt, nftId })).title, nft.title);
  // A pre-naming image checkpoint can gain a model title without an image call.
  await query("UPDATE profile_nft_render_jobs SET status='queued',attempt_count=0,available_at=now(),render_asset=render_asset-'title' WHERE id=$1", [saved.id]);
  let legacyNames = 0;
  deps.name = async ({ artSpec }) => { legacyNames++; assert.equal(artSpec.creature, "Wyvern"); return { title: "Keeper of the Bent Wing", model: "moonshotai/kimi-k3", titlePromptDigest: "title_fixture" }; };
  assert.equal((await runProfileNftRenderWorkerOnce({ deps })).ok, true);
  assert.equal(legacyNames, 1);
  const namedLegacy = await getProfileNft({ accountId: withArt, nftId });
  assert.equal(namedLegacy.title, "Keeper of the Bent Wing");
  assert.equal(namedLegacy.imageCid, nft.imageCid);
  const next = await profileNftGenerateStart({ method: "POST", session: { accountId: mixed } });
  const workerA = await claimProfileNftRenderJob();
  assert.equal(workerA.profileNftId,next.body.nft.id);
  await query("UPDATE profile_nft_render_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [workerA.id]);
  const workerB = await claimProfileNftRenderJob();
  assert.notEqual(workerA.workerAttemptId,workerB.workerAttemptId);
  assert.equal(await renewProfileNftRenderClaim(workerA),false);
  await assert.rejects(withProfileNftRenderClaim(workerA, () => completeProfileNftRenderJob(workerA)), { code: "profile_nft_render_lease_lost" });
  await withProfileNftRenderClaim(workerB, () => completeProfileNftRenderJob(workerB));
  console.log(JSON.stringify({ ok: true, checks: ["three total tasks", "mixed kinds", "walletless", "rejected and fixture exclusions", "missing art priority", "canonical history", "immediate queue", "concurrent deduplication", "accurate award status", "spec retry reuse", "generated title and mint metadata", "stable checkpoint title", "legacy checkpoint naming without image regeneration", "selected PFP preserved", "stale attempt fenced"] }));
} finally {
  await query("DELETE FROM profile_nft_daily_awards WHERE account_id=ANY($1::text[])",[ids]);
  await query("DELETE FROM profile_nfts WHERE account_id=ANY($1::text[])",[ids]);
  await query("DELETE FROM task_projections WHERE account_id=ANY($1::text[])",[ids]);
  await closePool();
}
