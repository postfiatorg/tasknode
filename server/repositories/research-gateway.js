import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "../db/pool.js";
import { hasValidatorBinding } from "./validator-bindings.js";
import { validatorError } from "../validator-identity.js";
import { researchLedgerAmount } from "../research-billing.js";
import { insertLedgerEntry } from "./chat-billing.js";
import { researchMode, researchProgress, newerResearchProgress } from "../../shared/research-agent.js";

export const hashResearchKey = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export async function createResearchKey(accountId, name = "") {
  if (!(await hasValidatorBinding(accountId))) throw validatorError("validator_required", 403);
  const key = `tnr_${randomBytes(32).toString("base64url")}`;
  const result = await query(`INSERT INTO research_api_keys(id,account_id,key_hash,key_prefix,name,scope)
    VALUES($1,$2,$3,$4,$5,'research:run') RETURNING id,key_prefix,name,scope,created_at`,
  [`rk_${randomUUID()}`, accountId, hashResearchKey(key), key.slice(0, 12), String(name).slice(0, 80)]);
  return { ...result.rows[0], key };
}

export async function listResearchKeys(accountId) {
  return (await query(`SELECT id,key_prefix,name,scope,created_at,last_used_at,revoked_at FROM research_api_keys
    WHERE account_id=$1 ORDER BY created_at DESC`, [accountId])).rows;
}

export async function revokeResearchKey(accountId, id) {
  return (await query(`UPDATE research_api_keys SET revoked_at=now() WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [accountId, id])).rowCount > 0;
}

export async function authenticateResearchKey(key) {
  if (typeof key !== "string" || !key.startsWith("tnr_") || key.length !== 47) throw validatorError("research_key_invalid", 401);
  const result = await query(`UPDATE research_api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL
    AND scope='research:run' AND EXISTS(SELECT 1 FROM validator_bindings b WHERE b.account_id=research_api_keys.account_id AND b.revoked_at IS NULL)
    RETURNING id,account_id`, [hashResearchKey(key)]);
  if (!result.rowCount) throw validatorError("research_key_invalid", 401);
  return { accountId: result.rows[0].account_id, apiKeyId: result.rows[0].id };
}

export async function reserveResearchJob({ accountId, apiKeyId = null, question, maxCostUsd, requestKey, mode, routeToken, resolvedMode }) {
  if (typeof question !== "string" || !question.trim() || question.length > 16000) throw validatorError("research_question_invalid");
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0.05 || maxCostUsd > 10)) throw validatorError("research_budget_invalid");
  const selectedMode = researchMode(mode);
  const effectiveMode = resolvedMode === undefined ? selectedMode : researchMode(resolvedMode);
  if (routeToken !== undefined && (typeof routeToken !== "string" || !routeToken || routeToken.length > 8192)) throw validatorError("research_route_token_invalid");
  if (typeof requestKey !== "string" || !requestKey || requestKey.length > 180) throw validatorError("research_request_key_invalid");
  // Preserve legacy hashes; expiring preview text never changes a request's identity.
  const requestHash = hashResearchKey(JSON.stringify({ question, maxCostUsd: maxCostUsd ?? null, ...(mode === undefined ? {} : { mode: selectedMode }) }));
  return transaction(async (client) => {
    // Serialize admission against ledger projection updates and other research reservations.
    await client.query(`INSERT INTO billing_accounts(account_id) VALUES($1) ON CONFLICT DO NOTHING`, [accountId]);
    const balance = (await client.query(`SELECT current_credit_usd-current_spend_usd AS available FROM billing_accounts WHERE account_id=$1 FOR UPDATE`, [accountId])).rows[0];
    const previous = (await client.query(`SELECT * FROM research_gateway_jobs WHERE account_id=$1 AND request_key=$2`, [accountId, requestKey])).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash) throw validatorError("research_request_conflict", 409);
      return previous;
    }
    const reserved = (await client.query(`SELECT COALESCE(SUM((request_json->>'max_cost_usd')::numeric),0) AS amount FROM research_gateway_jobs
      WHERE account_id=$1 AND status IN ('submitting','queued','running') AND billed_at IS NULL`, [accountId])).rows[0];
    const available = Number(balance.available) - Number(reserved.amount);
    if (available < 0.5) throw validatorError("research_credit_required", 402);
    const budget = maxCostUsd ?? Math.min(effectiveMode === "agent" ? 3 : 1.5, Math.floor(available * 1e12) / 1e12);
    if (budget > available) throw validatorError("research_budget_exceeds_credit", 402);
    const id = `rj_${randomUUID()}`;
    return (await client.query(`INSERT INTO research_gateway_jobs(id,account_id,api_key_id,request_key,request_hash,request_json)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [id, accountId, apiKeyId, requestKey, requestHash, JSON.stringify({ question, max_cost_usd: budget, request_id: id, mode: effectiveMode,
      ...(routeToken ? { route_token: routeToken } : {}) })])).rows[0];
  });
}

