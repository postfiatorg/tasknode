import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { registerL1Gateway } from '../../../../server/l1/gateway.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const stub=new WebSocketServer({port:0,host:'127.0.0.1'});await once(stub,'listening');
stub.on('connection',ws=>ws.on('message',b=>{const r=JSON.parse(b);ws.send(JSON.stringify({id:r.id,ok:true,result:{chain_id:'postfiat-wan-devnet-2',account:{balance:'7000000'}}}));}));
const server=createServer(async(req,res)=>{try{const r=await fetch('http://127.0.0.1:5198'+req.url);res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'text/plain'});res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(502);res.end();}});
const gateway=registerL1Gateway(server,{env:{L1_WALLET_PROXY_URL:`ws://127.0.0.1:${stub.address().port}`},getSession:async token=>token==='fixture'?{status:'signed_in',accountId:'test-browser'}:null,sessionCookieName:'sid',cookieValue:req=>req.headers.cookie?.split('=')[1],json:(r,s,b)=>{r.writeHead(s);r.end(JSON.stringify(b));},readJson:async()=>({})});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext();await context.addCookies([{name:'sid',value:'fixture',url:origin}]);const page=await context.newPage();await page.goto(origin);
 const result=await page.evaluate(async()=>{const {RpcClient}=await import('/src/features/wallet/l1/lib/rpc-client.js');const rpc=new RpcClient();try{return await rpc.call('account',{address:'pf'+'1'.repeat(40)});}finally{rpc.close();}});
 assert.equal(result.result.chain_id,'postfiat-wan-devnet-2');assert.equal(result.result.account.balance,'7000000');
 await context.clearCookies();
 const rejected=await page.evaluate(async()=>{const {RpcClient}=await import('/src/features/wallet/l1/lib/rpc-client.js');const rpc=new RpcClient();try{await rpc.call('account',{});return false;}catch{return true;}finally{rpc.close();}});assert.equal(rejected,true);
 console.log('PASS: browser same-origin RpcClient -> session-protected Task Node gateway -> local devnet-2 data stub; logged-out browser rejected. This is transport evidence, not live devnet proof.');
}finally{await browser.close();gateway.close();for(const ws of stub.clients)ws.terminate();await new Promise(r=>server.close(r));await new Promise(r=>stub.close(r));}
