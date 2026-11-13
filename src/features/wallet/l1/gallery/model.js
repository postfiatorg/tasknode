import { integer, resultOf } from "../market/amounts.js";
import { valueAt } from "../format.js";

const exact = value => { try { return integer(value); } catch { return null; } };
export function finalizedReadings(proof) {
  return (proof?.packets || []).filter(packet => packet.state === "finalized")
    .sort((a, b) => integer(a.epoch) < integer(b.epoch) ? -1 : integer(a.epoch) > integer(b.epoch) ? 1 : 0);
}

export function verificationSplit(packet, profile) {
  const total = exact(packet?.verified_net_assets);
  if (total === null || total === 0n) return { available: false, bps: [0, 0, 10000], values: [0n, 0n, total], reason: "No positive finalized value to classify." };
  const proven = exact(packet?.cryptographically_verified_value ?? 0), attested = exact(packet?.attested_value ?? 0);
  const invalid = proven === null || attested === null || proven + attested > total;
  const reportedOnly = !profile || profile.verifier_kind === "placeholder" || invalid;
  const values = reportedOnly ? [0n, 0n, total] : [proven, attested, total - proven - attested];
  // Largest remainder rounding preserves a displayed sum of exactly 100.00%.
  const bps = values.map(value => Number(value * 10000n / total));
  const order = values.map((value, i) => ({ i, remainder: value * 10000n % total }))
    .sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.i - b.i);
  for (let i = 0, left = 10000 - bps.reduce((a, b) => a + b, 0); i < left; i++) bps[order[i].i]++;
  return { available: true, bps, values, reportedOnly: values[0] === 0n && values[1] === 0n,
    reason: invalid ? "The packet’s trust values are inconsistent; no independent coverage is credited." : null };
}

export function freshness(packet, profile, currentHeight) {
  const height = exact(currentHeight), submitted = exact(packet?.submitted_at_height);
  const limits = [profile?.max_snapshot_age_blocks, profile?.max_epoch_gap_blocks].map(exact);
  const known = Boolean(profile) && limits.every(value => value !== null);
  const positive = limits.filter(value => value !== null && value > 0n);
  const limit = positive.length ? positive.reduce((a, b) => a < b ? a : b) : null;
  if (height === null || submitted === null || height < submitted) return { age: null, limit, stale: null, known };
  const age = height - submitted;
  return { age, limit, stale: known ? limit !== null && age > limit : null, known };
}

export function changeBps(current, previous) {
  const now = exact(current), before = exact(previous);
  return now !== null && before !== null && before > 0n ? (now - before) * 10000n / before : null;
}

export function askDepth(report, coin, currentHeight) {
  if (!report || !Array.isArray(report.offers)) return null;
  if (report.taker_gets_asset_id && (report.taker_gets_asset_id !== coin.asset_id || report.taker_pays_asset_id !== coin.market_quote_asset_id)) throw new Error("Order book asset mismatch");
  const height = exact(currentHeight);
  const offers = report.offers.filter(o => o.state === "open" && o.taker_gets_asset_id === coin.asset_id && o.taker_pays_asset_id === coin.market_quote_asset_id)
    .filter(o => !o.expiration_height || (height !== null && integer(o.expiration_height) > height))
    .map(o => ({ size: integer(o.taker_gets_amount_remaining), total: integer(o.taker_pays_amount_remaining) }))
    .filter(o => o.size > 0n && o.total > 0n)
    .sort((a, b) => a.total * b.size < b.total * a.size ? -1 : a.total * b.size > b.total * a.size ? 1 : 0);
  return { amount: offers.reduce((sum, o) => sum + o.size, 0n), best: offers[0] ? offers[0].total * 1000000n / offers[0].size : null, partial: report.truncated === true };
}

export async function loadRegistry(fetcher = fetch) {
  const response = await fetcher("/api/l1/navcoin/registry", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("NAVCoin registry is unavailable");
  const { coins } = await response.json();
  if (!Array.isArray(coins) || !coins.length || coins.some(c => !/^[0-9a-f]{96}$/.test(c.asset_id) || !/^[0-9a-f]{96}$/.test(c.market_quote_asset_id) || !/^[a-z0-9-]+$/.test(c.slug))) throw new Error("Invalid NAVCoin registry");
  return coins;
}

export async function readCoin(client, coin) {
  const [proofRead, assetRead, bookRead, poolRead] = await Promise.allSettled([
    client.call("nav_reserve_proof_status", { asset_id: coin.asset_id }).then(resultOf),
    client.call("asset_info", { asset_id: coin.asset_id }).then(resultOf),
    client.call("book_offers", { taker_gets_asset_id: coin.asset_id, taker_pays_asset_id: coin.market_quote_asset_id, limit: 100 }).then(resultOf),
    coin.route_id ? client.call("navcoin_bridge_supply_status", { route_id: coin.route_id }).then(resultOf) : Promise.resolve(null),
  ]);
  const errors = [];
  function read(result, label) { if (result.status === "fulfilled") return result.value; errors.push(`${label} unavailable: ${result.reason.message}`); return null; }
  const proof = read(proofRead, "NAV reading"), asset = read(assetRead, "Supply")?.asset;
  const book = read(bookRead, "Order book"), pool = read(poolRead, "Cash-in reserve");
  if ((proof && proof.asset_id !== coin.asset_id) || (asset && asset.asset_id !== coin.asset_id) || (pool && (pool.route_id !== coin.route_id || pool.native_nav_asset_id !== coin.asset_id))) throw new Error("NAVCoin response identity mismatch");
  const history = finalizedReadings(proof), latest = history.at(-1) || null;
  return { ...coin, proof, asset, pool, history, latest, errors, depth: askDepth(book, coin, proof?.current_height),
    split: verificationSplit(latest, proof?.active_profile), freshness: freshness(latest, proof?.active_profile, proof?.current_height),
    change: changeBps(latest?.nav_per_unit, history.at(-2)?.nav_per_unit) };
}

export function sortByTvl(coins) {
  return [...coins].sort((a, b) => {
    const av = exact(a.latest?.verified_net_assets), bv = exact(b.latest?.verified_net_assets);
    return av === bv ? a.name.localeCompare(b.name) : av === null ? 1 : bv === null ? -1 : av > bv ? -1 : 1;
  });
}

export function heldNavValues(lines, coins) {
  return coins.map(coin => {
    const balance = lines.filter(line => line.asset_id === coin.asset_id).reduce((sum, line) => sum + integer(line.balance ?? line.balance_atoms ?? 0), 0n);
    return { coin, balance, value: balance === 0n ? 0n : valueAt(balance, coin.latest?.nav_per_unit, coin.asset?.precision ?? 6) };
  });
}
