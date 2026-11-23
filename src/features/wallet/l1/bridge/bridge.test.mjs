import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController, STUCK_AFTER_MS, amountAtoms, needsRecovery } from './controller.js';
import * as api from './bridge-relay.js';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import { advanceDeposit, checkEarlier, MAX_SET_ASIDE, pollDelay, RECOVERY_POLL_MS, RECOVERY_WINDOW_MS, sendDeposit as sendSolanaDeposit, RESEND_SIGNED_MS, setAside, solanaReadiness } from './solana-session.js';
import { assertLamports, assertTokenAccount, LIGHTHOUSE, pub, solanaDeposit, transfer, unitLimit, unitPrice } from './solana-fixtures.mjs';
import { DEPOSIT_CHECK_VERSION, LIGHTHOUSE_PROGRAM, MAX_COMPUTE_UNIT_PRICE } from './solana-shape.js';
import { handleBridgeRoutes } from '../../../../../server/l1/bridge-routes.js';
import { address, owner, memoryStorage, routeReport, readyPayload } from './fixtures.mjs';
function setup(overrides = {}) {
  const sent = [];
  const client = { address, accountId: 'bob', unlocked: true, call: async () => routeReport() };
  const ethereum = { connectMetaMask: async () => owner, ensureEthereumMainnet: async () => {},
    getEvmBalance: async () => owner, getEthereumUsdcBalance: async () => 10000000n,
    getEthereumUsdcAllowance: async () => 10000000n, assertContractCodeHash: async () => {},
    approveEthereumUsdc: async () => sent.push('approve'), depositToEthereumBridge: async () => sent.push('deposit') };
  const service = { ...api, loadBridgeReadiness: async () => readyPayload(), ...overrides };
  return { sent, client, model: new BridgeController(client, { ethereum, service, storage: memoryStorage() }) };
}
test('B7 connect shows the unlocked pf recipient and mainnet USDC balance/allowance', async () => {
  const { model } = setup();
  await model.readiness(); await model.connect();
  assert.equal(model.address, address); assert.equal(model.state.owner, owner);
  assert.equal(model.state.balance, 10000000n); assert.equal(model.state.allowance, 10000000n);
});
test('B10 missing anchor and unreachable readiness prevent ALL sends, even invoked directly', async () => {
  for (const loadBridgeReadiness of [async () => ({ ok: true, ready: false, message: 'No authenticated anchor' }),
    async () => { throw new Error('Offline'); }, async () => ({ ...readyPayload(), beacon_anchor_authenticated: false })]) {
    const { model, sent } = setup({ loadBridgeReadiness });
    await model.connect();
    await assert.rejects(() => model.approve('1'));
    await assert.rejects(() => model.deposit('1'));
    assert.equal(model.state.ready, false); assert.deepEqual(sent, []);
  }
});
test('stale readiness and account switch are rechecked before signing', async () => {
  const { model, client, sent } = setup();
  await model.readiness(); await model.connect();
  model.service.loadBridgeReadiness = async () => { throw new Error('Offline'); };
  await assert.rejects(() => model.approve('1'));
  client.accountId = 'alice';
  await assert.rejects(() => model.deposit('1'));
  assert.deepEqual(sent, []);
});
test('amount input rejects overflow, negative, exponent, zero and precision loss', () => {
  for (const amount of ['0', '-1', '1e6', '1.0000001', '18446744073710']) assert.equal(amountAtoms(amount), null);
  assert.equal(amountAtoms('1.000001'), 1000001n);
});
test('gateway rejects unauthenticated, cross-origin and custody fields; upstream failure is closed', async () => {
  const responses = [];
  const context = { req: { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' } }, res: { setHeader() {} },
    url: new URL('http://localhost/api/l1/bridge/jobs'), session: null, json: (_res, status, body) => responses.push({ status, body }),
    readJson: async () => ({ seed: 'synthetic' }), proxyUrl: 'http://127.0.0.1:1' };
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 401);
  context.session = { accountId: 'bob' }; context.req.headers.origin = 'http://evil.test';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 403);
  context.req.headers.origin = 'http://localhost';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).status, 400);
  context.req.method = 'GET'; context.url.pathname = '/api/l1/bridge/readiness';
  await handleBridgeRoutes(context); assert.equal(responses.at(-1).body.ready, false);
  assert.equal(responses.at(-1).status, 502);
});

