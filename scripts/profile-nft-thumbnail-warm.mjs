import { closePool, databaseEnabled, query } from "../server/db/pool.js";
import { fetchProfileNftPfpThumbnail, normalizeThumbnailSize } from "../server/profile-nft-image-proxy.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback, { min = 1, max = 1000 } = {}) {
  const value = Number(argValue(name, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sizeArgs() {
  const raw = argValue("--sizes", "48,96,192");
  return [...new Set(String(raw || "")
    .split(",")
    .map((item) => normalizeThumbnailSize(item))
    .filter(Boolean))];
}

function usage() {
  return [
    "Usage: node scripts/profile-nft-thumbnail-warm.mjs [options]",
    "",
    "Options:",
    "  --execute             Generate thumbnails. Default is dry-run.",
    "  --limit <n>           Max image CIDs to scan. Default: 100.",
    "  --sizes <csv>         Thumbnail sizes. Default: 48,96,192.",
    "  --concurrency <n>     Concurrent thumbnail generations. Default: 1.",
    "",
    "The script is idempotent: existing durable cache files are reused.",
    "Run it on the app machine so thumbnails are written to the mounted /data cache.",
  ].join("\n");
}

async function profileNftImageCids({ limit }) {
  if (!databaseEnabled()) throw new Error("database_not_configured");
  const result = await query(
    `
      SELECT image_cid,
             bool_or(selected) AS selected,
             bool_or(status = 'minted') AS minted,
             max(created_at) AS newest_created_at,
             count(*)::int AS refs
      FROM profile_nfts
      WHERE image_cid <> ''
      GROUP BY image_cid
      ORDER BY bool_or(selected) DESC,
               bool_or(status = 'minted') DESC,
               max(created_at) DESC,
               image_cid ASC
      LIMIT $1
    `,
    [limit]
  );
  return result.rows.map((row) => ({
    cid: row.image_cid,
    selected: Boolean(row.selected),
    minted: Boolean(row.minted),
    refs: Number(row.refs || 0),
    newestCreatedAt: row.newest_created_at ? new Date(row.newest_created_at).toISOString() : null,
  }));
}

async function runBounded(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      results.push(await worker(item));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const execute = hasArg("--execute");
  const limit = numberArg("--limit", 100, { min: 1, max: 1000 });
  const sizes = sizeArgs();
  const concurrency = numberArg("--concurrency", 1, { min: 1, max: 4 });
  process.env.TASKNODE_PROFILE_NFT_THUMBNAIL_GENERATION_CONCURRENCY = String(concurrency);
  const cids = await profileNftImageCids({ limit });
  const jobs = cids.flatMap((record) => sizes.map((size) => ({ ...record, size })));

  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      cidCount: cids.length,
      thumbnailCount: jobs.length,
      sizes,
      sample: cids.slice(0, 10),
    }, null, 2));
    return;
  }

  const startedAt = Date.now();
  let generated = 0;
  let reused = 0;
  const failures = [];
  await runBounded(jobs, concurrency, async (job) => {
    const result = await fetchProfileNftPfpThumbnail({ cid: job.cid, size: job.size });
    if (!result.ok) {
      failures.push({ cid: job.cid, size: job.size, error: result.error || "thumbnail_failed" });
      return result;
    }
    if (result.cache === "disk") reused += 1;
    else generated += 1;
    return result;
  });

  console.log(JSON.stringify({
    ok: failures.length === 0,
    dryRun: false,
    cidCount: cids.length,
    thumbnailCount: jobs.length,
    generated,
    reused,
    failed: failures.length,
    failures: failures.slice(0, 20),
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
