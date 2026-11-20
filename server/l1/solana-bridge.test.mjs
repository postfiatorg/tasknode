import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { getProgramDerivedAddress } from '@solana/addresses';
import { isSignerRole, isWritableRole } from '@solana/instructions';
import { getCompiledTransactionMessageDecoder, decompileTransactionMessage } from '@solana/transaction-messages';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import * as vault from './solana-vault.js';
import { buildVaultDeposit, readVault, recoverDeposit, sendDeposit } from './solana-vault.js';
import { handleBridgeRoutes } from './bridge-routes.js';
import { solanaDeposit, transfer, RECENT_BLOCKHASHES } from '../../src/features/wallet/l1/bridge/solana-fixtures.mjs';

const pub = byte => bs58.encode(Buffer.alloc(32, byte));
const program = pub(2), owner = pub(5), mint = pub(7), source = pub(9);
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Independent route-binding vector from the ledger's vault_bridge_route_binding test.
const binding = 'bceb5f7d7b32245250a394adb9f4a29c83e8806f805d6427caa4e055aa17473a';
const request = { owner: owner, amount_atoms: '2500000', pftl_recipient: 'pf' + 'ab'.repeat(20) };
const signature = bs58.encode(Buffer.alloc(64, 4));
const pda = async (...seeds) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];

function fixture() {
  const data = Buffer.alloc(96);
  Buffer.from(bs58.decode(mint)).copy(data);
  Buffer.from(binding, 'hex').copy(data, 32);
  data.writeBigUInt64LE(10000000n, 64);
  data.writeBigUInt64LE(20000000n, 72);
  data.writeBigUInt64LE(15000000n, 80);
  data.writeBigUInt64LE(10n, 88);
  const account = { owner: program, data };
  const health = { ok: true, ready: true, vault_program_id: program, light_client_epoch: 3 };
  const rpc = {
    getAccountInfo: async key => { assert.ok(key === await pda('config')); return account; },
    getEpochInfo: async () => ({ epoch: 3, absoluteSlot: 100 }),
    getLatestBlockhash: async () => ({ blockhash: pub(12), lastValidBlockHeight: 1234 }),
    getTokenAccounts: async () => ({ value: [{ pubkey: source, account: { owner: token, data: { parsed: { info: {
      state: 'initialized', owner: request.owner, mint: mint, tokenAmount: { amount: '5000000', decimals: 6 },
    } } } } }] }),
  };
  return { settings: { rpc, program, binding, mint }, account, health };
}

test('unsigned Phantom message matches the vault ABI, account order, privileges and caps', async () => {
  const { settings, health } = fixture();
  const ready = await readVault(settings, health);
  assert.equal(ready.available_atoms, '5000000');
  assert.equal(ready.total_cap_atoms, '20000000');
  const first = await buildVaultDeposit(settings, ready, request);
  const second = await buildVaultDeposit(settings, ready, request);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.receipt, second.receipt);
  const nonce = Buffer.from(first.nonce, 'hex');
  // One empty signature slot precedes the message, as Phantom's transaction decoder requires.
  assert.deepEqual([...bs58.decode(first.message_b58).subarray(0, 65)], [1, ...Array(64).fill(0)]);
  const tx = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(bs58.decode(first.message_b58).subarray(65)));
  assert.deepEqual(tx.feePayer.address, owner);
  assert.equal(tx.lifetimeConstraint.blockhash, pub(12));
  assert.equal(tx.instructions.length, 1);
  const [ix] = tx.instructions;
  assert.deepEqual(ix.programAddress, program);
  assert.deepEqual(ix.accounts.map(k => k.address), [owner, source, await pda('config'), await pda('custody'), mint, await pda('receipt', nonce), token, '11111111111111111111111111111111']);
  assert.deepEqual(ix.accounts.map(k => isWritableRole(k.role)), [true, true, true, true, false, true, false, false]);
  assert.deepEqual(ix.accounts.filter(k => isSignerRole(k.role)).map(k => k.address), [owner]);
  assert.equal(Buffer.from(ix.data).toString('hex'), '01a025260000000000' + 'ab'.repeat(20) + first.nonce);
  assert.equal(await pda('receipt', nonce), first.receipt);
  await assert.rejects(buildVaultDeposit(settings, ready, { ...request, amount_atoms: '5000001' }), /exceeds/);
  settings.rpc.getTokenAccounts = async () => ({ value: [] });
  await assert.rejects(buildVaultDeposit(settings, ready, request), /No USDC account/);
});