export async function getResearchJob(accountId, id) {
  const row = (await query(`SELECT * FROM research_gateway_jobs WHERE account_id=$1 AND id=$2`, [accountId, id])).rows[0];
  if (!row) throw validatorError("research_job_not_found", 404);
  return row;
}

export async function storeResearchProgress(id, upstream) {
  const next = researchProgress(upstream.progress);
  return transaction(async client => {
    const row = (await client.query("SELECT * FROM research_gateway_jobs WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (row.billed_at) return row;
    const previous = row.progress_json || {};
    const progress = newerResearchProgress(previous, next);
    if (upstream.mode !== undefined && !["fast", "agent"].includes(upstream.mode)) throw validatorError("research_mode_response_invalid", 502);
    const mode = upstream.mode === undefined ? row.request_json.mode : upstream.mode;
    if (progress === previous && previous.sequence !== undefined) return row;
    return (await client.query(`UPDATE research_gateway_jobs SET status=$2,progress_json=$3::jsonb,
      request_json=request_json || $4::jsonb,updated_at=now(),last_error=NULL WHERE id=$1 RETURNING *`,
    [id, upstream.status, JSON.stringify(progress), JSON.stringify(mode ? { resolved_mode: mode } : {})])).rows[0];
  });
}

export async function settleResearchJob(id, upstream, result = null) {
  const cost = upstream?.usage?.total_cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || !["completed", "failed"].includes(upstream.status)) {
    throw validatorError("research_cost_invalid", 502);
  }
  const ledgerAmount = researchLedgerAmount(cost);
  return transaction(async (client) => {
    const row = (await client.query(`SELECT * FROM research_gateway_jobs WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!row || row.upstream_id !== upstream.job_id) throw validatorError("research_job_mismatch", 502);
    if (row.billed_at) {
      if (Number(row.cost_usd) !== cost) throw validatorError("research_cost_changed", 502);
      return row;
    }
    if (cost < (row.progress_json?.cost_usd || 0)) throw validatorError("research_cost_regressed", 502);
    await insertLedgerEntry(client, { kind: "chat_debit", accountId: row.account_id, amountUsd: ledgerAmount,
      source: "validator_research", note: "GoodAlexander research at provider cost", uniqueKey: `research-job:${id}`,
      onConflictUnique: true, providerCostUsd: ledgerAmount, costSource: "provider_cost_ceil_6dp", responseId: row.upstream_id,
      metadata: { researchJobId: id, upstreamJobId: row.upstream_id, rounding: "up_to_usd_microdollar" } });
    const latest = newerResearchProgress(row.progress_json || {}, researchProgress(upstream.progress));
    const progress = latest.sequence === undefined ? latest : { ...latest, stage: upstream.status, cost_usd: cost };
    return (await client.query(`UPDATE research_gateway_jobs SET status=$2,cost_usd=$3,billed_at=now(),result_json=$4::jsonb,
      last_error=$5,progress_json=$6::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
    [id, upstream.status, cost, result ? JSON.stringify(result) : null,
      upstream.status === "failed" ? typeof upstream.error === "string" ? upstream.error.slice(0, 1000) : "research_job_failed" : null, JSON.stringify(progress)])).rows[0];
  });
}
