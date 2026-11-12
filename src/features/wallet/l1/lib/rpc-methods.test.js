import assert from 'node:assert/strict';
import test from 'node:test';
import { assertL1CallAllowed, L1_READ_METHODS, L1_SUBMIT_METHODS } from './rpc-methods.js';
test('tab RPC contract permits reads and quotes while locked, signed submits only while unlocked', () => {
 for (const method of ['vault_bridge_route','vault_bridge_status','account_assets','book_offers','account_offers','offer_info','navcoin_bridge_routes','navcoin_bridge_supply_status','nav_reserve_proof_status','asset_info','issuer_assets','pftl_uniswap_receipt','asset_fee_quote','offer_fee_quote']) {
  assert.ok(L1_READ_METHODS.has(method));assert.doesNotThrow(()=>assertL1CallAllowed(method,false));
 }
 for (const method of ['mempool_submit_signed_asset_transaction','mempool_submit_signed_asset_transaction_finality','mempool_submit_signed_offer_transaction']) {
  assert.ok(L1_SUBMIT_METHODS.has(method));assert.throws(()=>assertL1CallAllowed(method,false),/Unlock/);assert.doesNotThrow(()=>assertL1CallAllowed(method,true));
 }
 for(const method of ['governance_activate','wallet_keygen','wallet_sign_transfer','unknown']) assert.throws(()=>assertL1CallAllowed(method,true),/not allowed/);
});
