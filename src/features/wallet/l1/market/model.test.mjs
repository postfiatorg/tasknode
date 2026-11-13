import test from "node:test";
import assert from "node:assert/strict";
import { atoms, units } from "./amounts.js";
import { validateConfig } from "./constants.js";
import { buildOffer, buildCancel, verifyOffer, snapshot } from "./model.js";
import { prepareAction, submitAction } from "./transaction.js";
import { buildFund, validateEquityPlan, verifyFund, validateFeeOperation, verifyFee } from "../issuer/model.js";
import { buildRedeem, redemptionQuote, redeemPreflight, verifyRedeem } from "../redeem/model.js";
import { publicEquity, handleNavcoinRoutes } from "../../../../../server/l1/navcoin-routes.js";
import { config, bob, lines, state, equityPlan } from "./fixtures.mjs";
const nonce = "1".repeat(64);
test("six-decimal amounts remain exact and reject unsafe or ambiguous input", () => {
  assert.equal(atoms("419234.35"), 419234350000); assert.equal(units(-1234567), "−1.234567");
  for (const value of ["0", "-1", "1e6", "1.0000001", " 1", "01", "9007199255"]) assert.throws(() => atoms(value));
});
test("configuration permits pending management but never accepts malformed asset IDs", () => {
  assert.equal(validateConfig({ ...config, management_address: null }).management_address, null);
  assert.throws(() => validateConfig({ ...config, b23_asset_id: "missing" }));
});
test("buy pays PFUSDC, sell pays B23, issuer and pre-G1 trading reject", () => {
  const buy = buildOffer(config, bob, "buy", "10", "11", "0", state()).operation;
  assert.equal(buy.taker_gets_asset_id, config.market_quote_asset_id); assert.equal(buy.taker_gets_amount, 11000000);
  assert.equal(buildOffer(config, bob, "sell", "10", "11", "0", state()).operation.taker_gets_asset_id, config.b23_asset_id);
  assert.throws(() => buildOffer(config, config.issuer_address, "sell", "10", "11", "0", state()));
  assert.throws(() => buildOffer({ ...config, g1_passed: false }, bob, "buy", "10", "11", "0", state()));
});
function offerCase(received, spent, locked) {
  const intent = buildOffer(config, bob, "buy", "10", "10", "0", state());
  const before = state(), after = state(); before.recipientLines = lines(0,0,0); after.recipientLines = lines(0,0,spent); after.balances.assets = lines(100000000 + received, 200000000, 200000000 - spent - locked);
  const offer = { offer_id: "offer-1", owner: bob, state: "open", taker_gets_asset_id: config.market_quote_asset_id, taker_pays_asset_id: config.b23_asset_id, original_taker_gets_amount: 10000000, original_taker_pays_amount: 10000000, taker_gets_amount_remaining: locked, taker_pays_amount_remaining: 10000000 - received };
  if (locked) after.offers.offers.push(offer);
  const fills = spent ? [{ taker: bob, maker_owner: config.alice_holder_address, maker_sends_asset_id: config.b23_asset_id, taker_sends_asset_id: config.market_quote_asset_id, maker_sends_amount: received, taker_sends_amount: spent }] : [];
  return { intent, before, after, receipt: { accepted: true, offer_id: locked ? "offer-1" : null, offer_fills: fills } };
}
for (const [received, spent, locked, label] of [[0,0,10000000,"Unfilled"], [4000000,4000000,6000000,"Partially filled"], [10000000,9000000,0,"Filled"]]) {
  test(`order book ${label}: receipts, spendable debit, locked funds and remainder reconcile`, () => {
    const c = offerCase(received, spent, locked); if (!spent) delete c.receipt.offer_fills; const result = verifyOffer(c.intent, c.before, c.after, config, c.receipt);
    assert.match(result.message, new RegExp(label)); assert.equal(result.locked, String(locked));
    c.after.pool.settlement_reserve_atoms++; assert.throws(() => verifyOffer(c.intent, c.before, c.after, config, c.receipt));
  });
}
test("cancel verifies refunded locked remainder, not a reversed fill", () => {
  const c = offerCase(4000000,4000000,6000000), before = c.after, after = structuredClone(before), offer = before.offers.offers[0];
  const intent = buildCancel(bob, offer); after.offers.offers[0].state = "canceled"; after.balances.assets = lines(104000000,200000000,196000000);
  assert.match(verifyOffer(intent,before,after,config,{accepted:true}).message,/refund/);
  assert.throws(() => buildCancel(config.issuer_address, offer));
});
test("fund raises reserve without minting and fails when supply changes", () => {
  const before = state(), intent = buildFund(config,bob,before,"10",nonce), after = state();
  after.pool.settlement_reserve_atoms += 10000000; after.balances.assets = lines(100000000,190000000);
  assert.equal(intent.operation.funding_sequence,(before.pool.funding_sequence ?? 0)+1);
  assert.equal(buildFund(config,bob,{...before,pool:{...before.pool,funding_sequence:7}},"10",nonce).operation.funding_sequence,8);
  assert.match(verifyFund(config,intent,before,after).message,/No B23/);
  after.supply++; assert.throws(() => verifyFund(config,intent,before,after));
  assert.throws(() => buildFund({...config,g1_passed:false},bob,before,"10",nonce));
});
test("redemption quote splits full NAV into holder and manager, caps at reserve", () => {
  const quote = redemptionQuote(config,state(),"100"); assert.equal(quote.holder,99800000); assert.equal(quote.management,200000); assert.equal(quote.gross,100000000);
  assert.throws(() => redemptionQuote(config,state(),"501"));
  const changed = state(); changed.pool.spread_recipient = null; assert.throws(() => redemptionQuote(config,changed,"1"));
});
test("redeem requires both receipt credits, both actual credits, supply and reserve deltas", () => {
  const before = state(), after = state(), { intent } = buildRedeem(config,bob,before,"100",nonce);
  after.balances.assets = lines(0,299800000); after.managementLines = lines(0,200000); after.supply -= 100000000; after.pool.settlement_reserve_atoms -= 100000000;
  const receipt = { redemption_settlement: { settlement_asset_id: config.pfusdc_asset_id, settlement_recipient: bob, spread_recipient: config.management_address, settlement_value_atoms: 99800000, spread_value_atoms: 200000 } };
  assert.match(verifyRedeem(config,intent,before,after,receipt).message,/verified/);
  assert.throws(() => verifyRedeem(config,intent,before,after,{})); after.managementLines = lines(0,0); assert.throws(() => verifyRedeem(config,intent,before,after,receipt));
});
test("redemption rejects changed policy or stale height before signing", () => {
  const before = state(), {intent} = buildRedeem(config,bob,before,"1",nonce), current = state();
  current.pool.policy_epoch++; assert.throws(() => redeemPreflight(config,intent,current,before));
  current.pool.policy_epoch--; current.proof.current_height = intent.operation.expires_at_height; assert.throws(() => redeemPreflight(config,intent,current,before));
});
test("opening plan counts existing supply once and rejects unretired PFDEP / wrong scale", () => {
  assert.equal(validateEquityPlan(equityPlan(),config).additional_mint_atoms,1000000000);
  for (const mutate of [p=>p.pfdep_retired=false,p=>p.packet.valuation_unit="USD_1E8",p=>p.additional_mint_atoms=p.target_supply_atoms,p=>p.operations[0].proof_profile="9".repeat(96)]) {
    const plan = equityPlan(); mutate(plan); assert.throws(()=>validateEquityPlan(plan,config));
  }
});
test("fee intent binds next epochs, current NAV and management; verify actual route update", () => {
  const before = state(), operation = {operation:"pftl_uniswap_route_epoch_advance",operator:config.issuer_address,route_id:config.route_id,prior_route_epoch:2,next_route_epoch:3,next_route_config_digest:"f".repeat(96),live_value_enabled:true,next_primary_market_policy:{policy_hash:"f".repeat(96),policy_epoch:3,redeem_multiplier_bps:9975,spread_recipient:config.management_address,pricing_nav_epoch:2,pricing_reserve_packet_hash:before.pool.pricing_reserve_packet_hash}};
  const intent=validateFeeOperation(operation,config,before,"25"), after=state(); Object.assign(after.pool,{route_epoch:3,policy_hash:"f".repeat(96),redeem_multiplier_bps:9975});
  assert.match(verifyFee(config,intent,before,after).message,/No redeploy/); assert.throws(()=>validateFeeOperation(operation,config,before,"26"));
});
function clientMock(receipt={accepted:true}) {
  const calls=[]; return {calls,accountId:"account-a",address:bob,unlocked:true,
    quote:async intent=>{calls.push("quote");return {operation:intent.operation};},sign:async()=>{calls.push("sign");return {opaque:true};},submit:async()=>{calls.push("submit");return {txId:"synthetic-tx",receipt};}};
}
test("mock client follows read→quote→read→sign→submit→read and verifies effects", async()=>{
  const client=clientMock(), read=async()=>{client.calls.push("read");return state();};
  const prepared=await prepareAction(client,{kind:"offer",operation:{}},read);
  const result=await submitAction(client,prepared,read,()=>({message:"verified"}));
  assert.equal(result.verified,true);assert.deepEqual(client.calls,["read","quote","read","sign","submit","read"]);
});
test("6/6 finality or rejected receipt cannot pass; failed balance read is not success", async()=>{
  for(const receipt of [{accepted:false,message:"rejected"},{round_ok:true},null]) {
    const client=clientMock(receipt), prepared=await prepareAction(client,{},async()=>state());
    await assert.rejects(()=>submitAction(client,prepared,async()=>state(),()=>({})),/not accepted/);
  }
  const client=clientMock(), prepared=await prepareAction(client,{},async()=>state());let reads=0;
  const result=await submitAction(client,prepared,async()=>{if(++reads>=2)throw Error("read unavailable");return state();},()=>({}),()=>true,()=>{},{attempts:3,delayMs:1});
  assert.equal(result.verified,false);assert.match(result.verificationError,/read unavailable/);assert.equal(reads,4);
  const client2=clientMock(), prepared2=await prepareAction(client2,{},async()=>state());let checks=0;
  const late=await submitAction(client2,prepared2,async()=>state(),()=>{if(++checks<3)throw Error("stale read");return {message:"verified"};},()=>true,()=>{},{attempts:5,delayMs:1});
  assert.equal(late.verified,true);assert.equal(checks,3);
});
test("account switch and stale review block signing/submission", async()=>{
  const client=clientMock(),prepared=await prepareAction(client,{},async()=>state());client.accountId="account-b";
  await assert.rejects(()=>submitAction(client,prepared,async()=>state(),()=>({})),/Wallet changed/);assert.deepEqual(client.calls,["quote"]);
  client.accountId="account-a";await assert.rejects(()=>submitAction(client,prepared,async()=>state(),()=>({}),()=>false),/expired/);
});
test("public equity projection strips private and unrecognized fields",()=>{
  const plan=equityPlan();plan.seed="not-a-real-secret";plan.packet.account_number="fixture";plan.operations[0].private_key="fixture";
  const rendered=JSON.stringify(publicEquity(plan));assert.ok(!rendered.includes("not-a-real-secret"));assert.ok(!rendered.includes("account_number"));assert.ok(!rendered.includes("private_key"));
});
test("server route rejects unauthenticated, writes and malformed fee without remote calls",async()=>{
  for(const [method,path,session,expected] of [["GET","config",null,401],["POST","config",{accountId:"a"},405],["GET","fee?bps=501",{accountId:"a"},400]]) {
    let response;await handleNavcoinRoutes({req:{method},res:{setHeader(){}},url:new URL(`https://test/api/l1/navcoin/${path}`),session,json:(_r,status,body)=>response={status,body}});assert.equal(response.status,expected);
  }
});
test("snapshot rejects an account mismatch instead of treating other-account data as zero",async()=>{
  const s=state();const client={address:bob,getBalances:async()=>({...s.balances,address:config.issuer_address}),call:async method=>({navcoin_bridge_supply_status:s.pool,nav_reserve_proof_status:s.proof,asset_info:{asset:{asset_id:config.b23_asset_id,outstanding_supply:s.supply}},account_offers:s.offers}[method])};
  await assert.rejects(()=>snapshot(client,config),/Wallet changed/);
});
test("cash-in rejects a source-series payout when family reserve was reviewed", () => {
  const sourceId="9".repeat(96), settings={...config,pfusdc_source_asset_ids:[sourceId]}, before=state(),after=state();
  before.balances.assets.lines.push({asset_id:sourceId,balance:0});before.managementLines.lines.push({asset_id:sourceId,balance:0});
  after.balances.assets=lines(0,200000000);after.balances.assets.lines.push({asset_id:sourceId,balance:99800000});after.managementLines.lines.push({asset_id:sourceId,balance:200000});
  after.supply-=100000000;after.pool.settlement_reserve_atoms-=100000000;
  const {intent}=buildRedeem(settings,bob,before,"100",nonce),receipt={redemption_settlement:{settlement_asset_id:sourceId,settlement_recipient:bob,spread_recipient:config.management_address,settlement_value_atoms:99800000,spread_value_atoms:200000}};
  assert.equal(Object.hasOwn(intent.operation, "settlement_source_asset_id"),false);
  assert.throws(()=>verifyRedeem(settings,intent,before,after,receipt),/payout asset mismatch/);
  assert.throws(()=>verifyRedeem(config,intent,before,after,receipt));
});
test("opening packet rejects stale or fabricated cutoff times", () => {
  for(const observed of ["2020-01-01T00:00:00Z","2099-01-01T00:00:00Z","invalid"]) {const plan=equityPlan();plan.packet.cutoff_at_utc=observed;plan.packet.observed_at_utc=observed;assert.throws(()=>validateEquityPlan(plan,config));}
});
