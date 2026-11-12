import { integer, resultOf, safeInteger, atoms } from "./amounts.js";
export async function readPool(client, config) {
  const [pool, proof, asset] = await Promise.all([
    client.call("navcoin_bridge_supply_status", { route_id: config.route_id }).then(resultOf),
    client.call("nav_reserve_proof_status", { asset_id: config.b23_asset_id }).then(resultOf),
    client.call("asset_info", { asset_id: config.b23_asset_id }).then(resultOf),
  ]);
  if (pool.route_id !== config.route_id || pool.native_nav_asset_id !== config.b23_asset_id || pool.settlement_asset_id !== config.pfusdc_asset_id) throw new Error("Pool asset or route binding does not match B23 configuration");
  if (asset.asset?.asset_id !== config.b23_asset_id || proof.asset_id !== config.b23_asset_id) throw new Error("B23 state response mismatch");
  integer(asset.asset.outstanding_supply, "B23 total supply");
  const nav = proof.packets?.find(packet => packet.state === "finalized" && packet.epoch === pool.pricing_nav_epoch && packet.reserve_packet_hash === pool.pricing_reserve_packet_hash);
  return { pool, proof, nav, supply: asset.asset.outstanding_supply };
}
export async function readBook(client, config) {
  const [asks, bids, mine] = await Promise.all([
    client.call("book_offers", { taker_gets_asset_id: config.b23_asset_id, taker_pays_asset_id: config.pfusdc_asset_id, limit: 100 }).then(resultOf),
    client.call("book_offers", { taker_gets_asset_id: config.pfusdc_asset_id, taker_pays_asset_id: config.b23_asset_id, limit: 100 }).then(resultOf),
    client.call("account_offers", { account: client.address, limit: 100 }).then(resultOf),
  ]);
  return { asks, bids, mine: { ...mine, offers: (mine.offers || []).filter(o => [config.b23_asset_id, config.pfusdc_asset_id].includes(o.taker_gets_asset_id) && [config.b23_asset_id, config.pfusdc_asset_id].includes(o.taker_pays_asset_id)) } };
}
export function lineBalance(report, assetId) {
  const data = resultOf(report);
  if (!Array.isArray(data?.lines) || data.truncated) throw new Error("Complete asset balances are unavailable");
  const line = data.lines.find(item => item.asset_id === assetId);
  return line ? integer(line.balance, "Asset balance") : 0n;
}
export async function snapshot(client, config, { management = false, recipient = null } = {}) {
  const [balances, state, offers, managementLines, recipientLines] = await Promise.all([
    client.getBalances(), readPool(client, config),
    client.call("account_offers", { account: client.address, limit: 100 }).then(resultOf),
    management ? client.call("account_lines", { account: config.management_address, limit: 100 }).then(resultOf) : null,
    recipient && recipient !== client.address ? client.call("account_lines", { account: recipient, limit: 100 }).then(resultOf) : null,
  ]);
  if (balances.address !== client.address) throw new Error("Wallet changed during balance read");
  return { ...state, balances, offers, managementLines, recipientLines };
}
export function buildOffer(config, address, side, quantity, consideration, expiration = "0", state) {
  if (!config.g1_passed || !config.management_address || state?.pool?.spread_recipient !== config.management_address) throw new Error("B23 trading is blocked until G1 and the management policy are installed");
  if (address === config.issuer_address) throw new Error("Use Alice's holder wallet; the issuer cannot post offers");
  if (!["buy", "sell"].includes(side)) throw new Error("Choose buy or sell");
  const b23 = atoms(quantity, "B23 amount"), pfusdc = atoms(consideration, "PFUSDC total");
  return { kind: "offer", operation: {
    operation: "offer_create", owner: address,
    taker_gets_asset_id: side === "buy" ? config.pfusdc_asset_id : config.b23_asset_id,
    taker_gets_amount: side === "buy" ? pfusdc : b23,
    taker_pays_asset_id: side === "buy" ? config.b23_asset_id : config.pfusdc_asset_id,
    taker_pays_amount: side === "buy" ? b23 : pfusdc,
    expiration_height: safeInteger(expiration, "Expiration height"),
  } };
}
export function buildCancel(address, offer) {
  if (offer.owner !== address || offer.state !== "open") throw new Error("Only your open remainder can be cancelled");
  return { kind: "offer", operation: { operation: "offer_cancel", owner: address, offer_id: offer.offer_id } };
}
export function offerProgress(offer) {
  const remaining = integer(offer.taker_gets_amount_remaining), original = integer(offer.original_taker_gets_amount);
  if (remaining > original) throw new Error("Invalid offer remainder");
  return { filled: String(original - remaining), remaining: String(remaining), label: remaining === 0n ? "Filled" : remaining === original ? "Unfilled" : "Partially filled" };
}
export function balanceDeltas(before, after, config) {
  return Object.fromEntries([["B23", config.b23_asset_id], ["PFUSDC", config.pfusdc_asset_id]].map(([name, id]) => [name, String(lineBalance(after.balances.assets, id) - lineBalance(before.balances.assets, id))]));
}
export function verifyOffer(intent, before, after, config, receipt) {
  const deltas = balanceDeltas(before, after, config), op = intent.operation;
  if (integer(before.supply) !== integer(after.supply) || integer(before.pool.settlement_reserve_atoms) !== integer(after.pool.settlement_reserve_atoms)) throw new Error("Market transaction changed B23 supply or redemption reserve");
  if (after.offers.truncated || before.offers.truncated) throw new Error("Offer history is truncated; remainder cannot be verified");
  if (op.operation === "offer_cancel") {
    const prior = before.offers.offers.find(row => row.offer_id === op.offer_id);
    const offer = after.offers.offers.find(row => row.offer_id === op.offer_id);
    if (!prior || !offer || offer.state !== "canceled") throw new Error("Cancellation is not yet verified");
    const sell = prior.taker_gets_asset_id === config.b23_asset_id;
    if (BigInt(sell ? deltas.B23 : deltas.PFUSDC) !== integer(prior.taker_gets_amount_remaining) || BigInt(sell ? deltas.PFUSDC : deltas.B23) !== 0n) throw new Error("Cancelled remainder refund does not match balances");
    return { deltas, message: "Offer cancellation and unfilled balance refund verified; prior fills are retained.", offer };
  }
  const fills = receipt?.offer_fills;
  if (!Array.isArray(fills)) throw new Error("Offer receipt fill records unavailable");
  let spent = 0n, received = 0n;
  for (const fill of fills) {
    if (fill.taker !== op.owner || fill.taker_sends_asset_id !== op.taker_gets_asset_id || fill.maker_sends_asset_id !== op.taker_pays_asset_id) throw new Error("Offer fill asset or wallet mismatch");
    spent += integer(fill.taker_sends_amount); received += integer(fill.maker_sends_amount);
  }
  let offer = null, locked = 0n;
  if (receipt.offer_id) {
    offer = after.offers.offers.find(row => row.offer_id === receipt.offer_id);
    if (!offer || offer.owner !== op.owner || offer.state !== "open" || integer(offer.original_taker_gets_amount) !== integer(op.taker_gets_amount) || integer(offer.original_taker_pays_amount) !== integer(op.taker_pays_amount)) throw new Error("Accepted offer remainder cannot be verified");
    locked = integer(offer.taker_gets_amount_remaining);
    if (spent + locked !== integer(op.taker_gets_amount)) throw new Error("Fill and locked remainder do not sum to the offer budget");
  }
  if (spent > integer(op.taker_gets_amount) || (!offer && fills.length === 0)) throw new Error("Offer fill or remainder is missing");
  const buy = op.taker_pays_asset_id === config.b23_asset_id;
  if (BigInt(buy ? deltas.PFUSDC : deltas.B23) !== -(spent + locked) || BigInt(buy ? deltas.B23 : deltas.PFUSDC) !== received) throw new Error("Offer fills and locked remainder do not match actual balance deltas");
  const label = fills.length === 0 ? "Unfilled" : offer ? "Partially filled" : "Filled";
  return { deltas, offer, fills, spent: String(spent), received: String(received), locked: String(locked), message: `${label} offer verified. Unfilled offered funds are locked until filled or cancelled. B23 supply and redemption reserve are unchanged.` };
}
