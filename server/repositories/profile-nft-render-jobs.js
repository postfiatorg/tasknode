import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transactionCommand } from "../db/pool.js";

function normalized(row = {}) {
  return {
    id: row.id, profileNftId: row.profile_nft_id, accountId: row.account_id,
    sanitizedPrompt: row.sanitized_prompt || "", artSpec: row.art_spec || {},
    stylePreference: row.style_preference || "", promptDigest: row.prompt_digest || "", templateDigest: row.template_digest || "",
    renderAsset: row.render_asset || {}, workerAttemptId: row.worker_attempt_id,
    model: row.model, size: row.size, quality: row.quality, outputFormat: row.output_format,
    status: row.status, attemptCount: Number(row.attempt_count || 0),
  };
}

export async function enqueueProfileNftRenderJob({ profileNftId, stylePreference = "", model, size, quality, outputFormat } = {}) {
  if (!profileNftId) throw new Error("profile_nft_render_job_invalid");
  const result = await query(`INSERT INTO profile_nft_render_jobs
    (id,profile_nft_id,sanitized_prompt,style_preference,model,size,quality,output_format)
    VALUES ($1,$2,'',$3,$4,$5,$6,$7) ON CONFLICT (profile_nft_id) DO UPDATE SET updated_at=now() RETURNING *`,
  [`nft_render_${randomUUID()}`, profileNftId, String(stylePreference).slice(0,1200), model, size, quality, outputFormat]);
  return normalized(result.rows[0]);
}

export async function claimProfileNftRenderJob({ staleMinutes = 15 } = {}) {
  if (!databaseEnabled()) return null;
  const minutes = Math.max(5, Math.min(60, Number(staleMinutes) || 15));
  return transactionCommand(async (client) => {
    await client.query(`UPDATE profile_nft_render_jobs SET status='queued',worker_attempt_id='',claimed_at=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE status='rendering' AND COALESCE(lease_expires_at,claimed_at+interval '15 minutes') < now()`);
    const result = await client.query(`WITH candidate AS (
      SELECT job.id FROM profile_nft_render_jobs job WHERE status='queued' AND available_at<=now()
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE profile_nft_render_jobs job SET status='rendering',attempt_count=attempt_count+1,
      worker_attempt_id=$1,lease_expires_at=now()+($2 * interval '1 minute'),claimed_at=now(),updated_at=now(),error=''
      FROM candidate,profile_nfts nft WHERE job.id=candidate.id AND nft.id=job.profile_nft_id RETURNING job.*,nft.account_id`, [randomUUID(), minutes]);
    if (!result.rows[0]) return null;
    await client.query("UPDATE profile_nfts SET status='generating',error='',updated_at=now() WHERE id=$1 AND status IN ('generating','failed')", [result.rows[0].profile_nft_id]);
    return normalized(result.rows[0]);
  });
}

export async function renewProfileNftRenderClaim(job) {
  const result = await query(`UPDATE profile_nft_render_jobs SET lease_expires_at=now()+interval '15 minutes',updated_at=now()
    WHERE id=$1 AND worker_attempt_id=$2 AND status='rendering' AND lease_expires_at>now() RETURNING id`, [job.id,job.workerAttemptId]);
  return Boolean(result.rowCount);
}

export function withProfileNftRenderClaim(job, work) {
  return transactionCommand(async (client) => {
    const owned = await client.query(`SELECT id FROM profile_nft_render_jobs
      WHERE id=$1 AND worker_attempt_id=$2 AND status='rendering' AND lease_expires_at>now() FOR UPDATE`, [job.id,job.workerAttemptId]);
    if (!owned.rowCount) throw Object.assign(new Error("profile_nft_render_lease_lost"), { code: "profile_nft_render_lease_lost" });
    return work(client);
  });
}

export function saveProfileNftArtSpec(job, prepared) {
  return withProfileNftRenderClaim(job, (client) => client.query(`UPDATE profile_nft_render_jobs
    SET sanitized_prompt=$2,art_spec=$3::jsonb,prompt_digest=$4,template_digest=$5,style_preference='',updated_at=now() WHERE id=$1`,
  [job.id,prepared.prompt,JSON.stringify(prepared.artSpec),prepared.promptDigest,prepared.templateDigest]));
}

export function saveProfileNftRenderAsset(job, asset) {
  return withProfileNftRenderClaim(job, (client) => client.query("UPDATE profile_nft_render_jobs SET render_asset=$2::jsonb,updated_at=now() WHERE id=$1", [job.id,JSON.stringify(asset)]));
}

// Caller holds withProfileNftRenderClaim across both NFT and job publication.
export async function completeProfileNftRenderJob(job) {
  await query(`UPDATE profile_nft_render_jobs SET status='completed',completed_at=now(),lease_expires_at=NULL,error='',updated_at=now()
    WHERE id=$1 AND worker_attempt_id=$2 AND status='rendering'`, [job.id,job.workerAttemptId]);
}

export async function failProfileNftRenderJob({ job, error, retryable = false } = {}) {
  const retry = retryable && job.attemptCount < 3;
  await query(`UPDATE profile_nft_render_jobs SET status=$3,available_at=CASE WHEN $3='queued' THEN now()+interval '2 minutes' ELSE available_at END,
    lease_expires_at=NULL,claimed_at=NULL,error=$4,updated_at=now() WHERE id=$1 AND worker_attempt_id=$2 AND status='rendering'`,
  [job.id,job.workerAttemptId,retry ? "queued" : "failed",error]);
}
