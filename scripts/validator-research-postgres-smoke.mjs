import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeNodePublic } from "ripple-address-codec";
import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { bindValidator, hasValidatorBinding, issueValidatorChallenge, revokeValidatorBinding } from "../server/repositories/validator-bindings.js";
import { authenticateResearchKey, createResearchKey, getResearchJob, listResearchKeys, reserveResearchJob, revokeResearchKey, settleResearchJob } from "../server/repositories/research-gateway.js";
import { issueCode, issueViewerToken, upsertIndex } from "../server/repositories/index-viewer.js";
import { handleIndexViewerRoute } from "../server/index-viewer-routes.js";
import { runValidatorRewards } from "../server/validator-rewards.js";
import { submitResearchJob, refreshResearchJob } from "../server/research-gateway.js";
import { networkBadgeProjectionForAccount, publicNetworkBadgesForAccount } from "../server/repositories/network-badges.js";
import { deleteAccountDatabaseData } from "../server/account-deletion-db.js";
import { usageSummary } from "../server/repositories/chat-billing-read.js";

const accountId = `trackc_smoke_${randomUUID()}`;
const otherAccount = `${accountId}_other`;
const archiveId = `${accountId}_archive`;
const indexId = `trackc_index_${randomUUID()}`;
const keypair = deriveKeypair(generateSeed({ algorithm: "ed25519" }));
const masterPublicKey = encodeNodePublic(Buffer.from(keypair.publicKey, "hex"));
const signatureFor = (challenge) => sign(Buffer.from(challenge).toString("hex"), keypair.privateKey);
const lookup = async () => ({ network: "devnet" });
const origin = "https://tasknode.postfiat.org";
async function viewerRoute(path, { method = "POST", payload = {}, token = "", requestOrigin = origin, account = accountId } = {}) {
  let status;
  let body;
  const res = { writeHead: (code) => { status = code; }, end: () => {} };
  await handleIndexViewerRoute({ json: (_res, code, value) => { status = code; body = value; }, readJson: async () => payload,
    req: { method, headers: { ...(requestOrigin ? { origin: requestOrigin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    res, session: account ? { accountId: account } : null, url: new URL(path, origin) });
  return { status, body };
}
try {
  await migrateDatabase();
  await assert.rejects(createResearchKey(otherAccount), /validator_required/);
  const challenge = await issueValidatorChallenge(accountId);
  const payload = { accountId, masterPublicKey, challenge: challenge.challenge, signature: signatureFor(challenge.challenge) };
  await assert.rejects(bindValidator({ ...payload, signature: "0".repeat(128) }, { lookup }), /signature_invalid/);
  await assert.rejects(bindValidator({ ...payload, accountId: otherAccount }, { lookup }), /challenge_invalid/);
  const binding = await bindValidator(payload, { lookup });
  assert.equal(await hasValidatorBinding(accountId), true);
  assert.ok((await publicNetworkBadgesForAccount({ accountId })).badges.some((badge) => badge.badgeId === "validator"));
  assert.ok(!(await networkBadgeProjectionForAccount({ accountId })).verifiedBadgeIds.includes("validator"), "validator membership must not change task-routing eligibility");
  await assert.rejects(bindValidator(payload, { lookup }), /challenge_invalid/);
  const second = await issueValidatorChallenge(otherAccount);
  await assert.rejects(bindValidator({ ...payload, accountId: otherAccount, challenge: second.challenge, signature: signatureFor(second.challenge) }, { lookup }), /already_bound/);
  const expired = await issueValidatorChallenge(accountId);
  await query(`UPDATE validator_challenges SET expires_at=now()-interval '1 second' WHERE challenge=$1`, [expired.challenge]);
  await assert.rejects(bindValidator({ ...payload, challenge: expired.challenge, signature: signatureFor(expired.challenge) }, { lookup }), /challenge_invalid/);

  await upsertIndex({ indexId, tier: "validator", contentKey: randomBytes(32).toString("base64") });
  assert.equal((await viewerRoute(`/index-auth/start?index_id=${indexId}&return_to=https://attacker.example/`, { method: "GET" })).status, 400);
  const { code } = await issueCode({ indexId, accountId, returnOrigin: origin });
  const exchange = { payload: { index_id: indexId, code } };
  assert.equal((await viewerRoute("/api/index-viewer/exchange", { ...exchange, requestOrigin: "" })).status, 403);
  assert.equal((await viewerRoute("/api/index-viewer/exchange", { ...exchange, requestOrigin: "https://evil.example" })).status, 403);
  assert.equal((await viewerRoute("/api/index-viewer/exchange", { ...exchange, requestOrigin: "https://agti.net" })).status, 403, "even another allowlisted origin cannot redeem it");
  const good = await viewerRoute("/api/index-viewer/exchange", exchange);
  assert.equal(good.status, 200);
  assert.equal((await viewerRoute("/api/index-viewer/exchange", exchange)).status, 403);
  const token = good.body.viewer_token;
  assert.equal((await viewerRoute(`/api/index-viewer/indices/${indexId}/unlock`, { token })).status, 200);
  assert.equal((await viewerRoute(`/api/index-viewer/indices/${indexId}/unlock`, { token, requestOrigin: "https://agti.net" })).status, 403);
  assert.equal((await viewerRoute(`/api/index-viewer/indices/${indexId}/unlock`, { account: "" })).status, 403);
  const outsiderToken = await issueViewerToken({ indexId, accountId: otherAccount, returnOrigin: origin });
  assert.equal((await viewerRoute(`/api/index-viewer/indices/${indexId}/unlock`, { token: outsiderToken.token })).status, 403);

  const created = await createResearchKey(accountId, "Fixture");
  assert.equal(created.key.startsWith("tnr_"), true);
  assert.equal((await authenticateResearchKey(created.key)).accountId, accountId);
  assert.ok(!JSON.stringify(await listResearchKeys(accountId)).includes(created.key));
  assert.equal((await query(`SELECT key_hash FROM research_api_keys WHERE id=$1`, [created.id])).rows[0].key_hash.length, 64);
  const identity = { accountId, apiKeyId: created.id };
  await assert.rejects(reserveResearchJob({ ...identity, question: "Question", requestKey: "no-credit" }), /credit_required/);
  await query(`INSERT INTO billing_accounts(account_id,current_credit_usd) VALUES($1,0.49) ON CONFLICT(account_id) DO UPDATE SET current_credit_usd=0.49`, [accountId]);
  await assert.rejects(reserveResearchJob({ ...identity, question: "Question", requestKey: "low-credit" }), /credit_required/);
  await query(`UPDATE billing_accounts SET current_credit_usd=1 WHERE account_id=$1`, [accountId]);
  const admitted = await Promise.allSettled(["concurrent-one", "concurrent-two"].map((requestKey) => reserveResearchJob({ ...identity, question: "Q", maxCostUsd: 1, requestKey })));
  assert.equal(admitted.filter((row) => row.status === "fulfilled").length, 1, "concurrent jobs cannot oversubscribe available credit");
  await query(`UPDATE research_gateway_jobs SET status='failed',billed_at=now(),cost_usd=0 WHERE account_id=$1`, [accountId]);
  await query(`UPDATE billing_accounts SET current_credit_usd=10 WHERE account_id=$1`, [accountId]);
  const fake = async ({ method, path, payload }) => method === "POST" ? { job_id: `upstream-${payload.request_id}`, status: "queued" }
    : { job_id: path.split("/")[3], status: "completed", usage: { total_cost_usd: 0.123456789 }, ...(path.endsWith("/result") ? { markdown: "Answer with evidence.", sources: [] } : {}) };
  const job = await submitResearchJob(identity, { question: "What changed?", max_cost_usd: 1 }, "integration-job", fake);
  assert.equal(job.status, "completed");
  assert.equal(Number(job.cost_usd), 0.123456789, "exact provider cost is retained on the job");
  assert.equal((await query(`SELECT amount_usd FROM billing_ledger_entries WHERE idempotency_key=$1`, [`research-job:${job.id}`])).rows[0].amount_usd, "0.123457", "ledger rounds up once to six decimals");
  await Promise.all(Array.from({ length: 5 }, () => refreshResearchJob(job, fake)));
  const replay = await submitResearchJob(identity, { question: "What changed?", max_cost_usd: 1 }, "integration-job", fake);
  assert.equal(replay.id, job.id);
  await assert.rejects(submitResearchJob(identity, { question: "Different?", max_cost_usd: 1 }, "integration-job", fake), /request_conflict/);
  await assert.rejects(getResearchJob(otherAccount, job.id), /not_found/);
  assert.equal((await query(`SELECT count(*)::int n FROM billing_ledger_entries WHERE idempotency_key=$1`, [`research-job:${job.id}`])).rows[0].n, 1);
  assert.equal((await usageSummary({ accountId })).currentSpendUsd, 0.123457);
  const failed = await reserveResearchJob({ ...identity, question: "Failed provider question", maxCostUsd: 1, requestKey: "failed-job" });
  await query(`UPDATE research_gateway_jobs SET upstream_id='failed-upstream' WHERE id=$1`, [failed.id]);
  await Promise.all(Array.from({ length: 8 }, () => settleResearchJob(failed.id, { job_id: "failed-upstream", status: "failed", usage: { total_cost_usd: 0.01 } })));
  assert.equal((await usageSummary({ accountId })).currentSpendUsd, 0.133457);
  await assert.rejects(settleResearchJob(failed.id, { job_id: "failed-upstream", status: "failed", usage: { total_cost_usd: 0.02 } }), /cost_changed/);
  await assert.rejects(settleResearchJob(failed.id, { job_id: "failed-upstream", status: "failed", usage: { total_cost_usd: -1 } }), /cost_invalid/);
  await revokeResearchKey(accountId, created.id);
  await assert.rejects(authenticateResearchKey(created.key), /key_invalid/);

  const rewardsDeps = { lookup, reports: async () => Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.parse("2026-10-01") - (i + 1) * 86400000).toISOString(), score: 0.99 })) };
  const dry = await runValidatorRewards({ month: "2026-10", accountId }, rewardsDeps);
  assert.equal(dry.report[0].eligible, true);
  assert.equal(dry.granted, 0);
  process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED = "true";
  const grants = await Promise.all(Array.from({ length: 6 }, () => runValidatorRewards({ month: "2026-10", accountId, dryRun: false }, rewardsDeps)));
  assert.equal(grants.reduce((sum, item) => sum + item.granted, 0), 1, "concurrent reward workers grant once");
  const again = await runValidatorRewards({ month: "2026-10", accountId, dryRun: false }, rewardsDeps);
  assert.equal(again.granted, 0);
  assert.equal((await query(`SELECT amount_usd FROM billing_ledger_entries WHERE idempotency_key=$1`, [`validator-reward:${masterPublicKey}:2026-10`])).rows[0].amount_usd, "20.000000");
  assert.equal((await usageSummary({ accountId })).currentCreditUsd, 30);
  const keyBeforeUnbind = await createResearchKey(accountId);
  await revokeValidatorBinding(accountId, binding.id);
  assert.equal(await hasValidatorBinding(accountId), false);
  assert.equal((await viewerRoute(`/api/index-viewer/indices/${indexId}/unlock`, { token })).status, 403);
  await assert.rejects(authenticateResearchKey(keyBeforeUnbind.key), /key_invalid/);
  await deleteAccountDatabaseData({ accountId, archiveId, account: { id: accountId } });
  assert.equal((await query(`SELECT account_id FROM validator_reward_grants WHERE master_public_key=$1`, [masterPublicKey])).rows[0].account_id, archiveId);
  const rebound = await issueValidatorChallenge(otherAccount);
  await bindValidator({ accountId: otherAccount, masterPublicKey, challenge: rebound.challenge, signature: signatureFor(rebound.challenge) }, { lookup });
  const afterDeletion = await runValidatorRewards({ month: "2026-10", accountId: otherAccount, dryRun: false }, rewardsDeps);
  assert.equal(afterDeletion.granted, 0, "account deletion/rebinding cannot collect the reward twice");
  assert.equal((await query(`SELECT count(*)::int n FROM billing_ledger_entries WHERE idempotency_key=$1`, [`validator-reward:${masterPublicKey}:2026-10`])).rows[0].n, 1);
  console.log("validator-research-postgres-smoke ok: expiry/replay/ownership, 403 origin matrix, hashed scoped keys, concurrent reservations, exact and once-only billing including failures, reward eligibility and concurrency, unbind revocation");
} finally {
  for (const table of ["research_gateway_jobs", "research_api_keys", "validator_reward_grants", "billing_ledger_entries", "billing_accounts", "validator_bindings", "validator_challenges", "index_viewer_codes", "index_viewer_tokens"]) {
    await query(`DELETE FROM ${table} WHERE account_id IN ($1,$2,$3)`, [accountId, otherAccount, archiveId]).catch(() => {});
  }
  await query(`DELETE FROM index_viewer_indices WHERE index_id=$1`, [indexId]).catch(() => {});
  await closePool();
}
