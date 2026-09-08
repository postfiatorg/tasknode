import { randomUUID } from "node:crypto";
import { query, transaction } from "../db/pool.js";
import { digest, identifier, seal, unseal, timestamp, text, stringList, trackerError, TRACKER_CAPABILITIES, TRACKER_QUOTA_BYTES, validateEvent } from "../campaign-tracker-contract.js";

const binding = (account, id) => `${account}:${id}`;
export async function trackerAudit(client, actor, subject, action, resource = "") {
  await client.query("INSERT INTO campaign_tracker_audit(actor_account_id,subject_account_id,action,resource_id) VALUES($1,$2,$3,$4)", [actor, subject, action, resource]);
}
export async function trackerStorageBytes(client,account) {
  const result=await client.query(`SELECT COALESCE((SELECT sum(payload_bytes) FROM campaign_tracker_activity WHERE account_id=$1),0)
    + COALESCE((SELECT sum(octet_length(payload_envelope::text)) FROM campaign_tracker_annotations WHERE account_id=$1),0)
    + COALESCE((SELECT sum(octet_length(payload_envelope::text)) FROM campaign_tracker_campaigns WHERE owner_account_id=$1),0) AS bytes`,[account]);
  return Number(result.rows[0].bytes);
}
export async function accountLock(client, account) { await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`campaign-tracker:${account}`]); }
export async function trackerStatus(accountId) {
  const [enrollments, usage, identity] = await Promise.all([
    query("SELECT workspace_id,enabled,policy_version,enrolled_at FROM campaign_tracker_enrollments WHERE account_id=$1 ORDER BY enrolled_at", [accountId]),
    query("SELECT count(*)::int AS events,COALESCE(sum(payload_bytes),0)::bigint AS bytes,count(*) FILTER(WHERE summary_state='pending')::int AS pending FROM campaign_tracker_activity WHERE account_id=$1 AND expires_at>now()", [accountId]),
    query("SELECT hive_handle FROM app_accounts WHERE account_id=$1", [accountId]),
  ]);
  return { ok: true, accountId, handle: identity.rows[0]?.hive_handle || "", enrollments: enrollments.rows, usage: usage.rows[0], quotaBytes: TRACKER_QUOTA_BYTES, coverage: "Recorded enrolled Corbanu TUI events; other clients and offline gaps are not complete employee activity." };
}
export async function trackerEnroll(accountId, workspaceId, enabled) {
  identifier(workspaceId);
  if (typeof enabled !== "boolean") throw trackerError("tracker_enrollment_invalid");
  return transaction(async client => {
    await accountLock(client, accountId);
    const row = await client.query(`INSERT INTO campaign_tracker_enrollments(account_id,workspace_id,enabled) VALUES($1,$2,$3)
      ON CONFLICT(account_id,workspace_id) DO UPDATE SET enabled=$3,policy_version=campaign_tracker_enrollments.policy_version+1,updated_at=now() RETURNING *`, [accountId, workspaceId, enabled]);
    await trackerAudit(client, accountId, accountId, enabled ? "enroll" : "pause", workspaceId);
    return { ok: true, enrollment: row.rows[0] };
  });
}
export async function trackerIngest(accountId, raw, { quotaBytes = TRACKER_QUOTA_BYTES, env = process.env } = {}) {
  const event = validateEvent(raw);
  const hash = digest(event.kind === "agent_output" ? {...event,content:""} : event);
  return transaction(async client => {
    await accountLock(client, accountId);
    const deleted = await client.query("SELECT 1 FROM campaign_tracker_tombstones WHERE account_id=$1 AND event_id=$2", [accountId,event.id]);
    if (deleted.rowCount) return {ok:true,id:event.id,replayed:true,summaryState:"deleted"};
    const existing = await client.query("SELECT payload_digest,summary_state,received_at FROM campaign_tracker_activity WHERE account_id=$1 AND event_id=$2", [accountId, event.id]);
    if (existing.rows.length) {
      if (existing.rows[0].payload_digest !== hash) throw trackerError("tracker_idempotency_conflict", 409);
      return { ok: true, id: event.id, replayed: true, summaryState: existing.rows[0].summary_state, receivedAt: existing.rows[0].received_at };
    }
    if(Date.parse(event.occurredAt)<Date.now()-365*24*60*60_000) {
      await client.query("INSERT INTO campaign_tracker_tombstones(account_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[accountId,event.id]);
      return {ok:true,id:event.id,replayed:false,summaryState:"deleted"};
    }
    const enrollment = await client.query("SELECT enabled FROM campaign_tracker_enrollments WHERE account_id=$1 AND workspace_id=$2", [accountId, event.workspaceId]);
    if (!enrollment.rows[0]?.enabled) throw trackerError("tracker_workspace_not_enrolled", 403);
    // The client cannot link another account's task or invent a completion.
    if (event.taskIds.length) {
      const tasks = await client.query("SELECT task_id FROM task_projections WHERE account_id=$1 AND task_id=ANY($2)", [accountId, event.taskIds]);
      if (tasks.rowCount !== event.taskIds.length) throw trackerError("tracker_task_not_owned", 403);
    }
    const identity = await client.query("SELECT hive_handle FROM app_accounts WHERE account_id=$1", [accountId]);
    const persisted = { ...event, content: event.kind === "agent_output" ? "" : event.content, handleAtExecution: identity.rows[0]?.hive_handle || "", summary: null };
    const envelope = seal(persisted, binding(accountId, event.id), env);
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    const usage = await trackerStorageBytes(client,accountId);
    if (usage + bytes > quotaBytes) throw trackerError("tracker_storage_quota", 413);
    const state = event.kind === "agent_output" ? "pending" : "not_applicable";
    await client.query(`INSERT INTO campaign_tracker_activity(account_id,event_id,instance_id,session_id,turn_id,sequence,workspace_id,kind,occurred_at,payload_digest,payload_envelope,payload_bytes,summary_state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$9::timestamptz+interval '365 days')`, [accountId,event.id,event.instanceId,event.sessionId,event.turnId,event.sequence,event.workspaceId,event.kind,event.occurredAt,hash,envelope,bytes,state]);
    await trackerAudit(client, accountId, accountId, "ingest", event.id);
    return { ok: true, id: event.id, replayed: false, summaryState: state };
  });
}
export async function trackerExpireSource(accountId,id) {
  await query("UPDATE campaign_tracker_activity SET summary_state='unavailable' WHERE account_id=$1 AND event_id=$2 AND summary_state='pending' AND occurred_at<now()-interval '72 hours'",[accountId,id]);
}
export async function trackerCompleteSummary(accountId, id, summary, env = process.env) {
  return transaction(async client => {
    await accountLock(client, accountId);
    const result = await client.query("SELECT * FROM campaign_tracker_activity WHERE account_id=$1 AND event_id=$2 AND expires_at>now() FOR UPDATE", [accountId,id]);
    const row = result.rows[0];
    if (!row || row.summary_state !== "pending") return;
    const event = unseal(row.payload_envelope, binding(accountId,id), env);
    event.summary = summary;
    const envelope = seal(event,binding(accountId,id),env);
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    const usage = await trackerStorageBytes(client,accountId);
    if (usage - Number(row.payload_bytes) + bytes > TRACKER_QUOTA_BYTES) throw trackerError("tracker_storage_quota",413);
    await client.query("UPDATE campaign_tracker_activity SET payload_envelope=$3,payload_bytes=$4,summary_state='ready',revision=revision+1 WHERE account_id=$1 AND event_id=$2",[accountId,id,envelope,bytes]);
  });
}

async function grantsFor(client, actor, subject) {
  if (actor === subject) return [{ capabilities: TRACKER_CAPABILITIES, workspace_ids: [], history_from: new Date(0), history_to: null }];
  const result = await client.query(`SELECT g.* FROM campaign_tracker_grants g JOIN task_history_grants r ON r.grant_id=g.relationship_grant_id
    WHERE g.subject_account_id=$1 AND g.viewer_account_id=$2 AND g.revoked_at IS NULL AND g.expires_at>now()
      AND r.status='active' AND ((r.subject_account_id=$1 AND r.viewer_account_id=$2) OR (r.subject_account_id=$2 AND r.viewer_account_id=$1)) FOR SHARE OF g,r`,[subject,actor]);
  return result.rows;
}
function capabilitiesFor(grants, row) {
  return new Set(grants.filter(g => new Date(row.occurred_at) >= new Date(g.history_from) && (!g.history_to || new Date(row.occurred_at)<new Date(g.history_to)) && (!g.workspace_ids.length || g.workspace_ids.includes(row.workspace_id))).flatMap(g=>g.capabilities));
}
export async function trackerRead(actor, options = {}, env = process.env, withinClient = null) {
  const subject = options.accountId || actor;
  identifier(subject);
  const read = async client => {
    const grants = await grantsFor(client,actor,subject);
    if (!grants.length) throw trackerError("tracker_access_denied",403);
    const result = await client.query(`SELECT * FROM campaign_tracker_activity WHERE account_id=$1 AND expires_at>now()
      AND ($2::text IS NULL OR session_id=$2) AND ($3::text IS NULL OR event_id=$3)
      AND ($4::timestamptz IS NULL OR (occurred_at,event_id)<($4::timestamptz,$5::text))
      AND ($1=$6 OR EXISTS(SELECT 1 FROM campaign_tracker_grants g JOIN task_history_grants r ON r.grant_id=g.relationship_grant_id
        WHERE g.subject_account_id=$1 AND g.viewer_account_id=$6 AND g.revoked_at IS NULL AND g.expires_at>now() AND r.status='active'
        AND g.capabilities ? 'summary' AND (NOT $7::boolean OR g.capabilities ? 'replay') AND (NOT $8::boolean OR g.capabilities ? 'export')
        AND g.history_from<=occurred_at AND (g.history_to IS NULL OR occurred_at<g.history_to)
        AND (jsonb_array_length(g.workspace_ids)=0 OR g.workspace_ids ? workspace_id)))
      ORDER BY occurred_at DESC,event_id DESC LIMIT 21`, [subject,options.sessionId || null,options.id || null,options.before || null,options.beforeId || "",actor,Boolean(options.replay),Boolean(options.export)]);
    const rows=result.rows.slice(0,20), items=[];
    let last=null,responseBytes=0,hasMore=result.rows.length>20;
    for (const row of rows) {
      if(items.length && responseBytes+Number(row.payload_bytes)>2*1024*1024){hasMore=true;break;}
      last=row;
      const caps=capabilitiesFor(grants,row);
      if (!caps.has("summary") || (options.replay && !caps.has("replay")) || (options.export && !caps.has("export"))) continue;
      const event=unseal(row.payload_envelope,binding(subject,row.event_id),env);
      if (options.workspaceId && event.workspaceId!==options.workspaceId) continue;
      if (options.taskId && !event.taskIds.includes(options.taskId) && !event.summary?.taskIds?.includes(options.taskId)) continue;
      if (!caps.has("prompt")) { event.content=""; event.promptWithheld=["human_prompt","automated_prompt"].includes(event.kind); }
      if (options.search && !JSON.stringify([event.content,event.summary]).toLowerCase().includes(options.search.toLowerCase())) continue;
      // Metadata is observable; all model outcomes remain claims, not verified completion.
      responseBytes+=Number(row.payload_bytes);
      items.push({...event,accountId:subject,revision:row.revision,summaryState:row.summary_state,receivedAt:row.received_at,capabilities:[...caps]});
    }
    if (options.id && !items.length) throw trackerError("tracker_activity_not_found",404);
    await trackerAudit(client,actor,subject,options.export?"export":options.replay?"replay":options.search?"search":"read",options.id || options.sessionId || "timeline");
    return {ok:true,items,nextCursor:hasMore && last?{before:last.occurred_at.toISOString(),beforeId:last.event_id}:null,coverage:"observed_tui"};
  };
  return withinClient ? read(withinClient) : transaction(read);
}
export async function trackerGrant(actor, body) {
  const handle=text(body.handle,80,true);
  // Handles are looked up through the canonical account table; never accept a client subject ID.
  const normalized=handle.startsWith("@")?handle.slice(1):handle;
  const viewer=await query("SELECT account_id FROM app_accounts WHERE lower(hive_handle)=lower($1) AND status='active'",[normalized]);
  const viewerId=viewer.rows[0]?.account_id;
  if (!viewerId || viewerId===actor) throw trackerError("tracker_viewer_invalid");
  const capabilities=stringList(body.capabilities);
  if (!capabilities.includes("summary") || capabilities.some(c=>!TRACKER_CAPABILITIES.includes(c))) throw trackerError("tracker_capabilities_invalid");
  const from=timestamp(body.historyFrom || new Date().toISOString());
  const to=body.historyTo?timestamp(body.historyTo):null;
  const expires=timestamp(body.expiresAt);
  if (Date.parse(expires)<=Date.now() || (to && Date.parse(to)<=Date.parse(from))) throw trackerError("tracker_grant_dates_invalid");
  const workspaces=stringList(body.workspaceIds || []);
  return transaction(async client=>{
    const relationship=await client.query(`SELECT grant_id FROM task_history_grants WHERE status='active' AND ((subject_account_id=$1 AND viewer_account_id=$2) OR (subject_account_id=$2 AND viewer_account_id=$1)) FOR SHARE`,[actor,viewerId]);
    if (!relationship.rowCount) throw trackerError("tracker_accepted_relationship_required",403);
    const id=randomUUID();
    await client.query(`INSERT INTO campaign_tracker_grants(grant_id,subject_account_id,viewer_account_id,relationship_grant_id,capabilities,workspace_ids,history_from,history_to,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,actor,viewerId,relationship.rows[0].grant_id,JSON.stringify(capabilities),JSON.stringify(workspaces),from,to,expires]);
    await trackerAudit(client,actor,actor,"grant",id);
    return {ok:true,grantId:id};
  });
}
export async function trackerRevoke(actor,id) {
  identifier(id);
  return transaction(async client=>{
    const result=await client.query("UPDATE campaign_tracker_grants SET revoked_at=now() WHERE grant_id=$1 AND subject_account_id=$2 RETURNING grant_id",[id,actor]);
    if (!result.rowCount) throw trackerError("tracker_grant_not_found",404);
    await trackerAudit(client,actor,actor,"revoke",id);
    return {ok:true};
  });
}
export async function trackerGrants(actor) {
  const result=await query(`SELECT g.*,s.hive_handle AS subject_handle,v.hive_handle AS viewer_handle FROM campaign_tracker_grants g
    LEFT JOIN app_accounts s ON s.account_id=g.subject_account_id LEFT JOIN app_accounts v ON v.account_id=g.viewer_account_id
    WHERE g.subject_account_id=$1 OR g.viewer_account_id=$1 ORDER BY g.created_at DESC LIMIT 100`,[actor]);
  return {ok:true,items:result.rows};
}
export async function trackerAuditList(actor) {
  const result=await query("SELECT * FROM campaign_tracker_audit WHERE subject_account_id=$1 ORDER BY id DESC LIMIT 100",[actor]);
  return {ok:true,items:result.rows};
}
export async function trackerDelete(actor,id) {
  return transaction(async client=>{
    await accountLock(client,actor);
    const source=await client.query("SELECT session_id,turn_id FROM campaign_tracker_activity WHERE account_id=$1 AND event_id=$2",[actor,id]);
    if (!source.rowCount) throw trackerError("tracker_activity_not_found",404);
    const affected=await client.query("SELECT event_id FROM campaign_tracker_activity WHERE account_id=$1 AND (event_id=$2 OR (session_id=$3 AND turn_id=$4 AND kind='agent_output'))",[actor,id,source.rows[0].session_id,source.rows[0].turn_id]);
    const ids=affected.rows.map(row=>row.event_id);
    await client.query("INSERT INTO campaign_tracker_tombstones(account_id,event_id) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",[actor,ids]);
    await client.query("DELETE FROM campaign_tracker_activity WHERE account_id=$1 AND event_id=ANY($2)",[actor,ids]);
    await trackerAudit(client,actor,actor,"delete",id);
    return {ok:true};
  });
}
export async function trackerExpire() {
  // Content-free audit retention is separately bounded.
  await transaction(async client=>{
    await client.query("INSERT INTO campaign_tracker_tombstones(account_id,event_id) SELECT account_id,event_id FROM campaign_tracker_activity WHERE expires_at<=now() ON CONFLICT DO NOTHING");
    await client.query("DELETE FROM campaign_tracker_activity WHERE expires_at<=now()");
  });
  await query("DELETE FROM campaign_tracker_audit WHERE occurred_at<now()-interval '730 days'");
  await query("DELETE FROM campaign_tracker_tombstones WHERE deleted_at<now()-interval '730 days'");
}
