import { databaseEnabled, transaction } from "./db/pool.js";
import { audit, fail, lockedCase, personalStatus, resolveCase } from "./reinstatement.js";

const operatorPrefix = "/api/operator/blacklist";
async function operator(client, account) {
  const row = (await client.query("SELECT enrollment FROM reinstatement_operators WHERE account_id=$1 FOR SHARE", [account])).rows[0];
  if (!row) fail(403, "Reinstatement operator access required");
  return row.enrollment;
}

export async function operatorQueue(account) {
  if (!databaseEnabled()) return [];
  return transaction(async client => {
    await operator(client, account);
    return (await client.query(`SELECT b.id,b.public_handle,b.account_id,b.created_at,b.reason,r.id AS request_id,r.reason AS rationale,r.opened_by,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('account',x.account_id,'wallet',x.wallet_address,
        'due',x.opened_at+interval '24 hours')),'[]') FROM reinstatement_wallet_conflicts x WHERE x.blacklist_id=b.id) AS wallet_reviews,
      count(v.enrollment)::int AS approvals,bool_or(o.account_id=$1) AS voted,
      (SELECT count(*) FROM reinstatement_operators eligible WHERE eligible.account_id<>b.account_id)>=3 AS quorum_available
      FROM account_blacklist b LEFT JOIN reinstatement_overrides r ON r.blacklist_id=b.id AND r.status='open'
      LEFT JOIN reinstatement_votes v ON v.request_id=r.id LEFT JOIN reinstatement_operators o ON o.enrollment=v.enrollment
      WHERE b.status='active' GROUP BY b.id,r.id ORDER BY b.created_at`, [account])).rows;
  });
}

export async function overrideAction({ actor, entry, request, action, reason }) {
  return transaction(async client => {
    const enrollment = await operator(client, actor);
    const c = await lockedCase(client, entry);
    if (actor === c.owner) fail(403, "You cannot override your own blacklist");
    if (!request) {
      if (!c.active) fail(409, "Entry already closed");
      if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) fail(400, "Enter a rationale of up to 2000 characters");
      const row = (await client.query(`INSERT INTO reinstatement_overrides(blacklist_id,opened_by,reason)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [entry, actor, reason.trim()])).rows[0];
      if (!row) fail(409, "An override is already open");
      await audit(client, entry, actor, "open_override", { request: row.id, reason });
      return { request: row.id, approvals: 0 };
    }
    const r = (await client.query("SELECT * FROM reinstatement_overrides WHERE blacklist_id=$1 AND id::text=$2 FOR UPDATE", [entry, request])).rows[0];
    if (!r) fail(404, "Override not found");
    if (r.status === "resolved" && action === "approve") {
      const replay = await client.query(`SELECT FROM reinstatement_history WHERE blacklist_id=$1 AND detail->'voters' ? $2
        AND action='quorum' AND detail->>'request'=$3
        AND NOT EXISTS (SELECT FROM account_blacklist WHERE account_id=$4 AND status='active')`, [entry, actor, request, c.owner]);
      if (replay.rowCount) return { request, resolved: true, approvals: 3 };
    }
    if (!c.active || r.status !== "open") fail(409, "Override closed");
    if (action === "cancel") {
      if (actor !== r.opened_by) fail(403, "Only the initiator can cancel");
      await client.query("UPDATE reinstatement_overrides SET status='cancelled' WHERE id=$1", [request]);
    } else if (action === "withdraw") {
      await client.query("DELETE FROM reinstatement_votes WHERE request_id=$1 AND enrollment=$2", [request, enrollment]);
    } else if (action === "approve") {
      const result = await client.query("INSERT INTO reinstatement_votes VALUES ($1,$2) ON CONFLICT DO NOTHING", [request, enrollment]);
      if (result.rowCount) await audit(client, entry, actor, action, { request });
    } else fail(400, "Unknown override action");
    if (action !== "approve") await audit(client, entry, actor, action, { request });
    const voters = (await client.query(`SELECT o.account_id FROM reinstatement_votes v JOIN reinstatement_operators o USING(enrollment)
      WHERE request_id=$1 ORDER BY o.account_id FOR SHARE OF o`, [request])).rows.map(row => row.account_id);
    if (voters.length === 3 && action === "approve") {
      await audit(client, entry, actor, "quorum", { request, voters });
      await resolveCase(client, c, actor, "override", r.reason);
      return { request, approvals: 3, resolved: true };
    }
    return { request, approvals: voters.length, cancelled: action === "cancel" };
  });
}

export async function handleReinstatementRoute({ req, res, url, session, json, readJson }) {
  const path = url.pathname;
  const personal = path === "/api/me/reinstatement";
  const match = path.match(/^\/api\/operator\/blacklist\/([^/]+)\/overrides(?:\/([^/]+)\/(approve|withdraw|cancel))?$/);
  if (!personal && path !== operatorPrefix && !match) return false;
  if (!session?.accountId) fail(401, "Sign in first");
  const actor = session.accountId;
  res.setHeader("Cache-Control", "private, no-store");
  let result;
  if (personal && req.method === "GET") result = { entry: await personalStatus(actor) };
  else if (path === operatorPrefix && req.method === "GET") result = { entries: await operatorQueue(actor) };
  else if (match && req.method === "POST") {
    const body = await readJson(req, 12000);
    result = await overrideAction({ actor, entry: match[1], request: match[2], action: match[3], reason: body.reason });
  } else fail(405, "Method not allowed");
  json(res, 200, result);
  return true;
}
