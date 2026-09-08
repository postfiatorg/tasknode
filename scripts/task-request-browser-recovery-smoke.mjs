import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { browserFixture } from './browser-fixture-driver.mjs';
import { taskBody } from '../server/request-body-contracts.js';
import { validateJsonDocument } from '../server/request-validation.js';
const origin=process.env.TASKNODE_APP_ORIGIN||'http://127.0.0.1:5192';
const browser=await browserFixture({port:Number(process.env.CDP_PORT||9347)});
const commands=[], receipts=new Map();let loseNext=true;
const html=`<!doctype html><html><body><div id="fixture"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
const {createRoot}=ReactDOM;
import {TaskRequestModal} from '/src/features/tasks/TaskRequestModal.jsx';
const root=createRoot(document.getElementById('fixture'));
window.show=(accountId='browser_alice')=>root.render(React.createElement(TaskRequestModal,{accountId,directOffchain:true,linkedWalletAddress:'rFixture',onClose:()=>root.render(React.createElement('button',{id:'reopen',onClick:()=>window.show(accountId)},'Reopen'))}));
window.show();
</script></body></html>`;
async function intercept(request){const path=new URL(request.url).pathname;
 if(path==='/__task_request_fixture')return {body:html,type:'text/html'};
 if(path==='/api/tasks/request'){
  const body=JSON.parse(request.postData);commands.push(body);
  try { validateJsonDocument(body,taskBody.schema); }
  catch(error) { return {code:400,body:{ok:false,error:error.message,field:error.field,message:"The request body does not match this route's contract."}}; }
  if(body.phase==='config')return {body:{ok:true,offchainLifecycle:{enabled:true,dualWrite:false}}};
  if(body.phase==='submit'){
   const key=body.expectedAccountId+':'+body.requestId;
   if(!receipts.has(key))receipts.set(key,{ok:true,requestId:body.requestId,offchainLifecycle:{writeSource:'direct_write'}});
   if(loseNext){loseNext=false;return {fail:true};}
   return {body:receipts.get(key)};
  }
 }
}
const type=text=>`(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`;
const open=()=>browser.page({url:origin+'/__task_request_fixture',intercept});
try {
 const first=await open();await first.until("Boolean(document.querySelector('textarea'))");
 await first.evaluate(type('Recover my original request after the connection closes.'));
 await first.until("document.querySelector('.task-request-primary')?.disabled===false");
 await first.evaluate("document.querySelector('form').requestSubmit()");
 await first.until("document.body.innerText.includes('saved here for retry')");
 const original=commands.find(command=>command.phase==='submit').requestId;
 await first.command('Page.reload');await first.until("document.querySelector('textarea')?.value.includes('Recover my original request')");
 await first.until("document.querySelector('.task-request-primary')?.disabled===false");
 await first.evaluate("document.querySelector('form').requestSubmit()");
 await first.until("document.body.innerText.includes('Task request recorded')");
 assert.equal(commands.filter(command=>command.phase==='submit').at(-1).requestId,original);
 assert.equal(receipts.size,1);
 // The two real tabs share IndexedDB but race to save different fresh IDs.
 const second=await open();await second.until("Boolean(document.querySelector('textarea'))");
 const save=id=>`(async()=>{const draft=await import('/src/features/tasks/task-request-draft.js');return draft.saveTaskRequestDraft('browser_alice',{requestId:${JSON.stringify(id)},bundleId:'bundle',conversationId:'chat',userDetailText:'The same uncertain command in two tabs.'});})()`;
 const saved=await Promise.all([first.evaluate(save('one')),second.evaluate(save('two'))]);
 assert.equal(saved[0].requestId,saved[1].requestId);
 await second.command('Page.reload');await second.until("document.querySelector('textarea')?.value==='The same uncertain command in two tabs.'");
 await second.evaluate("window.show('browser_bob')");await second.until("document.querySelector('textarea')?.value===''");
 await second.evaluate("window.show('browser_alice')");await second.until("document.querySelector('textarea')?.value==='The same uncertain command in two tabs.'");
 const isolation=await first.evaluate(`(async()=>{const d=await import('/src/features/tasks/task-request-draft.js');await d.saveTaskRequestDraft('browser_alice',{requestId:'distinct',userDetailText:'A distinct intention survives the other receipt being cleared.'});await d.clearTaskRequestDraft('browser_alice',${JSON.stringify(saved[0].requestId)});return {alice:await d.readTaskRequestDraft('browser_alice'),bob:await d.readTaskRequestDraft('browser_bob')};})()`);
 assert.equal(isolation.alice.requestId,'distinct');assert.equal(isolation.bob,null);
 await mkdir('docs/verification/reliability-implementation-2026-09-05',{recursive:true});
 await writeFile('docs/verification/reliability-implementation-2026-09-05/browser-request-recovery.json',JSON.stringify({passed:true,mode:'Real React modal and browser IndexedDB with synthetic HTTP responses',checks:['lost HTTP response preserves original request','page reload recovers exact key','concurrent tabs share command','account switches hide other drafts','distinct draft survives unrelated receipt clearing'],submissions:commands.filter(command=>command.phase==='submit').length,receipts:receipts.size},null,2)+'\n');
 console.log('Browser request recovery passed: reload, uncertain response, concurrent tabs, account isolation, independent drafts.');
} finally {await browser.close();}
