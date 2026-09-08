import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture-driver.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { taskBody } from "../server/request-body-contracts.js";
import { validateJsonDocument } from "../server/request-validation.js";
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9347) });
const commands = []; let fail = true;
const html = `<!doctype html><html><body><div id="fixture"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {TaskRequestQueue} from '/src/features/tasks/TaskRequestQueue.jsx';
const root=ReactDOM.createRoot(document.getElementById('fixture'));
const request={requestId:'old_failed',accountId:'fixture_account',status:'failed',statusLabel:'Needs attention',isActive:true,canRetry:true,canDismiss:true,workerAttemptCount:2,userDetailText:'An older request whose work is no longer needed.',ago:'40d ago'};
const show=()=>root.render(React.createElement(TaskRequestQueue,{requests:[request],onRefresh:async()=>root.render(React.createElement('p',null,'No active requests'))}));show();
</script></body></html>`;
try {
 const page = await browser.page({ url: (process.env.TASKNODE_APP_ORIGIN || 'http://127.0.0.1:5192') + '/__dismiss_fixture', intercept: async request => {
   const path = new URL(request.url).pathname;
   if(path==='/__dismiss_fixture') return {body:html,type:'text/html'};
   if(path==='/api/tasks/request'){const body=JSON.parse(request.postData);commands.push(body);try{validateJsonDocument(body,taskBody.schema);}catch(error){return {code:400,body:{ok:false,message:error.message,field:error.field}};}if(fail){fail=false;return {code:503,body:{ok:false,message:'Please retry the dismissal.'}};}return {body:{ok:true,request:{requestId:'old_failed',status:'cancelled'}}};}
 }});
 await page.until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Dismiss')");
 const click = "[...document.querySelectorAll('button')].find(b=>b.textContent==='Dismiss').click()";
 await page.evaluate(click);
 await page.until("document.querySelector('[role=alert]')?.textContent.includes('Please retry')");
 assert.ok(await page.evaluate("document.body.innerText.includes('older request')"));
 await page.evaluate(click);
 await page.until("document.body.innerText.includes('No active requests')");
 assert.equal(commands.length,2);
 assert.deepEqual(commands[0],commands[1]);
 assert.equal(commands[0].phase,'dismiss');assert.equal(commands[0].expectedAttemptCount,2);assert.equal(commands[0].expectedAccountId,'fixture_account');
 const result={passed:true,mode:'Real browser and React request queue with synthetic HTTP responses',checks:['Dismiss visible on failed request','failed dismissal keeps row and shows error','retry preserves owner/request/attempt','successful dismissal refreshes the queue']};
 await mkdir('docs/verification/request-sync-2026-09-06',{recursive:true});await writeFile('docs/verification/request-sync-2026-09-06/browser-dismiss.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
} finally {await browser.close();}
