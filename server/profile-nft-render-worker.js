import { createProfileNftArtSpec, PROFILE_NFT_SPEC_MODEL } from "./profile-nft-art-spec.js";
import { profileNftTaskSource } from "./profile-nft-task-source.js";
import { promptDigest } from "./prompt-registry.js";
import { PROFILE_NFT_ART_VERSION } from "../shared/profile-nft-art.js";
import { createProfileNftThumbnail } from "./profile-nft-thumbnails.js";
import { pinIpfsFile } from "./context-ipfs.js";
import { renderProfileNftImage } from "./profile-nft-image-provider.js";
import { reviewRenderedProfileNftImage } from "./profile-nft-image-review.js";
import { generateProfileNftTitle, validateProfileNftTitle } from "./profile-nft-title.js";
import { classifyProfileNftGenerationFailure } from "./profile-nft-failures.js";
import { completeProfileNftRenderJob, claimProfileNftRenderJob, failProfileNftRenderJob, renewProfileNftRenderClaim, withProfileNftRenderClaim, saveProfileNftArtSpec, saveProfileNftRenderAsset } from "./repositories/profile-nft-render-jobs.js";
import { confirmDailyProfileNftAwardGenerated, failDailyProfileNftAwardForRender } from "./repositories/profile-nft-daily-awards.js";
import { markProfileNftFailed, markProfileNftGenerated } from "./repositories/profile-nfts.js";

let timer = null;
let activeRuns = 0;

export function profileNftRenderConcurrency(env = process.env) {
  const configured = Number(env.TASKNODE_PROFILE_NFT_RENDER_CONCURRENCY || 3);
  return Number.isFinite(configured) ? Math.max(1, Math.min(6, Math.trunc(configured))) : 3;
}

function mimeTypeFor(format = "png") {
  const value = String(format || "png").toLowerCase();
  if (["jpg", "jpeg"].includes(value)) return "image/jpeg";
  if (value === "webp") return "image/webp";
  return "image/png";
}

