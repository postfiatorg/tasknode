import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as wasm from './wasm/postfiat_wallet_wasm.js';
import { TxBuilder, reviewedSignedOperation } from './lib/tx-builder.js';
import { CHAIN_ID, GENESIS_HASH } from './lib/utils.js';
const bytes=await readFile(new URL('./wasm/postfiat_wallet_wasm_bg.wasm',import.meta.url));
wasm.initSync({module:bytes});
const wallet=wasm.wallet_keygen(CHAIN_ID,wasm.random_master_seed(),0);
const recipient='pf'+'2'.repeat(40);
const policy={policy_hash:'1'.repeat(96),policy_epoch:2,issue_multiplier_bps:10020,redeem_multiplier_bps:9980,issue_capacity_atoms:1000000000000,redeem_capacity_atoms:1000000000000,max_order_atoms:1000000000000,min_order_atoms:1,valid_from_height:100,expires_at_height:100000,max_nav_age_blocks:1000,pricing_nav_epoch:1,pricing_reserve_packet_hash:'3'.repeat(96),spread_recipient:recipient};
// bbefee80b policy computed_hash: ordered text, SHA3-384(domain || NUL || text).
const policyKeys=['policy_epoch','issue_multiplier_bps','redeem_multiplier_bps','issue_capacity_atoms','redeem_capacity_atoms','max_order_atoms','min_order_atoms','valid_from_height','expires_at_height','max_nav_age_blocks','pricing_nav_epoch','pricing_reserve_packet_hash','spread_recipient'];
policy.policy_hash=createHash('sha3-384').update('postfiat.pftl_uniswap.primary_market_policy.v2').update(Buffer.from([0])).update(policyKeys.map(key=>`${key}=${policy[key]}\n`).join('')).digest('hex');
const operations=[
 {operation:'pftl_uniswap_route_epoch_advance',operator:wallet.address,route_id:'synthetic-b23-route',prior_route_epoch:1,next_route_epoch:2,next_route_config_digest:'4'.repeat(96),live_value_enabled:true,next_primary_market_policy:policy},
 {operation:'pftl_uniswap_redemption_fund',funder:wallet.address,route_id:'synthetic-b23-route',settlement_asset_id:'5'.repeat(96),funding_nonce:'6'.repeat(64),amount_atoms:1000000,funding_sequence:1},
];
for(const operation of operations){
 const quote={chain_id:CHAIN_ID,genesis_hash:GENESIS_HASH,protocol_version:1,source:wallet.address,minimum_fee:1,sequence:1,sender_meets_reserve_after_fee:true,operation};
 let captured;
 const signingWasm={wallet_sign_asset_transaction_fields:(backup,fields)=>{captured=wasm.wallet_sign_asset_transaction_fields(backup,fields);return captured;}};
 const rpc={call:async method=>{assert.equal(method,'asset_fee_quote','Signing qualification must never submit');return {ok:true,result:structuredClone(quote)};}};
 const builder=new TxBuilder(rpc);const intent={kind:'asset',operation};const reviewed=await builder.quote(intent,wallet.address);
 builder.sign(intent,reviewed,wallet.address,wallet.backup_json,signingWasm);
 assert.deepEqual(reviewedSignedOperation(captured,operation),operation);
 assert.ok(captured.signature_hex && captured.public_key_hex,'Actual ML-DSA signature required');
 if(operation.operation.endsWith('epoch_advance'))assert.equal(captured.unsigned.next_primary_market_policy.spread_recipient,recipient);
 else assert.equal(captured.unsigned.funding_sequence,1);
 console.log('PASS:',operation.operation,'real WASM signature preserves every reviewed field');
}
console.log(JSON.stringify({release:'aba0efb70',wasmSha256:createHash('sha256').update(bytes).digest('hex'),signedOperations:2,submissions:0}));
