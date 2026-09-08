#!/usr/bin/env node
// Local-only PTY qualification server. Uses the real tracker handlers and a
// disposable PostgreSQL schema; inference/auth identities are explicit fixtures.
import http from "node:http";
import {randomUUID,randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import pg from "pg";
const info=JSON.parse(execFileSync("docker",["inspect","tasknodeofficial-db-1"],{encoding:"utf8"}))[0];
const env=Object.fromEntries(info.Config.Env.map(s=>{const i=s.indexOf("=");return[s.slice(0,i),s.slice(i+1)];}));
const dbUrl=new URL("postgresql://127.0.0.1:5436/");dbUrl.username=env.POSTGRES_USER;dbUrl.password=env.POSTGRES_PASSWORD;dbUrl.pathname=env.POSTGRES_DB;
const admin=new pg.Client({connectionString:dbUrl.toString()});await admin.connect();
const schema=`tracker_pty_${randomUUID().split("-").join("")}`;await admin.query(`CREATE SCHEMA ${schema}`);
dbUrl.searchParams.set("options",`-c search_path=${schema},public`);process.env.DATABASE_URL=dbUrl.toString();process.env.TASKNODE_DATABASE_ENABLED="true";
process.env.CAMPAIGN_TRACKER_ENCRYPTION_KEY=randomBytes(32).toString("base64");
const {query,closePool}=await import("../server/db/pool.js");
const {handleCampaignTrackerRoute}=await import("../server/campaign-tracker-routes.js");
await query("CREATE TABLE app_accounts(account_id text PRIMARY KEY,hive_handle text,status text DEFAULT 'active'); CREATE TABLE task_history_grants(grant_id uuid PRIMARY KEY,subject_account_id text,viewer_account_id text,status text); CREATE TABLE task_projections(task_id text PRIMARY KEY,account_id text,status text)");
await query(await readFile(new URL("../server/db/migrations/140_campaign_tracker.sql",import.meta.url),"utf8"));
await query("INSERT INTO app_accounts VALUES('tracker-qa-alice','tracker-qa-alice','active'),('tracker-qa-bob','tracker-qa-bob','active')");
const relation=randomUUID();await query("INSERT INTO task_history_grants VALUES($1,'tracker-qa-alice','tracker-qa-bob','active')",[relation]);
let summaryFailure=false;
const json=(res,status,body)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
const readJson=async req=>{let text="";for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1200*1024)throw Error("request too large");}return text?JSON.parse(text):{};};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,"http://127.0.0.1");
    if(url.pathname==="/qa/summary-failure"){summaryFailure=(await readJson(req)).enabled===true;return json(res,200,{ok:true});}
    if(url.pathname==="/responses" || url.pathname==="/v1/responses") {
      await readJson(req);
      const id=`resp_${randomUUID()}`,message={id:`msg_${randomUUID()}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"TRACKER_OK — inspected the requested workflow. This is a local QA model response.",annotations:[]}]};
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
      const send=(type,extra)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...extra})}\n\n`);
      send("response.created",{response:{id,object:"response",status:"in_progress",output:[]}});
      send("response.output_item.added",{output_index:0,item:{...message,status:"in_progress",content:[]}});
      send("response.content_part.added",{item_id:message.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
      send("response.output_text.delta",{item_id:message.id,output_index:0,content_index:0,delta:message.content[0].text});
      send("response.output_text.done",{item_id:message.id,output_index:0,content_index:0,text:message.content[0].text});
      send("response.output_item.done",{output_index:0,item:message});
      send("response.completed",{response:{id,object:"response",status:"completed",output:[message],usage:{input_tokens:30,output_tokens:20,total_tokens:50}}});res.end();return;
    }
    const token=req.headers.authorization;
    const accountId=token==="Bearer tracker-qa-alice-token"?"tracker-qa-alice":token==="Bearer tracker-qa-bob-token"?"tracker-qa-bob":"";
    if(!accountId)return json(res,401,{ok:false,error:"fixture_terminal_auth_required"});
    if(url.pathname==="/api/terminal/tasknode/status")return json(res,200,{ok:true,accountId,github:{linked:true,username:accountId},wallet:{linked:true},counts:{outstanding:0,verification:0,refused:0,rewarded:0}});
    if(url.pathname==="/api/terminal/tasknode/requests")return json(res,200,{ok:true,items:[]});
    if(url.pathname==="/api/terminal/tasknode/campaign-tracker/team")return json(res,200,{ok:true,members:[{accountId:"tracker-qa-bob",relationship:"collaborator",identity:{hiveHandle:"tracker-qa-bob"}}]});
    const handled=await handleCampaignTrackerRoute({json,readJson,req,res,url,session:{accountId}}, {
      entitlement:async key=>{if(key!=="tracker-qa-plan-token")throw Object.assign(Error("tracker_subscription_required"),{code:"tracker_subscription_required",status:402});},
      summarize:async(_account,_event)=>{if(summaryFailure)throw Error("fixture provider unavailable");return {title:"Workflow inspection",summary:"The assistant reported inspecting the workflow. No tool verification was observed.",outcome:"reported_complete",taskIds:[],rationale:"No task selected",mappingStatus:"unmapped",model:"zai/glm-5.3-flash",schema:1};},
    });
    if(!handled)json(res,404,{ok:false,error:"fixture_route_not_found"});
  }catch{if(!res.headersSent)json(res,500,{ok:false,error:"fixture_request_failed"});else res.end();}
});
server.listen(18764,"127.0.0.1",()=>console.log("Campaign Tracker local PTY server ready on port 18764 (real PostgreSQL and tracker routes; fixture identity and inference)."));
async function stop(){server.close();await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();process.exit(0);}
process.on("SIGTERM",stop);process.on("SIGINT",stop);
