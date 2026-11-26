import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { registerL1Gateway, readProxyToken } from '../../../../server/l1/gateway.js';
const directory=await mkdtemp('/home/postfiat/repos/b23-coord/evidence/wallet/token-fixture-');
const tokenPath=directory+'/token';const fileToken='synthetic-file-credential';const envToken='synthetic-env-credential';
const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');
const expectedOrigin='http://127.0.0.1:8080';let expected=fileToken,echoCredential=false;
upstream.on('connection',(ws,req)=>{const originMatches=req.headers.origin===expectedOrigin;ws.on('message',data=>{const request=JSON.parse(data);ws.send(JSON.stringify({id:request.id,ok:originMatches&&request.proxy_auth_token===expected,result:echoCredential?{unsafe:expected}:{checked:true}}));});});
async function fixture(env){
 const server=createServer();const gateway=registerL1Gateway(server,{env:{L1_WALLET_PROXY_URL:`ws://127.0.0.1:${upstream.address().port}`,...env},getSession:async()=>({accountId:'synthetic',authenticated:true}),sessionCookieName:'sid',cookieValue:()=>'',json:(r,s,b)=>{r.writeHead(s);r.end(JSON.stringify(b));},readJson:async()=>({})});
 await gateway.ready;server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;const url=origin.replace('http','ws')+'/api/l1/rpc';
 return {gateway,url,origin,close:async()=>{gateway.close();await new Promise(r=>server.close(r));}};
}
async function check(f,ok){const socket=new WebSocket(f.url,{origin:f.origin});try{await once(socket,'open');const response=once(socket,'message');socket.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:'test',method:'book_offers',params:{},proxy_auth_token:'browser-supplied-value'}));assert.ok(JSON.parse((await response)[0]).ok===ok,'Expected token and Origin authentication result');}finally{socket.terminate();}}
let f;
try{
 await writeFile(tokenPath,JSON.stringify({'local-demo':fileToken})+'\n',{mode:0o600});
 f=await fixture({L1_WALLET_PROXY_ORIGIN:expectedOrigin,L1_WALLET_PROXY_TOKEN_FILE:tokenPath,L1_WALLET_PROXY_TOKEN:envToken});await check(f,true);
 await writeFile(tokenPath,'synthetic-replaced-after-startup');await check(f,true); // Startup snapshot must remain unchanged.
 echoCredential=true;const socket=new WebSocket(f.url,{origin:f.origin});await once(socket,'open');let received=false;socket.on('message',()=>{received=true;});const closed=once(socket,'close');socket.send(JSON.stringify({version:'postfiat-local-rpc-v1',id:'echo',method:'book_offers',params:{}}));assert.equal((await closed)[0],1011);assert.equal(received,false);echoCredential=false;await f.close();f=null;
 expected=envToken;f=await fixture({L1_WALLET_PROXY_ORIGIN:expectedOrigin,L1_WALLET_PROXY_TOKEN:envToken});await check(f,true);await f.close();f=null;
 f=await fixture({L1_WALLET_PROXY_TOKEN:envToken});await check(f,false);await f.close();f=null;
 f=await fixture({L1_WALLET_PROXY_ORIGIN:expectedOrigin});await check(f,false);await f.close();f=null;
 await writeFile(tokenPath,fileToken+'\n');assert.ok(await readProxyToken({L1_WALLET_PROXY_TOKEN_FILE:tokenPath})===fileToken,'Plain token file must be accepted');
 for(const content of ['\n','{bad JSON}',JSON.stringify({'other-principal':fileToken}),JSON.stringify({'local-demo':3})]){await writeFile(tokenPath,content);await assert.rejects(readProxyToken({L1_WALLET_PROXY_TOKEN_FILE:tokenPath}),/credential/);}
 f=await fixture({L1_WALLET_PROXY_TOKEN_FILE:directory+'/missing'});const denied=new WebSocket(f.url,{origin:f.origin});denied.on('error',()=>{});const [,res]=await once(denied,'unexpected-response');assert.equal(res.statusCode,503);denied.terminate();await f.close();f=null;
 console.log('PASS: non-public read requires upstream configured Origin AND message token; JSON local-demo/plain files, startup snapshot, env fallback, missing/invalid credentials, browser-token override rejection, and credential echo blocked. No secrets logged. Local stub only.');
}finally{await f?.close();for(const ws of upstream.clients)ws.terminate();await new Promise(r=>upstream.close(r));await rm(directory,{recursive:true,force:true});}
