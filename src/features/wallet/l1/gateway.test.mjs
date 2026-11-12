import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { registerL1Gateway } from '../../../../server/l1/gateway.js';
const upstream = new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');
const observed=[];upstream.on('connection',(ws,req)=>{assert.equal(req.headers.origin,origin);assert.equal(req.headers['x-forwarded-host'],new URL(origin).host);ws.on('message',data=>{const r=JSON.parse(data);observed.push(r.method);ws.send(JSON.stringify({id:r.id,ok:true,result:{chain_id:'postfiat-wan-devnet-2',account:{balance:'7000000'}}}));});});
let account='alice';const server=createServer((_q,r)=>r.end('existing route'));
const gateway=registerL1Gateway(server,{env:{L1_WALLET_PROXY_URL:`ws://127.0.0.1:${upstream.address().port}`},getSession:async token=>token==='fixture'&&account?{accountId:account,authenticated:true}:null,sessionCookieName:'sid',cookieValue:req=>req.headers.cookie?.split('=')[1],json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));},readJson:async()=>({})});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;const url=origin.replace('http','ws')+'/api/l1/rpc';let client;
async function denied(headers,status){const ws=new WebSocket(url,{headers});const [res]=await once(ws,'unexpected-response').then(([,r])=>[r]);assert.equal(res.statusCode,status);ws.terminate();ws.on('error',()=>{});}
try{
 assert.equal(await (await fetch(origin+'/existing')).text(),'existing route');
 assert.equal((await fetch(origin+'/api/l1/rpc')).status,401);
 await denied({origin},401);await denied({origin:'https://attacker.invalid',cookie:'sid=fixture'},403);
 client=new WebSocket(url,{headers:{origin,cookie:'sid=fixture'}});await once(client,'open');
 async function call(method,params={}){const reply=once(client,'message');client.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:method,method,params}));return JSON.parse((await reply)[0]);}
 assert.equal((await call('account',{address:'pf'+'1'.repeat(40)})).result.account.balance,'7000000');
 assert.equal((await call('governance_activate')).error.code,'l1_method_not_allowed');
 assert.equal((await call('wallet_keygen')).error.code,'l1_method_not_allowed');
 assert.equal((await call('account',{seed:'synthetic-seed-sentinel'})).error.code,'l1_custody_material_rejected');
 assert.equal((await call('account',{operation_json:'{"passphrase":"synthetic"}'})).error.code,'l1_custody_material_rejected');
 assert.deepEqual(observed,['account']);
 account='bob';const closed=once(client,'close');client.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:'stale',method:'account',params:{}}));assert.equal((await closed)[0],1008);
 account=null;await denied({origin,cookie:'sid=fixture'},401);
 console.log('PASS: local proxy stub read; signed-out and foreign Origin rejected; governance/signing RPC and nested custody material rejected; account-switched socket rejected; existing HTTP routes retained. No chain writes.');
}finally{client?.terminate();gateway.close();for(const ws of upstream.clients)ws.terminate();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));}
