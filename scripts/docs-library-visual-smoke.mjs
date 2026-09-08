import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const WebSocket=require('ws');
const cdpOrigin = `http://127.0.0.1:${process.env.CDP_PORT || 9347}`;
const browserInfo = await fetch(cdpOrigin + '/json/version').then(r => r.json());
const browserSocket = new WebSocket(browserInfo.webSocketDebuggerUrl);
await new Promise(resolve => browserSocket.once('open', resolve));
let browserId = 0;
const browserPending = new Map();
browserSocket.on('message', raw => { const message = JSON.parse(String(raw)); const pending = browserPending.get(message.id); if (pending) { browserPending.delete(message.id); message.error ? pending.reject(message.error) : pending.resolve(message.result); } });
function browserCommand(method, params = {}) { const id = ++browserId; return new Promise((resolve, reject) => { browserPending.set(id, {resolve,reject}); browserSocket.send(JSON.stringify({id,method,params})); }); }
const {browserContextId} = await browserCommand('Target.createBrowserContext');
const {targetId} = await browserCommand('Target.createTarget', {url:'about:blank',browserContextId});
const targets = await fetch(cdpOrigin + '/json/list').then(r => r.json());
const socket = new WebSocket(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
await new Promise(r=>socket.once('open',r));
let id=0;const pending=new Map();
function command(method,params={}){const n=++id;socket.send(JSON.stringify({id:n,method,params}));return new Promise((resolve,reject)=>pending.set(n,{resolve,reject}));}
let fixture={account:{accountId:'docs_ux_fixture',encryptedRootKeyEnvelope:{}},documents:Array.from({length:6},(_,i)=>({documentId:crypto.randomUUID(),owned:true,owner:{displayName:'You'},status:'active',accessRole:'owner',channelHash:String(i+1).repeat(32),shares:[],updatedAt:'2026-09-05T10:00:00Z',taskIds:[]})),pendingShares:[],identity:{accountId:'docs_ux_fixture',displayName:'@alex',hiveHandle:'alex'}};
let walletAddress='rFixture';
const origin=process.env.TASKNODE_APP_ORIGIN || 'http://127.0.0.1:5192';
const screenshotDir=process.env.SCREENSHOT_DIR || '/home/pfrpc/repos/tasknode/docs/verification/docs-library-ux/screenshots';
const fixtureModuleOrigin=process.env.DOCS_FIXTURE_MODULE_ORIGIN;
const fixtureModules=new Set();
const config={collaboration:{docsEnabled:true,pfdocsEditorEnabled:true,pfdocsOrigin:'https://tasknode-pfdocs.fly.dev',pfdocsBridgePath:'/tasknode/',docsOdvEnabled:true},auth:{providers:[]}};
async function fulfill(requestId,body,type='application/json',code=200){await command('Fetch.fulfillRequest',{requestId,responseCode:code,responseHeaders:[{name:'Content-Type',value:type}],body:Buffer.from(typeof body==='string'?body:JSON.stringify(body)).toString('base64')});}
socket.on('message',async raw=>{const m=JSON.parse(String(raw));if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);return;}if(m.method!=='Fetch.requestPaused')return;const {requestId,request}=m.params;const path=new URL(request.url).pathname;
if(fixtureModuleOrigin && ['/src/','/node_modules/','/@id/','/@vite/'].some(prefix=>path.startsWith(prefix))){const response=await fetch(fixtureModuleOrigin+new URL(request.url).pathname+new URL(request.url).search);fixtureModules.add(path);return fulfill(requestId,await response.text(),response.headers.get('content-type')||'application/javascript',response.status);}
if(path==='/runtime-config.js')return fulfill(requestId,`window.__TASKNODE_CONFIG__=${JSON.stringify(config)};`,'application/javascript');
if(path==='/runtime-config.json')return fulfill(requestId,config);
if(path==='/api/docs')return fulfill(requestId,fixture);
if(path==='/api/docs/library'){const payload=JSON.parse(request.postData);if(payload.expectedVersion!==(fixture.account.libraryMetadataVersion||0))return fulfill(requestId,{ok:false,error:'docs_library_conflict'},'application/json',409);fixture.account.encryptedLibraryMetadata=payload.encryptedLibraryMetadata;fixture.account.libraryMetadataVersion=(fixture.account.libraryMetadataVersion||0)+1;return fulfill(requestId,{ok:true,version:fixture.account.libraryMetadataVersion});}
if(path==='/api/app-state')return fulfill(requestId,{session:{status:'signed_in',accountId:'docs_ux_fixture',displayName:'@alex',hiveHandle:'alex',identityProfile:{displayName:'@alex',handleRequired:false},linkedProviders:[],accountLinks:[]},wallet:{pftWallet:{status:'linked',address:walletAddress}},chat:{recents:[]},tasks:{outstanding:[],verification:[],refused:[],rewarded:[],sync:{status:'ready'}},usage:{availableCreditUsd:10},context:{}});
if(path.startsWith('/api/'))return fulfill(requestId,{});
await command('Fetch.continueRequest',{requestId});});
async function evalJs(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
await command('Page.enable');await command('Runtime.enable');await command('Fetch.enable',{patterns:[{urlPattern:'*'}]});
await command('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
await command('Page.navigate',{url:origin+'/#docs'});await delay(4500);
await mkdir(screenshotDir,{recursive:true});
async function shot(name){const img=await command('Page.captureScreenshot',{format:'png'});await writeFile(screenshotDir+'/'+name+'.png',Buffer.from(img.data,'base64'));}
assert.equal(await evalJs("document.querySelectorAll('.docs-unlock-panel button').length"),1);
await shot('after-locked-desktop');
const seeded=await evalJs(`(async()=>{const wallet=await import('/src/wallet-core.js'); const crypto=await import('/src/features/docs-library/docs-crypto.js'); const mnemonic=wallet.generateTaskNodeMnemonic(); const summary=wallet.deriveWalletSummary(mnemonic); await wallet.saveEncryptedMnemonicVault({accountId:'docs_ux_fixture',mnemonic,password:'fixture-password-only'}); const rootKey=crypto.createDocsRootKey(); const encryptedRootKeyEnvelope=await wallet.encryptTaskNodePayload({plaintext:JSON.stringify({rootKey}),recipientPublicKeys:[await wallet.deriveTaskNodePublicKey(mnemonic)]});const titles=['Product direction','Research notes','Launch budget','Team handbook','September plan','Project forecast']; const docs=await Promise.all(titles.map((title,i)=>crypto.encryptDocsMetadata({title,documentType:[2,5].includes(i)?'sheet':'pad',editHref:([2,5].includes(i)?'/sheet/':'/pad/')+'#/2/pad/edit/fixture/',viewHref:'/pad/#/2/pad/view/fixture/'},rootKey)));globalThis.__docsFixtureSeed={mnemonic,summary,rootKey};return {summary,encryptedRootKeyEnvelope,docs};})()`);
walletAddress=seeded.summary.address;fixture.account.encryptedRootKeyEnvelope=seeded.encryptedRootKeyEnvelope;fixture.documents.forEach((d,i)=>d.encryptedMetadata=seeded.docs[i]);
await writeFile('/tmp/tasknode-docs-fixture.json',JSON.stringify({fixture,walletAddress}));
await evalJs(`(async()=>{const {saveUnlockedWalletSession}=await import('/src/features/wallet/wallet-unlocked-session.js');await saveUnlockedWalletSession({accountId:'docs_ux_fixture',...globalThis.__docsFixtureSeed.summary,mnemonic:globalThis.__docsFixtureSeed.mnemonic});})()`);
await command('Page.reload');await delay(2500);await shot('after-library-desktop');

const browser=evalJs;
async function until(expression){for(let i=0;i<50;i++){if(await browser(expression))return;await delay(100);}throw new Error(expression);}
const type=(selector,text)=>`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
async function create(name){await browser("document.querySelector('.docs-add-folder').click()");await until("Boolean(document.querySelector('dialog[open] input'))");await browser(type('dialog[open] input',name));await browser("document.querySelector('dialog[open] form').requestSubmit()");await until("!document.querySelector('dialog[open]')");await until(`Array.from(document.querySelectorAll('.docs-folder-row strong')).some(e=>e.textContent===${JSON.stringify(name)})`);}
async function folder(name){await browser(`Array.from(document.querySelectorAll('.docs-folder-row .docs-file-name')).find(e=>e.textContent.includes(${JSON.stringify(name)})).click()`);}
await create('Research');await create('Planning');await folder('Research');await create('Market notes');await browser("document.querySelector('.docs-breadcrumbs>button').click()");
await browser(`(()=>{const row=Array.from(document.querySelectorAll('.docs-file-row')).find(e=>e.textContent.includes('Launch budget'));row.querySelector('summary').click();Array.from(row.querySelectorAll('button')).find(e=>e.textContent.includes('Move to folder')).click()})()`);
await until("Boolean(document.querySelector('dialog[open] select'))");await browser(`(()=>{const select=document.querySelector('dialog[open] select');select.value=Array.from(select.options).find(o=>o.text==='Research / Market notes').value;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await browser("document.querySelector('dialog[open] form').requestSubmit()");await until("!document.querySelector('dialog[open]')");
assert.ok(!(await browser("document.querySelector('.docs-file-list').innerText")).includes('Launch budget'));
await folder('Research');await folder('Market notes');assert.ok((await browser("document.querySelector('.docs-file-list').innerText")).includes('Launch budget'));
await browser("document.querySelector('.docs-breadcrumbs>button').click()");await browser(type('.docs-library-search input','budget'));await until("document.querySelectorAll('.docs-file-row').length === 1");assert.ok((await browser("document.querySelector('.docs-file-list').innerText")).includes('Research / Market notes'));
await browser("document.querySelector('[aria-label=\"Clear search\"]').click()");
await shot('after-folders-desktop');await command('Page.reload');await until("document.querySelectorAll('.docs-folder-row').length === 2");
await folder('Research');await folder('Market notes');assert.ok((await browser("document.querySelector('.docs-file-list').innerText")).includes('Launch budget'));

await browser("document.querySelector('.docs-breadcrumbs>button').click()");
await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await delay(300);
assert.equal(await browser("document.documentElement.scrollWidth > document.documentElement.clientWidth"),false);
await shot('after-folders-mobile');
await browser("(async()=>{const sessions=await import('/src/features/wallet/wallet-unlocked-session.js');sessions.clearAllUnlockedWalletSessions();})()");
await command('Page.reload');await until("Boolean(document.querySelector('.docs-unlock-panel'))");
assert.equal(await browser("document.querySelectorAll('.docs-unlock-panel button').length"),1);
assert.equal(await browser("document.querySelectorAll('.docs-file-row').length"),0);
assert.equal(await browser("document.body.innerText.includes('Launch budget')"),false);
await shot('after-locked-mobile');
await browser("document.querySelector('.docs-unlock-panel button').click()");
await until("Boolean(document.querySelector('input[type=password]'))");
await browser(type('input[type=password]','fixture-password-only'));
await browser("Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='Unlock').click()");
await until("document.querySelectorAll('.docs-folder-row').length===2");
await writeFile(screenshotDir+'/../browser-results.json',JSON.stringify({
  passed:true,origin,mode:fixtureModuleOrigin?'Deployed app assets with synthetic API fixtures and local wallet-seeding helpers':'Local app with synthetic API fixtures',fixtureModules:[...fixtureModules],checks:['one page unlock','native wallet unlock','encrypted fixtures','nested folders','move spreadsheet','breadcrumbs','global search','reload persistence','mobile overflow','clear titles on lock'],viewports:[{width:1440,height:960},{width:390,height:844}]
},null,2)+'\n');
console.log('Docs library browser checks passed. Desktop and mobile screenshots captured.');
socket.close();
await browserCommand('Target.disposeBrowserContext',{browserContextId});
browserSocket.close();