test('readiness refuses mismatched program, mint, binding, epoch, config owner, cap and initialization slot', async () => {
  for (const change of [
    ({ health }) => { health.vault_program_id = pub(11); },
    ({ account }) => { account.data[0] ^= 1; },
    ({ account }) => { account.data[32] ^= 1; },
    ({ health }) => { health.light_client_epoch++; },
    ({ account }) => { account.owner = '11111111111111111111111111111111'; },
    ({ account }) => account.data.writeBigUInt64LE(20000000n, 80),
    ({ account }) => account.data.writeBigUInt64LE(100n, 88),
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(readVault(f.settings, f.health));
  }
});

test('lost Phantom reply recovers only a finalized successful vault deposit for the nonce', async () => {
  const nonce = '45'.repeat(32), recovery = { nonce, vault_program_id: program, last_valid_block_height: 98 };
  const receipt = await pda('receipt', Buffer.from(nonce, 'hex'));
  const rpc = { getEpochInfo: async () => ({ absoluteSlot: 100, blockHeight: 99 }), getAccountInfo: async (id, options) => {
    assert.ok(id === receipt); assert.equal(options.minContextSlot, 100); return null;
  } };
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, expired: true });
  assert.deepEqual(await recoverDeposit({ rpc, program }, { ...recovery, last_valid_block_height: 99 }), { ok: true, expired: false });
  const account = Buffer.alloc(132); account.write('PFSOLRC1'); Buffer.from(nonce, 'hex').copy(account, 68);
  rpc.getAccountInfo = async () => ({ owner: program, data: account });
  rpc.getSignaturesForAddress = async () => [{ signature: 'unrelated', err: null }, { signature, err: null }];
  rpc.getParsedTransaction = async sig => ({ meta: { err: null }, transaction: { message: { instructions: [{
    programId: sig === signature ? program : mint, accounts: [owner, source, await pda('config'), await pda('custody'), mint, receipt],
    data: bs58.encode(Buffer.concat([Buffer.from([1]), Buffer.alloc(28), Buffer.from(nonce, 'hex')])),
  }] } } });
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, signature });
  rpc.getSignaturesForAddress = async () => [];
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, expired: false });
});

async function route(path, options = {}) {
  let result;
  await handleBridgeRoutes({ url: new URL('https://wallet.test/api/l1/bridge/solana/' + path),
    session: { accountId: 'test' }, req: { method: 'POST', headers: { host: 'wallet.test', origin: 'https://wallet.test' } },
    res: { setHeader() {} }, readJson: async () => request, json: (_, status, body) => { result = { status, body }; },
    env: {}, ...options });
  return result;
}

test('Solana write endpoints enforce session, same origin, exact field shapes and decoded lengths', async () => {
  assert.equal((await route('intent', { session: null })).status, 401);
  for (const path of ['intent', 'recovery', 'jobs']) {
    for (const headers of [{ host: 'wallet.test' }, { host: 'wallet.test', origin: 'https://other.test' },
      { host: 'wallet.test', origin: 'https://wallet.test', 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await route(path, { req: { method: 'POST', headers } })).status, 403);
    }
  }
  for (const body of [null, [], { ...request, unknown: 1 }, { ...request, amount_atoms: 1 }, { ...request, amount_atoms: '0' },
    { ...request, amount_atoms: String(2n ** 64n) }, { ...request, pftl_recipient: 'pf' }, { ...request, owner: '1'.repeat(44) }]) {
    assert.equal((await route('intent', { readJson: async () => body })).status, 400);
  }
  for (const body of [{ signature: '1'.repeat(88) }, { signature, url: 'extra' }, {}]) {
    assert.equal((await route('jobs', { readJson: async () => body })).status, 400);
  }
  assert.equal((await route('intent')).status, 503);
  assert.equal((await route('advances')).status, 404);
  assert.equal((await route('jobs/bogus')).status, 404);
});

