import test from 'node:test';
import assert from 'node:assert/strict';
import { depth, transactionsInBlock, createProfileReader } from '../navcoin-profile.js';
import { principalFromTicks } from './ethereum.js';
import { proofProfileId } from './proof-profile.js';
import { readFileSync } from 'node:fs';
import { decodePublicValues, boundPublicValues } from './public-values.js';
import { precisePercentages } from '../../../src/features/wallet/l1/profile/verification.js';
const coin = {slug:'test',asset_id:'asset',market_quote_asset_id:'quote'};
test('archived B24 PFNAV001 decodes attested amount, source policy and block heights without inventing a timestamp', () => {
 const bytes = [...Buffer.from(readFileSync(new URL('./fixtures/b24-epoch1.hex', import.meta.url), 'utf8').trim(), 'hex')];
 const v = decodePublicValues(bytes);
 assert.equal(v.attested_value, '420302380000'); assert.equal(v.observation_not_before, '1310'); assert.equal(v.observation_not_after, '1310');
 assert.equal(v.source_manifest_hash, 'c01d72df74871cae7a513e51d889ca2ac56f38be0367578c22b01396262b593366c3176e3a0b95b47fa78f9815b2e161');
 assert.equal(v.reading_timestamp, undefined);
 const op = { sp1_public_values: bytes, asset_id: v.nav_asset_id, proof_profile: v.proof_profile_id };
 assert.deepEqual(boundPublicValues(op, v.pftl_genesis_hash), v);
 assert.throws(() => boundPublicValues({ ...op, asset_id: 'wrong' }, v.pftl_genesis_hash), /do not match/);
 assert.throws(() => decodePublicValues(bytes.slice(1)), /schema/);
 const corrupt = [...bytes]; corrupt[400] ^= 1; assert.throws(() => decodePublicValues(corrupt), /Inconsistent/);
});
test('trust percentages preserve small reported amounts and a total of 100 percent', () => {
 assert.deepEqual(precisePercentages([0n, 420302380000n, 20000000n]), ['0%', '99.995%', '0.005%']);
 assert.deepEqual(precisePercentages([1n, 1n, 1n]), ['33.334%', '33.333%', '33.333%']);
 assert.equal(precisePercentages([1n, 1000000000n, 0n])[0], '<0.001%');
});
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
function readerFixture(accepted=true, wrongBlock=false, extra={}){
 const packet={epoch:1,state:'finalized',submitted_at_height:10,reserve_packet_hash:'packet'};
 const block=h=>({header:{height:h,block_hash:`hash${h}`,batch_id:`batch${h}`,batch_kind:'transparent'},receipt_ids:[`tx${h}`]});
 return createProfileReader({...extra,coins:()=>[coin],ethereum:async()=>null,rpc:async(method,params)=>{
  if(method==='nav_reserve_proof_status')return{found:true,asset_id:'asset',current_height:11,packets:[packet],active_profile:{profile_id:'profile'}};
  if(method==='asset_info')return{asset:{asset_id:'asset',precision:6}};
  if(method==='book_offers')return{offers:[]};
  if(method==='blocks')return[block(params.from_height)];
  if(method==='batch_archive'){const h=Number(params.batch_id.slice(5));return[{batch_id:`batch${h}`,batch_kind:'transparent',payload_json:JSON.stringify({batch_id:`batch${h}`,asset_transactions:[{unsigned:{operation:h===10?'nav_reserve_submit':'nav_epoch_finalize',asset_id:'asset',epoch:1,reserve_packet_hash:'packet',proof_profile:'profile'}}]})}];}
  if(method==='receipts')return[{tx_id:wrongBlock?'wrong':params.tx_id,accepted}];
  throw Error('Unexpected read');
 }});
}
test('snapshot verification requires literal accepted receipts, not merely commitment',async()=>{assert.equal((await readerFixture().snapshot('test',1)).verified,true);assert.equal((await readerFixture(false).snapshot('test',1)).verified,false);});
test('snapshot refuses a mismatched receipt and unknown epochs',async()=>{await assert.rejects(readerFixture(true,true).snapshot('test',1),/conflicting transaction receipts/);await assert.rejects(readerFixture().snapshot('test',2),/not found/);});

test('archive refuses payload substitution against the committed certificate',()=>{
 const block={header:{batch_id:'b',batch_kind:'transparent',consensus_v2_commit:{precommit_qc:{block:{payload_hash:'anchored'}}}},receipt_ids:[]};
 assert.throws(()=>transactionsInBlock(block,[{batch_id:'b',batch_kind:'transparent',payload_hash:'substituted',payload_json:'{}'}]),/payload hash/);
});

test('Ethereum publication requires exact asset, epoch, reserve packet and route bindings',async()=>{
 const {Interface,keccak256,toUtf8Bytes}=await import('ethers');
 const {decodePublication}=await import('./ethereum-history.js');
 const iface=new Interface(['function verifyAndAccept(bytes,bytes)']);
 const coin={asset_id:'11'.repeat(48),route_id:'route-a'},packet={epoch:7,reserve_packet_hash:'22'.repeat(48)};
 const words=Array(35).fill('00'.repeat(32));words[13]=keccak256('0x'+coin.asset_id).slice(2);words[15]=(7n).toString(16).padStart(64,'0');words[16]=keccak256('0x'+packet.reserve_packet_hash).slice(2);words[10]=keccak256(toUtf8Bytes(coin.route_id)).slice(2);
 const input=iface.encodeFunctionData('verifyAndAccept',['0x'+words.join(''),'0x01']);assert.equal(decodePublication(input,coin,packet),true);
 assert.equal(decodePublication(input,coin,{...packet,epoch:8}),false);assert.equal(decodePublication(input,{...coin,asset_id:'33'.repeat(48)},packet),false);assert.equal(decodePublication(input,coin,{...packet,reserve_packet_hash:'44'.repeat(48)}),false);assert.equal(decodePublication(input,{...coin,route_id:'route-b'},packet),false);
});

test('temporary Ethereum history failures do not poison immutable native snapshot caching', async () => {
 let reads = 0;
 const reader = readerFixture(true, false, { ethereumHistory: async () => { if (++reads === 1) throw Error('temporary RPC failure'); return ['0xverified']; } });
 const first = await reader.snapshot('test', 1); assert.equal(first.verified, true); assert.deepEqual(first.ethereum_transactions, []);
 const refreshed = await reader.snapshot('test', 1); assert.deepEqual(refreshed.ethereum_transactions, ['0xverified']); assert.equal(refreshed.submit.tx_id, first.submit.tx_id);
});

test('actual B24 V2 Ethereum publication binds its native epoch and reserve packet', async () => {
 const { decodePublication } = await import('./ethereum-history.js');
 const input = readFileSync(new URL('./fixtures/b24-mainnet-publication.hex', import.meta.url), 'utf8').trim();
 const coin = { asset_id: '52285e4ded1d58113cfaa12bbc034b8b10213f699b3224c74160450229d6bf7ccfe505c78f2599d975ae2ecf98f7d8af', route_id: 'pftl-b24-ethereum-wB24-usdc-v1' };
 const packet = { epoch: 2, reserve_packet_hash: '72d72a20dd2a00ba325175968ee0dcee680d5354bd2ebac6b18c5f324215bc7fdba5bf5569b516e51ba6351e2bad178a' };
 assert.equal(decodePublication(input, coin, packet), true);
 assert.equal(decodePublication(input, coin, { ...packet, epoch: 1 }), false);
});