export async function runProfileNftRenderWorkerOnce({ env = process.env, deps = {} } = {}) {
  const job = await claimProfileNftRenderJob({ staleMinutes: Number(env.PROFILE_NFT_RENDER_STALE_MINUTES || 15) });
  if (!job) return { ok: true, processed: false };
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    renewProfileNftRenderClaim(job).then((owned) => { if (!owned) controller.abort(); }).catch(() => controller.abort());
  }, 30_000);
  heartbeat.unref?.();
  try {
    if (job.artSpec.version !== PROFILE_NFT_ART_VERSION || !job.sanitizedPrompt) {
      const sourcePacket = await (deps.taskSource || profileNftTaskSource)({ accountId: job.accountId, style: job.stylePreference });
      const prepared = await (deps.prepare || createProfileNftArtSpec)({ sourcePacket, env, signal: controller.signal });
      await saveProfileNftArtSpec(job, prepared);
      Object.assign(job, { artSpec: prepared.artSpec, sanitizedPrompt: prepared.prompt, promptDigest: prepared.promptDigest, templateDigest: prepared.templateDigest });
    }
    if (promptDigest(job.sanitizedPrompt) !== job.promptDigest) throw new Error("profile_nft_spec_digest_mismatch");
    let asset = job.renderAsset;
    if (!asset.cid) {
      const rendered = await (deps.render || renderProfileNftImage)({ prompt: job.sanitizedPrompt, model: job.model, size: job.size, quality: job.quality, outputFormat: job.outputFormat, env, signal: controller.signal });
      const imageBase64 = rendered?.data?.[0]?.b64_json || "";
      if (!imageBase64) throw new Error("profile_nft_image_missing");
      const mimeType = mimeTypeFor(job.outputFormat);
      const review = await (deps.review || reviewRenderedProfileNftImage)({ imageBase64, mimeType, sanitizedPrompt: job.sanitizedPrompt, env, signal: controller.signal });
      if (controller.signal.aborted) throw new Error("profile_nft_render_lease_lost");
      const imageBytes = Buffer.from(imageBase64, "base64");
      const thumbnail = await createProfileNftThumbnail(imageBytes);
      const pin = await (deps.pin || pinIpfsFile)({
        bytes: imageBytes, name: `profile_nft_${job.profileNftId}.${job.outputFormat}`,
        mimeType, keyvalues: { type: "profile_nft_image", profileNftId: job.profileNftId }, env,
      });
      asset = { cid: pin.cid, sizeBytes: pin.sizeBytes, sha256: pin.sha256, mimeType, thumbnail,
        title: review.title, titleModel: review.model, titlePromptDigest: review.titlePromptDigest };
      await saveProfileNftRenderAsset(job, asset);
    }
    if (!asset.title) {
      const named = await (deps.name || generateProfileNftTitle)({ artSpec: job.artSpec, env, signal: controller.signal });
      asset = { ...asset, title: validateProfileNftTitle(named.title), titleModel: named.model, titlePromptDigest: named.titlePromptDigest };
      await saveProfileNftRenderAsset(job, asset);
    }
    const title = validateProfileNftTitle(asset.title);
    await withProfileNftRenderClaim(job, async () => {
      await markProfileNftGenerated({
        accountId: job.accountId, nftId: job.profileNftId, imageCid: asset.cid, title,
        imageGatewayUrl: `https://dweb.link/ipfs/${encodeURIComponent(asset.cid)}`,
        imageMimeType: asset.mimeType, imageSizeBytes: asset.sizeBytes, imageSha256: asset.sha256,
        model: job.model, size: job.size, quality: job.quality, outputFormat: job.outputFormat,
        promptSource: PROFILE_NFT_ART_VERSION, promptDigest: job.promptDigest, templateDigest: job.templateDigest,
        metadataJson: { art: job.artSpec, specModel: PROFILE_NFT_SPEC_MODEL, naming: { model: asset.titleModel, promptDigest: asset.titlePromptDigest } },
      });
      await completeProfileNftRenderJob(job);
      await confirmDailyProfileNftAwardGenerated({ profileNftId: job.profileNftId });
    });
    return { ok: true, processed: true, jobId: job.id, profileNftId: job.profileNftId };
  } catch (error) {
    const failure = classifyProfileNftGenerationFailure(error);
    try {
      await withProfileNftRenderClaim(job, async () => {
        await failProfileNftRenderJob({ job, error: failure.message, retryable: failure.retryable });
        if (!failure.retryable || job.attemptCount >= 3) {
          await markProfileNftFailed({ accountId: job.accountId, nftId: job.profileNftId, error: failure.message });
          await failDailyProfileNftAwardForRender({ profileNftId: job.profileNftId, error: failure.message, errorCode: failure.code, retryable: failure.retryable });
        }
      });
    } catch (finalizeError) {
      if (finalizeError.code !== "profile_nft_render_lease_lost") throw finalizeError;
    }
    return { ok: false, processed: true, jobId: job.id, error: failure.code };
  } finally {
    clearInterval(heartbeat);
    controller.abort();
  }
}

export function startProfileNftRenderWorker({
  env = process.env,
  runOnce = runProfileNftRenderWorkerOnce,
} = {}) {
  if (timer || env.TASKNODE_PROFILE_NFT_RENDER_WORKER_ENABLED === "false") return;
  const intervalMs = Math.max(2000, Number(env.TASKNODE_PROFILE_NFT_RENDER_INTERVAL_MS || 5000));
  const concurrency = profileNftRenderConcurrency(env);
  const tick = () => {
    while (activeRuns < concurrency) {
      activeRuns += 1;
      let processed = false;
      Promise.resolve()
        .then(() => runOnce({ env }))
        .then((result) => {
          processed = Boolean(result?.processed);
        })
        .catch(() => console.error("profile_nft_render_worker_failed"))
        .finally(() => {
          activeRuns -= 1;
          if (processed) queueMicrotask(tick);
        });
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { concurrency };
}