async function relayFiles(t) {
  const dir = await mkdtemp(join(tmpdir(), 'solana-relay-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'relay.json');
  await writeFile(join(dir, 'http-token'), 'fixture-only');
  await writeFile(config, JSON.stringify({ ledger: 'node', vault_program: Buffer.from(bs58.decode(program)).toString('hex'),
    deposit_vkey: '0x' + '42'.repeat(32), profile_hash: '11'.repeat(48), route_binding: binding, http_token_file: 'http-token', state: dir, current_epoch: 3 }));
  return config;
}

test('Solana proxy forwards job create and status to configured endpoints and guards relay credentials', async t => {
  const calls = [], id = '0x' + 'ab'.repeat(32);
  const jobRequest = { kind: 'deposit', route_id: 'solana-mainnet-usdc-v1', deposit_tx_hash: signature };
  let payload = { ok: true, job_id: id, ledger: 'node', request: jobRequest };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ href: url.href, ...options }); return Response.json(payload, { status: options.method === 'POST' ? 202 : 200 });
  });
  const env = { L1_SOLANA_RELAY_CONFIG: await relayFiles(t), L1_SOLANA_RELAY_URL: 'http://local.test' };
  assert.equal((await route('jobs', { env, readJson: async () => ({ signature }) })).status, 202);
  assert.equal(calls[0].href, 'http://local.test/api/bridge/jobs');
  assert.deepEqual(JSON.parse(calls[0].body), { route_id: jobRequest.route_id, deposit_tx_hash: signature, idempotency_key: signature });
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-only');
  payload = { ...payload, ledger: 'node', observer_attestor_enabled: false, request: {
    kind: 'deposit', route_id: 'solana-mainnet-usdc-v1', deposit_tx_hash: signature }, status: 'running',
    stage_history: [{ stage: 'proof_done', status: 'running', started_at: 100.25, started_at_unix: 100 }] };
  const read = { req: { method: 'GET', headers: {} }, env };
  const result = await route('jobs/' + id, read);
  assert.equal(result.status, 200);
  assert.equal(result.body.signature, signature);
  assert.deepEqual(result.body.stage_history[0], { stage: 'proof', status: 'running', started_at_unix: 100.25, completed_at_unix: undefined });
  assert.equal(calls[1].href, 'http://local.test/api/bridge/jobs/' + id);
  const remote = { ...read, withdrawViaRelay: true, bridgeProxyUrl: 'https://relay.test', proxyToken: 'test-token', proxyOrigin: 'https://relay.test' };
  assert.equal((await route('readiness', remote)).status, 200);
  assert.equal(calls[2].href, 'https://relay.test/api/l1/bridge/solana/readiness');
  assert.equal(calls[2].headers.Authorization, 'Bearer test-token');
  payload = { echo: 'test-token' };
  const refused = await route('readiness', remote);
  assert.equal(refused.status, 502);
  assert.ok(!JSON.stringify(refused).includes('test-token'));
  payload = { ...result.body, ledger: 'stub' };
  assert.equal((await route('jobs/' + id, read)).status, 502);
});

