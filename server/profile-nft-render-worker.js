import { pinIpfsFile } from "./context-ipfs.js";
import { renderProfileNftImage } from "./profile-nft-image-provider.js";
import { reviewRenderedProfileNftImage } from "./profile-nft-image-review.js";
import { classifyProfileNftGenerationFailure } from "./profile-nft-failures.js";
import { completeProfileNftRenderJob, claimProfileNftRenderJob, failProfileNftRenderJob } from "./repositories/profile-nft-render-jobs.js";
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

export async function runProfileNftRenderWorkerOnce({ env = process.env } = {}) {
  const job = await claimProfileNftRenderJob({ staleMinutes: Number(env.PROFILE_NFT_RENDER_STALE_MINUTES || 15) });
  if (!job) return { ok: true, processed: false };
  try {
    const rendered = await renderProfileNftImage({ prompt: job.sanitizedPrompt, model: job.model, size: job.size, quality: job.quality, outputFormat: job.outputFormat, env });
    const imageBase64 = rendered?.data?.[0]?.b64_json || "";
    if (!imageBase64) throw new Error("profile_nft_image_missing");
    const mimeType = mimeTypeFor(job.outputFormat);
    await reviewRenderedProfileNftImage({ imageBase64, mimeType, sanitizedPrompt: job.sanitizedPrompt, env });
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const pin = await pinIpfsFile({
      bytes: imageBuffer,
      name: `profile_nft_${job.profileNftId}.${mimeType.split("/")[1] || "png"}`,
      mimeType,
      keyvalues: { type: "profile_nft_image", profileNftId: job.profileNftId },
      env,
    });
    await markProfileNftGenerated({
      accountId: job.accountId, nftId: job.profileNftId, imageCid: pin.cid,
      imageGatewayUrl: `https://dweb.link/ipfs/${encodeURIComponent(pin.cid)}`,
      imageMimeType: mimeType, imageSizeBytes: pin.sizeBytes, imageSha256: pin.sha256,
      model: job.model, size: job.size, quality: job.quality, outputFormat: job.outputFormat,
    });
    await completeProfileNftRenderJob(job.id);
    await confirmDailyProfileNftAwardGenerated({ profileNftId: job.profileNftId });
    return { ok: true, processed: true, jobId: job.id, profileNftId: job.profileNftId };
  } catch (error) {
    const failure = classifyProfileNftGenerationFailure(error);
    await failProfileNftRenderJob({ jobId: job.id, error: failure.message, retryable: failure.retryable, attemptCount: job.attemptCount });
    if (!failure.retryable || job.attemptCount >= 3) {
      await markProfileNftFailed({ accountId: job.accountId, nftId: job.profileNftId, error: failure.message });
      await failDailyProfileNftAwardForRender({
        profileNftId: job.profileNftId,
        error: failure.message,
        errorCode: failure.code,
        retryable: failure.retryable,
      });
    }
    return { ok: false, processed: true, jobId: job.id, error: failure.code };
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
        .catch((error) => console.error("profile nft render worker failed", error?.message || error))
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
