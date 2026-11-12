// Focused browser test entry only. Not imported by the application or shell.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Market from "./index.jsx";
import Issuer from "../issuer/index.jsx";
import Redeem from "../redeem/index.jsx";
import { config, bob, lines, state, equityPlan } from "./fixtures.mjs";
const params = new URLSearchParams(location.search), tab = params.get("tab") || "market";
let ledger = state(), counter = 0;
const history = [];
const address = tab === "issuer" ? config.issuer_address : bob;
ledger.balances.address = address;
if (params.get("gate") === "blocked") config.g1_passed = false;
const allOffers = [];
function offer(operation, id) { return { offer_id: id, owner: address, state: "open", taker_gets_asset_id: operation.taker_gets_asset_id, taker_pays_asset_id: operation.taker_pays_asset_id, original_taker_gets_amount: operation.taker_gets_amount, original_taker_pays_amount: operation.taker_pays_amount, taker_gets_amount_remaining: operation.taker_gets_amount, taker_pays_amount_remaining: operation.taker_pays_amount }; }
function balance(assetId, delta) { ledger.balances.assets.lines.find(row => row.asset_id === assetId).balance += delta; }
const feeOperation = x => ({ operation: "pftl_uniswap_route_epoch_advance", operator: config.issuer_address, route_id: config.route_id, prior_route_epoch: ledger.pool.route_epoch, next_route_epoch: ledger.pool.route_epoch + 1, next_route_config_digest: "f".repeat(96), live_value_enabled: true, next_primary_market_policy: { policy_epoch: ledger.pool.policy_epoch + 1, policy_hash: "f".repeat(96), redeem_multiplier_bps: 10000 - Number(x), spread_recipient: config.management_address, pricing_nav_epoch: ledger.pool.pricing_nav_epoch, pricing_reserve_packet_hash: ledger.pool.pricing_reserve_packet_hash, issue_multiplier_bps:10000,issue_capacity_atoms:1000000000,redeem_capacity_atoms:1000000000,min_order_atoms:1,max_order_atoms:1000000000,valid_from_height:1,expires_at_height:10000,max_nav_age_blocks:10000 } });
const client = { accountId: "synthetic-navcoin-account", address, unlocked: true, chainId: "devnet-2",
  async getBalances() { history.push("balances"); return structuredClone(ledger.balances); },
  async call(method, args) {
    history.push(method);
    if (method === "navcoin_bridge_supply_status") return structuredClone(ledger.pool);
    if (method === "nav_reserve_proof_status") return structuredClone(ledger.proof);
    if (method === "asset_info") return {asset:{asset_id:config.b23_asset_id,outstanding_supply:ledger.supply}};
    if (method === "account_offers") return {offers:structuredClone(allOffers),truncated:false};
    if (method === "book_offers") return {offers:structuredClone(allOffers.filter(o=>o.state==="open"&&o.taker_gets_asset_id===args.taker_gets_asset_id)),truncated:false};
    if (method === "account_lines") return structuredClone(args.account === config.management_address ? ledger.managementLines : ledger.recipientLines || lines(0,0));
    throw Error(`Unexpected mock read ${method}`);
  },
  async quote(intent) { history.push("quote"); return { minimum_fee:100, operation:intent.operation, estimated_cross_count:1 }; },
  async sign(intent) { history.push("sign"); return {synthetic:true,intent:structuredClone(intent)}; },
  async submit(signed) {
    history.push("submit"); const op=signed.intent.operation, receipt={accepted:params.get("reject")!=="yes",offer_fills:[]};
    if(!receipt.accepted) return {txId:"synthetic-rejected",receipt:{...receipt,message:"synthetic rejection"}};
    if(op.operation==="offer_create") {
      const resting=offer(op,`synthetic-offer-${++counter}`), buy=op.taker_gets_asset_id===config.pfusdc_asset_id;
      const spent=buy?4000000:0, received=buy?4000000:0;
      balance(op.taker_gets_asset_id,-op.taker_gets_amount);balance(op.taker_pays_asset_id,received);
      resting.taker_gets_amount_remaining-=spent;resting.taker_pays_amount_remaining-=received;allOffers.push(resting);receipt.offer_id=resting.offer_id;
      if(spent)ledger.recipientLines=lines(0,spent);
      if(spent)receipt.offer_fills=[{taker:address,maker_owner:config.alice_holder_address,taker_sends_asset_id:op.taker_gets_asset_id,maker_sends_asset_id:op.taker_pays_asset_id,taker_sends_amount:spent,maker_sends_amount:received}];
    } else if(op.operation==="offer_cancel") {
      const resting=allOffers.find(o=>o.offer_id===op.offer_id);resting.state="canceled";balance(resting.taker_gets_asset_id,resting.taker_gets_amount_remaining);receipt.offer_id=resting.offer_id;
    } else if(op.operation==="pftl_uniswap_redemption_fund") { balance(config.pfusdc_asset_id,-op.amount_atoms);ledger.pool.settlement_reserve_atoms+=op.amount_atoms;ledger.pool.available_redeem_atoms+=op.amount_atoms;
    } else if(op.operation==="pftl_uniswap_primary_redeem") {
      const gross=op.nav_amount_atoms, holder=Math.floor(gross*ledger.pool.redeem_multiplier_bps/10000), spread=gross-holder;
      balance(config.b23_asset_id,-op.nav_amount_atoms);balance(config.pfusdc_asset_id,holder);ledger.supply-=op.nav_amount_atoms;ledger.pool.settlement_reserve_atoms-=gross;ledger.pool.available_redeem_atoms-=op.nav_amount_atoms;ledger.managementLines=lines(0,spread);
      receipt.redemption_settlement={settlement_asset_id:config.pfusdc_asset_id,settlement_recipient:address,settlement_value_atoms:holder,spread_recipient:config.management_address,spread_value_atoms:spread};
    } else if(op.operation==="pftl_uniswap_route_epoch_advance") { Object.assign(ledger.pool,{route_epoch:op.next_route_epoch,policy_epoch:op.next_primary_market_policy.policy_epoch,policy_hash:op.next_primary_market_policy.policy_hash,redeem_multiplier_bps:op.next_primary_market_policy.redeem_multiplier_bps});
    } else if(op.operation==="nav_reserve_submit") { ledger.proof.packets.unshift({...op,state:"pending"});
    } else if(op.operation==="nav_epoch_finalize") { ledger.proof.packets.find(p=>p.epoch===op.epoch).state="finalized";
    } else if(op.operation==="nav_mint_at_nav") { ledger.supply+=op.amount;ledger.recipientLines=lines(op.amount,0); }
    return {txId:`synthetic-tx-${++counter}`,receipt};
  },
};
window.fetch = async url => {
  const path=new URL(url,location.origin);
  if(path.pathname.endsWith("/config")) return Response.json(config);
  if(path.pathname.endsWith("/equity")) return Response.json(equityPlan());
  if(path.pathname.endsWith("/fee")) return Response.json({operation:feeOperation(path.searchParams.get("bps"))});
  throw Error("Fixture forbids unmocked network");
};
function App() {
  const [,rerender]=useState(0);
  window.fixture={history,ledger,client,installOpeningPolicy:()=>{const p=equityPlan();ledger.pool.pricing_nav_epoch=3;ledger.pool.pricing_reserve_packet_hash=p.packet.packet_hash;},switchAccount:()=>{client.accountId="another-account";client.address=config.alice_holder_address;rerender(n=>n+1);}};
  const Tab={market:Market,issuer:Issuer,redeem:Redeem}[tab];
  return <main><p>SYNTHETIC CLIENT — NO LIVE TRANSACTIONS</p><Tab client={{...client}} onNavigate={id=>history.push(`navigate:${id}`)} /></main>;
}
createRoot(document.getElementById("root")).render(<App />);