test('readiness and intent use the same current route through the Solana JSON-RPC transport', async t => {
  const { account, health } = fixture();
  let epoch = 3;
  const env = { L1_SOLANA_RELAY_CONFIG: await relayFiles(t), L1_SOLANA_RELAY_URL: 'http://jobs.test', L1_SOLANA_ROUTE_EPOCH: '7', L1_SOLANA_RPC_URL: 'http://solana.test',
    L1_SOLANA_VAULT_PROGRAM_ID: program, L1_SOLANA_USDC_MINT: mint, L1_SOLANA_ROUTE_BINDING: binding };
  t.mock.method(globalThis, 'fetch', async (url, opt) => {
    if (new URL(url).host === 'jobs.test') {
      if (url.pathname === '/api/bridge/jobs') {
        assert.equal(url.searchParams.get('recipient'), request.pftl_recipient);
        assert.equal(opt.headers.Authorization, 'Bearer fixture-only');
        return Response.json({ ok: true, jobs: [] });
      }
      assert.equal(url.pathname + url.search, '/api/bridge/readiness?route=solana-mainnet-usdc-v1');
      return Response.json({ ...health, ledger: 'node', route_id: 'solana-mainnet-usdc-v1', source_proof_kind: 'sp1-solana-alpenglow-finality-v1',
        program_vkey: '0x' + '42'.repeat(32), observer_attestor_enabled: false });
    }
    const { id, method } = JSON.parse(opt.body);
    const info = { lamports: 100000, executable: false, rentEpoch: 2 };
    const context = { slot: 100 };
    const results = {
      getEpochInfo: { epoch, absoluteSlot: 100, slotsInEpoch: 50, slotIndex: 12 },
      getAccountInfo: { context, value: { ...info, owner: program, data: [account.data.toString('base64'), 'base64'] } },
      getLatestBlockhash: { context, value: { blockhash: pub(12), lastValidBlockHeight: 1234 } },
      getTokenAccountsByOwner: { context, value: [{ pubkey: source, account: { ...info, owner: token,
        data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: request.owner, mint: mint,
          state: 'initialized', tokenAmount: { decimals: 6, amount: '9999999' } } } } } }] },
    };
    assert.ok(method in results);
    return Response.json({ jsonrpc: '2.0', id, result: results[method] });
  });
  const readiness = await route('readiness', { req: { method: 'GET' }, env });
  assert.equal(readiness.body.light_client_epoch, 3);
  assert.equal(readiness.body.available_atoms, '5000000');
  assert.equal((await route('intent', { env })).status, 200);
  epoch++;
  assert.equal((await route('intent', { env })).status, 503);
});

test('deposits closed by the relay: no intent, no nonce lease and no broadcast of an earlier signed deposit', async t => {
  const { account } = fixture();
  let open = true;
  const rpcCalls = [], sent = [];
  const env = { L1_SOLANA_RELAY_CONFIG: await relayFiles(t), L1_SOLANA_RELAY_URL: 'http://jobs.test', L1_SOLANA_RPC_URL: 'http://solana.test',
    L1_SOLANA_VAULT_PROGRAM_ID: program, L1_SOLANA_USDC_MINT: mint, L1_SOLANA_ROUTE_BINDING: binding };
  t.mock.method(globalThis, 'fetch', async (url, opt) => {
    if (new URL(url).host === 'jobs.test') {
      if (url.pathname === '/api/bridge/jobs') return Response.json({ ok: true, jobs: [] });
      if (!open) return Response.json({ ok: false, ready: false, route_id: 'solana-mainnet-usdc-v1', message: 'deposits closed' }, { status: 503 });
      return Response.json({ ok: true, ready: true, ledger: 'node', route_id: 'solana-mainnet-usdc-v1',
        source_proof_kind: 'sp1-solana-alpenglow-finality-v1', program_vkey: '0x' + '42'.repeat(32), observer_attestor_enabled: false });
    }
    const { id, method, params } = JSON.parse(opt.body);
    rpcCalls.push(method);
    const info = { lamports: 100000, executable: false, rentEpoch: 2 };
    const context = { slot: 100 };
    const results = {
      getEpochInfo: { epoch: 3, absoluteSlot: 100, slotsInEpoch: 50, slotIndex: 12 },
      getAccountInfo: { context, value: { ...info, owner: program, data: [account.data.toString('base64'), 'base64'] } },
      getLatestBlockhash: { context, value: { blockhash: pub(12), lastValidBlockHeight: 1234 } },
      getTokenAccountsByOwner: { context, value: [{ pubkey: source, account: { ...info, owner: token,
        data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: request.owner, mint: mint,
          state: 'initialized', tokenAmount: { decimals: 6, amount: '9999999' } } } } } }] },
      sendTransaction: signature,
      getSignatureStatuses: { context, value: [{ slot: 101, confirmations: 0, err: null, confirmationStatus: 'processed' }] },
    };
    if (method === 'sendTransaction') sent.push(params[0]);
    assert.ok(method in results);
    return Response.json({ jsonrpc: '2.0', id, result: results[method] });
  });
  open = false;
  const closedIntent = await route('intent', { env });
  assert.equal(closedIntent.status, 503);
  assert.equal(closedIntent.body.code, 'solana_deposits_closed');
  assert.deepEqual(rpcCalls, [], 'a closed relay prepares nothing and leases no nonce');
  open = true;
  const intent = await route('intent', { env });
  assert.equal(intent.status, 200);
  // The depositor signed while deposits were open; the relay closes before the wallet sends it.
  const signed = Buffer.from(bs58.decode(intent.body.message_b58));
  signed.fill(9, 1, 65);
  const body = { nonce: intent.body.nonce, transaction_b64: signed.toString('base64') };
  open = false;
  const refused = await route('send', { env, readJson: async () => body });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, 'solana_deposits_closed');
  assert.match(refused.body.message, /closed.*Nothing was sent/);
  assert.deepEqual(sent, []);
  open = true;
  const accepted = await route('send', { env, readJson: async () => body });
  assert.equal(accepted.status, 200);
  assert.equal(sent.length, 1);
  // The re-send loop sees the landed status after one interval; let it stop under the mock.
  await new Promise(resolve => setTimeout(resolve, 2200));
});

