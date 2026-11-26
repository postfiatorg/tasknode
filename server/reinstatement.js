import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "./db/pool.js";
import { applyOffchainTaskOfferWithClient } from "./offchain-task-lifecycle.js";

export const reinstatementBoard = "board_reinstatement";
export const taskInstructions = "Submit a link or other checkable evidence of your own contribution. Explain how it helped Post Fiat or addressed the reason for your blacklist. Work outside Task Node is eligible. This task pays 0 PFT.";
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }

export async function lockedCase(client, id) {
  const entry = (await client.query("SELECT * FROM account_blacklist WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!entry) fail(404, "Blacklist entry not found");
  const row = (await client.query("SELECT * FROM reinstatement_cases WHERE blacklist_id=$1 FOR UPDATE", [id])).rows[0];
  if (!row) fail(409, "This blacklist entry is closed");
  return { ...row, owner: entry.account_id, reason: entry.reason, active: entry.status === "active" };
}

export async function audit(client, id, actor, action, detail = {}) {
  await client.query("INSERT INTO reinstatement_history(blacklist_id,actor,action,detail) VALUES ($1,$2,$3,$4)", [id, actor, action, detail]);
}

async function issue(client, id) {
  const c = await lockedCase(client, id);
  const due = await client.query("SELECT FROM reinstatement_cases WHERE blacklist_id=$1 AND eligible_at<=now() AND coalesce(retry_at,now())<=now()", [id]);
  if (!c.active || c.stage !== "waiting" || !due.rowCount) return;
  const taskId = "task_reinstate_" + id;
  await client.query("UPDATE reinstatement_cases SET stage='offered',task_id=$2,retry_at=NULL WHERE blacklist_id=$1", [id, taskId]);
  await applyOffchainTaskOfferWithClient(client, {
    accountId: c.owner, reinstatementId: id,
    offerPayload: { task_id: taskId, task_kind: "network", task_class: "network", title: "Restore your Task Node access", description: taskInstructions,
      submission_requirement: { type: "evidence", criteria: taskInstructions } },
  });
  await client.query(`INSERT INTO network_task_allocations
    (id,project_id,generated_task_id,candidate_account_id,allocation_status,reward_min_pft,reward_max_pft)
    VALUES ($1,$2,$1,$3,'proposed',0,0)`, [taskId, reinstatementBoard, c.owner]);
  await audit(client, id, "issuer", "issued", { taskId });
}

export async function dispatchDue() {
  const rows = (await query(`SELECT c.blacklist_id FROM reinstatement_cases c JOIN account_blacklist b ON b.id=c.blacklist_id
    WHERE b.status='active' AND c.stage='waiting' AND eligible_at<=now() AND coalesce(retry_at,now())<=now()
    ORDER BY eligible_at,blacklist_id LIMIT 32`)).rows;
  for (const { blacklist_id: id } of rows) {
    try { await transaction(client => issue(client, id)); }
    catch (error) {
      console.error("reinstatement_delivery_failed", id, error.message);
      const failure = await query(`UPDATE reinstatement_cases SET retry_at=now()+CASE failures WHEN 0 THEN interval '15 seconds'
        WHEN 1 THEN interval '1 minute' ELSE interval '5 minutes' END, failures=failures+1
        WHERE blacklist_id=$1 AND stage='waiting' RETURNING eligible_at<=now()-interval '5 minutes' AS overdue`, [id]);
      if (failure.rows[0]?.overdue) console.error("reinstatement_delivery_overdue", id);
    }
  }
  const overdue = await query(`UPDATE reinstatement_cases SET review_escalated_at=now()
    WHERE stage='submitted' AND submitted_at<=now()-interval '24 hours'
      AND (review_escalated_at IS NULL OR review_escalated_at<=now()-interval '24 hours') RETURNING blacklist_id`);
  for (const item of overdue.rows) console.warn("reinstatement_review_overdue", item.blacklist_id);
  return rows.length;
}

export function startReinstatementWorker() {
  if (!databaseEnabled() || process.env.TASKNODE_REINSTATEMENT_ISSUANCE_ENABLED === "false") return;
  async function tick() {
    let delay = 15000;
    try { if (await dispatchDue() === 32) delay = 0; }
    catch (error) { console.error("reinstatement_worker", error.message); }
    setTimeout(tick, delay).unref();
  }
  void tick();
}

export async function personalStatus(owner) {
  if (!databaseEnabled()) return null;
  const { rows } = await query(`WITH own AS (
    SELECT b.id,b.reason,b.created_at,b.status,b.lifted_at,c.stage,c.task_id,c.eligible_at,
      c.revision,c.feedback,c.submitted_at,c.review_escalated_at,c.resolved_via,r.id AS override_id,
      (SELECT count(*)::int FROM reinstatement_votes WHERE request_id=r.id) AS approvals
      FROM account_blacklist b JOIN reinstatement_cases c ON c.blacklist_id=b.id
      LEFT JOIN reinstatement_overrides r ON r.blacklist_id=b.id AND r.status='open'
     WHERE b.account_id=$1 ORDER BY (b.status='active') DESC,b.created_at DESC LIMIT 1
    ) SELECT own.*,now() AS server_time,conflict.wallet_restricted FROM
      (SELECT EXISTS(SELECT FROM reinstatement_wallet_conflicts WHERE account_id=$1) AS wallet_restricted) conflict
      LEFT JOIN own ON true`, [owner]);
  const entry = rows[0];
  return entry.id || entry.wallet_restricted ? entry : null;
}

async function mirror(client, c, projection, allocation) {
  if (!c.task_id) return;
  await client.query("UPDATE task_projections SET status=$2,updated_at=now(),last_event_at=now() WHERE task_id=$1", [c.task_id, projection]);
  await client.query("UPDATE network_task_allocations SET allocation_status=$2,updated_at=now() WHERE generated_task_id=$1", [c.task_id, allocation]);
}

export async function resolveCase(client, c, actor, via, reason) {
  const id = c.blacklist_id;
  await client.query("UPDATE reinstatement_cases SET stage='resolved',resolved_via=$2,lease_token=NULL,lease_until=NULL WHERE blacklist_id=$1", [id, via]);
  await client.query("UPDATE account_blacklist SET status='lifted',lifted_at=now(),lifted_by=$2,lift_reason=$3 WHERE id=$1 AND status='active'", [id, actor, reason]);
  await client.query("UPDATE reinstatement_overrides SET status=$2 WHERE blacklist_id=$1 AND status='open'", [id, via === "task" ? "superseded" : "resolved"]);
  await mirror(client, c, via === "task" ? "reinstatement_completed" : "reinstatement_superseded", "completed");
  await audit(client, id, actor, "lifted", { via, reason });
}

const transitions = { accept: ["offered"], resume: ["paused"], pause: ["offered", "working"], submit: ["working"] };
export async function contributorAction({ owner, id, action, revision, evidence }) {
  return transaction(async client => {
    const c = await lockedCase(client, id);
    if (owner !== c.owner) fail(404, "Task not found");
    if (action === "submit" && c.stage === "submitted" && c.revision === revision + 1 && typeof evidence === "string" && c.evidence === evidence.trim()) return { ok: true };
    if (!Object.hasOwn(transitions, action)) fail(400, "Unknown task action");
    if (!c.active || !transitions[action].includes(c.stage) || c.revision !== revision) fail(409, "Task has changed. Refresh its status.");
    if (action === "submit") {
      if (typeof evidence !== "string" || !evidence.trim() || evidence.length > 12000) fail(400, "Provide evidence and a short explanation");
      await client.query(`UPDATE reinstatement_cases SET stage='submitted',revision=revision+1,evidence=$2,
        submitted_at=now(),review_escalated_at=NULL,feedback='',reviewer=NULL,lease_token=NULL,lease_until=NULL WHERE blacklist_id=$1`, [id, evidence.trim()]);
      await mirror(client, c, "reinstatement_submitted", "submitted");
    } else {
      const stage = action === "pause" ? "paused" : "working";
      await client.query("UPDATE reinstatement_cases SET stage=$2 WHERE blacklist_id=$1", [id, stage]);
      await mirror(client, c, stage === "paused" ? "reinstatement_paused" : "accepted", "accepted");
    }
    await audit(client, id, owner, action, { revision, evidence: action === "submit" ? evidence.trim() : undefined });
    return { ok: true };
  });
}

export async function reviewCase({ id, revision, action, actor, token, reason }) {
  return transaction(async client => {
    const c = await lockedCase(client, id);
    if (!c.active || c.stage !== "submitted" || c.revision !== revision) fail(409, "This revision is no longer awaiting review");
    if (action === "claim") {
      const claimed = await client.query(`UPDATE reinstatement_cases SET reviewer=$2,lease_token=$3,lease_until=now()+interval '5 minutes'
        WHERE blacklist_id=$1 AND (lease_until IS NULL OR lease_until<=now() OR reviewer=$2)
        RETURNING lease_token,lease_until,evidence,revision`, [id, actor, randomUUID()]);
      if (!claimed.rowCount) fail(409, "Another reviewer holds this submission");
      return { ...claimed.rows[0], blacklist_reason: c.reason };
    }
    if (!["reinstate","revise"].includes(action) || !reason?.trim() || reason.length > 2000) fail(400, "A verdict and reason are required");
    const lease = await client.query("SELECT FROM reinstatement_cases WHERE blacklist_id=$1 AND reviewer=$2 AND lease_token::text=$3 AND lease_until>now()", [id, actor, token]);
    if (!lease.rowCount) fail(409, "Review lease expired. Claim the current revision.");
    await audit(client, id, actor, action, { revision, reason, rubric: "reinstatement-v1" });
    if (action === "reinstate") await resolveCase(client, c, actor, "task", reason);
    else {
      await client.query("UPDATE reinstatement_cases SET stage='working',feedback=$2,lease_token=NULL,lease_until=NULL WHERE blacklist_id=$1", [id, reason]);
      await mirror(client, c, "verification_requested", "verification_requested");
    }
    return { ok: true, action };
  });
}
