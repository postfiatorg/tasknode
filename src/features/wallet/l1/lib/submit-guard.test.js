// The optional operation guard of a submission (R5-01), run with the real TxBuilder and RpcClient
// over a stand-in socket. The guard is asked after the connection is established and just before
// the bytes are sent. Without a guard a submission is unchanged, byte for byte and call for call,
// from b24a7c1 (the transport before the proving-window feature).
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import { CHAIN_ID, GENESIS_HASH, PROTOCOL_VERSION } from './utils.js';
import { RpcClient } from './rpc-client.js';
import { TxBuilder } from './tx-builder.js';

const BASELINE = 'b24a7c1dde0e5f6f7d0b8783621f99373b466870';
const here = new URL('.', import.meta.url);
const address = 'pf' + '1'.repeat(40), TX = 'e'.repeat(96);
const intent = { kind: 'asset', operation: { operation: 'vault_bridge_burn_to_redeem', owner: address, amount_atoms: 1 } };
const wasm = { wallet_sign_asset_transaction_fields: (backup, fields) => ({ unsigned: JSON.parse(fields), signature: 'synthetic' }) };
function later() { let finish; const promise = new Promise(resolve => { finish = resolve; }); return { promise, finish }; }

// b24a7c1's rpc-client.js and tx-builder.js, with their other imports pointed at today's modules.
async function baseline(dir) {
  const show = name => execFileSync('git', ['show', `${BASELINE}:src/features/wallet/l1/lib/${name}`], { cwd: new URL('../../../../..', here), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const point = code => code.replace(/from '\.\/(custody-boundary|vault|utils)\.js'/g, (whole, name) => `from '${new URL(`${name}.js`, here).href}'`);
  await writeFile(join(dir, 'rpc-client.js'), point(show('rpc-client.js')));
  await writeFile(join(dir, 'tx-builder.js'), point(show('tx-builder.js')));
  const base = pathToFileURL(join(dir, '/')).href;
  return { RpcClient: (await import(base + 'rpc-client.js')).RpcClient, TxBuilder: (await import(base + 'tx-builder.js')).TxBuilder };
}

// One quote, one signature and one submission; the socket answers every request it is sent.
async function submission({ RpcClient: Rpc, TxBuilder: Builder }, { guard, during } = {}) {
  const rpc = new Rpc('ws://fixture.invalid'), sent = [], calls = [], events = [];
  rpc.connect = () => Promise.resolve();
  rpc.socket = {
    send(raw) {
      sent.push(raw); events.push('send');
      const message = JSON.parse(raw), task = rpc.pending.get(message.id);
      const result = message.method === 'asset_fee_quote'
        ? { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: PROTOCOL_VERSION, source: address, sequence: 1, minimum_fee: 1, sender_meets_reserve_after_fee: true, operation: JSON.parse(message.params.operation_json) }
        : { tx_id: TX, finality: { receipt: { tx_id: TX, accepted: true } } };
      queueMicrotask(() => { clearTimeout(task.timer); rpc.pending.delete(message.id); task.resolve({ id: message.id, ok: true, result }); });
    },
  };
  const call = rpc.call.bind(rpc);
  rpc.call = (...args) => { calls.push(args.map(arg => (typeof arg === 'function' ? 'function' : arg))); return call(...args); };
  const builder = new Builder(rpc);
  const quote = await builder.quote(intent, address);
  const handle = builder.sign(intent, quote, address, 'fixture', wasm);
  const gate = later();
  if (during) rpc.connect = () => gate.promise;
  const asked = guard && (() => { events.push('guard'); return guard(); });
  const submitting = builder.submit(handle, asked ? { guard: asked } : undefined).then(value => ({ value }), error => ({ error }));
  if (during) { await new Promise(resolve => setImmediate(resolve)); events.push('connected'); during(); gate.finish(); }
  return { ...(await submitting), sent, calls, events };
}

test('without a guard, a submission sends the same bytes with the same calls as b24a7c1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'submit-guard-'));
  try {
    const before = await submission(await baseline(dir)), now = await submission({ RpcClient, TxBuilder });
    assert.equal(now.error, undefined);
    assert.equal(now.sent.length, 2);
    assert.deepEqual(now.calls.map(args => args.length), [2, 3]);
    assert.deepEqual(now, before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a guard that refuses once the connection is established sends nothing', async () => {
  let allowed = true;
  const out = await submission({ RpcClient, TxBuilder }, { guard: () => allowed, during: () => { allowed = false; } });
  assert.equal(out.error?.code, 'l1_not_dispatched');
  assert.equal(out.sent.length, 1, 'only the quote was sent');
  assert.deepEqual(out.events, ['send', 'connected', 'guard']);
});

test('a guard that allows is asked after the connection and just before the bytes leave', async () => {
  const out = await submission({ RpcClient, TxBuilder }, { guard: () => true, during: () => {} });
  assert.equal(out.value.txId, TX);
  assert.deepEqual(out.events, ['send', 'connected', 'guard', 'send']);
});
