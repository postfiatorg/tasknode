import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAIN_ID, GENESIS_HASH } from './utils.js';
import { explicitReceipt, requireAccepted, pftInputAtoms, TxBuilder, reviewedSignedOperation } from './tx-builder.js';
const address = 'pf' + '1'.repeat(40), to = 'pf' + '2'.repeat(40);
const intent = { kind: 'transfer', to, amount: '1000000' };
const quote = { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, from: address, to, amount: 1000000, minimum_fee: 1, sequence: 1, sender_meets_reserve_after_transfer: true };
const wasm = { wallet_sign_transfer: () => ({ signature: 'synthetic' }) };
function setup(finality, receipt = []) {
  const calls = [];
  const rpc = { call: async method => { calls.push(method); return { ok: true, result: method === 'transfer_fee_quote' ? { ...quote } : method === 'receipts' ? receipt : finality }; } };
  return { builder: new TxBuilder(rpc), calls };
}
test('certified round, confirmed flag, absent or mismatched receipt are not success', () => {
  assert.equal(explicitReceipt('tx', { round_ok: true, finality: { confirmed: true, tx_id: 'tx', block: { header: { certificate: {} } } } }), null);
  assert.equal(explicitReceipt('tx', { finality: { receipt: { tx_id: 'other', accepted: true } } }), null);
  assert.throws(() => requireAccepted('tx', null), /No execution receipt/);
  assert.throws(() => requireAccepted('tx', { tx_id: 'tx', accepted: false, reject_reason: 'insufficient_balance' }), /insufficient_balance/);
});
test('accepted receipt returns; handle is single-use', async () => {
  const { builder, calls } = setup({ tx_id: 'tx', finality: { receipt: { tx_id: 'tx', accepted: true } } });
  const q = await builder.quote(intent, address);const signed = builder.sign(intent, q, address, 'fixture', wasm);
  assert.equal((await builder.submit(signed)).receipt.accepted, true);
  await assert.rejects(builder.submit(signed), /stale or already submitted/);
  assert.equal(calls.filter(m => m.includes('submit')).length, 1);
});
test('certified rejected transaction throws and missing receipt stays unverified', async () => {
  for (const accepted of [false, null]) {
    const { builder } = setup({ tx_id: 'tx', round_ok: true }, accepted === null ? [] : [{ tx_id: 'tx', accepted, code: 'rejected' }]);
    const q = await builder.quote(intent, address);const signed = builder.sign(intent, q, address, 'fixture', wasm);
    await assert.rejects(builder.submit(signed, { timeoutMs: 5, pollMs: 1 }), accepted === false ? /rejected/ : /No execution receipt/);
  }
});
test('changed quote, intent, chain domain and unreviewed quote cannot sign', async () => {
  const { builder } = setup({});const q = await builder.quote(intent, address);
  assert.throws(() => builder.sign({ ...intent, amount: '2' }, q, address, 'fixture', wasm), /changed/);
  assert.throws(() => builder.sign(intent, { ...q }, address, 'fixture', wasm), /changed/);
  q.minimum_fee = 100;assert.throws(() => builder.sign(intent, q, address, 'fixture', wasm), /changed/);
  const wrong = new TxBuilder({ call: async () => ({ ok: true, result: { ...quote, chain_id: 'wrong' } }) });
  await assert.rejects(wrong.quote(intent, address), /devnet-2/);
});
test('exact PFT conversion rejects precision loss, zero, negatives and unsafe amounts', () => {
  assert.equal(pftInputAtoms('1.000001'), '1000001');
  for (const value of ['0', '-1', '0.0000001', '1e6', '9999999999999999999']) assert.throws(() => pftInputAtoms(value));
});

test('asset signer cannot silently discard new policy fields', async () => {
  const operation = { operation: 'synthetic_policy', spread_recipient: to };
  const assetIntent = { kind: 'asset', operation };
  const builder = new TxBuilder({ call: async () => ({ ok: true, result: { ...quote, source: address, operation, sender_meets_reserve_after_fee: true } }) });
  const q = await builder.quote(assetIntent, address);
  assert.throws(() => builder.sign(assetIntent, q, address, 'fixture', { wallet_sign_asset_transaction_fields: () => ({ unsigned: { operation: { operation: 'synthetic_policy' } } }) }), /cannot preserve/);
});

test('flattened signed operation preserves complete reviewed fields and detects omissions', () => {
 const operation={operation:'pftl_uniswap_redemption_fund',funding_sequence:7,amount_atoms:1000000};
 assert.deepEqual(reviewedSignedOperation({unsigned:{chain_id:CHAIN_ID,...operation}},operation),operation);
 assert.equal(reviewedSignedOperation({unsigned:{operation:operation.operation,amount_atoms:1000000}},operation),null);
});

test('offers submit only through release-2 finality with exact signed parameter and accepted receipt', async () => {
 const operation={operation:'offer_cancel',owner:address,offer_id:'a'.repeat(96)}, calls=[];
 const builder=new TxBuilder({call:async(method,params)=>{calls.push({method,params});return {ok:true,result:method==='offer_fee_quote'?{...quote,source:address,operation,sender_meets_reserve_after_fee:true}:{tx_id:'offer-tx',finality:{receipt:{tx_id:'offer-tx',accepted:true}}}};}});
 const intent={kind:'offer',operation}, reviewed=await builder.quote(intent,address);
 const handle=builder.sign(intent,reviewed,address,'fixture',{wallet_sign_offer_transaction_fields:()=>({unsigned:operation})});
 assert.equal((await builder.submit(handle)).receipt.accepted,true);
 assert.equal(calls[1].method,'mempool_submit_signed_offer_transaction_finality');
 assert.deepEqual(Object.keys(calls[1].params),['signed_offer_transaction_json']);
});
