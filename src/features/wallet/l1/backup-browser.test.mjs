import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();let account='backup-source';
 await page.route('**/api/**',r=>r.fulfill({json:r.request().url().includes('/api/app-state')?{session:{status:'signed_in',accountId:account},wallet:{},tasks:{},chat:{conversations:[],messages:[]}}:{}}));
 await page.route('**/runtime-config*',r=>r.fulfill({contentType:'application/json',body:'{}'}));
 await page.goto('http://127.0.0.1:5198/#l1-wallet');
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-backup-password');
 await page.getByRole('button',{name:'Create L1 wallet',exact:true}).click();
 await page.getByTestId('l1-address').waitFor();const original=await page.getByTestId('l1-address').textContent();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download encrypted backup',exact:true}).click();
 const file=await download;const stream=await file.createReadStream();const chunks=[];for await(const c of stream)chunks.push(c);const bytes=Buffer.concat(chunks);
 const parsed=JSON.parse(bytes.toString());assert.ok(parsed.vault.ciphertext);assert.ok(!parsed.seed && !parsed.passphrase && !parsed.backup_json);
 account='backup-destination';await page.reload();await page.getByRole('button',{name:'Create L1 wallet',exact:true}).waitFor();
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-backup-password');
 await page.getByLabel('Encrypted backup',{exact:true}).setInputFiles({name:'synthetic-encrypted.json',mimeType:'application/json',buffer:bytes});
 await page.getByTestId('l1-address').waitFor();assert.equal(await page.getByTestId('l1-address').textContent(),original);
 await page.reload();await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).waitFor();
 await page.getByLabel('Wallet passphrase',{exact:true}).fill('synthetic-backup-password');await page.getByRole('button',{name:'Unlock L1 wallet',exact:true}).click();
 await page.getByTestId('l1-address').waitFor();assert.equal(await page.getByTestId('l1-address').textContent(),original);
 console.log('PASS: create, encrypted download, import into separate account, reload and unlock preserve pf address. Synthetic unfunded backup; founder acceptance NOT observed.');
}finally{await browser.close();}
