const WEB=process.env.L1_WEB_ORIGIN||'http://127.0.0.1:5198';
const EVIDENCE=process.env.L1_EVIDENCE_DIR||'/home/postfiat/repos/b23-coord/evidence/wallet';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>route.fulfill({json:route.request().url().includes('/api/app-state')?{session:{status:'signed_in',accountId:'synthetic-l1-account'},wallet:{},tasks:{},chat:{conversations:[],messages:[]}}:{}}));
 await page.route('**/runtime-config*',route=>route.fulfill({contentType:'application/json',body:'{}'}));
 await page.routeWebSocket(/\/api\/l1\/rpc/,ws=>ws.onMessage(m=>{const r=JSON.parse(String(m));ws.send(JSON.stringify({id:r.id,ok:false,result:null,error:{code:'stub',message:'Shell test gateway stub'}}));}));
 await page.goto(WEB+'/#l1-wallet');
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'L1 wallet tabs'}).count(),0,'tabs stay hidden until the wallet is open');
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-shell-passphrase');
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).click();
 const tabs=page.getByRole('navigation',{name:'L1 wallet tabs'});await tabs.waitFor();
 for(const name of ['Home','Add funds','Market','Cash in','Send','Activity']) assert.equal(await tabs.getByRole('button',{name,exact:true}).count(),1);
 assert.equal(await tabs.getByRole('button',{name:'Issuer desk',exact:true}).count(),0);
 for (const [step, heading] of [['1 Connect MetaMask','Add funds'],['2 Convert USDC to PFUSDC','Add funds'],['3 Buy B23','Market']]) {
  await tabs.getByRole('button',{name:'Home',exact:true}).click();
  await page.getByRole('navigation',{name:'Bob journey'}).getByRole('button',{name:step,exact:true}).click();
  await page.getByRole('heading',{name:heading,exact:true}).waitFor();
 }
 await page.reload();
 await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).waitFor();
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-shell-passphrase');
 await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).click();
 await page.getByRole('navigation',{name:'L1 wallet tabs'}).waitFor();
 await page.screenshot({path:EVIDENCE+'/6b-shell.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS: served Task Node #l1-wallet, signed-in synthetic account, locked gate, six wallet tabs and no issuer desk link, Bob Connect/Convert/Buy navigation from Home, reload and unlock; no runtime errors. Authentication and gateway are fixture-backed.');
} finally {await browser.close();}