// Durable nonces. Each test uses its own nonce accounts: leases live for the whole process.
const SYSTEM = '11111111111111111111111111111111';
const keyOf = seed => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const addressOf = seed => bs58.encode(createPublicKey(keyOf(seed)).export({ format: 'der', type: 'spki' }).subarray(-32));
const publicKeyOf = key => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bs58.decode(key)]), format: 'der', type: 'spki' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function nonceData(authority, value) {
  const data = Buffer.alloc(80);
  data.writeUInt32LE(1, 4);
  Buffer.from(bs58.decode(authority)).copy(data, 8);
  Buffer.from(bs58.decode(value)).copy(data, 40);
  return data;
}

// base: a byte unique to the test. keySeed differs from the nonce file's authority to model a wrong key.
async function durableFixture(t, base, { keySeed = Buffer.alloc(32, base) } = {}) {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'solana-nonce-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authority = addressOf(Buffer.alloc(32, base));
  const nonceAccounts = [pub(base + 1), pub(base + 2)];
  const values = new Map(nonceAccounts.map((account, i) => [account, pub(base + 10 + i)]));
  const config = await pda('config');
  f.settings.rpc.getAccountInfo = async key => {
    if (key === config) return f.account;
    return values.has(key) ? { owner: SYSTEM, data: nonceData(authority, values.get(key)) } : null;
  };
  const nonceFile = join(dir, 'nonce.json'), nonceKey = join(dir, 'key.json');
  await writeFile(nonceFile, JSON.stringify({ authority, accounts: nonceAccounts }));
  await writeFile(nonceKey, JSON.stringify([...keySeed, ...bs58.decode(addressOf(keySeed))]));
  Object.assign(f.settings, { nonceFile, nonceKey });
  return { ...f, authority, nonceAccounts, values, ready: await readVault(f.settings, f.health) };
}
const signed = intent => { const bytes = Buffer.from(bs58.decode(intent.message_b58)); bytes.fill(9, 1, 65); return bytes; };
const sendBody = (bytes, nonce) => ({ nonce, transaction_b64: Buffer.from(bytes).toString('base64') });

