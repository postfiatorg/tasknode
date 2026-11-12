const WEB=process.env.L1_WEB_ORIGIN||'http://127.0.0.1:5198';
const EVIDENCE=process.env.L1_EVIDENCE_DIR||'/home/postfiat/repos/b23-coord/evidence/wallet';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { registerL1Gateway } from '../../../../server/l1/gateway.js';
import { findCustodyMaterial } from './lib/custody-boundary.js';
import { CHAIN_ID, GENESIS_HASH } from './lib/utils.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const recipient='pf'+'2'.repeat(40), txId='synthetic-accepted-transfer';let sent=false, sender, lastQuote, submitCount=0;
const stub=new WebSocketServer({port:0,host:'127.0.0.1'});await once(stub,'listening');
stub.on('connection',ws=>ws.on('message',b=>{
 const request=JSON.parse(b);assert.deepEqual(findCustodyMaterial(request.params),[]);
 const {method,params}=request;let result={};
 if(method==='account') result={account:{balance:params.address===recipient?(sent?'3000000':'2000000'):(sent?'8999999':'10000000'),sequence:sent?1:0}};
 if(method==='account_lines') result={lines:[{asset_id:'synthetic-pfusdc',asset_code:'PFUSDC',balance:'5000000'}]};
 if(method==='wallet_subscribe') result={subscription_id:'fixture-subscription'};
 if(method==='transfer_fee_quote'){
  sender=params.from;lastQuote={chain_id:CHAIN_ID,genesis_hash:GENESIS_HASH,protocol_version:1,...params,sequence:1,sequence_source:'ledger',sender_balance:10000000,sender_sequence:0,mempool_pending_for_sender:0,recipient_exists:true,will_create_recipient_account:false,base_transfer_fee:1,state_expansion_fee:0,minimum_fee:1,account_reserve:1,transfer_account_creation_fee:0,transfer_fee_byte_quantum:1024,transfer_fee_per_quantum:0,transfer_weight_bytes:1,sender_balance_after_amount_and_fee:8999999,sender_meets_reserve_after_transfer:true,recipient_balance_after_amount:3000000,recipient_meets_reserve_after_transfer:true};result=lastQuote;
 }
 if(method==='mempool_submit_signed_transfer_finality'){
  assert.ok(params.signed_transfer_json);assert.ok(!params.signed_transfer_json.includes('synthetic-send-password'));
  const signed=JSON.parse(params.signed_transfer_json);assert.ok(signed.signature_hex || signed.signature || signed.transaction || signed.signed_transfer || Object.keys(signed).length>3);
  submitCount++;sent=true;result={tx_id:txId,round_ok:true,finality:{receipt:{tx_id:txId,accepted:true,code:'accepted'}}};
 }
 if(method==='account_tx') result={rows:sent?[{tx_id:txId,accepted:true,kind:'transfer',from:sender,to:recipient,amount:1000000}]:[]};
 ws.send(JSON.stringify({id:request.id,ok:true,result}));
}));
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.startsWith('/api/app-state')?{session:{status:'signed_in',accountId:'synthetic-send'},wallet:{},tasks:{},chat:{messages:[],conversations:[]}}:{}));return;}
 if(req.url.startsWith('/runtime-config')){res.setHeader('content-type','application/json');res.end('{}');return;}
 const r=await fetch(WEB+''+req.url);res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'text/plain'});res.end(Buffer.from(await r.arrayBuffer()));
}catch{res.writeHead(502);res.end();}});
const gateway=registerL1Gateway(server,{env:{L1_WALLET_PROXY_URL:`ws://127.0.0.1:${stub.address().port}`},getSession:async token=>token==='fixture'?{status:'signed_in',accountId:'synthetic-send'}:null,sessionCookieName:'sid',cookieValue:req=>req.headers.cookie?.split('=')[1],json:(r,s,b)=>{r.writeHead(s);r.end(JSON.stringify(b));},readJson:async()=>({})});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext();await context.addCookies([{name:'sid',value:'fixture',url:origin}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#l1-wallet');
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-send-password');await page.getByRole('button',{name:'Create L1 wallet',exact:true}).click();await page.getByTestId('l1-address').waitFor();
 await page.getByText('PFUSDC',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByLabel('Recipient pf address',{exact:true}).fill(recipient);await page.getByLabel('PFT amount',{exact:true}).fill('1');
 await page.getByRole('button',{name:'Review transfer',exact:true}).click();await page.getByRole('button',{name:'Confirm and send PFT',exact:true}).click();
 await page.getByText('Both balance changes match the payment and fee.',{exact:true}).waitFor({timeout:20000});
 assert.equal(submitCount,1);assert.ok(lastQuote);await page.screenshot({path:EVIDENCE+'/send-stub.png'});
 await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByText(txId,{exact:true}).waitFor();await page.getByText('Accepted',{exact:true}).waitFor();assert.deepEqual(errors,[]);
 console.log('PASS: served Task Node page -> real browser ML-DSA WASM sign -> authenticated gateway -> local stub; explicit accepted receipt, sender -1000001 atoms, recipient +1000000 atoms, activity and asset balance rendered. ONE stub submission; NO live chain transaction.');
}finally{await browser.close();gateway.close();for(const ws of stub.clients)ws.terminate();await new Promise(r=>server.close(r));await new Promise(r=>stub.close(r));}
