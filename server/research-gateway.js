import { researchLedgerAmount } from "./research-billing.js";
import { randomUUID } from "node:crypto";
import { query } from "./db/pool.js";
import { callResearchService } from "./research-provider.js";
import { getResearchJob, reserveResearchJob, settleResearchJob } from "./repositories/research-gateway.js";
import { validatorError } from "./validator-identity.js";

export function publicResearchJob(row) {
  return { job_id: row.id, status: row.status, created_at: row.created_at, updated_at: row.updated_at,
    usage: row.cost_usd === null ? null : { total_cost_usd: Number(row.cost_usd) },
    billing: row.billed_at ? { amount_usd: researchLedgerAmount(Number(row.cost_usd)), rounding: "up_to_usd_microdollar" } : null, error: row.last_error || null };
}

export async function refreshResearchJob(row, call = callResearchService) {
  if (row.billed_at) return row;
  if (!row.upstream_id) {
    const submitted = await call({ method: "POST", path: "/v1/research", accountId: row.account_id, payload: row.request_json });
    if (typeof submitted.job_id !== "string" || !submitted.job_id || !["queued", "running", "completed", "failed"].includes(submitted.status)) {
      throw validatorError("research_service_response_invalid", 502);
    }
    row = (await query(`UPDATE research_gateway_jobs SET upstream_id=$2,status=$3,updated_at=now(),last_error=NULL
      WHERE id=$1 AND upstream_id IS NULL RETURNING *`, [row.id, submitted.job_id, submitted.status])).rows[0]
      || await getResearchJob(row.account_id, row.id);
  }
  const path = `/v1/research/${encodeURIComponent(row.upstream_id)}`;
  const upstream = await call({ path, accountId: row.account_id });
  if (upstream.job_id !== row.upstream_id || !["queued", "running", "completed", "failed"].includes(upstream.status)) throw validatorError("research_service_response_invalid", 502);
  if (["completed", "failed"].includes(upstream.status)) {
    const result = upstream.status === "completed" ? await call({ path: `${path}/result`, accountId: row.account_id }) : null;
    if (result && (result.job_id !== upstream.job_id || result.usage?.total_cost_usd !== upstream.usage?.total_cost_usd || typeof result.markdown !== "string")) {
      throw validatorError("research_result_invalid", 502);
    }
    return settleResearchJob(row.id, upstream, result);
  }
  return (await query(`UPDATE research_gateway_jobs SET status=$2,updated_at=now(),last_error=NULL WHERE id=$1 AND billed_at IS NULL RETURNING *`, [row.id, upstream.status])).rows[0]
    || await getResearchJob(row.account_id, row.id);
}

export async function submitResearchJob(identity, payload, requestKey, call) {
  const row = await reserveResearchJob({ ...identity, question: payload.question, maxCostUsd: payload.max_cost_usd,
    requestKey: requestKey || payload.request_id || randomUUID() });
  try { return await refreshResearchJob(row, call); }
  catch (error) {
    // A durable request_id lets the worker recover an ambiguous upstream timeout
    // without creating a second provider job or charging the account twice.
    if (!row.upstream_id && [400, 413, 422].includes(error.status)) {
      await query(`UPDATE research_gateway_jobs SET status='failed',cost_usd=0,billed_at=now(),last_error=$2,updated_at=now()
        WHERE id=$1 AND upstream_id IS NULL AND billed_at IS NULL`, [row.id, error.message]);
      throw error;
    }
    await query(`UPDATE research_gateway_jobs SET last_error=$2,updated_at=now() WHERE id=$1 AND billed_at IS NULL`, [row.id, error.status ? error.message : "research_service_unavailable"]);
    return getResearchJob(row.account_id, row.id);
  }
}

export async function reconcileResearchJobs() {
  const rows = (await query(`SELECT * FROM research_gateway_jobs WHERE billed_at IS NULL
    AND status IN ('submitting','queued','running','completed','failed') ORDER BY updated_at LIMIT 10`)).rows;
  for (const row of rows) {
    try { await refreshResearchJob(row); }
    catch (error) {
      await query(`UPDATE research_gateway_jobs SET last_error=$2,updated_at=now() WHERE id=$1 AND billed_at IS NULL`,
        [row.id, error.status ? error.message : "research_service_unavailable"]);
    }
  }
  return { checked: rows.length };
}
