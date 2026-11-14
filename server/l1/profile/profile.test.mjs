import test from 'node:test';
import assert from 'node:assert/strict';
import { depth, transactionsInBlock, createProfileReader } from '../navcoin-profile.js';
import { principalFromTicks } from './ethereum.js';
import { proofProfileId } from './proof-profile.js';
const coin = {slug:'test',asset_id:'asset',market_quote_asset_id:'quote'};
test('depth excludes expired, closed and unrelated offers and preserves quote amounts',()=>{
 const offer={state:'open',taker_gets_asset_id:'asset',taker_pays_asset_id:'quote',taker_gets_amount_remaining:'1500000',taker_pays_amount_remaining:'1600000'};
 assert.deepEqual(depth({offers:[offer,{...offer,state:'filled'},{...offer,expiration_height:20},{...offer,taker_gets_asset_id:'other'}],truncated:true},coin,20),{coin_atoms:'1500000',quote_atoms:'1600000',offers:1,partial:true});
 assert.equal(depth(null,coin,20),null);
});
test('bid depth reverses quote and coin sides',()=>{assert.deepEqual(depth({offers:[{state:'open',taker_gets_asset_id:'quote',taker_pays_asset_id:'asset',taker_gets_amount_remaining:'2000000',taker_pays_amount_remaining:'3000000'}]},coin,1,'bids'),{coin_atoms:'3000000',quote_atoms:'2000000',offers:1,partial:false});});
test('archive refuses missing batches and mismatched transaction counts',()=>{
 const block={header:{batch_id:'b',batch_kind:'transparent'},receipt_ids:['tx']};
 assert.throws(()=>transactionsInBlock(block,[]),/unavailable/);
 assert.throws(()=>transactionsInBlock(block,[{batch_id:'b',batch_kind:'transparent',payload_json:JSON.stringify({batch_id:'b',asset_transactions:[]})}]),/count mismatch/);
});
test('v4 principal covers both sides of a position and verifies complete tick coverage',()=>{
 const ticks=[{tick:-100,net:'1000000000'},{tick:100,net:'-1000000000'}];
 const p=principalFromTicks(ticks,2n**96n,1000000000n,0);assert.ok(p.amount0>4900000&&p.amount0<5000000);assert.ok(Math.abs(p.amount0-p.amount1)<0.00001);
 assert.throws(()=>principalFromTicks(ticks.slice(0,1),2n**96n,1000000000n,0),/coverage/);
 assert.throws(()=>principalFromTicks(ticks,2n**96n,0n,0),/coverage/);
});
test('zero active liquidity can still have off-price principal',()=>{
 const p=principalFromTicks([{tick:100,net:'1000'},{tick:200,net:'-1000'}],2n**96n,0n,0);assert.ok(p.amount0>0);assert.equal(p.amount1,0);
});
test('canonical proof ID reproduces the known live B24 profile',()=>{
 const p={verifier_kind:'sp1-nav-reserve-v1',source_class:'b23-schwab-account-equity-nitro-sp1-v1',max_snapshot_age_blocks:1000,challenge_window_blocks:1,max_epoch_gap_blocks:128,settle_deadline_blocks:256,min_challenge_bond:0,min_attestations:0,tolerance_bp:0,valuation_policy_hash:'2f994eeb09d1aea664d6da8f821b4f96c9911b715cba9ff5fb67f3469f30526c',sp1_program_vkey:'0x003aa6418ef9f87dde386129a1464ea15daf9757849aa66f63cdb779e89266c6',sp1_proof_encoding:'groth16',max_proof_bytes:356,max_public_values_bytes:584,public_values_schema:'postfiat.nav_reserve_public_values.v1',source_manifest_hash:'c01d72df74871cae7a513e51d889ca2ac56f38be0367578c22b01396262b593366c3176e3a0b95b47fa78f9815b2e161',valuation_unit_id:'6003b806e016ecb2d6cbdb34c2ca7877bbf654ba1b26948e575e441962fb038dc53615f2b3b814c7a1b6bb06df537d99',max_observation_span_blocks:1};
 assert.equal(proofProfileId(p),'18365d7d8069dec897afc05ff74b2a910cd01c88265e35e900b0a97d1393211c8b2f6ed1c0c7a37968dee861f3ea9c8e');assert.notEqual(proofProfileId({...p,sp1_program_vkey:'wrong'}),proofProfileId(p));
});
function readerFixture(accepted=true, wrongBlock=false){
 const packet={epoch:1,state:'finalized',submitted_at_height:10,reserve_packet_hash:'packet'};
 const block=h=>({header:{height:h,block_hash:`hash${h}`,batch_id:`batch${h}`,batch_kind:'transparent'},receipt_ids:[`tx${h}`]});
 return createProfileReader({coins:()=>[coin],ethereum:async()=>null,rpc:async(method,params)=>{
  if(method==='nav_reserve_proof_status')return{found:true,asset_id:'asset',current_height:11,packets:[packet],active_profile:{profile_id:'profile'}};
  if(method==='asset_info')return{asset:{asset_id:'asset',precision:6}};
  if(method==='book_offers')return{offers:[]};
  if(method==='blocks')return[block(params.from_height)];
  if(method==='batch_archive'){const h=Number(params.batch_id.slice(5));return[{batch_id:`batch${h}`,batch_kind:'transparent',payload_json:JSON.stringify({batch_id:`batch${h}`,asset_transactions:[{unsigned:{operation:h===10?'nav_reserve_submit':'nav_epoch_finalize',asset_id:'asset',epoch:1,reserve_packet_hash:'packet',proof_profile:'profile'}}]})}];}
  if(method==='tx'){const h=Number(params.tx_id.slice(2));return{tx_id:params.tx_id,confirmed:true,block:wrongBlock?block(99):block(h),receipt:{tx_id:params.tx_id,accepted}};}
  throw Error('Unexpected read');
 }});
}
test('snapshot verification requires literal accepted receipts, not merely commitment',async()=>{assert.equal((await readerFixture().snapshot('test',1)).verified,true);assert.equal((await readerFixture(false).snapshot('test',1)).verified,false);});
test('snapshot refuses receipt from a different block and unknown epochs',async()=>{await assert.rejects(readerFixture(true,true).snapshot('test',1),/identity mismatch/);await assert.rejects(readerFixture().snapshot('test',2),/not found/);});