test('durable nonce: [AdvanceNonce, deposit], owner then authority as the only signers, a valid co-signature, and the intent names the nonce', async t => {
  const f = await durableFixture(t, 40);
  const intent = await buildVaultDeposit(f.settings, f.ready, request, 'holder-a');
  const bytes = Buffer.from(bs58.decode(intent.message_b58));
  assert.equal(bytes[0], 2);
  assert.ok(bytes.subarray(1, 65).every(b => b === 0), 'the depositor slot is left for Phantom');
  const message = bytes.subarray(129);
  const compiled = getCompiledTransactionMessageDecoder().decode(message);
  const keys = compiled.staticAccounts;
  assert.equal(compiled.header.numSignerAccounts, 2);
  assert.deepEqual(keys.slice(0, 2), [owner, f.authority]);
  assert.equal(compiled.lifetimeToken, f.values.get(f.nonceAccounts[0]));
  assert.equal(compiled.instructions.length, 2);
  const [advance, deposit] = compiled.instructions;
  assert.deepEqual([advance.programAddressIndex, ...advance.accountIndices].map(i => keys[i]), [SYSTEM, f.nonceAccounts[0], RECENT_BLOCKHASHES, f.authority]);
  assert.equal(Buffer.from(advance.data).toString('hex'), '04000000');
  assert.equal(keys[deposit.programAddressIndex], program);
  assert.ok(verify(null, message, publicKeyOf(f.authority), bytes.subarray(65, 129)), 'the authority signed exactly this message');
  assert.deepEqual([intent.nonce_account, intent.nonce_authority, intent.nonce_value], [f.nonceAccounts[0], f.authority, f.values.get(f.nonceAccounts[0])]);
});

test('nonce leases: one per holder, fallback when all are held, released on decline and on a failure, re-leased after expiry', async t => {
  const f = await durableFixture(t, 60);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const lease = holder => buildVaultDeposit(f.settings, f.ready, request, holder);
  const [n0, n1] = f.nonceAccounts;
  const a1 = await lease('a'), a2 = await lease('a'), b = await lease('b');
  assert.deepEqual([a1.nonce_account, a2.nonce_account, b.nonce_account], [n0, n0, n1], 'a second intent replaces the holder\'s first lease');
  const c = await lease('c');
  assert.equal(c.nonce_account, undefined, 'all held: a recent blockhash instead');
  assert.equal(bs58.decode(c.message_b58)[0], 1);
  // The browser reports a decline. Only the holder can release its own lease.
  const release = (accountId, nonce) => route('release', { session: { accountId }, readJson: async () => ({ nonce }) });
  assert.deepEqual((await release('c', b.nonce)).body, { ok: true, released: false });
  assert.deepEqual((await release('b', b.nonce)).body, { ok: true, released: true });
  assert.equal((await lease('c')).nonce_account, n1);
  t.mock.timers.tick(11 * 60 * 1000 + 1);
  assert.equal((await lease('d')).nonce_account, n0, 'an expired lease is offered again');
  // A failure after leasing gives the nonce back.
  const latest = f.settings.rpc.getLatestBlockhash;
  f.settings.rpc.getLatestBlockhash = async () => { throw Error('Solana RPC unavailable'); };
  await assert.rejects(lease('e'), /unavailable/);
  f.settings.rpc.getLatestBlockhash = latest;
  assert.equal((await lease('f')).nonce_account, n1);
});

test('a nonce authority key that does not match the nonce file: no nonce, logged once', async t => {
  const f = await durableFixture(t, 80, { keySeed: Buffer.alloc(32, 81) });
  const warn = t.mock.method(console, 'warn', () => {});
  for (const holder of ['x', 'y']) {
    const intent = await buildVaultDeposit(f.settings, f.ready, request, holder);
    assert.equal(bs58.decode(intent.message_b58)[0], 1, 'one signature: the depositor');
    assert.equal(intent.nonce_account, undefined);
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /authority/);
});

