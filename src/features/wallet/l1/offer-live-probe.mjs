// Opt-in live gateway probes. No valid signed transaction is ever constructed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
if (process.env.L1_LIVE_INVALID_PROBES !== '1') throw new Error('Opt in with L1_LIVE_INVALID_PROBES=1');
const reservation=createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
const origin=`http://127.0.0.1:${port}`, scratch=await mkdtemp('/home/postfiat/repos/b23-coord/evidence/wallet/probe-runtime-');
const server=spawn(process.execPath,['server/index.js'],{env:{PATH:process.env.PATH,PORT:String(port),TASKNODE_BIND_HOST:'127.0.0.1',TASKNODE_PROCESS_ROLE:'web',NODE_ENV:'development',TASKNODE_ENV:'development',TASKNODE_DATABASE_DISABLED:'true',TASKNODE_DATABASE_ENABLED:'false',TASKNODE_DEV_AUTH_ENABLED:'true',TASKNODE_STORE_PATH:scratch+'/runtime.json',L1_WALLET_PROXY_URL:'ws://127.0.0.1:8080/rpc',L1_WALLET_PROXY_ORIGIN:'http://127.0.0.1:8080',L1_WALLET_PROXY_TOKEN_FILE:'/home/postfiat/.local/state/postfiat-a666-wallet/proxy-tokens.json'},stdio:'ignore'});
let ws;
try {
 let ready=false;
 for(let attempt=0;attempt<80;attempt++) {if(server.exitCode!==null)throw new Error('Isolated gateway exited');try{const r=await fetch(origin+'/health');ready=r.ok&&(await r.json()).database==='ready';}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,250));}
 assert.ok(ready,'Isolated API startup');
 const login=await fetch(origin+'/api/auth/dev/start',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'synthetic-invalid-probe@example.invalid'})});assert.equal(login.status,200);
 const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 ws=new WebSocket(origin.replace('http:','ws:')+'/api/l1/rpc',{origin,headers:{cookie}});await once(ws,'open');
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=method;const timer=setTimeout(()=>{ws.off('message',handler);reject(new Error(`${method} probe timeout`));},45000);const handler=data=>{const response=JSON.parse(data);if(response.id!==id)return;clearTimeout(timer);ws.off('message',handler);resolve(response);};ws.on('message',handler);ws.send(JSON.stringify({version:'postfiat-local-rpc-v1',id,method,params}));});
 const info=await call('server_info');assert.equal(info.result?.chain_id,'postfiat-wan-devnet-2');
 const offer=await call('mempool_submit_signed_offer_transaction_finality',{signed_offer_transaction_json:'THIS IS INTENTIONALLY NOT JSON OR A SIGNED TRANSACTION'});
 const receipt=await call('pftl_uniswap_receipt',{tx_id:'0'.repeat(96)});
 assert.equal(offer.ok,false,'Malformed unsigned probe must not be accepted');
 console.log(JSON.stringify({observedAt:new Date().toISOString(),through:'isolated signed-in Task Node session -> current lane gateway -> LIVE pinned proxy :8080',servedInstanceUntouched:true,chain:info.result.chain_id,offerFinality:offer,receiptRead:receipt,validSignedPayloads:0,chainWrites:0},null,2));
}finally{
 ws?.close();if(server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null){server.kill('SIGKILL');await exited;}}
 await rm(scratch,{recursive:true,force:true});
}