test('B8 reload resumes identical job and displays seven persisted stages', async () => {
  const { stageRows, STAGES } = await import('./stages.js');
  const { jobId, depositTx, asset } = await import('./fixtures.mjs');
  const storage = memoryStorage();
  const { model: original, client } = setup();
  original.storage = storage;
  await original.readiness();
  const pending = { recipient: address, route: original.route, owner, amountAtoms: '1000000', tx: depositTx, jobId };
  original.save(pending); original.dispose();
  const requested = [];
  const job = { job_id: jobId, asset_id: asset, status: 'proving', retryable: true,
    request: { pftl_recipient: address, deposit_tx_hash: depositTx, amount_atoms: '1000000', route_id: 'ethereum-mainnet-usdc-v1', depositor: owner },
    stage_history: STAGES.slice(0, 4).map(([stage], index) => ({ stage, status: index < 3 ? 'complete' : 'running', started_at_unix: 100 + index, completed_at_unix: index < 3 ? 101 + index : null })) };
  const resumed = new BridgeController(client, { storage, service: { loadBridgeJob: async (id) => { requested.push(id); return job; } } });
  await resumed.resume();
  assert.deepEqual(requested, [jobId]);
  const rows = stageRows(resumed.state.job);
  assert.equal(rows.length, 7); assert.equal(rows[0].completed, 101); assert.equal(rows[3].status, 'running'); assert.equal(rows[6].status, 'pending');
  const other = new BridgeController({ ...client, accountId: 'alice' }, { storage });
  assert.equal(other.state.pending, null);
  job.request.pftl_recipient = `pf${'99'.repeat(20)}`;
  await assert.rejects(() => resumed.poll(), /does not match/);
});
test('B9 exact child asset read, zero truth, unavailable/missing/malformed balance stays unverified', async () => {
  const { creditedBalance } = await import('./balance.js');
  const { asset, jobId, depositTx } = await import('./fixtures.mjs');
  const family = 'ff'.repeat(48);
  assert.equal(creditedBalance({ ok: true, result: { assets: [{ asset_id: asset, balance: '0' }] } }, asset).atoms, '0');
  assert.deepEqual(creditedBalance({ ok: true, result: { assets: [
    { asset_id: family, balance: '99000000' }, { asset_id: asset, balance: '2000000' },
  ] } }, asset), { assetId: asset, atoms: '2000000' });
  for (const response of [{ ok: false }, { ok: true, result: { assets: [{ asset_id: family, balance: '999' }] } },
    { ok: true, result: { assets: [{ asset_id: asset, balance: 9007199254740992 }] } }]) assert.throws(() => creditedBalance(response, asset));
  const { model, client } = setup();
  await model.readiness();
  model.save({ route: model.route, recipient: address, owner, amountAtoms: '1000000', tx: depositTx, jobId });
  const job = { status: 'accepted', receipt_code: 'ACCEPTED', receipt_id: 'aa'.repeat(48), job_id: jobId, credited_asset_id: asset, asset_id: model.route.profile.asset_id,
    request: { pftl_recipient: address, deposit_tx_hash: depositTx, amount_atoms: '1000000', route_id: 'ethereum-mainnet-usdc-v1', depositor: owner } };
  model.service.loadBridgeJob = async () => job;
  client.call = async () => { throw new Error('Balance RPC offline'); };
  await assert.rejects(() => model.poll(), /offline/); assert.equal(model.state.result.balancePending, true);
  client.call = async () => ({ ok: true, result: { assets: [{ asset_id: asset, balance: '2000000' }] } });
  await model.poll(); assert.equal(model.state.result.atoms, '2000000'); assert.equal(model.state.result.balancePending, false);
  job.receipt_code = 'REJECTED'; await assert.rejects(() => model.poll(), /accepted receipt/);
  job.receipt_code = 'ACCEPTED'; delete job.credited_asset_id; await assert.rejects(() => model.poll(), /identity is unverified/);
  assert.equal(model.state.result, null);
});

