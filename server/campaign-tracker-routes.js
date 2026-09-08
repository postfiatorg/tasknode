import { trackerMetrics } from "./campaign-tracker-metrics.js";
import { listTeam } from "./repositories/collaboration.js";
import * as workflows from "./repositories/campaign-tracker-workflows.js";
import * as store from "./repositories/campaign-tracker.js";
import { object, text, trackerError, validateEvent } from "./campaign-tracker-contract.js";
import { trackerEntitlement, trackerSummarize } from "./campaign-tracker-model.js";

const prefix="/api/terminal/tasknode/campaign-tracker";
let nextMaintenance=0;
export async function handleCampaignTrackerRoute({json,readJson,req,res,url,session},dependencies={}) {
  if (url.pathname!==prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const account=session.accountId;
  res.setHeader("Cache-Control","no-store");
  try {
    if(Date.now()>nextMaintenance) {await store.trackerExpire();nextMaintenance=Date.now()+60*60_000;}
    const path=url.pathname.slice(prefix.length) || "/status";
    const method=req.method;
    let result;
    if (method==="GET") {
      if (path==="/status") result=await store.trackerStatus(account);
      else if (path==="/grants") result=await store.trackerGrants(account);
      else if (path==="/audit") result=await store.trackerAuditList(account);
      else if (path==="/metrics") {
        const options=Object.fromEntries(url.searchParams);object(options,["accountId","sessionId","workspaceId","taskId"]);
        result=await trackerMetrics(account,options);
      }
      else if (path==="/team") result=await listTeam({accountId:account});
      else if (path==="/campaigns") result=await workflows.trackerCampaigns(account);
      else if (path==="/annotations") result=await workflows.trackerAnnotations(account,url.searchParams.get("accountId") || account,url.searchParams.get("id"));
      else if (path==="/activity" || path==="/replay" || path==="/export") {
        const options=Object.fromEntries(url.searchParams);
        object(options,["accountId","sessionId","id","before","beforeId","workspaceId","taskId","search"]);
        if(options.search)text(options.search,500);
        result=await store.trackerRead(account,{...options,replay:path==="/replay",export:path==="/export"});
      } else throw trackerError("tracker_route_not_found",404);
    } else if (method==="POST") {
      const body=object(await readJson(req));
      if(path==="/enrollment") {
        object(body,["workspaceId","enabled","apiKey"]);
        if(body.enabled) await (dependencies.entitlement || trackerEntitlement)(body.apiKey);
        result=await store.trackerEnroll(account,body.workspaceId,body.enabled);
      } else if(path==="/events") {
        object(body,["event","apiKey"]);
        await (dependencies.entitlement || trackerEntitlement)(body.apiKey);
        const event=validateEvent(body.event);
        result=await store.trackerIngest(account,event);
        if(result.summaryState==="pending") {
          if(Date.parse(event.occurredAt)<Date.now()-72*60*60_000) {
            await store.trackerExpireSource(account,event.id);
            result.summaryState="unavailable";
          } else {
            try {
              const summary=await (dependencies.summarize || trackerSummarize)(account,event,body.apiKey);
              await store.trackerCompleteSummary(account,event.id,summary);
              result.summaryState="ready";
            } catch {
              // Never leak gateway responses or credentials; retain local source for retry.
              result.summaryState="pending"; result.message="Output summary pending; source remains in the encrypted local outbox.";
            }
          }
        }
      } else if(path==="/campaigns") {
        result=await workflows.trackerCreateCampaign(account,body);
      } else if(path==="/annotations") {
        result=await workflows.trackerAnnotate(account,body);
      } else if(path==="/grants") {
        object(body,["handle","capabilities","historyFrom","historyTo","expiresAt","workspaceIds"]);
        result=await store.trackerGrant(account,body);
      } else if(path==="/revoke") {
        object(body,["grantId"]); result=await store.trackerRevoke(account,body.grantId);
      } else if(path==="/delete") {
        object(body,["id"]); result=await store.trackerDelete(account,body.id);
      } else throw trackerError("tracker_route_not_found",404);
    } else throw trackerError("tracker_method_not_allowed",405);
    json(res,200,result);
  } catch(error) {
    const status=Number.isInteger(error.status)?error.status:500;
    const code=error.code?.startsWith("tracker_")?error.code:"tracker_request_failed";
    json(res,status,{ok:false,error:code,message:code.split("_").join(" ")});
  }
  return true;
}
