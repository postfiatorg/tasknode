#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {trackerEntitlement,trackerGenerateSummary} from "../server/campaign-tracker-model.js";
const resolved=spawnSync("corbanu-debug",["vault","auth-helper","provider/pfterminal_plan_api_key"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
const key=process.env.PFTERMINAL_PLAN_API_KEY || (resolved.status===0?resolved.stdout.trim():"");
if(!key){console.log("Live Flash smoke unavailable: no operational Corbanu subscription credential in this session. No model substituted.");process.exitCode=77;}
else {
  try {
    await trackerEntitlement(key);
    const result=await trackerGenerateSummary({output:"The test command exited with code 1. The assistant claimed completion, but verification failed.",observedFacts:{exitCode:1},repository:{label:"qa"},candidates:[],context:""},key);
    console.log(JSON.stringify({ok:true,model:result.model,outcome:result.outcome,mappingStatus:result.mappingStatus,summary:result.summary}));
  }catch(error){console.log(JSON.stringify({ok:false,error:error.code || "tracker_live_model_unavailable",message:"Live subscription/model check failed; no credential or provider response logged, no model substituted."}));process.exitCode=1;}
}
