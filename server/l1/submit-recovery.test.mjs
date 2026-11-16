import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitRecovery } from './submit-recovery.js';
const env = { L1_HISTORY_RPC_URL: 'tcp://127.0.0.1:1' };
function fixture() {
  const domain = { chain_id: 'fixture', genesis_hash: 'genesis', protocol_version: 1 };
  const signed = { unsigned: { ...domain, source: 'wallet', sequence: 7, operation: 'offer_create', amount: 100 }, public_key_hex: 'public', signature_hex: 'signature' };
  const block = { header: { height: 1, block_hash: 'tip', batch_kind: 'transparent', batch_id: 'batch' }, receipt_ids: ['tx'] };
  const batch = { batch_id: 'batch', offer_transactions: [signed] };
  const responses = { status: { ...domain, block_height: 1, block_tip_hash: 'tip' }, blocks: [block],
    tx: { ...domain, tx_id: 'tx', confirmed: true, verification_mode: 'full-block-replay', block_log_verified: true, receipt_index: 0, receipt_count: 1, block: structuredClone(block), receipt: { tx_id: 'tx', accepted: true, code: 'filled' } } };
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    assert.ok(['status', 'blocks', 'batch_archive', 'tx'].includes(method), 'recovery must only read');
    return method === 'batch_archive' ? [{ batch_kind: 'transparent', batch_id: 'batch', payload_json: JSON.stringify(batch) }] : responses[method];
  };
  return { signed, block, batch, responses, calls, recover: createSubmitRecovery(env, rpc), request: { method: 'mempool_submit_signed_offer_transaction_finality', params: { signed_offer_transaction_json: JSON.stringify(signed) } } };
}
test('exact signed envelope and confirmed bound literal receipt recover with reads only', async () => {
  const f = fixture(), result = await f.recover(f.request);
  assert.equal(result.tx_id, 'tx'); assert.equal(result.finality.receipt.accepted, true);
  assert.deepEqual(f.calls.map(c => c.method), ['status', 'blocks', 'batch_archive', 'tx']);
});
test('any changed signature, key, sequence, source or operation cannot recover', async () => {
  for (const change of [f => f.signed.signature_hex = 'other', f => f.signed.public_key_hex = 'other', f => f.signed.unsigned.sequence++, f => f.signed.unsigned.source = 'other', f => f.signed.unsigned.operation = 'other']) {
    const f = fixture(); change(f); assert.equal(await f.recover(f.request), null);
    assert.ok(!f.calls.some(c => c.method === 'tx'));
  }
});
test('domain, tip, block, receipt identity and confirmation must match', async () => {
  for (const change of [f => f.responses.status.chain_id = 'foreign', f => f.block.header.block_hash = 'unanchored', f => f.responses.tx.block.header.height = 2,
    f => f.responses.tx.genesis_hash = 'foreign', f => f.responses.tx.tx_id = 'other', f => f.responses.tx.receipt.tx_id = 'other',
    f => f.responses.tx.confirmed = false, f => f.responses.tx.block_log_verified = false, f => f.responses.tx.receipt_count = 2,
    f => f.responses.tx.receipt_index = 1, f => f.responses.tx.receipt.accepted = 'true']) {
    const f = fixture(); change(f); assert.equal(await f.recover(f.request), null);
  }
});
test('multi-transaction batches and absent matches remain uncertain', async () => {
  for (const change of [f => f.batch.offer_transactions.push(f.signed), f => f.block.receipt_ids.push('second'), f => f.batch.batch_id = 'other', f => f.batch.offer_transactions = []]) {
    const f = fixture(); change(f); assert.equal(await f.recover(f.request), null);
  }
});
test('literal rejection remains rejection, never converted into acceptance', async () => {
  const f = fixture(); f.responses.tx.receipt.accepted = false;
  assert.equal((await f.recover(f.request)).finality.receipt.accepted, false);
});
test('native selected-block mode preserves its explicit lack of full historical replay', async () => {
  const f = fixture(); f.responses.tx.block_log_verified = false; f.responses.tx.verification_mode = 'selected-block-hot-path';
  const result = await f.recover(f.request);
  assert.equal(result.finality.confirmed, true); assert.equal(result.finality.block_log_verified, false);
});
test('recovery requires explicit loopback read configuration and a signed finality request', async () => {
  assert.equal(createSubmitRecovery({}), null);
  assert.throws(() => createSubmitRecovery({ L1_HISTORY_RPC_URL: 'tcp://remote.invalid:1' }), /loopback/);
  const f = fixture(); assert.equal(await f.recover({ method: 'account', params: {} }), null); assert.equal(f.calls.length, 0);
});
