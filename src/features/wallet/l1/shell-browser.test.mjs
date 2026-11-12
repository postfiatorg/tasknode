import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>route.fulfill({json:route.request().url().includes('/api/app-state')?{session:{status:'signed_in',accountId:'synthetic-l1-account'},wallet:{},tasks:{},chat:{conversations:[],messages:[]}}:{}}));
 await page.route('**/runtime-config*',route=>route.fulfill({contentType:'application/json',body:'{}'}));
 await page.goto('http://127.0.0.1:5198/#l1-wallet');
 await page.getByRole('navigation',{name:'L1 wallet tabs'}).waitFor();
 for(const name of ['Home','Send','Activity','Bridge','Market','Issuer','Redeem']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
 await page.reload();
 await page.getByRole('navigation',{name:'L1 wallet tabs'}).waitFor();
 await page.screenshot({path:'/home/postfiat/repos/b23-coord/evidence/wallet/shell.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS: served Task Node #l1-wallet, signed-in synthetic account, seven tabs, reload; no runtime errors. Authentication is fixture-backed.');
} finally {await browser.close();}