test('B7 gateway forwards only the fixed bridge paths and public request, without browser credentials', async () => {
  const { createServer } = await import('node:http');
  const { profile, depositTx } = await import('./fixtures.mjs');
  const observed = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    observed.push({ path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, job_id: `0x${'ab'.repeat(32)}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = { route_id: profile.route_id, source_chain_id: 1, deposit_tx_hash: depositTx, deposit_id: `0x${'aa'.repeat(32)}`,
      pftl_recipient: address, depositor: owner, amount_atoms: '1000000', idempotency_key: depositTx,
      route_profile_hash: routeReport().result.profile_hash, route_epoch: 12, route_binding: `0x${routeReport().result.route_binding}` };
    const responses = [];
    const ctx = { req: { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', cookie: 'synthetic-cookie', authorization: 'synthetic-bearer' } },
      res: { setHeader() {} }, url: new URL('http://localhost/api/l1/bridge/jobs'), session: { accountId: 'bob' },
      json: (_res, status, body) => responses.push({ status, body }), readJson: async () => request,
      proxyUrl: `http://127.0.0.1:${server.address().port}/ignored?also=ignored` };
    await handleBridgeRoutes(ctx);
    assert.equal(responses.at(-1).status, 200); assert.equal(observed[0].path, '/api/bridge/jobs');
    assert.deepEqual(JSON.parse(observed[0].body), request);
    assert.equal(observed[0].headers.cookie, undefined); assert.equal(observed[0].headers.authorization, undefined);
    ctx.req.method = 'GET'; ctx.url.pathname = '/api/l1/bridge/readiness';
    await handleBridgeRoutes(ctx);
    assert.equal(observed[1].path, '/api/bridge/readiness?route=ethereum-mainnet-usdc-v1');
    ctx.url.pathname = `/api/l1/bridge/jobs/0x${'ab'.repeat(32)}`;
    await handleBridgeRoutes(ctx); assert.equal(observed[2].path, `/api/bridge/jobs/0x${'ab'.repeat(32)}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

async function unfinished(pendingPatch = {}) {
  const { jobId, depositTx } = await import('./fixtures.mjs');
  const storage = memoryStorage();
  const { model: original, client, sent } = setup();
  original.storage = storage;
  await original.readiness();
  const nonce = `0x${'5e'.repeat(32)}`;
  original.save({ recipient: address, route: original.route, owner, amountAtoms: '1000000', nonce, tx: null, jobId: null, ...pendingPatch });
  original.dispose();
  const created = [];
  const service = { ...api, loadBridgeReadiness: async () => readyPayload(),
    createBridgeJob: async (request) => { created.push(request); return { job_id: jobId }; },
    loadBridgeJob: async () => ({ job_id: jobId, status: 'proving', request: created.at(-1) }) };
  const event = { pftl_recipient: address, depositor: owner, amount: 1000000n, nonce, source_chain_id: 1,
    vault: original.route.vaultAddress, token: original.route.tokenAddress, deposit_id: `0x${'aa'.repeat(32)}` };
  const events = new Map([[depositTx, event]]);
  const ethereum = { ...original.ethereum, ensureEthereumMainnet: async () => {}, waitForReceipt: async () => ({ status: '0x1' }),
    watchDepositEvent: async (_vault, tx) => events.get(tx) || null, generateNonce: () => `0x${'99'.repeat(32)}`,
    depositToEthereumBridge: async () => { sent.push('deposit'); throw new Error('User rejected the request.'); } };
  const model = new BridgeController(client, { ethereum, service, storage });
  const stored = () => JSON.parse(storage.getItem(model.key)).pending;
  return { model, storage, stored, created, events, event, sent, depositTx, jobId };
}
test('reload with tx: null can be discarded, which re-enables a new deposit', async () => {
  const { model, stored, sent } = await unfinished();
  assert.equal(model.state.pending.tx, null);
  await assert.rejects(() => model.resume(), /No broadcast deposit/);
  await assert.rejects(() => model.deposit('1'), /Resume the existing deposit/);
  model.discard();
  assert.equal(model.state.pending, null); assert.equal(stored(), null);
  await model.readiness(); await model.connect();
  await assert.rejects(() => model.deposit('1'), /User rejected/);
  assert.deepEqual(sent, ['deposit']);
});
test('a wrong recovery hash is refused and not stored', async () => {
  const { model, stored, events, event } = await unfinished();
  const unknown = `0x${'ef'.repeat(32)}`, otherNonce = `0x${'01'.repeat(32)}`;
  await assert.rejects(() => model.recoverHash(unknown), /does not match/);
  events.set(otherNonce, { ...event, nonce: `0x${'77'.repeat(32)}` });
  await assert.rejects(() => model.recoverHash(otherNonce), /does not match/);
  model.ethereum.waitForReceipt = async () => { throw new Error('Transaction failed (status 0x0)'); };
  await assert.rejects(() => model.recoverHash(otherNonce), /failed/);
  assert.equal(model.state.pending.tx, null); assert.equal(stored().tx, null);
});
test('a matching recovery hash is accepted, and replaces a stored hash that has no job', async () => {
  const stale = `0x${'12'.repeat(32)}`;
  const { model, stored, created, depositTx, jobId } = await unfinished({ tx: stale });
  await model.recoverHash(depositTx);
  assert.equal(stored().tx, depositTx); assert.equal(stored().jobId, jobId);
  assert.equal(created.length, 1); assert.equal(created[0].deposit_tx_hash, depositTx);
  assert.equal(model.state.job.status, 'proving');
  await assert.rejects(() => model.recoverHash(stale), /No interrupted broadcast/);
});
test('a record with a bridge job is never discarded', async () => {
  const { model, stored, depositTx, jobId } = await unfinished({ tx: `0x${'cd'.repeat(32)}`, jobId: `0x${'ab'.repeat(32)}` });
  assert.throws(() => model.discard(), /cannot be discarded/);
  assert.equal(stored().jobId, jobId); assert.equal(model.state.pending.tx, depositTx);
  const other = await unfinished();
  other.storage.setItem(other.model.key, JSON.stringify({ accountId: 'bob', pending: { ...other.stored(), tx: depositTx, jobId } }));
  assert.throws(() => other.model.discard(), /cannot be discarded/);
  await assert.rejects(() => other.model.recoverHash(depositTx), /No interrupted broadcast/);
  assert.equal(other.stored().jobId, jobId);
});
test('recovery area stays hidden while a valid hash waits, and appears once the deposit is stuck', async () => {
  const { model, events, event, depositTx, jobId } = await unfinished();
  model.discard(); await model.readiness(); await model.connect();
  const nonce = `0x${'99'.repeat(32)}`;
  events.set(depositTx, { ...event, nonce });
  let confirm;
  model.ethereum.depositToEthereumBridge = async () => depositTx;
  model.ethereum.waitForReceipt = () => new Promise((resolve) => { confirm = resolve; });
  const running = model.deposit('1');
  while (!confirm) await new Promise((resolve) => setImmediate(resolve));
  const waiting = model.state.pending;
  assert.equal(waiting.tx, depositTx); assert.equal(waiting.jobId, null);
  assert.equal(needsRecovery(waiting, model.state.checkFailed), false);
  assert.equal(needsRecovery(waiting, false, waiting.txSavedAt + STUCK_AFTER_MS - 1), false);
  assert.equal(needsRecovery(waiting, false, waiting.txSavedAt + STUCK_AFTER_MS), true);
  assert.equal(needsRecovery({ ...waiting, txSavedAt: undefined }, false), true);
  assert.equal(needsRecovery({ ...waiting, tx: null }, false), true);
  confirm({ status: '0x1' }); await running;
  assert.equal(model.state.pending.jobId, jobId);
  assert.equal(needsRecovery(model.state.pending, true, Date.now() + STUCK_AFTER_MS), false);
  for (const [fail, pattern] of [
    [(m) => { m.ethereum.waitForReceipt = async () => { throw new Error(`Transaction ${depositTx} not confirmed within 120s`); }; }, /not confirmed/],
    [(m) => { m.ethereum.waitForReceipt = async () => { throw new Error('Transaction failed (status 0x0)'); }; }, /failed/],
    [(m, map) => { map.delete(depositTx); }, /does not match/],
  ]) {
    const young = await unfinished({ tx: depositTx, txSavedAt: Date.now() });
    assert.equal(needsRecovery(young.model.state.pending, young.model.state.checkFailed), false);
    fail(young.model, young.events);
    await assert.rejects(() => young.model.resume(), pattern);
    assert.equal(young.model.state.checkFailed, true);
    assert.equal(needsRecovery(young.model.state.pending, young.model.state.checkFailed), true);
  }
  const offline = await unfinished({ tx: depositTx, txSavedAt: Date.now() });
  offline.model.ethereum.ensureEthereumMainnet = async () => { throw new Error('Switch MetaMask to Ethereum mainnet'); };
  await assert.rejects(() => offline.model.resume(), /mainnet/);
  assert.equal(needsRecovery(offline.model.state.pending, offline.model.state.checkFailed), false);
});

// A browser with Web Locks and localStorage, a Phantom that signs whatever it is shown, and a server
// that returns `intent` and answers /send with `reply`. Records what the browser does.
function solanaBrowser(t, { intent, reply = sent => ({ ok: true, signature: sent.signature }), phantom, recovery = () => ({ ok: true, expired: false }), ready = solana.ready } = {}) {
  const store = new Map(), saved = [], posted = [], opened = [];
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: async (key, options, fn) => fn({}) } }, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: key => store.get(key) ?? null }, configurable: true });
  t.after(() => { Object.defineProperty(globalThis, 'navigator', navigator); delete globalThis.localStorage; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    posted.push({ path: url.slice(url.lastIndexOf('/solana/') + 8), body });
    if (url.endsWith('/solana/intent')) return Response.json(intent);
    if (url.endsWith('/solana/release')) return Response.json({ ok: true, released: true });
    if (url.endsWith('/solana/send')) {
      const bytes = Buffer.from(body.transaction_b64, 'base64');
      const result = reply({ signature: bs58.encode(bytes.subarray(1, 65)) });
      return Response.json(result, { status: result.ok ? 200 : result.status ?? 503 });
    }
    if (url.endsWith('/solana/recovery')) return Response.json(recovery());
    throw Error('unexpected ' + url);
  });
  const save = record => { saved.push(record); if (record) store.set('k', JSON.stringify(record)); else store.delete('k'); };
  const provider = { publicKey: { toString: () => solana.request.owner }, request: async ({ params }) => {
    opened.push(params.message);
    if (phantom) return phantom();
    const bytes = Buffer.from(bs58.decode(params.message));
    bytes.fill(9, 1, 65);
    return { serialize: () => Uint8Array.from(bytes) };
  } };
  const run = () => sendSolanaDeposit({ key: 'k', provider, request: solana.request, ready, save, active: () => true });
  return { run, saved, posted, opened };
}
const solana = { program: pub(2), mint: pub(7), owner: pub(5), source: pub(9), nonce: 'ab'.repeat(32) };
solana.request = { owner: solana.owner, amount_atoms: '1000000', pftl_recipient: address };
solana.ready = { vault_program_id: solana.program, mint: solana.mint, check_version: DEPOSIT_CHECK_VERSION };
solana.durable = { nonce_account: pub(20), nonce_authority: pub(21), nonce_value: pub(22) };
const solanaShape = { ...solana, ...solana.request };
const serverBudget = [unitLimit(200450), unitPrice(100000)];
const phantomSigned = bytes => () => { const copy = Buffer.from(bytes); copy.fill(9, 1, 65); return { serialize: () => Uint8Array.from(copy) }; };
async function solanaIntent(overrides = {}, durable = false) {
  const nonce = durable ? { nonceAccount: solana.durable.nonce_account, authority: solana.durable.nonce_authority, lifetime: solana.durable.nonce_value } : {};
  // The server's own compute budget, as it builds every deposit.
  const bytes = await solanaDeposit({ ...solanaShape, ...nonce, budget: serverBudget, ...overrides });
  return { ok: true, build_id: 'dev', ...solana.request, vault_program_id: solana.program, nonce: solana.nonce, last_valid_block_height: 1234,
    message_b58: bs58.encode(bytes), ...(durable && solana.durable) };
}
test('an older server or stale tab prompts a reload before Phantom opens', async t => {
  for (const build_id of [undefined, 'previous']) {
    const browser = solanaBrowser(t, { intent: { ...await solanaIntent(), build_id } });
    await assert.rejects(browser.run(), /Reload this page/);
    assert.equal(browser.opened.length, 0);
    assert.deepEqual(browser.posted.map(row => row.path), ['intent', 'release']);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(options.headers['X-Tasknode-Build'], 'dev');
    return Response.json({ ok: true, ready: true, build_id: 'other' });
  });
  await assert.rejects(solanaReadiness(), /Reload this page/);
});

test('Phantom opens only when the co-signing relay runs this page\'s deposit check', async t => {
  const older = { vault_program_id: solana.program, mint: solana.mint };
  const mismatch = /^Error: This page and the Solana deposit service run different deposit checks\. Reload this page or try again later\. Nothing was signed\.$/;
  for (const [label, durable] of [['one signer', false], ['two signers', true]]) {
    const other = solanaBrowser(t, { intent: await solanaIntent({}, durable), ready: { ...older, check_version: DEPOSIT_CHECK_VERSION + 1 } });
    await assert.rejects(other.run(), mismatch, label + ': another version');
    assert.deepEqual([other.posted, other.opened], [[], []], label + ': no intent, no lease, Phantom closed');
    t.mock.restoreAll();
  }
  // A relay that reports no version predates the check; it refuses Phantom's edits only when it co-signs.
  const unversioned = solanaBrowser(t, { intent: await solanaIntent({}, true), ready: older });
  await assert.rejects(unversioned.run(), mismatch);
  assert.deepEqual(unversioned.opened, []);
  assert.deepEqual(unversioned.posted.map(row => row.body), [solana.request, { nonce: solana.nonce }], 'released without a reason an older relay refuses');
  t.mock.restoreAll();
  const oneSigner = solanaBrowser(t, { intent: await solanaIntent(), ready: older });
  await oneSigner.run();
  assert.equal(oneSigner.posted.at(-1).path, 'send');
  t.mock.restoreAll();
  const refused = solanaBrowser(t, { intent: await solanaIntent(), ready: older,
    phantom: phantomSigned(await solanaDeposit({ ...solanaShape, budget: serverBudget, amount_atoms: '1000001' })) });
  t.mock.method(console, 'warn', () => {});
  await assert.rejects(refused.run(), /Nothing was sent/);
  assert.deepEqual(refused.posted.at(-1), { path: 'release', body: { nonce: solana.nonce } });
});

test('Phantom opens only for the exact deposit transaction the request describes', async t => {
  for (const [label, intent] of [
    ['another Post Fiat recipient', await solanaIntent({ pftl_recipient: 'pf' + '99'.repeat(20) })],
    ['another amount', await solanaIntent({ amount_atoms: '1000001' })],
    ['another mint', await solanaIntent({ mint: pub(32) })],
    ['PDAs of another program', await solanaIntent({ pdaProgram: pub(33) })],
    ['another vault program', await solanaIntent({ program: pub(33), pdaProgram: solana.program })],
    ['another fee payer', await solanaIntent({ feePayer: pub(34) })],
    ['an extra instruction', await solanaIntent({ extra: [transfer(solana.owner, pub(35))] })],
    ['a Lighthouse assertion the server would never add', await solanaIntent({ extra: [assertLamports(solana.owner, 1)] })],
    ['a nonce account other than the one named', await solanaIntent({ nonceAccount: pub(36) }, true)],
    ['a nonce value other than the one named', await solanaIntent({ lifetime: pub(37) }, true)],
    ['an advance the intent does not name', { ...await solanaIntent({}, true), nonce_account: undefined, nonce_authority: undefined, nonce_value: undefined }],
  ]) {
    const browser = solanaBrowser(t, { intent });
    await assert.rejects(browser.run(), /^Error: Not the vault deposit: .+\. Phantom was not opened\.$/, label);
    assert.deepEqual(browser.opened, [], label + ': Phantom stays closed');
    assert.deepEqual(browser.saved.filter(Boolean), [], label + ': no pending deposit');
    const release = browser.posted.at(-1);
    assert.equal(release.path, 'release');
    assert.equal(release.body.nonce, solana.nonce);
    assert.match(release.body.reason, /^Not the vault deposit: /);
    if (label === 'another amount') assert.equal(release.body.reason, 'Not the vault deposit: amount or recipient');
    t.mock.restoreAll();
  }
  for (const durable of [false, true]) {
    const browser = solanaBrowser(t, { intent: await solanaIntent({}, durable) });
    await browser.run();
    assert.equal(browser.opened.length, 1);
    const record = browser.saved.at(-1);
    assert.equal(record.signature, bs58.encode(Buffer.alloc(64, 9)));
    assert.deepEqual([record.nonce_account, record.nonce_value], durable ? [solana.durable.nonce_account, solana.durable.nonce_value] : [undefined, undefined]);
    t.mock.restoreAll();
  }
});

test('the signature returned by /solana/send must be the one in the bytes Phantom signed', async t => {
  const browser = solanaBrowser(t, { intent: await solanaIntent(), reply: () => ({ ok: true, signature: bs58.encode(Buffer.alloc(64, 7)) }) });
  await assert.rejects(browser.run(), /different transaction signature/);
  assert.equal(browser.saved.at(-1).signature, undefined, 'the card checks the vault instead of trusting the reply');
});

test('a decline in Phantom gives the nonce lease back; recovery sends the signed nonce', async t => {
  const browser = solanaBrowser(t, { intent: await solanaIntent({}, true), phantom: () => { throw Object.assign(Error('declined'), { code: 4001 }); } });
  await assert.rejects(browser.run(), { message: 'You declined the deposit in Phantom.' });
  assert.equal(browser.saved.at(-1), null);
  assert.deepEqual(browser.posted.at(-1), { path: 'release', body: { nonce: solana.nonce } });
  t.mock.restoreAll();
  const recovering = solanaBrowser(t, { intent: await solanaIntent({}, true) });
  const record = { ...solana.request, nonce: solana.nonce, last_valid_block_height: 1234, vault_program_id: solana.program, ...solana.durable, started: 1 };
  delete record.nonce_authority;
  await advanceDeposit(record, {});
  assert.deepEqual(recovering.posted.at(-1), { path: 'recovery', body: { nonce: solana.nonce, vault_program_id: solana.program,
    last_valid_block_height: 1234, nonce_account: solana.durable.nonce_account, nonce_value: solana.durable.nonce_value } });
});

test('Solana send refused because deposits closed: the saved deposit is cleared and the closed message is kept', async t => {
  const closed = 'Solana deposits are closed right now. Nothing was sent; please try again later.';
  const browser = solanaBrowser(t, { intent: await solanaIntent(), reply: () => ({ ok: false, code: 'solana_deposits_closed', message: closed }) });
  await assert.rejects(browser.run(), { message: closed });
  assert.equal(browser.saved.at(-1), null, 'nothing was sent, so no pending deposit is kept');
});

test('Phantom may replace or add the compute budget of a one-signer deposit within the caps; it is sent as signed', async t => {
  for (const [label, edit] of [
    ['limit and price prepended', { budget: [], first: [unitLimit(61000), unitPrice(150000)] }],
    ['limit and price appended', { budget: [], extra: [unitPrice(150000), unitLimit(61000)] }],
    ['the server budget kept', {}],
  ]) {
    const browser = solanaBrowser(t, { intent: await solanaIntent(), phantom: phantomSigned(await solanaDeposit({ ...solanaShape, budget: serverBudget, ...edit })) });
    await browser.run();
    const send = browser.posted.find(row => row.path === 'send');
    assert.ok(send, label + ': sent');
    assert.equal(browser.saved.at(-1).signature, bs58.encode(Buffer.alloc(64, 9)), label);
    t.mock.restoreAll();
  }
});

test('Phantom\'s signed bytes are checked before /send: a mismatch is refused, the record dropped and the lease given back', async t => {
  const durable = await solanaIntent({}, true);
  const durableWith = async overrides => {
    const bytes = await solanaDeposit({ ...solanaShape, nonceAccount: solana.durable.nonce_account, authority: solana.durable.nonce_authority,
      lifetime: solana.durable.nonce_value, budget: serverBudget, ...overrides });
    return bytes;
  };
  for (const [label, intent, bytes] of [
    ['a third compute-budget instruction', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: serverBudget, extra: [unitLimit(70000)] })],
    ['a compute-budget instruction with an account', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: [unitPrice(5, [{ address: pub(40), role: 0 }])] })],
    ['a price over the cap', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: [unitPrice(MAX_COMPUTE_UNIT_PRICE + 1)] })],
    ['another amount', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: serverBudget, amount_atoms: '1000001' })],
    ['another recipient', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: serverBudget, pftl_recipient: 'pf' + '99'.repeat(20) })],
    ['a durable deposit with another source', durable, await durableWith({ source: pub(90) })],
    ['a durable deposit with a wallet-added limit', durable, await durableWith({ extra: [unitLimit(61000)] })],
    ['a durable deposit with the authority signature changed', durable, (await durableWith({})).fill(7, 65, 129)],
  ]) {
    const browser = solanaBrowser(t, { intent, phantom: phantomSigned(bytes) });
    const warning = t.mock.method(console, 'warn', () => {});
    await assert.rejects(browser.run(), /^Error: Not the vault deposit: .+\. Nothing was sent\.$/, label);
    const [reason, layout] = warning.mock.calls[0].arguments;
    assert.deepEqual(browser.posted.at(-1), { path: 'release', body: { nonce: solana.nonce, reason } });
    assert.ok(layout.instructions.length > 0, label);
    assert.equal(browser.saved.at(-1), null, label + ': no pending deposit');
    assert.ok(!browser.posted.some(row => row.path === 'send'), label + ': nothing sent');
    t.mock.restoreAll();
  }
  const browser = solanaBrowser(t, { intent: durable });
  await browser.run();
  assert.ok(browser.posted.some(row => row.path === 'send'), 'the unchanged durable deposit is sent');
});

// The same bytes with one read-only account moved into the writable section (no compiler emits this).
function writable(bytes, key) {
  const start = 1 + 64 * bytes[0], m = getCompiledTransactionMessageDecoder().decode(bytes.subarray(start));
  const from = m.staticAccounts.indexOf(key), to = m.staticAccounts.length - m.header.numReadonlyNonSignerAccounts;
  const order = m.staticAccounts.map((_, i) => i).filter(i => i !== from);
  order.splice(to, 0, from);
  const at = index => order.indexOf(index);
  const edited = { ...m, header: { ...m.header, numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts - 1 },
    staticAccounts: order.map(i => m.staticAccounts[i]),
    instructions: m.instructions.map(ix => ({ ...ix, programAddressIndex: at(ix.programAddressIndex), accountIndices: ix.accountIndices?.map(at) })) };
  return Buffer.concat([bytes.subarray(0, start), Buffer.from(getCompiledTransactionMessageEncoder().encode(edited))]);
}
// What Phantom appends on mainnet: the fee payer's SOL and the source token account, both read-only.
const lighthouse = [assertLamports(solana.owner, 4_000_000), assertTokenAccount(solana.source, solana.owner, 0)];

test('Phantom\'s Lighthouse assertions pass on the one-signer path and are sent as signed; anything else is refused', async t => {
  assert.equal(LIGHTHOUSE_PROGRAM, LIGHTHOUSE);
  for (const [label, edit] of [
    ['appended after the server budget', { budget: serverBudget, extra: lighthouse }],
    ['with a wallet budget', { first: [unitLimit(61000), unitPrice(150000)], extra: lighthouse }],
    ['one assertion on the fee payer', { budget: serverBudget, extra: [assertLamports(solana.owner, 1)] }],
  ]) {
    const bytes = await solanaDeposit({ ...solanaShape, ...edit });
    const browser = solanaBrowser(t, { intent: await solanaIntent(), phantom: phantomSigned(bytes) });
    await browser.run();
    const expected = Buffer.from(bytes);
    expected.fill(9, 1, 65);
    assert.equal(browser.posted.find(row => row.path === 'send')?.body.transaction_b64, expected.toString('base64'), label + ': the bytes as signed');
    assert.equal(browser.saved.at(-1).signature, bs58.encode(Buffer.alloc(64, 9)), label);
    t.mock.restoreAll();
  }
  const durable = await solanaIntent({}, true);
  const durableBytes = await solanaDeposit({ ...solanaShape, nonceAccount: solana.durable.nonce_account, authority: solana.durable.nonce_authority,
    lifetime: solana.durable.nonce_value, budget: serverBudget, extra: lighthouse });
  const signed = await solanaDeposit({ ...solanaShape, nonceAccount: solana.durable.nonce_account, authority: solana.durable.nonce_authority,
    lifetime: solana.durable.nonce_value, budget: [unitPrice(20000), unitLimit(80000)], extra: lighthouse });
  const edited = solanaBrowser(t, { intent: durable, phantom: () => ({ serialize(options) {
    assert.deepEqual(options, { requireAllSignatures: false });
    return phantomSigned(signed)().serialize();
  } }) });
  await edited.run();
  assert.equal(edited.posted.at(-1).path, 'send');
  t.mock.restoreAll();
  // AdvanceNonce changes the nonce account; Phantom may assert on it.
  const guarded = solanaBrowser(t, { intent: durable, phantom: phantomSigned(await solanaDeposit({ ...solanaShape, nonceAccount: solana.durable.nonce_account,
    authority: solana.durable.nonce_authority, lifetime: solana.durable.nonce_value, budget: serverBudget,
    extra: [...lighthouse, assertLamports(solana.durable.nonce_account, 1)] })) });
  await guarded.run();
  assert.equal(guarded.posted.at(-1).path, 'send', 'an assertion on the nonce account is sent');
  t.mock.restoreAll();
  const oneSigner = extra => solanaDeposit({ ...solanaShape, budget: serverBudget, extra });
  for (const [label, intent, bytes] of [
    ['the same layout from another program', await solanaIntent(), await oneSigner([assertLamports(solana.owner, 1, { programAddress: pub(41) })])],
    ['an assertion that adds a signer', await solanaIntent(), await oneSigner([assertLamports(pub(42), 1, { role: 2 })])],
    ['an assertion that makes the mint writable', await solanaIntent(), await oneSigner([assertLamports(solana.mint, 1, { role: 1 })])],
    ['the vault program writable', await solanaIntent(), writable(await oneSigner(lighthouse), solana.program)],
    ['the source token account read-only', await solanaIntent(), await solanaDeposit({ ...solanaShape, budget: serverBudget, sourceRole: 0, extra: lighthouse })],
    ['writable Lighthouse program', durable, writable(durableBytes, LIGHTHOUSE)],
  ]) {
    const browser = solanaBrowser(t, { intent, phantom: phantomSigned(bytes) });
    const warning = t.mock.method(console, 'warn', () => {});
    await assert.rejects(browser.run(), /^Error: Not the vault deposit: .+\. Nothing was sent\.$/, label);
    const [reason, layout] = warning.mock.calls[0].arguments;
    assert.deepEqual(browser.posted.at(-1), { path: 'release', body: { nonce: solana.nonce, reason } });
    assert.ok(layout.instructions.length > 0, label);
    assert.ok(!browser.posted.some(row => row.path === 'send'), label + ': nothing sent');
    t.mock.restoreAll();
  }
});

test('an unreadable Phantom reply and a /send shape refusal give the lease back and drop the record', async t => {
  const unreadable = solanaBrowser(t, { intent: await solanaIntent({}, true), phantom: () => ({ serialize: () => { throw Error('bad'); } }) });
  await assert.rejects(unreadable.run(), { message: 'Not the vault deposit: unreadable Phantom reply. Nothing was sent.' });
  assert.equal(unreadable.saved.at(-1), null);
  assert.deepEqual(unreadable.posted.at(-1), { path: 'release', body: { nonce: solana.nonce, reason: 'Not the vault deposit: unreadable Phantom reply' } });
  t.mock.restoreAll();
  const refused = solanaBrowser(t, { intent: await solanaIntent(), reply: () => ({ ok: false, status: 400, code: 'solana_deposit_shape_mismatch',
    message: 'The signed transaction is not this vault deposit.' }) });
  await assert.rejects(refused.run(), { message: 'The signed transaction is not this vault deposit.' });
  assert.equal(refused.saved.at(-1), null, 'nothing reached Solana');
  assert.deepEqual(refused.posted.at(-1), { path: 'release', body: { nonce: solana.nonce } });
});

test('a signed durable deposit that never landed: recovery re-sends its copy while the lease is held, then ends once the lease is gone', async t => {
  let answer = { ok: true, expired: false, resend: true };
  const intent = await solanaIntent({}, true);
  // /send fails without an answer: the record keeps the signed copy and no signature.
  const browser = solanaBrowser(t, { intent, recovery: () => answer, reply: () => ({ ok: false, status: 502, code: 'solana_bridge_unavailable', message: 'unreachable' }) });
  await assert.rejects(browser.run(), /unreachable/);
  let record = JSON.parse(JSON.stringify(browser.saved.at(-1)));
  assert.ok(record.transaction_b64 && !record.signature, 'the signed copy is kept');
  record = await advanceDeposit(record, {});
  assert.deepEqual(browser.posted.slice(-2).map(row => row.path), ['recovery', 'send'], 'recovery first, then the signed copy again');
  assert.equal(browser.posted.at(-1).body.transaction_b64, record.transaction_b64);
  assert.ok(record.resent && !record.signature, 'the send failed again: throttled, still waiting');
  const posts = browser.posted.length;
  record = await advanceDeposit(record, {});
  assert.equal(browser.posted.length, posts + 1, `no second send within ${RESEND_SIGNED_MS} ms`);
  answer = { ok: true, expired: false, lapsed: true };
  record = await advanceDeposit(record, {});
  assert.equal(record.terminal, undefined, 'not an end: the deposit can still land');
  assert.ok(record.lapsed > 0);
  assert.equal(record.transaction_b64, undefined, 'the signed copy is dropped');
  t.mock.restoreAll();
  const sent = solanaBrowser(t, { intent, recovery: () => ({ ok: true, expired: false, resend: true }) });
  const stored = { ...JSON.parse(JSON.stringify(browser.saved.at(-1))) };
  const next = await advanceDeposit(stored, {});
  assert.equal(next.signature, bs58.encode(Buffer.alloc(64, 9)), 'a re-send the server accepts moves on to the proof job');
  assert.equal(next.transaction_b64, undefined);
  assert.deepEqual(sent.posted.map(row => row.path), ['recovery', 'send']);
});

test('a durable deposit the server no longer holds is checked slowly for a day, and ends only when its nonce moved or the day is over', async t => {
  assert.equal(RECOVERY_POLL_MS, 30_000);
  assert.equal(RECOVERY_WINDOW_MS, 24 * 60 * 60 * 1000);
  let answer = { ok: true, expired: false, lapsed: true };
  solanaBrowser(t, { recovery: () => answer });
  const start = { ...solana.request, nonce: solana.nonce, last_valid_block_height: 1234, vault_program_id: solana.program,
    nonce_account: solana.durable.nonce_account, nonce_value: solana.durable.nonce_value, started: 1, transaction_b64: 'AQ==' };
  assert.equal(pollDelay(start), 1000);
  const open = await advanceDeposit(start, {});
  assert.equal(open.terminal, undefined);
  assert.equal(pollDelay(open), RECOVERY_POLL_MS);
  assert.equal((await advanceDeposit(open, {})).lapsed, open.lapsed, 'the day counts from the first time');
  answer = { ok: true, signature: bs58.encode(Buffer.alloc(64, 6)) };
  const landed = await advanceDeposit(open, {});
  assert.equal(landed.signature, answer.signature, 'a late landing moves on to the proof job and its credit');
  assert.equal(landed.terminal, undefined);
  assert.equal(pollDelay(landed), 1000);
  answer = { ok: true, expired: true };
  assert.equal((await advanceDeposit(open, {})).terminal, 'expired', 'the nonce moved without a receipt: it can no longer land');
  answer = { ok: true, expired: false, lapsed: true };
  assert.equal((await advanceDeposit({ ...open, lapsed: Date.now() - RECOVERY_WINDOW_MS + 60_000 }, {})).terminal, undefined);
  const over = await advanceDeposit({ ...open, lapsed: Date.now() - RECOVERY_WINDOW_MS }, {});
  assert.equal(over.terminal, 'lapsed', 'the day is over');
  // Starting another deposit sets the open one aside, once, so the card keeps checking it.
  assert.deepEqual(setAside(null, open), [open]);
  const earlier = setAside([{ nonce: 'cd'.repeat(32) }], open);
  assert.deepEqual(earlier.map(row => row.nonce), ['cd'.repeat(32), solana.nonce]);
  assert.equal(setAside(earlier, { ...open, before: 'x' }).length, 2);
});

test('a failing read after the day ends the row', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let failing = () => { throw Error('This deposit belongs to a different vault configuration.'); };
  const browser = solanaBrowser(t, { recovery: () => failing() });
  const open = { ...solana.request, nonce: solana.nonce, last_valid_block_height: 1234, vault_program_id: solana.program,
    nonce_account: solana.durable.nonce_account, nonce_value: solana.durable.nonce_value, started: 1, lapsed: Date.now() - RECOVERY_WINDOW_MS + 60_000 };
  await assert.rejects(advanceDeposit(open, {}), 'within the day a failed check is reported');
  assert.equal(await checkEarlier(open, {}), open, 'an earlier card keeps the row and checks again');
  const posts = browser.posted.length;
  const over = await advanceDeposit({ ...open, lapsed: Date.now() - RECOVERY_WINDOW_MS }, {});
  assert.equal(browser.posted.length, posts + 1, 'the server is read once more after the day');
  assert.equal(over.terminal, 'lapsed');
  assert.equal(over.finished, Date.now());
  // The day ends while a failing check is under way, on the main card and on an earlier card.
  failing = () => { t.mock.timers.tick(60_000); throw Error('Solana RPC unavailable'); };
  for (const check of [advanceDeposit, checkEarlier]) {
    const row = { ...open, lapsed: Date.now() - RECOVERY_WINDOW_MS + 60_000 };
    const ended = await check(row, {});
    assert.deepEqual([ended.terminal, ended.lapsed], ['lapsed', row.lapsed], check.name);
  }
  // Once Solana recorded the deposit, the day no longer applies: its proof job goes on.
  const landed = { ...open, lapsed: Date.now() - 2 * RECOVERY_WINDOW_MS, signature: bs58.encode(Buffer.alloc(64, 6)) };
  await assert.rejects(advanceDeposit(landed, {}), /unexpected/);
  assert.equal(browser.posted.at(-1).path, 'jobs');
});

test('a read after the day that returns a signature continues to the proof job', async t => {
  const signature = bs58.encode(Buffer.alloc(64, 5));
  let answer = { ok: true, signature };
  const browser = solanaBrowser(t, { recovery: () => answer });
  // The page was closed while the deposit landed and reopened more than a day after its lease went.
  const open = { ...solana.request, nonce: solana.nonce, last_valid_block_height: 1234, vault_program_id: solana.program,
    nonce_account: solana.durable.nonce_account, nonce_value: solana.durable.nonce_value, started: 1, lapsed: Date.now() - RECOVERY_WINDOW_MS - 3_600_000 };
  for (const check of [advanceDeposit, checkEarlier]) {
    const next = await check(open, {});
    assert.deepEqual([next.signature, next.terminal], [signature, undefined], check.name);
  }
  assert.deepEqual(browser.posted.map(row => row.path), ['recovery', 'recovery']);
  answer = { ok: true, expired: false, lapsed: true };
  const over = await advanceDeposit(open, {});
  assert.deepEqual([over.terminal, over.lapsed], ['lapsed', open.lapsed], 'a read that still finds nothing ends the row');
});

test(`the set-aside list keeps at most ${MAX_SET_ASIDE} deposits by dropping ended ones, then ones past their day, never one that can still land`, () => {
  assert.equal(MAX_SET_ASIDE, 10);
  const row = (i, terminal) => ({ nonce: i.toString(16).padStart(64, '0'), ...(terminal && { terminal }) });
  const nonces = list => list.map(item => parseInt(item.nonce, 16));
  const mixed = Array.from({ length: 10 }, (_, i) => row(i, [1, 4].includes(i) ? 'expired' : undefined));
  assert.deepEqual(nonces(setAside(mixed, row(10))), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const late = { ...row(0), lapsed: Date.now() - RECOVERY_WINDOW_MS };
  assert.deepEqual(nonces(setAside([late, ...mixed.slice(1)], row(10))), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'an ended row goes before a row past its day');
  assert.deepEqual(nonces(setAside([late, ...mixed.slice(1), row(10), row(11)], row(12))), [2, 3, 5, 6, 7, 8, 9, 10, 11, 12], 'a longer stored list is cut back too: both ended rows, then the row past its day');
  const open = Array.from({ length: 10 }, (_, i) => row(i));
  assert.deepEqual(nonces(setAside(open, row(10))), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every row can still land: none goes and the list grows past the cap');
  assert.deepEqual(nonces(setAside([...open.slice(1), { ...row(10), lapsed: Date.now() - RECOVERY_WINDOW_MS + 60_000 }], row(11))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'a row inside its day stays');
  assert.equal(setAside(open, row(3)).length, 10, 'the same deposit is not added twice');
});
