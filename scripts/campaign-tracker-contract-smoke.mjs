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

const {text,trackerErrorResponse,validateEvent}=await import("../server/campaign-tracker-contract.js");
for (const [value,max,required,field,reason] of [
  [undefined,200,true,"title","type"], ["",200,true,"title","required"],
  ["x".repeat(201),200,true,"title","max_bytes"], ["界".repeat(67),200,true,"title","max_bytes"],
  [42,6000,true,"note","type"], ["",6000,true,"note","required"],
  ["é".repeat(251),500,false,"search","max_bytes"],
]) {
  assert.throws(()=>text(value,max,required,field),error=>{
    const body=trackerErrorResponse(error);
    assert.deepEqual(body.validation,{field,reason,maxBytes:max});
    assert.equal(body.error,"tracker_text_invalid");
    assert.ok(body.message.includes(reason==="max_bytes"?`${max} UTF-8 bytes`:reason==="required"?"is required":"must be text"));
    if(typeof value==="string"&&value.length>200)assert.ok(!JSON.stringify(body).includes(value));
    return true;
  });
}
assert.equal(text("界".repeat(66),200,true,"title"),"界".repeat(66));
assert.equal(text("é".repeat(250),500,false,"search"),"é".repeat(250));
assert.throws(()=>validateEvent({id:"event",instanceId:"instance",sessionId:"session",turnId:"turn",workspaceId:"",sequence:0}),error=>{
  assert.deepEqual(trackerErrorResponse(error).validation,{field:"event.workspaceId",reason:"required",maxBytes:200});return true;
});
assert.deepEqual(trackerErrorResponse({code:"tracker_text_invalid",validation:{field:"private-input",reason:"required",maxBytes:5,value:"must-not-leak"}}),{ok:false,error:"tracker_text_invalid",message:"tracker text invalid"});
for(const key of [undefined,null,""," \t"])await assert.rejects(()=>trackerEntitlement(key,{env,fetchImpl:()=>{throw Error("must not call gateway without credential");}}),error=>{
  assert.equal(error.code,"tracker_credential_required");assert.ok(trackerErrorResponse(error).message.includes("Link Corbanu API"));return true;
});
await assert.rejects(()=>trackerEntitlement("secret".repeat(1000),{env,fetchImpl:()=>{throw Error("oversized key must not leave server");}}),error=>{
  assert.deepEqual(trackerErrorResponse(error).validation,{field:"apiKey",reason:"max_bytes",maxBytes:4096});assert.ok(!JSON.stringify(trackerErrorResponse(error)).includes("secret"));return true;
});
console.log("Tracker validation: typed field metadata, UTF-8 boundaries, credential guidance and safe error envelopes passed.");

// repository.remote: bounded https text; garbage is a 400, never a 500, and never stored as a non-string.
const remoteEvent=remote=>validateEvent({id:"evt-1",instanceId:"inst-1",sessionId:"sess-1",turnId:"turn-1",sequence:1,workspaceId:"ws-1",kind:"tool",occurredAt:new Date(Date.now()-60_000).toISOString(),content:"x",repository:{remote}});
const remoteBase="https://github.com/";
for(const remote of ["https://github.com/postfiatorg/tasknode",remoteBase+"a".repeat(2048-remoteBase.length),remoteBase+"é".repeat(1014),undefined,null,""])assert.equal(remoteEvent(remote).repository.remote,remote);
for(const [remote,code,reason] of [
  ["not a url","tracker_remote_invalid"], ["https://","tracker_remote_invalid"], ["1".repeat(400),"tracker_remote_invalid"],
  ["http://github.com/x","tracker_remote_invalid"], ["https://user:pw@github.com/x","tracker_remote_invalid"],
  ["https://github.com/x?y=1","tracker_remote_invalid"], ["https://github.com/x#y","tracker_remote_invalid"],
  [123,"tracker_text_invalid","type"], [0,"tracker_text_invalid","type"], [Infinity,"tracker_text_invalid","type"],
  [{},"tracker_text_invalid","type"], [{href:"https://github.com/a"},"tracker_text_invalid","type"],
  [["https://github.com/a"],"tracker_text_invalid","type"], [true,"tracker_text_invalid","type"], [false,"tracker_text_invalid","type"],
  [remoteBase+"a".repeat(2049-remoteBase.length),"tracker_text_invalid","max_bytes"], [remoteBase+"é".repeat(1015),"tracker_text_invalid","max_bytes"],
]) {
  assert.throws(()=>remoteEvent(remote),error=>{
    assert.equal(error.status,400);assert.equal(error.code,code);
    const body=trackerErrorResponse(error);assert.equal(body.error,code);
    if(reason){assert.deepEqual(body.validation,{field:"repository.remote",reason,maxBytes:2048});assert.ok(body.message.startsWith("Repository remote "));}
    else assert.equal(body.validation,undefined);
    return true;
  },`remote ${JSON.stringify(remote)?.slice(0,60)}`);
}
console.log("Tracker repository.remote: bounded https text, typed 400s for non-string, oversize and unparseable remotes passed.");
