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
 await page.goto(WEB+'/#l1-wallet');
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-test-only-passphrase');
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).click();
 await page.getByTestId('l1-address').waitFor();
 const address=await page.getByTestId('l1-address').textContent();assert.match(address,/^pf[0-9a-f]{40}$/);
 await page.screenshot({path:EVIDENCE+'/custody.png'});
 await page.reload();
 await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).waitFor();
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-test-only-passphrase');
 await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).click();
 await page.getByTestId('l1-address').waitFor();
 assert.equal(await page.getByTestId('l1-address').textContent(),address);
 assert.deepEqual(errors,[]);
 console.log('PASS: served page creates devnet-2 pf address with real WASM; encrypted IndexedDB vault unlocks to same address after reload. Synthetic account only.');
} finally {await browser.close();}
