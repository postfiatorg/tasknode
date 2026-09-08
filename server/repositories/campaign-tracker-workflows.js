import { randomUUID } from "node:crypto";
import { query,transaction } from "../db/pool.js";
import { object,identifier,text,stringList,seal,unseal,trackerError,TRACKER_QUOTA_BYTES } from "../campaign-tracker-contract.js";
import { trackerRead,trackerAudit,trackerStorageBytes,accountLock } from "./campaign-tracker.js";

const dimensions=["clarity","context","constraints","successCriteria","iteration"];
export async function trackerAnnotate(actor,body) {
  object(body,["accountId","id","revision","kind","scores","note","taskIds"]);
  const subject=body.accountId || actor,id=identifier(body.id);
  if(!Number.isSafeInteger(body.revision))throw trackerError("tracker_revision_required");
  if(!["review","mapping"].includes(body.kind))throw trackerError("tracker_annotation_invalid");
  const note=text(body.note,6000,true);
  let payload;
  if(body.kind==="review") {
    const scores=object(body.scores,dimensions);
    if(Object.keys(scores).length!==5 || Object.values(scores).some(s=>s!==null && (!Number.isInteger(s)||s<1||s>5)))throw trackerError("tracker_review_scores_invalid");
    payload={scores,note,rubricVersion:"prompt-quality-v1",evaluator:"human",model:null};
  } else {
    if(actor!==subject)throw trackerError("tracker_owner_correction_required",403);
    const taskIds=stringList(body.taskIds);
    const tasks=await query("SELECT task_id FROM task_projections WHERE account_id=$1 AND task_id=ANY($2)",[actor,taskIds]);
    if(tasks.rowCount!==taskIds.length)throw trackerError("tracker_task_not_owned",403);
    payload={taskIds,note,mappingStatus:"corrected"};
  }
  return transaction(async client=>{
    // Serialize revisions and hold relationship/grant locks through the write.
    await accountLock(client,subject);
    const page=await trackerRead(actor,{accountId:subject,id},process.env,client);
    const record=page.items[0];
    if(body.kind==="review" && (!record.capabilities.includes("prompt") || !record.capabilities.includes("review")))throw trackerError("tracker_review_access_denied",403);
    if(body.revision!==record.revision)throw trackerError("tracker_revision_conflict",409);
    const annotationId=randomUUID();
    const envelope=seal(payload,`${subject}:${annotationId}`);
    if(await trackerStorageBytes(client,subject)+Buffer.byteLength(JSON.stringify(envelope))+100>TRACKER_QUOTA_BYTES)throw trackerError("tracker_storage_quota",413);
    await client.query("INSERT INTO campaign_tracker_annotations(annotation_id,account_id,event_id,actor_account_id,kind,source_revision,payload_envelope) VALUES($1,$2,$3,$4,$5,$6,$7)",[annotationId,subject,id,actor,body.kind,body.revision,envelope]);
    if(body.kind==="mapping") {
      const saved=await client.query("SELECT payload_envelope FROM campaign_tracker_activity WHERE account_id=$1 AND event_id=$2",[subject,id]);
      const activity=unseal(saved.rows[0].payload_envelope,`${subject}:${id}`);
      activity.taskIds=payload.taskIds;
      activity.mappingStatus="corrected";
      const updated=seal(activity,`${subject}:${id}`),bytes=Buffer.byteLength(JSON.stringify(updated));
      if(await trackerStorageBytes(client,subject)+bytes>TRACKER_QUOTA_BYTES)throw trackerError("tracker_storage_quota",413);
      await client.query("UPDATE campaign_tracker_activity SET payload_envelope=$3,payload_bytes=$4,revision=revision+1 WHERE account_id=$1 AND event_id=$2",[subject,id,updated,bytes]);
    }
    await trackerAudit(client,actor,subject,body.kind,id);
    return {ok:true,annotationId};
  });
}
export async function trackerAnnotations(actor,subject,id) {
  return transaction(async client=>{
  const page=await trackerRead(actor,{accountId:subject,id},process.env,client);
  if(!page.items[0].capabilities.includes("prompt"))throw trackerError("tracker_prompt_access_required",403);
  const rows=await client.query("SELECT * FROM campaign_tracker_annotations WHERE account_id=$1 AND event_id=$2 ORDER BY created_at LIMIT 100",[subject,id]);
  return {ok:true,items:rows.rows.map(row=>({id:row.annotation_id,actorAccountId:row.actor_account_id,sourceRevision:row.source_revision,kind:row.kind,createdAt:row.created_at,...unseal(row.payload_envelope,`${subject}:${row.annotation_id}`)}))};
  });
}
export async function trackerCreateCampaign(actor,body) {
  object(body,["title","objective","memberHandles","taskIds"]);
  const title=text(body.title,200,true),objective=text(body.objective,4000,true);
  const handles=Array.isArray(body.memberHandles)?body.memberHandles:[];
  if(handles.length>30)throw trackerError("tracker_campaign_too_many_members");
  const members=[];
  for(const raw of handles) {
    const handle=text(raw,80,true),normalized=handle.startsWith("@")?handle.slice(1):handle;
    const result=await query("SELECT account_id FROM app_accounts WHERE lower(hive_handle)=lower($1) AND status='active'",[normalized]);
    const id=result.rows[0]?.account_id;
    const relation=await query("SELECT 1 FROM task_history_grants WHERE status='active' AND ((subject_account_id=$1 AND viewer_account_id=$2) OR (subject_account_id=$2 AND viewer_account_id=$1))",[actor,id || ""]);
    if(!id || !relation.rowCount)throw trackerError("tracker_accepted_relationship_required",403);
    members.push(id);
  }
  const taskIds=stringList(body.taskIds || []);
  const tasks=await query("SELECT task_id FROM task_projections WHERE account_id=$1 AND task_id=ANY($2)",[actor,taskIds]);
  if(tasks.rowCount!==taskIds.length)throw trackerError("tracker_task_not_owned",403);
  const id=randomUUID(),payload={title,objective,members:[actor,...new Set(members)],taskIds};
  await transaction(async client=>{
    await accountLock(client,actor);
    const envelope=seal(payload,`${actor}:${id}`);
    if(await trackerStorageBytes(client,actor)+Buffer.byteLength(JSON.stringify(envelope))+100>TRACKER_QUOTA_BYTES)throw trackerError("tracker_storage_quota",413);
    await client.query("INSERT INTO campaign_tracker_campaigns(campaign_id,owner_account_id,payload_envelope) VALUES($1,$2,$3)",[id,actor,envelope]);
    await trackerAudit(client,actor,actor,"campaign_create",id);
  });
  return {ok:true,campaignId:id};
}
export async function trackerCampaigns(actor) {
  // Only accepted relationships are candidate owners; unrelated campaigns are never decrypted.
  const rows=await query(`SELECT c.* FROM campaign_tracker_campaigns c WHERE c.owner_account_id=$1 OR EXISTS(SELECT 1 FROM task_history_grants r WHERE r.status='active' AND ((r.subject_account_id=$1 AND r.viewer_account_id=c.owner_account_id) OR (r.viewer_account_id=$1 AND r.subject_account_id=c.owner_account_id))) ORDER BY c.created_at DESC LIMIT 100`,[actor]);
  const items=rows.rows.map(row=>({id:row.campaign_id,ownerAccountId:row.owner_account_id,revision:row.revision,...unseal(row.payload_envelope,`${row.owner_account_id}:${row.campaign_id}`)})).filter(c=>c.members.includes(actor));
  return {ok:true,items};
}
