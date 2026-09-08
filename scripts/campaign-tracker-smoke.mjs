#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";

// Reuse the local development Postgres process, with isolated disposable tables.
// Credentials stay in memory and are never printed or written to artifacts.
let base=process.env.CAMPAIGN_TRACKER_TEST_DATABASE_URL;
if (!base) {
  const info=JSON.parse(execFileSync("docker",["inspect","tasknodeofficial-db-1"],{encoding:"utf8"}))[0];
  const env=Object.fromEntries(info.Config.Env.map(s=>{const i=s.indexOf("=");return [s.slice(0,i),s.slice(i+1)];}));
  const url=new URL("postgresql://127.0.0.1:5436/");url.username=env.POSTGRES_USER;url.password=env.POSTGRES_PASSWORD;url.pathname=env.POSTGRES_DB;base=url.toString();
}
const admin=new pg.Client({connectionString:base});await admin.connect();
const schema=`tracker_test_${randomUUID().split("-").join("")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const url=new URL(base);url.searchParams.set("options",`-c search_path=${schema},public`);
process.env.DATABASE_URL=url.toString();process.env.TASKNODE_DATABASE_ENABLED="true";
process.env.CAMPAIGN_TRACKER_ENCRYPTION_KEY=randomBytes(32).toString("base64");
const { query,closePool }=await import("../server/db/pool.js");
const store=await import("../server/repositories/campaign-tracker.js");
const {trackerMetrics}=await import("../server/campaign-tracker-metrics.js");
const workflows=await import("../server/repositories/campaign-tracker-workflows.js");
const {validateEvent,parseSummary,seal,unseal}=await import("../server/campaign-tracker-contract.js");
let checks=0;
const check=(fn)=>{fn();checks++;};
const reject=async(fn,code)=>{await assert.rejects(fn,e=>e.code===code);checks++;};
const now=new Date().toISOString();
const event=(id,sequence,extra={})=>({id,instanceId:"instance",sessionId:"thread",turnId:"root",sequence,workspaceId:"workspace",kind:"human_prompt",occurredAt:now,content:"Reproduce the queue failure.\nVerify the retry behavior. 界",repository:{label:"payments"},goal:{active:false},facts:{},taskIds:[],...extra});
try {
  await query("CREATE TABLE app_accounts(account_id text PRIMARY KEY,hive_handle text,status text DEFAULT 'active'); CREATE TABLE task_history_grants(grant_id uuid PRIMARY KEY,subject_account_id text,viewer_account_id text,status text); CREATE TABLE task_projections(task_id text PRIMARY KEY,account_id text,status text)");
  await query(await readFile(new URL("../server/db/migrations/140_campaign_tracker.sql",import.meta.url),"utf8"));
  await query("INSERT INTO app_accounts VALUES('alice','alice','active'),('bob','bob','active'),('eve','eve','active')");
  const rel=randomUUID();await query("INSERT INTO task_history_grants VALUES($1,'alice','bob','active')",[rel]);
  await reject(()=>store.trackerIngest("alice",event("first",0)),"tracker_workspace_not_enrolled");
  await store.trackerEnroll("alice","workspace",true);
  const expired=await store.trackerIngest("alice",event("ancient",999,{occurredAt:"2020-01-01T00:00:00Z"}));
  check(()=>assert.equal(expired.summaryState,"deleted"));
  const receipt=await store.trackerIngest("alice",event("first",0));check(()=>assert.equal(receipt.replayed,false));
  const retries=await Promise.all(Array.from({length:8},()=>store.trackerIngest("alice",event("first",0))));check(()=>assert(retries.every(r=>r.replayed)));
  await reject(()=>store.trackerIngest("alice",event("first",0,{content:"Different intent"})),"tracker_idempotency_conflict");
  await reject(()=>store.trackerIngest("alice",event("forged",1,{accountId:"bob"})),"tracker_unknown_field");
  await store.trackerIngest("alice",event("second",1));
  const metrics=await trackerMetrics("alice");check(()=>assert.equal(metrics.metrics.humanPrompts,2));check(()=>assert.equal(metrics.metrics.verifiedTaskCompletions,0));
  let page=await store.trackerRead("alice");check(()=>assert.equal(page.items.length,2));check(()=>assert.equal(page.items[0].content,event("",0).content));
  await reject(()=>store.trackerRead("eve",{accountId:"alice"}),"tracker_access_denied");
  await reject(()=>store.trackerRead("bob",{accountId:"alice"}),"tracker_access_denied");
  const grant=await store.trackerGrant("alice",{handle:"@bob",capabilities:["summary","replay"],historyFrom:"2020-01-01T00:00:00Z",expiresAt:"2030-01-01T00:00:00Z"});
  page=await store.trackerRead("bob",{accountId:"alice",replay:true});check(()=>assert(page.items.every(i=>i.content===""&&i.promptWithheld)));
  await store.trackerRevoke("alice",grant.grantId);await reject(()=>store.trackerRead("bob",{accountId:"alice"}),"tracker_access_denied");
  const promptGrant=await store.trackerGrant("alice",{handle:"bob",capabilities:["summary","prompt","replay"],historyFrom:"2020-01-01T00:00:00Z",expiresAt:"2030-01-01T00:00:00Z"});
  page=await store.trackerRead("bob",{accountId:"alice",replay:true});check(()=>assert.equal(page.items[0].content,event("",0).content));
  await reject(()=>workflows.trackerAnnotate("bob",{accountId:"alice",id:"first",revision:1,kind:"review",scores:{clarity:4,context:3,constraints:3,successCriteria:4,iteration:null},note:"Clear failure and retry scope"}),"tracker_review_access_denied");
  await workflows.trackerAnnotate("alice",{id:"first",revision:1,kind:"review",scores:{clarity:4,context:3,constraints:3,successCriteria:4,iteration:null},note:"Clear failure and retry scope"});
  const reviews=await workflows.trackerAnnotations("alice","alice","first");check(()=>assert.equal(reviews.items[0].evaluator,"human"));
  await query("INSERT INTO task_projections VALUES('mapped-task','alice','rewarded')");
  await workflows.trackerAnnotate("alice",{id:"first",revision:1,kind:"mapping",taskIds:["mapped-task"],note:"Corrected from the observed work"});
  const corrected=(await store.trackerRead("alice",{id:"first"})).items[0];
  check(()=>assert.deepEqual(corrected.taskIds,["mapped-task"]));
  check(()=>assert.equal(corrected.revision,2));
  const correctedMetrics=await trackerMetrics("alice");
  check(()=>assert.equal(correctedMetrics.metrics.verifiedTaskCompletions,1));
  await reject(()=>workflows.trackerAnnotate("alice",{id:"first",revision:99,kind:"review",scores:{clarity:4,context:3,constraints:3,successCriteria:4,iteration:null},note:"Stale review"}),"tracker_revision_conflict");
  await workflows.trackerCreateCampaign("alice",{title:"Queue reliability",objective:"Make recovery observable",memberHandles:["bob"],taskIds:[]});
  const campaigns=await workflows.trackerCampaigns("bob");check(()=>assert.equal(campaigns.items.length,1));
  const outsiderCampaigns=await workflows.trackerCampaigns("eve");check(()=>assert.equal(outsiderCampaigns.items.length,0));
  const exported=await store.trackerRead("bob",{accountId:"alice",export:true});check(()=>assert.equal(exported.items.length,0));
  await query("UPDATE task_history_grants SET status='revoked' WHERE grant_id=$1",[rel]);await reject(()=>store.trackerRead("bob",{accountId:"alice"}),"tracker_access_denied");
  await reject(()=>store.trackerRevoke("eve",promptGrant.grantId),"tracker_grant_not_found");
  const output=event("output",2,{kind:"agent_output",content:"A very large raw provider response must never be archived."});await store.trackerIngest("alice",output);
  const raw=(await query("SELECT payload_envelope FROM campaign_tracker_activity WHERE event_id='output'")).rows[0];
  check(()=>assert(!JSON.stringify(raw).includes(output.content)));check(()=>assert.equal(unseal(raw.payload_envelope,"alice:output").content,""));
  const summary=parseSummary(JSON.stringify({title:"Queue retry investigation",summary:"The assistant reports a fix; verification was not supplied.",outcome:"reported_complete",taskIds:[],rationale:"No task supplied"}),[]);
  await store.trackerCompleteSummary("alice","output",summary);page=await store.trackerRead("alice",{id:"output"});check(()=>assert.equal(page.items[0].summaryState,"ready"));
  check(()=>assert.throws(()=>parseSummary(JSON.stringify({...summary,taskIds:["foreign"]}),[])));
  check(()=>assert.throws(()=>validateEvent(event("remote",3,{repository:{remote:"https://credential@example.com/private"}}))));
  const envelope=seal({secret:"sensitive prompt"},"alice:id");check(()=>assert.throws(()=>unseal(envelope,"bob:id")));
  await reject(()=>store.trackerIngest("alice",event("quota",3),{quotaBytes:1}),"tracker_storage_quota");
  await store.trackerEnroll("alice","workspace",false);await reject(()=>store.trackerIngest("alice",event("paused",3)),"tracker_workspace_not_enrolled");
  await store.trackerDelete("alice","first");
  const deletedRetry=await store.trackerIngest("alice",event("first",0));check(()=>assert.equal(deletedRetry.summaryState,"deleted"));
  await reject(()=>store.trackerRead("alice",{id:"first"}),"tracker_activity_not_found");
  const audit=await store.trackerAuditList("alice");check(()=>assert(audit.items.some(a=>a.action==="revoke")&&audit.items.some(a=>a.action==="replay")));
  await query("UPDATE campaign_tracker_activity SET expires_at=now()-interval '1 second'");await store.trackerExpire();
  const remaining=await query("SELECT count(*)::int AS count FROM campaign_tracker_activity");check(()=>assert.equal(remaining.rows[0].count,0));
  console.log(`Campaign Tracker PostgreSQL smoke: ${checks} checks passed. Isolated schema removed.`);
} finally {await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
