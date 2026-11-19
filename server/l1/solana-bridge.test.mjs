import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Message, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { buildVaultDeposit, readVault, recoverDeposit } from './solana-vault.js';
import { handleBridgeRoutes } from './bridge-routes.js';

const pub = byte => new PublicKey(Buffer.alloc(32, byte));
const program = pub(2), owner = pub(5), mint = pub(7), source = pub(9);
const token = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const binding = '23'.repeat(32);
const request = { owner: owner.toBase58(), amount_atoms: '2500000', pftl_recipient: 'pf' + 'ab'.repeat(20) };
const signature = bs58.encode(Buffer.alloc(64, 4));
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => Buffer.from(s)), program)[0];

function fixture() {
  const data = Buffer.alloc(96);
  mint.toBuffer().copy(data);
  Buffer.from(binding, 'hex').copy(data, 32);
  data.writeBigUInt64LE(10000000n, 64);
  data.writeBigUInt64LE(20000000n, 72);
  data.writeBigUInt64LE(15000000n, 80);
  data.writeBigUInt64LE(10n, 88);
  const account = { owner: program, data };
  const health = { ok: true, ready: true, vault_program_id: program.toBase58(), light_client_epoch: 3 };
  const rpc = {
    getAccountInfo: async key => { assert.ok(key.equals(pda('config'))); return account; },
    getEpochInfo: async () => ({ epoch: 3, absoluteSlot: 100 }),
    getLatestBlockhash: async () => ({ blockhash: pub(12).toBase58(), lastValidBlockHeight: 1234 }),
    getParsedTokenAccountsByOwner: async () => ({ value: [{ pubkey: source, account: { owner: token, data: { parsed: { info: {
      state: 'initialized', owner: request.owner, mint: mint.toBase58(), tokenAmount: { amount: '5000000', decimals: 6 },
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
  const tx = Transaction.populate(Message.from(bs58.decode(first.message_b58)));
  assert.deepEqual(tx.feePayer, owner);
  assert.equal(tx.recentBlockhash, pub(12).toBase58());
  assert.equal(tx.instructions.length, 1);
  const [ix] = tx.instructions;
  assert.deepEqual(ix.programId, program);
  assert.deepEqual(ix.keys.map(k => k.pubkey), [owner, source, pda('config'), pda('custody'), mint, pda('receipt', nonce), token, SystemProgram.programId]);
  assert.deepEqual(ix.keys.map(k => k.isWritable), [true, true, true, true, false, true, false, false]);
  assert.deepEqual(ix.keys.filter(k => k.isSigner).map(k => k.pubkey), [owner]);
  assert.equal(ix.data.toString('hex'), '01a025260000000000' + 'ab'.repeat(20) + first.nonce);
  assert.equal(pda('receipt', nonce).toBase58(), first.receipt);
  await assert.rejects(buildVaultDeposit(settings, ready, { ...request, amount_atoms: '5000001' }), /exceeds/);
  settings.rpc.getParsedTokenAccountsByOwner = async () => ({ value: [] });
  await assert.rejects(buildVaultDeposit(settings, ready, request), /No USDC account/);
});

test('readiness refuses mismatched program, mint, binding, epoch, config owner, cap and initialization slot', async () => {
  for (const change of [
    ({ health }) => { health.vault_program_id = pub(11).toBase58(); },
    ({ account }) => { account.data[0] ^= 1; },
    ({ account }) => { account.data[32] ^= 1; },
    ({ health }) => { health.light_client_epoch++; },
    ({ account }) => { account.owner = SystemProgram.programId; },
    ({ account }) => account.data.writeBigUInt64LE(20000000n, 80),
    ({ account }) => account.data.writeBigUInt64LE(100n, 88),
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(readVault(f.settings, f.health));
  }
});

test('lost Phantom reply recovers only a finalized successful vault deposit for the nonce', async () => {
  const nonce = '45'.repeat(32), recovery = { nonce, vault_program_id: program.toBase58(), last_valid_block_height: 98 };
  const receipt = pda('receipt', Buffer.from(nonce, 'hex'));
  const rpc = { getEpochInfo: async () => ({ absoluteSlot: 100, blockHeight: 99 }), getAccountInfo: async (id, options) => {
    assert.ok(id.equals(receipt)); assert.equal(options.minContextSlot, 100); return null;
  } };
  assert.deepEqual(await recoverDeposit({ rpc, program }, recovery), { ok: true, expired: true });
  assert.deepEqual(await recoverDeposit({ rpc, program }, { ...recovery, last_valid_block_height: 99 }), { ok: true, expired: false });
  const account = Buffer.alloc(132); account.write('PFSOLRC1'); Buffer.from(nonce, 'hex').copy(account, 68);
  rpc.getAccountInfo = async () => ({ owner: program, data: account });
  rpc.getSignaturesForAddress = async () => [{ signature: 'unrelated', err: null }, { signature, err: null }];
  rpc.getParsedTransaction = async sig => ({ meta: { err: null }, transaction: { message: { instructions: [{
    programId: sig === signature ? program : mint, accounts: [owner, source, pda('config'), pda('custody'), mint, receipt],
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
  await writeFile(config, JSON.stringify({ ledger: 'node', vault_program: program.toBuffer().toString('hex'),
    deposit_vkey: '0x' + '42'.repeat(32), http_token_file: 'http-token', state: dir, current_epoch: 3 }));
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
  const env = { L1_SOLANA_RELAY_CONFIG: await relayFiles(t), L1_SOLANA_RELAY_URL: 'http://jobs.test', L1_SOLANA_RPC_URL: 'http://solana.test',
    L1_SOLANA_VAULT_PROGRAM_ID: program.toBase58(), L1_SOLANA_USDC_MINT: mint.toBase58(), L1_SOLANA_ROUTE_BINDING: binding };
  t.mock.method(globalThis, 'fetch', async (url, opt) => {
    if (new URL(url).host === 'jobs.test') {
      assert.equal(url.pathname + url.search, '/api/bridge/readiness?route=solana-mainnet-usdc-v1');
      return Response.json({ ...health, ledger: 'node', route_id: 'solana-mainnet-usdc-v1', source_proof_kind: 'sp1-solana-alpenglow-finality-v1',
        program_vkey: '0x' + '42'.repeat(32), observer_attestor_enabled: false });
    }
    const { id, method } = JSON.parse(opt.body);
    const info = { lamports: 100000, executable: false, rentEpoch: 2 };
    const context = { slot: 100 };
    const results = {
      getEpochInfo: { epoch, absoluteSlot: 100, slotsInEpoch: 50, slotIndex: 12 },
      getAccountInfo: { context, value: { ...info, owner: program.toBase58(), data: [account.data.toString('base64'), 'base64'] } },
      getLatestBlockhash: { context, value: { blockhash: pub(12).toBase58(), lastValidBlockHeight: 1234 } },
      getTokenAccountsByOwner: { context, value: [{ pubkey: source.toBase58(), account: { ...info, owner: token.toBase58(),
        data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: request.owner, mint: mint.toBase58(),
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