test('/solana/send relays only the exact deposit, with a nonce account from the nonce file', async t => {
  const f = await durableFixture(t, 100);
  const sent = [];
  f.settings.rpc.sendTransaction = async () => { sent.push('send'); };
  f.settings.rpc.getSignatureStatus = async () => ({ slot: 1 });
  const quick = { every: 5, times: 2 };
  const durable = await buildVaultDeposit(f.settings, f.ready, request, 's1');
  assert.deepEqual(await sendDeposit(f.settings, sendBody(signed(durable), durable.nonce), quick), { ok: true, signature: bs58.encode(Buffer.alloc(64, 9)) });
  const single = await buildVaultDeposit({ ...f.settings, nonceFile: undefined }, f.ready, request);
  assert.equal((await sendDeposit(f.settings, sendBody(signed(single), single.nonce), quick)).ok, true);
  assert.equal(sent.length, 2);
  const nonce = '47'.repeat(32);
  const shape = { program, mint, owner, source, nonce, amount_atoms: request.amount_atoms, pftl_recipient: request.pftl_recipient, signed: 9 };
  for (const [label, bytes] of [
    ['an unrelated transfer that names the program and the receipt', await (async () => {
      const receipt = await pda('receipt', Buffer.from(nonce, 'hex'));
      const ix = transfer(owner, pub(31));
      ix.accounts.push({ address: program, role: 0 }, { address: receipt, role: 0 });
      return solanaDeposit({ ...shape, extra: [ix] }).then(b => b);
    })()],
    ['an extra instruction', await solanaDeposit({ ...shape, extra: [transfer(owner, pub(31))] })],
    ['another mint', await solanaDeposit({ ...shape, mint: pub(32) })],
    ['PDAs of another program', await solanaDeposit({ ...shape, pdaProgram: pub(33) })],
    ['a nonce account outside the nonce file', await solanaDeposit({ ...shape, nonceAccount: pub(34), authority: f.authority, lifetime: pub(35) })],
    ['a nonce authority other than the nonce file\'s', await solanaDeposit({ ...shape, nonceAccount: f.nonceAccounts[1], authority: pub(36), lifetime: pub(35) })],
  ]) {
    await assert.rejects(sendDeposit(f.settings, sendBody(bytes, nonce), quick), { status: 400 }, label);
  }
  assert.equal(sent.length, 2, 'nothing else was broadcast');
});

test('re-send loops are capped; a durable re-send continues while its lease is held and its nonce unchanged', async t => {
  const f = await durableFixture(t, 120);
  const cap = vault.MAX_RESEND_LOOPS;
  assert.ok(Number.isSafeInteger(cap) && cap > 0);
  let resends = 0;
  f.settings.rpc.sendTransaction = async (_, options) => { if (options.skipPreflight) resends++; };
  f.settings.rpc.getSignatureStatus = async () => null;
  const single = await buildVaultDeposit({ ...f.settings, nonceFile: undefined }, f.ready, request);
  const sends = Array.from({ length: cap + 2 }, () => sendDeposit(f.settings, sendBody(signed(single), single.nonce), { every: 40, times: 2 }));
  assert.equal((await Promise.all(sends)).length, cap + 2, 'every call is broadcast');
  await sleep(150);
  assert.equal(resends, cap * 2, 'two calls over the cap broadcast once and start no loop');
  resends = 0;
  const durable = await buildVaultDeposit(f.settings, f.ready, request, 'loop');
  await sendDeposit(f.settings, sendBody(signed(durable), durable.nonce), { every: 5, times: 2 });
  await sleep(80);
  assert.ok(resends > 2, 'past the blockhash schedule while the nonce is unchanged');
  f.values.set(durable.nonce_account, pub(250));
  await sleep(30);
  const stopped = resends;
  await sleep(40);
  assert.equal(resends, stopped, 'the nonce moved: re-sending stops');
});

test('durable recovery: expired only when the finalized nonce moved past the signed value and no receipt exists', async () => {
  const nonce = '46'.repeat(32), nonceAccount = pub(140), value = pub(141);
  let current = value;
  const rpc = { getEpochInfo: async () => ({ absoluteSlot: 100, blockHeight: 5000 }), getAccountInfo: async (id, options) => {
    assert.equal(options.commitment, 'finalized');
    return id === nonceAccount ? { owner: SYSTEM, data: nonceData(pub(142), current) } : null;
  } };
  const recovery = { nonce, vault_program_id: program, last_valid_block_height: 98, nonce_account: nonceAccount, nonce_value: value };
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, expired: false }, 'past the height, but it can still land');
  current = pub(143);
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, expired: true });
  assert.notEqual((await route('recovery', { readJson: async () => recovery })).status, 400, 'the route accepts the nonce fields');
});
