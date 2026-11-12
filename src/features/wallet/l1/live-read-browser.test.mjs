// Opt-in read-only acceptance. Never submits transactions or signs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerL1Gateway } from '../../../../server/l1/gateway.js';
if (!process.env.L1_WALLET_PROXY_URL || !process.env.L1_READ_ADDRESS) throw new Error('Set the OPS contract proxy URL and public pf address');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const server=createServer(async(req,res)=>{try{const r=await fetch('http://127.0.0.1:5198'+req.url);res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'text/plain'});res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(502);res.end();}});
const gateway=registerL1Gateway(server,{getSession:async token=>token==='synthetic-read-session'?{authenticated:true,accountId:'synthetic-read-account'}:null,sessionCookieName:'sid',cookieValue:req=>req.headers.cookie?.split('=')[1],json:(r,s,b)=>{r.writeHead(s);r.end(JSON.stringify(b));},readJson:async()=>({})});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext();await context.addCookies([{name:'sid',value:'synthetic-read-session',url:origin}]);const page=await context.newPage();await page.goto(origin);
 const result=await page.evaluate(async address=>{const {RpcClient,rpcResult}=await import('/src/features/wallet/l1/lib/rpc-client.js');const rpc=new RpcClient();try{
  const info=rpcResult(await rpc.call('server_info'));const account=rpcResult(await rpc.call('account',{address}));const lines=rpcResult(await rpc.call('account_lines',{account:address}));return {info,account,lines};
 }finally{rpc.close();}},process.env.L1_READ_ADDRESS);
 const chain=result.info.chain_id || result.account.chain_id;assert.equal(chain,'postfiat-wan-devnet-2');const account=result.account.account||result.account;assert.ok(BigInt(account.balance)>0n);
 await context.clearCookies();const rejected=await page.evaluate(async()=>{const {RpcClient}=await import('/src/features/wallet/l1/lib/rpc-client.js');const rpc=new RpcClient();try{await rpc.call('server_info');return false;}catch{return true;}finally{rpc.close();}});assert.equal(rejected,true);
 console.log(JSON.stringify({observedAt:new Date().toISOString(),chain,address:process.env.L1_READ_ADDRESS,balanceAtoms:String(account.balance),assetLineCount:result.lines.lines?.length,loggedOutRejected:rejected,authentication:'synthetic session adapter with production authenticated:true shape',data:'LIVE OPS wallet-proxy devnet-2 read',methods:['server_info','account','account_lines'],chainWrites:0},null,2));
}finally{await browser.close();gateway.close();await new Promise(r=>server.close(r));}
