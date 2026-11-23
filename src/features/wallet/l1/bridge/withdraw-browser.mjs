// Run with the same headless Chrome and CDP driver as the repo's other browser checks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { browserFixture } from '../../../../../scripts/browser-fixture-driver.mjs';
import { registerL1Gateway } from '../../../../../server/l1/gateway.js';
import { burn, ready, recipient, signature } from './withdraw-fixtures.mjs';

const json = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
const posts = [];
let stage, open = false, epoch = ready.epoch;
const payout = createServer(async (req, res) => {
  // Also the stub Solana RPC: the recipient has no account yet, which is a fresh wallet.
  if (req.method === 'POST' && req.url === '/') return json(res, 200, { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: null } });
  if (req.url === '/solana/withdrawals/readiness') return json(res, 200, open ? { ...ready, epoch } : { ok: true, ready: false, message: 'paused' });
  if (req.method === 'POST' && req.url === '/solana/withdrawals') {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    if (JSON.stringify(body) !== JSON.stringify({ burn_tx_id: burn })) return json(res, 400, { error: 'bad burn' });
    posts.push(body);
    if (posts.length === 1) return json(res, 429, { error: 'Withdrawal queue is full.' });
    if (!stage || stage === 'failed') stage = 'queued';
  } else if (req.url !== '/solana/withdrawals/' + burn || !stage) return json(res, 404, { error: 'unknown burn' });
  json(res, req.method === 'POST' && stage !== 'paid' ? 202 : 200, { burn_tx_id: burn, stage, detail: null,
    error: stage === 'failed' ? 'Proof worker offline.' : null, amount_atoms: '20000', recipient,
    burn_height: 101, solana_tx: stage === 'paid' ? signature : null });
});

const profile = await mkdtemp(join(tmpdir(), 'solana-withdraw-'));
let server, gateway, chrome, browser;
try {
  payout.listen(0, '127.0.0.1'); await once(payout, 'listening');
  const { output } = await build({ configFile: false, logLevel: 'warn', build: { write: false,
    rolldownOptions: { input: 'src/features/wallet/l1/bridge/withdraw-fixture.jsx' } } });
  const entry = output.find(asset => asset.isEntry).fileName;
  const styles = output.filter(asset => asset.fileName.endsWith('.css'))
    .map(asset => `<link rel="stylesheet" href="/${asset.fileName}">`).join('');
  server = createServer((req, res) => {
    if (req.url === '/fixture') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html>${styles}<div id="root"></div><script type="module" src="/${entry}"></script>`);
      return;
    }
    const asset = output.find(item => '/' + item.fileName === req.url);
    if (!asset) return json(res, 404, {});
    res.setHeader('Content-Type', asset.type === 'chunk' ? 'text/javascript' : 'text/css');
    res.end(asset.code ?? asset.source);
  });
  gateway = registerL1Gateway(server, { env: { TASKNODE_L1_ENABLED: 'true', L1_SOLANA_WITHDRAWALS_ENABLED: 'true',
    L1_SOLANA_WITHDRAW_SERVICE_URL: 'http://127.0.0.1:' + payout.address().port, L1_SOLANA_RPC_URL: 'http://127.0.0.1:' + payout.address().port },
    getSession: async () => ({ accountId: 'fixture', authenticated: true }), cookieValue: () => '', json,
    readJson: async req => { const chunks = []; for await (const part of req) chunks.push(part); return JSON.parse(Buffer.concat(chunks)); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const chromeExit = once(chrome, 'exit');
  const port = await Promise.race([chromeExit.then(() => { throw Error('Chrome exited before startup'); }), (async () => {
    for (let i = 0; i < 100; i++) {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await delay(100); }
    }
    throw Error('Chrome did not start');
  })()]);
  browser = await browserFixture({ port });
  const page = await browser.page({ url: 'http://127.0.0.1:' + server.address().port + '/fixture',
    intercept: req => req.url.endsWith('/api/l1/bridge/withdrawals/readiness') ? { body: { ok: true, ready: true, series_asset_id: '9'.repeat(96) } } : null });
  const visible = text => page.until(`document.body?.innerText.includes(${JSON.stringify(text)})`);
  async function click(text) {
    const find = `[...document.querySelectorAll('button')].find(b => b.offsetWidth && b.textContent === ${JSON.stringify(text)} && !b.disabled)`;
    await page.until(find + ' !== undefined'); await page.evaluate(find + '.click()');
  }
  const reload = async () => {
    const previous = await page.evaluate('performance.timeOrigin');
    await page.command('Page.reload');
    await page.until(`performance.timeOrigin !== ${previous} && document.readyState === 'complete'`);
  };
  const select = async () => {
    const radio = `document.querySelector('[aria-label="Withdraw to Solana"]')`;
    await page.until(`!!${radio}`); await page.evaluate(radio + '.click()');
  };
  await visible('Available from Ethereum deposits'); await select();
  await visible('Solana withdrawals are not available yet');
  open = true;
  await reload(); await select(); await visible('Available from the current Solana deposit series');
  assert.match(await page.evaluate('document.body.innerText'), /0\.02/);
  await click('Use my Phantom address');
  await page.evaluate(`const input = document.querySelector('[aria-label="Solana USDC withdrawal"] input[inputmode="decimal"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.02');
    input.dispatchEvent(new Event('input', { bubbles: true }));`);
  epoch++;
  await click('Review withdrawal'); await visible('You receive on Solana');
  assert.equal(await page.evaluate('window.quoted.operation.epoch'), epoch);
  assert.equal(await page.evaluate('window.quoted.operation.destination_ref'), ready.destination_prefix + '00'.repeat(32));
  epoch++;
  await click('Confirm and burn'); await visible('The reserve changed.');
  assert.equal(await page.evaluate('localStorage.getItem("test-signatures")'), null);
  await click('Review withdrawal'); await visible('You receive on Solana');
  await click('Confirm and burn'); await visible('Withdrawal queue is full.');
  await reload(); await visible('Waiting to start');
  stage = 'proving'; await reload(); await visible('Building the payout proof');
  stage = 'failed'; await visible('Proof worker offline.'); await click('Retry payout'); await visible('Waiting to start');
  for (const [next, label] of [['reading', 'Reading your burn'], ['paying', 'Sending USDC on Solana'], ['paid', 'USDC paid on Solana']]) {
    stage = next; await visible(label);
  }
  assert.equal(await page.evaluate('document.querySelector(\'a[href*="explorer.solana.com"]\').href'), 'https://explorer.solana.com/tx/' + signature);
  assert.equal(await page.evaluate('localStorage.getItem("test-signatures")'), '1');
  assert.deepEqual(posts, Array(3).fill({ burn_tx_id: burn }));
  console.log('Solana withdrawal browser passed: paused, review, one signature, recovery, retry and paid receipt.');
} finally {
  await browser?.close();
  if (chrome && chrome.exitCode === null && chrome.pid) { const stopped = once(chrome, 'exit'); chrome.kill(); await stopped; }
  gateway?.close(); if (server) await new Promise(resolve => server.close(resolve)); await new Promise(resolve => payout.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
