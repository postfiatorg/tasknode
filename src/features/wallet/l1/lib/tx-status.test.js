import assert from 'node:assert/strict';
import test from 'node:test';
import { chainTxStatus } from './tx-status.js';
const id = 'a'.repeat(96);
const client = response => ({ call: async (method, params) => { assert.equal(method, 'tx'); assert.equal(params.tx_id, id); return response; } });
test('chain status: only a typed not-found is missing; other failures throw', async () => {
  assert.equal(await chainTxStatus(client({ ok: true, result: { tx_id: id, confirmed: true, receipt: { tx_id: id, accepted: true } } }), id), 'accepted');
  assert.equal(await chainTxStatus(client({ tx_id: id, confirmed: true, receipt: { tx_id: id, accepted: false } }), id), 'rejected');
  assert.equal(await chainTxStatus(client({ ok: false, error: { code: 'rpc_tx_not_found', message: 'no receipt' } }), id), 'missing');
  assert.equal(await chainTxStatus(client({ ok: true, result: { tx_id: id, confirmed: false } }), id), 'unconfirmed');
  assert.equal(await chainTxStatus(client({ ok: true, result: { tx_id: 'b'.repeat(96), confirmed: true, receipt: { tx_id: id, accepted: false } } }), id), 'unconfirmed');
  await assert.rejects(chainTxStatus(client({ ok: false, error: { code: 'rpc_unavailable', message: 'Database already open' } }), id), /Database already open/);
  await assert.rejects(chainTxStatus({ call: async () => { throw new Error('L1 RPC timed out'); } }, id), /timed out/);
});
