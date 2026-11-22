// Run with the repository wallet WASM prepared and Playwright available via PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as viteServer } from 'vite';
import { resetRateLimitsForTests } from '../../../../../server/rate-limit.js';
import { createRelayServer } from '../../../../../server/l1/relay.js';
import { registerL1Gateway } from '../../../../../server/l1/gateway.js';
import { readValidatedJson } from '../../../../../server/request-validation.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { fundingDigest } from './shield.js';
import { receiptFor, snapshot } from '../../../../../scripts/private-wallet/receipt-fixture.mjs';
import vectors from '../../../../../scripts/private-wallet/funding-vectors.json' with { type: 'json' };
import { CHAIN_ID, GENESIS_HASH } from '../lib/utils.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; }
const close = server => new Promise(resolve => server.close(resolve));
const token = () => randomBytes(32).toString('hex');
const asset = 'a'.repeat(96), issuer = 'pf' + '2'.repeat(40), privateAddress = 'pfs1' + '3'.repeat(158), recipient = 'pfs1' + '4'.repeat(158);
const intents = new Map(), requests = new Map(), bearer = token();
let balance = 0, reserved = 0, unsigned, didMerge = false, owner, pending, registrations = 0, missingSeed = false, buildOnly = false, wrongDestination = false;
const prover = createServer(async (req, res) => {
  const body = await readValidatedJson(req, 32768);
  assert.ok(req.headers.authorization === 'Bearer ' + bearer);
  if (body.wallet_id) { owner ||= body.wallet_id; assert.equal(body.wallet_id, owner); }
  let result;
  switch (req.url) {
    case '/wallet/create':
      registrations++;
      if (missingSeed) return json(res, 400, { error: 'known wallet is missing its seed; restore the original seed file' });
      result = { address: privateAddress }; break;
    case '/abandon': {
      if (body.pending_id) {
        assert.equal(body.pending_id, pending); pending = null;
        result = { pending_id: body.pending_id, state: 'abandoned', exported_action_may_still_settle: false };
      } else {
        const op = body.intent_id ? [...requests.values()].find(r => r.intent_id === body.intent_id) : requests.get(body.request_id);
        if (op?.state !== 'built') return json(res, 400, { error: 'operation may be in admission; retry the original request to reconcile' });
        op.state = 'abandoned'; reserved = 0;
        result = { intent_id: op.intent_id, state: 'abandoned', exported_action_may_still_settle: true };
      }
      break;
    }
    case '/address':
      if (missingSeed) return json(res, 404, { error: 'No such file or directory' }); result = { address: privateAddress }; break;
    case '/balance': assert.ok(registrations); result = { snapshot, known_live_wallet_notes: balance ? 1 : 0, privacy_label: 'hidden, small pool', address: privateAddress, balances: { [asset]: balance }, available: { [asset]: balance - reserved }, notes: [] }; break;
    case '/shield/prepare':
      assert.equal(body.asset, asset); assert.ok(body.amount > 0); pending = randomBytes(32).toString('hex'); assert.equal(body.account, owner);
      unsigned = { intent: vectors[0].unsigned_funding.intent, terms: { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, address_namespace: 'postfiat.address.v1',
        signature_algorithm_id: 'ML-DSA-65', transaction_kind: 'asset_burn', source: owner, fee: 2, sequence: 1,
        operation: 'asset_burn', owner, issuer, asset_id: asset, amount: body.amount } };
      result = { pending_id: pending, private_address: wrongDestination ? recipient : privateAddress, unsigned_funding: unsigned, signing_digest_hex: Buffer.from(fundingDigest(unsigned)).toString('hex') }; break;
    case '/receipt': {
      const intent = intents.get(body.intent_id); assert.ok(intent);
      if (intent.offline) { result = { intent_id: body.intent_id, state: 'pending_unknown', contract_receipt: null }; break; }
      if (!intent.done) { balance += intent.delta; reserved = 0; intent.done = true; }
      result = receiptFor(body.intent_id); break;
    }
    default: {
      const key = body.pending_id || body.request_id;
      if (requests.has(key)) { result = requests.get(key); break; }
      let operation = req.url.slice(1), delta = 0;
      if (operation === 'shield/finish') {
        assert.equal(body.pending_id, pending); assert.deepEqual(body.funding_authorization.unsigned, unsigned);
        const { algorithm_id, signature_hex, public_key_hex } = body.funding_authorization;
        assert.equal(algorithm_id, 'ML-DSA-65');
        assert.ok(ml_dsa65.verify(Buffer.from(signature_hex, 'hex'), fundingDigest(unsigned), Buffer.from(public_key_hex, 'hex'),
          { context: Buffer.from('postfiat-l1-v2/tx/v1') }));
        assert.equal('pf' + createHash('sha3-384').update('postfiat.address.v1\0').update(Buffer.from(body.funding_authorization.public_key_hex,'hex')).digest('hex').slice(0,40), owner);
        operation = 'shield'; delta = unsigned.terms.amount;
      } else {
        assert.ok(['pay','exit'].includes(operation)); assert.equal(body.asset, asset);
        if (operation === 'pay') assert.equal(body.recipient, recipient); else assert.equal(body.destination, owner);
        if (operation === 'pay' && !didMerge) { operation = 'merge'; didMerge = true; } else delta = -body.amount;
        reserved = body.amount;
      }
      const intent_id = randomBytes(48).toString('hex');
      intents.set(intent_id, { delta, offline: buildOnly }); result = { operation, intent_id, state: buildOnly ? 'built' : 'queued',
        ...(buildOnly ? { action_json: JSON.stringify({ intent_id }) } : {}), ...(operation === 'merge' ? { next: 'Wait for acceptance and repeat with a fresh request_id.' } : {}) };
      requests.set(key, result);
      if (operation === 'exit') { res.destroy(); return; } // Lose the first acknowledgement after recording it.
    }
  }
  json(res, 200, result);
});
const env = { TASKNODE_L1_PRIVATE_PAYMENTS_ENABLED: 'true', L1_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1', L1_RELAY_TOKEN: token(),
  L1_PRIVATE_PROVER_URL: await listen(prover), L1_PRIVATE_PROVER_TOKEN: bearer, L1_WALLET_PROXY_URL: 'ws://127.0.0.1:1',
  L1_WALLET_PROXY_TOKEN: token(), L1_WALLET_PROXY_ORIGIN: 'http://127.0.0.1' };
