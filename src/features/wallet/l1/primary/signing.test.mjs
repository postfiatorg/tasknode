import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as wasm from '../wasm/postfiat_wallet_wasm.js';
import { TxBuilder, reviewedSignedOperation } from '../lib/tx-builder.js';
import { CHAIN_ID, GENESIS_HASH } from '../lib/utils.js';
import { fixture, config } from './fixtures.js';
import { createPlan, subscriberRedeem } from './model.js';
wasm.initSync({ module: await readFile(new URL('../wasm/postfiat_wallet_wasm_bg.wasm', import.meta.url)) });
const wallet = wasm.wallet_keygen(CHAIN_ID, wasm.random_master_seed(), 0), { client, state } = fixture(), plan = await createPlan(client, config, '1');
state.balances.assets.lines[0].balance = 1000000; state.pool.native_spendable_balances = [{ wallet: client.address, amount_atoms: 1000000 }]; state.pool.source_settlement_custody[0].principal_atoms = 1000000;
const operations = [...plan.steps.map(step => step.intent.operation), subscriberRedeem(config, state, '1', client.address).intent.operation];
for (const original of operations) {
  const operation = { ...original }; for (const key of ['subscriber', 'owner', 'settlement_recipient', 'releaser']) if (key in operation) operation[key] = wallet.address;
  const quote = { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, source: wallet.address, minimum_fee: 30, sequence: 1, sender_meets_reserve_after_fee: true, operation };
  let signed; const builder = new TxBuilder({ call: async method => { assert.equal(method, 'asset_fee_quote'); return { ok: true, result: quote }; } });
  const intent = { kind: 'asset', operation }, reviewed = await builder.quote(intent, wallet.address);
  builder.sign(intent, reviewed, wallet.address, wallet.backup_json, { wallet_sign_asset_transaction_fields: (backup, fields) => (signed = wasm.wallet_sign_asset_transaction_fields(backup, fields)) });
  assert.deepEqual(reviewedSignedOperation(signed, operation), operation); assert.ok(signed.signature_hex);
  console.log('PASS actual wallet signature preserves every reviewed field:', operation.operation);
}
console.log('Synthetic key only; no submissions.');
