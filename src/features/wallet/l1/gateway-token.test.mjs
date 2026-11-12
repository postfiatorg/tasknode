import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { registerL1Gateway, readProxyToken } from '../../../../server/l1/gateway.js';
const directory=await mkdtemp('/home/postfiat/repos/b23-coord/evidence/wallet/token-fixture-');
const tokenPath=directory+'/token';const fileToken='synthetic-file-credential';const envToken='synthetic-env-credential';
const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');
let expected=fileToken,connections=0;
upstream.on('connection',(ws,req)=>{connections++;const headerMatches=req.headers.authorization===`Bearer ${expected}`;ws.on('message',data=>{const request=JSON.parse(data);ws.send(JSON.stringify({id:request.id,ok:headerMatches&&request.proxy_auth_token===expected,result:{checked:true}}));});});
const env={L1_WALLET_PROXY_URL:`ws://127.0.0.1:${upstream.address().port}`,L1_WALLET_PROXY_TOKEN_FILE:tokenPath,L1_WALLET_PROXY_TOKEN:envToken};
const server=createServer();const gateway=registerL1Gateway(server,{env,getSession:async()=>({accountId:'synthetic',authenticated:true}),sessionCookieName:'sid',cookieValue:()=>'',json:(r,s,b)=>{r.writeHead(s);r.end(JSON.stringify(b));},readJson:async()=>({})});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;const url=origin.replace('http','ws')+'/api/l1/rpc';
async function check(){const socket=new WebSocket(url,{origin});try{await once(socket,'open');const response=once(socket,'message');socket.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:'test',method:'mempool_submit_signed_offer_transaction',params:{signed_offer_json:'{}'},proxy_auth_token:'browser-supplied-value'}));assert.ok(JSON.parse((await response)[0]).ok,'Server-side credential mismatch');}finally{socket.terminate();}}
try{
 await writeFile(tokenPath,fileToken+'\n',{mode:0o600});await check();
 expected='synthetic-rotated-credential';await writeFile(tokenPath,expected+'\n');await check();
 delete env.L1_WALLET_PROXY_TOKEN_FILE;expected=envToken;await check();
 assert.ok(await readProxyToken({})==='','No-token mode should remain available for reads');
 env.L1_WALLET_PROXY_TOKEN_FILE=directory+'/missing';const count=connections;
 const socket=new WebSocket(url,{origin});socket.on('error',()=>{});const [,response]=await once(socket,'unexpected-response');assert.equal(response.statusCode,503);socket.terminate();assert.equal(connections,count);
 await writeFile(tokenPath,'\n');await assert.rejects(readProxyToken({L1_WALLET_PROXY_TOKEN_FILE:tokenPath}),/credential file invalid/);
 console.log('PASS: token file precedence, new-connection rotation, env fallback, no-token reads, fail-closed missing/empty file, header and envelope auth; browser token cannot override. Synthetic local stub only; no credential values logged.');
}finally{gateway.close();for(const ws of upstream.clients)ws.terminate();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));await rm(directory,{recursive:true,force:true});}