const relay = createRelayServer(env, async () => ({})); env.L1_RELAY_URL = await listen(relay);
const vite = await viteServer({ configFile: false, cacheDir: 'node_modules/.vite-private-wallet-test', server: { middlewareMode: true, hmr: false }, appType: 'custom', esbuild: { jsx: 'automatic' } });
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/src/features/wallet/l1/private/browser-fixture.jsx"></script>'); }
  else vite.middlewares(req, res);
});
const gateway = registerL1Gateway(server, { env, getSession: async cookie => ({ accountId: 'browser', authenticated: cookie === 'fixture=1' }),
  cookieValue: req => req.headers.cookie, json, readJson: readValidatedJson });
const origin = await listen(server), evidence = 'artifacts/private-payments';
let browser;
try {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await context.addCookies([{ name: 'fixture', value: '1', url: origin }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/l1/**', route => route.request().url().includes('/api/l1/private/') ? route.continue() : route.fulfill({ json: { coins: [], rows: [] } }));
  await page.goto(origin);
  const button = name => page.getByRole('button', { name, exact: true });
  const enter = async (create = false) => {
    await page.getByLabel('Wallet passphrase', { exact: true }).fill('browser fixture passphrase');
    await button(create ? 'Create L1 wallet' : 'Unlock L1 wallet').click();
    await button('Private').click(); await page.getByText('Your private address', { exact: true }).waitFor();
  };
  await enter(true);
  const amount = page.getByRole('textbox', { name: /^Amount/ });
  await page.getByText('Snapshot height 41 · hidden, small pool').waitFor();
  wrongDestination = true;
  await amount.fill('2'); await button('Review move to private').click();
  await page.getByText(/prepared destination does not match your private address/).waitFor();
  assert.equal(await button('Sign and move to private').count(), 0);
  await button('Cancel and release funds').click();
  await page.getByText('Cancelled and released. No funds moved.').waitFor();
  wrongDestination = false;
  await amount.fill('2'); await button('Review move to private').click();
  await button('Replace unsigned shield').click(); await page.getByText('Cancelled and released. No funds moved.').waitFor();
  assert.equal(pending, null);
  await amount.fill('9'); await button('Review move to private').click();
  await page.getByText(/Funding fee 0\.000002/).waitFor(); await button('Sign and move to private').click();
  await page.getByText('Funds moved to your private balance.').waitFor();
  await page.getByLabel('Action', { exact: true }).selectOption('pay');
  await amount.fill('10'); await page.getByLabel('Recipient private address').fill(recipient); await button('Send privately').click();
  await page.getByText(/Enter an amount within the available balance/).waitFor();
  await amount.fill('4'); await button('Send privately').click();
  await page.getByText(/Combining private notes/).waitFor();
  await page.getByText('4.00 pending / reserved', { exact: true }).waitFor(); await page.screenshot({ path: evidence + '/merging.png' });
  await page.reload(); await enter(); await button('Resume and check status').click();
  await page.getByText('Private payment accepted.').waitFor(); assert.equal(balance, 5000000);
  await page.getByLabel('Action', { exact: true }).selectOption('exit');
  assert.equal(await page.getByLabel('Public destination').inputValue(), owner);
  await amount.fill('1'); await button('Move to public').click();
  await page.getByText(/Transfer status is unconfirmed/).waitFor();
  await button('Resume and check status').click();
  await page.getByText('Funds moved to the public destination.').waitFor();
  await page.getByText('4.00 available', { exact: true }).waitFor(); await page.screenshot({ path: evidence + '/complete.png' });
  assert.equal(balance, 4000000); assert.equal(requests.size, 4); assert.deepEqual(errors, []);
  resetRateLimitsForTests();
  buildOnly = true;
  await page.getByLabel('Action', { exact: true }).selectOption('pay');
  await amount.fill('4'); await page.getByLabel('Recipient private address').fill(recipient); await button('Send privately').click();
  await page.getByText(/Proof built/).waitFor();
  await page.getByText('0.00 available', { exact: true }).waitFor();
  await button('Cancel and release funds').click();
  await page.getByText('Local funds released. An exported copy may still settle.').waitFor();
  await page.getByText('4.00 available', { exact: true }).waitFor();
  assert.equal(requests.size, 5);
  assert.equal(registrations, 1);
  missingSeed = true;
  // Simulate the first open in a browser which has no registration marker.
  await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes(':registered:')).forEach(k => localStorage.removeItem(k)));
  async function openMissing() {
    await page.reload();
    await page.getByLabel('Wallet passphrase', { exact: true }).fill('browser fixture passphrase');
    await button('Unlock L1 wallet').click(); await button('Private').click();
    await page.getByText('Private balance needs restoring, contact support.').waitFor();
    assert.equal(await button('Refresh balances').isDisabled(), true);
  }
  await openMissing(); await openMissing(); assert.equal(registrations, 2);
  console.log('PASS: shield signed in browser, overdraw blocked, merge recovered after reload, private pay accepted, public exit recovered after a lost acknowledgement; unsigned and built requests cancelled, missing seed requires restoration.');
} finally { await browser?.close(); gateway.close(); await vite.close(); await close(server); await close(relay); await close(prover); }
