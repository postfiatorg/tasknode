import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import('/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const out = '/home/postfiat/repos/b23-coord/evidence/trade/phase2/primary-synthetic'; await mkdir(out, { recursive: true });
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, appType: 'custom', plugins: [{ name: 'primary-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!req.url.startsWith('/primary-fixture')) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/src/features/wallet/l1/primary/browser-fixture.jsx"></script></body></html>')); }); } }] });
await server.listen(); const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }), errors = [];
const p = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); p.setDefaultTimeout(10000); p.on('pageerror', e => errors.push(e.message));
const url = `http://127.0.0.1:${server.httpServer.address().port}/primary-fixture`;
async function confirm() { const before = await p.evaluate(() => window.primaryFixture.history.filter(x => x.startsWith('sign:')).length); await p.getByRole('button', { name: 'Get fee quote', exact: true }).click(); assert.equal(await p.evaluate(() => window.primaryFixture.history.filter(x => x.startsWith('sign:')).length), before); await p.getByRole('button', { name: 'Sign and submit', exact: true }).click(); await p.getByRole('heading', { name: 'Accepted and verified', exact: true }).waitFor(); }
try {
  await p.goto(url); await p.getByLabel('B24 quantity', { exact: true }).fill('3');
  await p.getByText('Create at NAV selected', { exact: true }).waitFor(); assert.equal(await p.getByLabel('PFUSDC total', { exact: true }).inputValue(), '3.015000'); assert.equal(await p.getByRole('button', { name: 'Review buy offer', exact: true }).count(), 0);
  await p.getByLabel('How to buy').selectOption('book'); await p.getByRole('button', { name: 'Review buy offer', exact: true }).waitFor();
  await p.getByLabel('How to buy').selectOption('create'); await p.getByLabel('B24 quantity', { exact: true }).fill('1'); await p.getByRole('button', { name: 'Review creation', exact: true }).click();
  await confirm(); await p.screenshot({ path: `${out}/reserved.png`, fullPage: true });
  // Remount after accepted reserve: persisted state offers Continue, never a duplicate signature.
  await p.evaluate(() => window.primaryFixture.remount()); await p.getByLabel('How to buy').selectOption('create');
  assert.equal(await p.getByRole('button', { name: 'Get fee quote', exact: true }).count(), 0);
  await p.getByRole('button', { name: 'Continue creation', exact: true }).click(); await confirm();
  await p.getByRole('button', { name: 'Continue creation', exact: true }).click(); await confirm(); await p.screenshot({ path: `${out}/created.png`, fullPage: true });
  await p.getByRole('button', { name: 'Done creating', exact: true }).click();
  assert.deepEqual(await p.evaluate(() => window.primaryFixture.history.filter(x => x.startsWith('submit:'))), ['submit:pftl_uniswap_order_reserve', 'submit:pftl_uniswap_primary_subscribe_v2', 'submit:pftl_uniswap_order_release']);
  await p.evaluate(() => window.primaryFixture.view('redeem')); await p.getByLabel('B24 to cash in').fill('1'); await p.getByRole('button', { name: 'Review cash-in', exact: true }).click(); await confirm(); await p.screenshot({ path: `${out}/cashed-in.png`, fullPage: true });
  assert.equal(await p.evaluate(() => window.primaryFixture.state.pool.export_entitlement_count), 0); assert.equal(await p.evaluate(() => window.primaryFixture.state.balances.assets.lines[1].balance), 9994500);
  console.log('PASS automatic routing, explicit book override, exact creation terms, reserve/resume/create/release with separate confirmations, no export, subscriber cash-in and fee custody.');
  await p.goto(url); await p.getByLabel('How to buy').selectOption('create'); await p.getByLabel('B24 quantity', { exact: true }).fill('1'); await p.getByRole('button', { name: 'Review creation' }).click(); await confirm(); await p.getByRole('button', { name: 'Continue creation' }).click(); await p.getByRole('button', { name: 'Cancel reserved creation' }).click(); await confirm(); await p.getByRole('button', { name: 'Done creating' }).click();
  assert.equal(await p.evaluate(() => window.primaryFixture.state.balances.assets.lines[1].balance), 10000000); assert.equal(await p.evaluate(() => window.primaryFixture.state.supply), 100000000);
  console.log('PASS explicit cancellation refunds held PFUSDC without creating coins.');
  await p.goto(url); await p.evaluate(() => { window.primaryFixture.state.balances.assets.lines[1].balance = 999999; window.primaryFixture.state.balances.assets.lines[1].limit = 1000000; });
  await p.getByLabel('How to buy').selectOption('create'); await p.getByLabel('B24 quantity', { exact: true }).fill('1'); await p.getByRole('button', { name: 'Review creation' }).click();
  await p.getByText('Set up PFUSDC before funding', { exact: true }).waitFor(); await confirm(); await p.getByRole('button', { name: 'Done setting up PFUSDC' }).click();
  assert.deepEqual(await p.evaluate(() => window.primaryFixture.history.filter(x => x.startsWith('submit:'))), ['submit:trust_set']);
  console.log('PASS insufficient source receiving limit offers only reviewed setup; no reservation or creation before funding.');
  await p.goto(url + '?uncertain=1'); await p.getByLabel('How to buy').selectOption('create'); await p.getByLabel('B24 quantity', { exact: true }).fill('1'); await p.getByRole('button', { name: 'Review creation' }).click(); await p.getByRole('button', { name: 'Get fee quote' }).click(); await p.getByRole('button', { name: 'Sign and submit' }).click(); await p.getByRole('heading', { name: 'Not completed' }).waitFor();
  await p.evaluate(() => window.primaryFixture.remount()); await p.getByLabel('How to buy').selectOption('create'); assert.equal(await p.getByRole('button', { name: 'Get fee quote' }).count(), 0); await p.getByText('This creation has an unfinished attempt', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.primaryFixture.history.filter(x => x.startsWith('submit:')).length), 1); console.log('PASS uncertain submission retained and never automatically replayed after remount.');
  assert.deepEqual(errors, []);
} catch (e) { console.error(await p.locator('body').innerText()); await p.screenshot({ path: `${out}/failure.png`, fullPage: true }); throw e; } finally { await browser.close(); await server.close(); }
