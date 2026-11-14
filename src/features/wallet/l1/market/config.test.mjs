import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfig, assetSymbols, marketReady } from './constants.js';
import { discoverRegistry } from '../../../../../server/l1/navcoin-registry.js';
import { readCoin, heldNavValues, sortByTvl } from '../gallery/model.js';
import { buildOffer } from './model.js';
import { labelActivity } from '../activity-model.js';
import { classifyLines } from '../portfolio.js';
const id = x => x.repeat(96), address = 'pf' + '1'.repeat(40);
function fixture() {
  const metadata = ['a','b','c','d'].map((key,i) => ({ asset_id:id(key), slug:'coin-'+key, name:'Coin'+key, retired:i===3, issue_multiplier_bps:9999, creation_enabled:true, market_quote_asset_id:id('f') }));
  const route = key => ({ route_id: 'route-'+key, native_nav_asset_id:id(key), settlement_asset_id:id('e'), ethereum_chain_id:1, handoff_controller:'0x'+'1'.repeat(40) });
  const packets = [{state:'finalized',epoch:3,reserve_packet_hash:id('f'),submitted_at_height:100,nav_per_unit:2000000,verified_net_assets:10000000,circulating_supply:5000000}];
  const rpc = async (method,params) => {
    const key = params?.asset_id?.[0] || params?.route_id?.at(-1);
    if(method==='status') return {active_nav_profiles: metadata.map(m=>({asset_id:m.asset_id}))};
    if(method==='navcoin_bridge_routes') return {routes:['a','b','d'].map(route)};
    if(method==='asset_info') return {asset:{asset_id:params.asset_id, code: key==='9'?'PFUSDC':'COIN'+key.toUpperCase(),issuer:address,precision:6,outstanding_supply:5000000,asset_family_id:key==='9'?id('e'):params.asset_id}};
    if(method==='nav_reserve_proof_status') return {asset_id:params.asset_id,current_height:110,active_profile:{profile_id:id('f')},packets};
    if(method==='navcoin_bridge_supply_status') return {...route(key),live_value_enabled:true,paused:false,invariant_holds:true,pricing_nav_epoch:3,pricing_reserve_packet_hash:id('f'),policy_valid_from_height:100,policy_expires_at_height:key==='b'?101:1000,max_nav_age_blocks:1000,issue_multiplier_bps:10050,redeem_multiplier_bps:9995,source_settlement_custody:[{asset_id:id('9'),enabled_for_issue:true}],settlement_reserve_atoms:0};
    if(method==='book_offers') return {...params,offers:[]};
    throw Error(method);
  };
  return {metadata,rpc};
}
test('registry discovers each identity and chain terms; metadata cannot override route or capabilities',async()=>{
 const f=fixture(), coins=await discoverRegistry(f.rpc,f.metadata);
 assert.equal(coins.length,4);
 const [active,stale,absent,retired]=coins;
 assert.equal(active.issue_multiplier_bps,10050); assert.equal(active.market_quote_asset_id,id('9'));
 assert.equal(active.nav_asset_id,id('a')); assert.equal(active.symbol,'COINA');
 assert.equal(active.capabilities.create.available,true); assert.equal(active.capabilities.book.available,true);
 assert.equal(stale.capabilities.create.available,false); assert.match(stale.capabilities.book.reason,/stale/);
 assert.equal(absent.route_id,null); assert.equal(absent.market_quote_asset_id,null); assert.equal(absent.capabilities.book.available,false);
 assert.equal(retired.retired,true); assert.equal(marketReady(retired,{}),false);
 assert.equal(active.ethereum.available,false); assert.match(active.ethereum.reason,/not verified/);
 assert.equal('b23_asset_id' in active,false);
 const owner='pf'+'2'.repeat(40);
 assert.equal(buildOffer(active,owner,'buy','1','2').operation.taker_pays_asset_id,id('a'));
 assert.throws(()=>buildOffer(stale,owner,'buy','1','2'),/blocked/);
 const read=await readCoin({call:()=>{throw Error('No extra RPC for server snapshot');}},absent);
 assert.equal(read.asset.asset_id,id('c')); assert.equal(read.depth,null);
});
test('cross-coin route and quote responses fail closed', async()=>{
 const f=fixture();
 for(const method of ['asset_info','nav_reserve_proof_status','navcoin_bridge_supply_status','book_offers']) {
  await assert.rejects(discoverRegistry(async(m,p)=>{const v=await f.rpc(m,p);if(m===method){if(m==='asset_info')v.asset.asset_id=id('0');else if(m==='nav_reserve_proof_status')v.asset_id=id('0');else if(m==='book_offers')v.taker_pays_asset_id=id('0');else v.native_nav_asset_id=id('0');}return v;},f.metadata),/identity mismatch/);
 }
});
test('selected config has no default; response must match selected asset',async()=>{
 await assert.rejects(loadConfig(),/Choose/);
 await assert.rejects(loadConfig(id('a'),async()=>Response.json({nav_asset_id:id('b')})),/identity mismatch/);
 assert.throws(()=>validateConfig({b23_asset_id:id('a')}),/Choose/);
 assert.equal(validateConfig({nav_asset_id:id('a'),private_key:'secret'}).private_key,undefined);
});
test('portfolio and activity label all coins by asset and route; retired NAV excluded',async()=>{
 const f=fixture(),coins=await discoverRegistry(f.rpc,f.metadata), lines=coins.map(c=>({asset_id:c.asset_id,balance:1000000}));
 assert.equal(assetSymbols(coins)[id('a')],'COINA');
 assert.equal(classifyLines(lines,coins).nav,4000000n);
 const rows=labelActivity([{transaction_kind:'issued_payment',asset_id:id('a')},{transaction_kind:'pftl_uniswap_primary_redeem',route_id:'route-b'}],coins);
 assert.equal(rows[0].unit,'COINA');assert.equal(rows[1].unit,'COINB');
 const rich=await Promise.all(coins.map(c=>readCoin({},c)));
 assert.equal(heldNavValues(lines,rich).find(c=>c.coin.retired).value,null);
 assert.equal(sortByTvl(rich).at(-1).asset_id,id('d'));
});

test('a newly finalized reading disables primary actions until route pricing catches up',async()=>{
 const f=fixture();
 const rpc=async(method,params)=>{
  const v=await f.rpc(method,params);
  if(method==='nav_reserve_proof_status')v.packets=[...v.packets,{...v.packets[0],epoch:4,reserve_packet_hash:id('0')}];
  if(method==='book_offers' && params.taker_gets_asset_id===id('a'))v.offers=[{state:'open',expiration_height:0}];
  return v;
 };
 const [coin]=await discoverRegistry(rpc,f.metadata);
 assert.equal(coin.capabilities.book.available,true);
 assert.equal(coin.creation_enabled,false);
 assert.equal(coin.redemption_mode,'unsupported');
 assert.match(coin.capabilities.create.reason,/latest finalized NAV/);
});
