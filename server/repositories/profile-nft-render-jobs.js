import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";

function safeText(value = "", max = 10000) {
  return String(value || "").trim().slice(0, max);
}

function normalized(row = {}) {
  return {
    id: row.id || "",
    profileNftId: row.profile_nft_id || "",
    accountId: row.account_id || "",
    sanitizedPrompt: row.sanitized_prompt || "",
    model: row.model || "",
    size: row.size || "",
    quality: row.quality || "",
    outputFormat: row.output_format || "",
    status: row.status || "",
    attemptCount: Number(row.attempt_count || 0),
  };
}

export async function enqueueProfileNftRenderJob({ profileNftId, sanitizedPrompt, model, size, quality, outputFormat } = {}) {
  if (!databaseEnabled()) throw Object.assign(new Error("profile_nft_render_queue_database_required"), { status: 503 });
  const prompt = safeText(sanitizedPrompt, 8000);
  if (!profileNftId || !prompt) throw Object.assign(new Error("profile_nft_render_job_invalid"), { status: 400 });
  const result = await query(
    `INSERT INTO profile_nft_render_jobs (id, profile_nft_id, sanitized_prompt, model, size, quality, output_format)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (profile_nft_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [`nft_render_${randomUUID()}`, safeText(profileNftId, 160), prompt, safeText(model, 120), safeText(size, 40), safeText(quality, 40), safeText(outputFormat, 40)]
  );
  return normalized(result.rows[0]);
}

export async function claimProfileNftRenderJob({ staleMinutes = 15 } = {}) {
  if (!databaseEnabled()) return null;
  return transaction(async (client) => {
    await client.query(
      `UPDATE profile_nft_render_jobs SET status = 'queued', claimed_at = NULL, updated_at = now()
       WHERE status = 'rendering' AND claimed_at < now() - ($1::text || ' minutes')::interval`,
      [Math.max(1, Number(staleMinutes || 15))]
    );
    const result = await client.query(
      `WITH candidate AS (
         SELECT job.id FROM profile_nft_render_jobs job
         WHERE job.status = 'queued' AND job.available_at <= now()
         ORDER BY job.created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE profile_nft_render_jobs job
       SET status = 'rendering', attempt_count = attempt_count + 1, claimed_at = now(), updated_at = now(), error = ''
       FROM candidate, profile_nfts nft
       WHERE job.id = candidate.id AND nft.id = job.profile_nft_id
       RETURNING job.*, nft.account_id`,
    );
    if (!result.rows[0]) return null;
    await client.query(
      `UPDATE profile_nfts
          SET status = 'generating', error = '', updated_at = now()
        WHERE id = $1
          AND status IN ('generating', 'failed')`,
      [result.rows[0].profile_nft_id]
    );
    return normalized(result.rows[0]);
  });
}

export async function completeProfileNftRenderJob(jobId = "") {
  await query(`UPDATE profile_nft_render_jobs SET status = 'completed', completed_at = now(), updated_at = now(), error = '' WHERE id = $1`, [safeText(jobId, 160)]);
}

export async function failProfileNftRenderJob({ jobId, error, retryable = false, attemptCount = 1 } = {}) {
  const retry = retryable && Number(attemptCount || 1) < 3;
  await query(
    `UPDATE profile_nft_render_jobs SET status = $2, available_at = CASE WHEN $2 = 'queued' THEN now() + interval '2 minutes' ELSE available_at END,
       claimed_at = NULL, error = $3, updated_at = now() WHERE id = $1`,
    [safeText(jobId, 160), retry ? "queued" : "failed", safeText(error, 500)]
  );
}
