import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from './constants.js';
import { buildOffer, readBook, verifyOffer } from './model.js';
import { planOfferSetup, offerPreflight, trustPreflight, verifyTrust } from './offer-setup.js';
import { handleNavcoinRoutes } from '../../../../../server/l1/navcoin-routes.js';
import { config, bob, lines, state } from './fixtures.mjs';
const buy = () => buildOffer(config,bob,'buy','10','10','0',state());
function client() {return {address:bob,call:async(method,{asset_id})=>{assert.equal(method,'asset_info');return {asset:{asset_id,issuer:config.issuer_address,precision:6,asset_family_id:config.pfusdc_asset_id,requires_authorization:false}};}};}
test('market quote defaults to first source, supports next epoch override, never silently chooses reserve',async()=>{
 const next='8'.repeat(96);
 assert.equal(validateConfig({...config,market_quote_asset_id:undefined}).market_quote_asset_id,config.pfusdc_source_asset_ids[0]);
 assert.equal(validateConfig({...config,market_quote_asset_id:undefined,pfusdc_source_asset_ids:[next]}).market_quote_asset_id,next);
 assert.equal(validateConfig({...config,market_quote_asset_id:next}).market_quote_asset_id,next);
 for(const id of [config.pfusdc_asset_id,config.b23_asset_id,'invalid'])assert.throws(()=>validateConfig({...config,market_quote_asset_id:id}));
 const previous=process.env.B23_NAVCOIN_CONFIG_JSON;
 try {
  process.env.B23_NAVCOIN_CONFIG_JSON=JSON.stringify({market_quote_asset_id:next});let payload;
  await handleNavcoinRoutes({req:{method:'GET'},res:{setHeader(){}},url:new URL('http://local/api/l1/navcoin/config'),session:{accountId:'fixture'},json:(_res,status,body)=>{assert.equal(status,200);payload=body;}});
  assert.equal(payload.market_quote_asset_id,next);
 } finally {if(previous===undefined)delete process.env.B23_NAVCOIN_CONFIG_JSON;else process.env.B23_NAVCOIN_CONFIG_JSON=previous;}
});
test('both sides of book and account offers use exact B23/source pair, excluding reserve and unrelated books',async()=>{
 const calls=[];const offers=[{taker_gets_asset_id:config.b23_asset_id,taker_pays_asset_id:config.market_quote_asset_id},{taker_gets_asset_id:config.b23_asset_id,taker_pays_asset_id:config.pfusdc_asset_id}];
 const book=await readBook({address:bob,call:async(method,params)=>{calls.push({method,params});return {offers,truncated:false};}},config);
 assert.deepEqual(calls.slice(0,2).map(c=>[c.params.taker_gets_asset_id,c.params.taker_pays_asset_id]),[[config.b23_asset_id,config.market_quote_asset_id],[config.market_quote_asset_id,config.b23_asset_id]]);
 assert.equal(book.mine.offers.length,1);
});
test('missing B23 and source lines are planned as separate reviewed holder trust_set operations',async()=>{
 const s=state();s.balances.assets=lines(0,0,0);s.balances.assets.lines=[];
 const plans=await planOfferSetup(client(),config,buy(),s);
 assert.deepEqual(plans.map(p=>p.intent.operation.asset_id),[config.b23_asset_id,config.market_quote_asset_id]);
 assert.ok(plans.every(p=>p.intent.kind==='asset'&&p.intent.operation.account===bob&&p.intent.operation.limit===10000000&&p.intent.operation.authorized===false));
 const after=structuredClone(s), op=plans[0].intent.operation;after.balances.assets.lines.push({...op,balance:0});
 assert.match(verifyTrust(plans[0].intent,s,after).message,/verified/);
 after.pool.settlement_reserve_atoms++;assert.throws(()=>verifyTrust(plans[0].intent,s,after),/changed/);
});
test('usable lines skip setup; limited receiving line grows for reviewed amount plus open offer reservations',async()=>{
 const s=state();assert.deepEqual(await planOfferSetup(client(),config,buy(),s),[]);
 s.balances.assets.lines[0].limit=100000000;
 s.offers.offers.push({state:'open',taker_pays_asset_id:config.b23_asset_id,taker_pays_amount_remaining:3000000});
 const plans=await planOfferSetup(client(),config,buy(),s);
 assert.equal(plans.length,1);assert.equal(plans[0].intent.operation.limit,113000000);
 assert.throws(()=>offerPreflight(config,buy(),s),/setup changed/);
});
test('reserve-only buy explains Add funds before any setup or signature; source is required for payment',async()=>{
 const s=state();s.balances.assets=lines(0,200000000,0);
 await assert.rejects(()=>planOfferSetup(client(),config,buy(),s),/Add funds.*Ethereum USDC/);
 assert.throws(()=>offerPreflight(config,buy(),s),/Reserve PFUSDC cannot be converted/);
 s.balances.assets=lines(100000000,0,200000000);assert.doesNotThrow(()=>offerPreflight(config,buy(),s));
});
test('truncated, frozen, wrong family/issuer, changed setup and unfunded snapshots fail closed',async()=>{
 const s=state();s.balances.assets.truncated=true;await assert.rejects(()=>planOfferSetup(client(),config,buy(),s),/Complete/);
 s.balances.assets.truncated=false;s.balances.assets.lines[0].frozen=true;await assert.rejects(()=>planOfferSetup(client(),config,buy(),s),/frozen/);
 s.balances.assets.lines=[];
 await assert.rejects(()=>planOfferSetup({address:bob,call:async()=>({asset:{asset_id:config.market_quote_asset_id}})},config,buy(),s),/identity/);
 const [plan]=await planOfferSetup(client(),config,buy(),s), changed=structuredClone(s);changed.balances.assets.lines.push({...plan.intent.operation,balance:0});
 assert.throws(()=>trustPreflight(plan.intent,changed,s),/changed/);
 const funded=state();funded.balances.assets=lines(100000000,0,0);assert.throws(()=>offerPreflight(config,buy(),funded),/Not enough PFUSDC/);
});
test('source offer verification never mistakes a family credit for Alice receiving the source asset',()=>{
 const before=state(),after=state(),intent=buy();before.recipientLines=lines(0,0,0);after.recipientLines=lines(0,10000000,0);
 after.balances.assets=lines(110000000,200000000,190000000);
 const receipt={offer_fills:[{taker:bob,maker_owner:config.alice_holder_address,taker_sends_asset_id:config.market_quote_asset_id,maker_sends_asset_id:config.b23_asset_id,taker_sends_amount:10000000,maker_sends_amount:10000000}]};
 assert.throws(()=>verifyOffer(intent,before,after,config,receipt),/Alice/);
 after.recipientLines=lines(0,0,10000000);assert.equal(verifyOffer(intent,before,after,config,receipt).deltas.PFUSDC,'-10000000');
});
