// Full Task Node server with isolated synthetic runtime store; read-only chain calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
const marketReads = process.env.L1_LIVE_MARKET_READS === '1';
if (marketReads && (!process.env.L1_WALLET_PROXY_TOKEN_FILE || !process.env.L1_WALLET_PROXY_ORIGIN)) throw new Error('Live market reads require server token-file and Origin configuration');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const origin=`http://127.0.0.1:${port}`;
const scratch=await mkdtemp('/home/postfiat/repos/b23-coord/evidence/wallet/session-runtime-');
const server=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),NODE_ENV:'development',TASKNODE_ENV:'development',TASKNODE_BIND_HOST:'127.0.0.1',TASKNODE_PROCESS_ROLE:'web',TASKNODE_DATABASE_DISABLED:'true',TASKNODE_DATABASE_ENABLED:'false',TASKNODE_DEV_AUTH_ENABLED:'true',TASKNODE_AUTH_SECRET:'synthetic-l1-session-fixture-only',TASKNODE_STORE_PATH:scratch+'/runtime.json',TASKNODE_PUBLIC_URL:origin,VITE_SITE_ORIGIN:origin,L1_WALLET_PROXY_URL:process.env.L1_WALLET_PROXY_URL||'ws://127.0.0.1:8080/rpc',AMBIENT_API_KEY:'',VERCEL_AI_GATEWAY_API_KEY:''},stdio:'ignore'});
let browser;
try {
 let ready=false;for(let n=0;n<80;n++){if(server.exitCode!==null)throw new Error('Isolated Task Node server exited');try{const response=await fetch(origin+'/health');if(response.ok&&(await response.json()).database==='ready'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'Task Node server ready');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>console.log('Browser error:',e.message));await page.addLocatorHandler(page.getByRole('dialog',{name:'Choose Hive handle'}),async dialog=>dialog.getByRole('button',{name:'Close',exact:true}).click());await page.goto(origin);
 const status=await page.evaluate(async()=>{const r=await fetch('/api/auth/dev/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'synthetic-l1-browser@example.invalid'})});return r.status;});assert.equal(status,200);
 await page.goto(origin+'/#l1-wallet');await page.reload();
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'L1 wallet tabs'}).count(),0);
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-session-passphrase');
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).click();
 await page.getByRole('navigation',{name:'L1 wallet tabs'}).waitFor();
 await page.reload();await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).waitFor();
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-session-passphrase');
 await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).click();
 await page.getByRole('navigation',{name:'L1 wallet tabs'}).waitFor();
 // Session authorization is independent of the local wallet. Close its background reads before the dedicated RPC check.
 await page.getByRole('button',{name:'Wallet menu',exact:true}).click();
 await page.getByRole('button',{name:'Lock L1 wallet',exact:true}).click();
 const result=await page.evaluate(async marketReads=>{
  const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/l1/rpc`);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('Gateway connection failed'));});
  const call = (method,params={}) => new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Live ${method} read timed out`)),60000);ws.onclose=event=>{clearTimeout(timer);reject(new Error(`Gateway closed during ${method}: ${event.code} ${event.reason}`));};ws.onerror=()=>{clearTimeout(timer);reject(new Error(`Gateway failed during ${method}`));};ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id!==method)return;clearTimeout(timer);resolve(message);};ws.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:method,method,params}));});
  try{
   const results={info:await call('server_info'),account:await call('account',{address:'pfab9b9228942e5c529633a13aa271d5297bec6353'})};
   if(marketReads){
    results.book=await call('book_offers',{taker_gets_asset_id:'ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627',taker_pays_asset_id:'02c46a36eb0da3516b4d8affea8f4028ad3f36825a3e8f0e009ea9dbbbcfb3c233f6830bd5221fe2717fb6a1a7005d7b',limit:10});
    results.accountOffers=await call('account_offers',{account:'pfab9b9228942e5c529633a13aa271d5297bec6353',limit:10});
   }
   return results;
  }finally{ws.close();}
 },marketReads);assert.equal(result.info.ok,true,JSON.stringify(result.info.error));assert.equal(result.account.ok,true,JSON.stringify(result.account.error));assert.equal(result.info.result.chain_id,'postfiat-wan-devnet-2');assert.ok(BigInt((result.account.result.account||result.account.result).balance)>0n);
 if(marketReads){for(const method of ['book','accountOffers'])assert.ok(result[method]?.ok===true,`${method} read failed: ${result[method]?.error?.code || 'unknown'} ${result[method]?.error?.message || ''}`);}
 await page.screenshot({path:(process.env.L1_EVIDENCE_DIR||'/home/postfiat/repos/b23-coord/evidence/wallet')+'/signed-session-page.png'});
 await context.clearCookies();const rejected=await page.evaluate(async()=>{const ws=new WebSocket(`ws://${location.host}/api/l1/rpc`);return new Promise(resolve=>{ws.onopen=()=>{ws.close();resolve(false);};ws.onerror=()=>resolve(true);});});assert.equal(rejected,true);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),page:'#l1-wallet',authentication:'real Task Node dev auth and getSession, isolated synthetic account',pageReload:true,chain:result.info.result.chain_id,balanceAtoms:String((result.account.result.account||result.account.result).balance),loggedOutRejected:true,marketReads:marketReads?{book_offers:result.book,account_offers:result.accountOffers}:undefined,chainWrites:0},null,2));
}finally{
 await browser?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null){server.kill('SIGKILL');await exited;}}
 await rm(scratch,{recursive:true,force:true});
}
