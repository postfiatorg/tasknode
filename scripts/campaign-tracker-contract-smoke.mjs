#!/usr/bin/env node
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {parse} from "acorn";
import {trackerEntitlement,trackerGenerateSummary,TRACKER_GATEWAY_MODEL,TRACKER_OUTSTANDING_STATUSES} from "../server/campaign-tracker-model.js";
import {TASK_STATUS,TASK_TABS,taskStatusTab} from "../shared/task-lifecycle.js";
assert.deepEqual(TRACKER_OUTSTANDING_STATUSES, Object.values(TASK_STATUS).filter(status=>taskStatusTab(status)===TASK_TABS.outstanding));
for(const status of ["proposed","accepted","submitted"])assert.ok(TRACKER_OUTSTANDING_STATUSES.includes(status));
for(const status of ["refused","cancelled","rewarded","expired"])assert.ok(!TRACKER_OUTSTANDING_STATUSES.includes(status));
assert.ok((await readFile("server/campaign-tracker-model.js","utf8")).includes("[accountId,TRACKER_OUTSTANDING_STATUSES]"),"candidate query must use canonical outstanding statuses");
import {parseSummary} from "../server/campaign-tracker-contract.js";
let calls=0;
const payload={title:"Queue recovery",summary:"The retry was attempted; the assistant supplied no verified test evidence.",outcome:"attempted",taskIds:["task-one"],rationale:"Queue work matches the selected candidate"};
const env={CAMPAIGN_TRACKER_GATEWAY_ORIGIN:"http://127.0.0.1:18765"};
const options={env,fetchImpl:async(url,init)=>{
  calls++;assert.equal(init.redirect,"error");assert.equal(init.headers.authorization,"Bearer fixture-subscription");
  if(url.endsWith("/account"))return new Response(JSON.stringify({corbanuApi:{balanceMicrousd:"1000000"}}));
  const body=JSON.parse(init.body);assert.equal(body.model,TRACKER_GATEWAY_MODEL);assert.deepEqual(body.response_format,{type:"json_object"});
  assert(!body.messages.some(m=>m.content.includes("fixture-subscription")));
  return new Response(JSON.stringify({model:TRACKER_GATEWAY_MODEL,choices:[{message:{content:JSON.stringify(payload)}}]}));
}};
await trackerEntitlement("fixture-subscription",options);
const summary=await trackerGenerateSummary({output:"Try the retry again",candidates:[{id:"task-one"}]},"fixture-subscription",options);
assert.equal(summary.mappingStatus,"suggested");assert.equal(calls,2);
await assert.rejects(()=>trackerEntitlement("fixture-subscription",{env,fetchImpl:async()=>new Response(JSON.stringify({corbanuApi:{balanceMicrousd:"0"}}))}),e=>e.code==="tracker_subscription_required");
await assert.rejects(()=>trackerGenerateSummary({candidates:[]},"fixture-subscription",{env,fetchImpl:async()=>new Response(JSON.stringify({model:"another-model",choices:[]}))}),e=>e.code==="tracker_model_mismatch");
let failedCalls=0;await assert.rejects(()=>trackerGenerateSummary({candidates:[]},"fixture-subscription",{env,fetchImpl:async()=>{failedCalls++;return new Response("unavailable",{status:503});}}));assert.equal(failedCalls,1);
assert.throws(()=>parseSummary(JSON.stringify({...payload,taskIds:["unauthorized-task"]}),["task-one"]));
assert.throws(()=>parseSummary(JSON.stringify({...payload,outcome:"verified_complete"}),["task-one"]));
assert.throws(()=>parseSummary("```json\n"+JSON.stringify(payload)+"\n```",["task-one"]));
for(const filename of ["server/campaign-tracker-contract.js","server/campaign-tracker-model.js","server/campaign-tracker-routes.js","server/repositories/campaign-tracker.js","server/repositories/campaign-tracker-workflows.js"]) {
  const ast=parse(await readFile(filename,"utf8"),{ecmaVersion:"latest",sourceType:"module"});
  const walk=value=>{if(!value||typeof value!=="object")return;if(value.regex || ((value.type==="NewExpression"||value.type==="CallExpression") && value.callee?.name==="RegExp"))throw Error(`${filename}: regex is forbidden on the tracker LLM path`);for(const child of Object.values(value)){if(Array.isArray(child))child.forEach(walk);else walk(child);}};walk(ast);
}
console.log("Campaign Tracker contract smoke passed: pinned Flash route, entitlement, schema, conservative mapping, no fallback, and AST regex guard.");
