import {trackerRead} from "./repositories/campaign-tracker.js";
import {query} from "./db/pool.js";

export async function trackerMetrics(actor,options={}) {
  let cursor={},scanned=0,more=true,pages=0;
  const rootRuns=new Set(),goalRuns=new Set(),tasks=new Set();
  const metrics={humanPrompts:0,automatedPrompts:0,toolActions:0,outputSummaries:0,failedActions:0,captureGaps:0,agentRuntimeMs:0,verifiedTaskCompletions:0,tokenUsage:null,costUsd:null};
  while(more && pages<100) {
    pages++;
    const page=await trackerRead(actor,{...options,...cursor});
    for(const event of page.items) {
      scanned++;
      if(event.kind==="human_prompt")metrics.humanPrompts++;
      if(event.kind==="automated_prompt")metrics.automatedPrompts++;
      if(event.kind==="tool")metrics.toolActions++;
      if(event.kind==="agent_output" && event.summaryState==="ready")metrics.outputSummaries++;
      if(event.kind==="gap")metrics.captureGaps++;
      if(["failed","error","interrupted"].includes(String(event.facts.status || "").toLowerCase()))metrics.failedActions++;
      if(event.kind==="turn_end") {
        const key=`${event.sessionId}:${event.facts.nativeTurnId || event.turnId}`;
        if(!rootRuns.has(key)) {rootRuns.add(key);metrics.agentRuntimeMs+=Math.max(0,event.facts.durationMs || 0);}
        if(event.goal.active)goalRuns.add(key);
      }
      for(const task of event.taskIds)tasks.add(task);
    }
    cursor=page.nextCursor || {};more=Boolean(page.nextCursor);
  }
  if(tasks.size) {
    const result=await query("SELECT task_id FROM task_projections WHERE account_id=$1 AND task_id=ANY($2) AND status='rewarded'",[options.accountId || actor,[...tasks]]);
    metrics.verifiedTaskCompletions=result.rowCount;
  }
  return {ok:true,metrics:{...metrics,rootRuns:rootRuns.size,goalRuns:goalRuns.size,mappedTasks:tasks.size,observedEvents:scanned},complete:!more,nextCursor:more?cursor:null,coverage:"Observed Corbanu TUI activity only. Runtime is agent execution, not employee working hours. Missing token/cost values are unknown, not zero."};
}
