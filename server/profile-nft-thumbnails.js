import sharp from "sharp";
import { databaseEnabled, query } from "./db/pool.js";

export async function createProfileNftThumbnail(bytes) {
  const thumbnail = await sharp(bytes, { animated: false, failOn: "none", limitInputPixels: 64_000_000 })
    .rotate().resize(192,192,{ fit: "cover", position: "centre" }).webp({ quality: 74, effort: 4 }).toBuffer();
  return { size: 192, format: "webp", base64: thumbnail.toString("base64") };
}

// The render worker already has the approved pixels. Saving one small PFP in
// its durable asset checkpoint lets every web machine serve it immediately,
// without waiting behind legacy IPFS downloads or sharing a local filesystem.
export async function readStoredProfileNftThumbnail({ cid, size, format, queryImpl = query } = {}) {
  if (!databaseEnabled()) return null;
  const result = await queryImpl(`SELECT job.render_asset->'thumbnail' AS thumbnail
    FROM profile_nft_render_jobs job JOIN profile_nfts nft ON nft.id=job.profile_nft_id
    WHERE nft.image_cid=$1 AND nft.image_cid<>'' AND nft.status IN ('generated','prepared','minted')
      AND job.render_asset ? 'thumbnail' LIMIT 1`, [cid]);
  const thumbnail = result.rows[0]?.thumbnail;
  if (!thumbnail || thumbnail.format !== "webp" || thumbnail.size !== 192 || typeof thumbnail.base64 !== "string" || thumbnail.base64.length > 100_000) return null;
  const bytes = Buffer.from(thumbnail.base64,"base64");
  if (size === 192 && format === "webp") return { ok: true, cid, size, format, bytes, contentType: "image/webp", cache: "render_checkpoint" };
  const pipeline = sharp(bytes).resize(size,size,{ fit: "cover" });
  const resized = format === "png" ? await pipeline.png().toBuffer() : await pipeline.webp({ quality: 74 }).toBuffer();
  return { ok: true, cid, size, format, bytes: resized, contentType: format === "png" ? "image/png" : "image/webp", cache: "render_checkpoint" };
}
