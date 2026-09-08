#!/usr/bin/env node
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
const root="/mnt/HC_Volume_101713660/pfrpc/scratch/campaign-tracker-qa";
async function get(path,who="alice") {
 const r=await fetch(`http://127.0.0.1:18764/api/terminal/tasknode/campaign-tracker${path}`,{headers:{authorization:`Bearer tracker-qa-${who}-token`}});
 return {status:r.status,...await r.json()};
}
const phase=process.argv[2];
const page=await get("/activity");assert.equal(page.status,200);
const human=page.items.filter(e=>e.kind==="human_prompt");
if(phase==="before") {
 assert.equal(human.length,2);assert.equal(page.items.length,6);
 assert.equal(human.find(e=>e.content.includes("audit alpha")).content,"Inspect the retry workflow; preserve this exact prompt: audit alpha 界.");
 assert(page.items.every(e=>e.accountId==="tracker-qa-alice" && e.repository.remote==="https://github.com/CorbanuCore/CorbanuTerminal.git"));
 assert.equal(page.items.filter(e=>e.summaryState==="pending").length,1);
 await writeFile(`${root}/before-restart.json`,JSON.stringify(page,null,2));
} else if(phase==="after") {
 const prior=JSON.parse(await readFile(`${root}/before-restart.json`,"utf8"));
 assert.deepEqual(page.items.map(e=>e.id).sort(),prior.items.map(e=>e.id).sort());
 assert.equal(page.items.filter(e=>e.summaryState==="ready").length,2);
 assert(page.items.filter(e=>e.kind==="agent_output").every(e=>e.content===""));
 const totals=await get("/metrics");assert.equal(totals.metrics.humanPrompts,2);assert.equal(totals.metrics.rootRuns,2);assert.equal(totals.metrics.verifiedTaskCompletions,0);
 await writeFile(`${root}/after-restart.json`,JSON.stringify({page,totals},null,2));
} else if(phase==="shared") {
 const shared=await get("/replay?accountId=tracker-qa-alice","bob");assert.equal(shared.status,200);assert(shared.items.some(e=>e.content.includes("audit alpha")));
 const exp=await get("/export?accountId=tracker-qa-alice","bob");assert.equal(exp.items?.length || 0,0);
 await writeFile(`${root}/shared-access.json`,JSON.stringify(shared,null,2));
} else if(phase==="revoked") {
 const denied=await get("/replay?accountId=tracker-qa-alice","bob");assert.equal(denied.status,403);
 await writeFile(`${root}/revoked-access.json`,JSON.stringify(denied,null,2));
} else if(phase==="paused") {
 const status=await get("/status");assert(status.enrollments.every(e=>!e.enabled));assert.equal(status.usage.pending,0);
 const totals=await get("/metrics");assert.equal(totals.metrics.humanPrompts,4);
 assert(!page.items.some(e=>e.content.includes("Paused recording test")));
 const campaigns=await get("/campaigns");assert(campaigns.items.some(c=>c.title==="QA Campaign - Retry visibility"));
 await writeFile(`${root}/paused-check.json`,JSON.stringify({status,totals,campaigns},null,2));
} else if(phase==="review") {
 const source=human.find(e=>e.content.startsWith("Final gamma:"));assert(source);
 const reviews=await get(`/annotations?accountId=tracker-qa-alice&id=${source.id}`);assert.equal(reviews.items.length,1);
 assert.equal(reviews.items[0].sourceRevision,source.revision);assert.equal(reviews.items[0].rubricVersion,"prompt-quality-v1");
 assert.deepEqual(Object.values(reviews.items[0].scores),[4,4,4,4,4]);
 assert.equal(reviews.items[0].note,"Clear retry objective and evidence requirement; missing reproduction context limits confidence.");
 await writeFile(`${root}/prompt-review.json`,JSON.stringify({source,reviews},null,2));
} else if(phase==="goal") {
 const totals=await get("/metrics");assert.equal(totals.metrics.humanPrompts,3);assert(totals.metrics.goalRuns>0);assert.equal(totals.metrics.verifiedTaskCompletions,0);assert.equal(totals.complete,true);
 await writeFile(`${root}/goal-metrics.json`,JSON.stringify(totals,null,2));
} else throw Error("Unknown phase");
console.log(`Campaign Tracker PTY-backed ${phase} assertions passed.`);
