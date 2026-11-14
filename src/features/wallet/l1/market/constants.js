// All deployment-specific IDs enter through this module, never through components.
export const SCALE = 1_000_000n;
export const B23_CONFIG_FIELDS = ["b23_asset_id", "pfusdc_asset_id", "market_quote_asset_id", "route_id", "issuer_address", "alice_holder_address", "management_address", "proof_profile", "pfusdc_source_asset_ids", "g1_passed", "symbol", "slug", "description", "methodology", "redemption_mode", "issue_multiplier_bps", "redeem_multiplier_bps", "ethereum", "retired_assets"];
// Published by OPS in contracts/b23-constants.md v1; pending fields stay null.
export const PUBLISHED_CONFIG = Object.freeze({
  symbol: "B23", slug: "b23", redemption_mode: "two-credit",
  description: "Backed by a Schwab brokerage account.",
  methodology: "NAV uses Schwab’s reported net liquidation value plus the native subscription reserve counted by the network. NAV per coin is this combined net asset value divided by the supply in the finalized reading. The Schwab reading is shown as Attested when supported by the enclave proof; the separate native reserve is Reported, not part of the attested Schwab value.",
  b23_asset_id: "ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627",
  pfusdc_asset_id: "02c46a36eb0da3516b4d8affea8f4028ad3f36825a3e8f0e009ea9dbbbcfb3c233f6830bd5221fe2717fb6a1a7005d7b",
  route_id: "pftl-pfdep-schwab-primary-pfusdc-v1",
  issuer_address: "pffcb93d9f87a843a8aa34e1adf241f5d58143e81b",
  alice_holder_address: "pfab9b9228942e5c529633a13aa271d5297bec6353",
  management_address: null, proof_profile: null, g1_passed: false,
  pfusdc_source_asset_ids: ["2bae082a6703375b9405af44715e1e64623265392627767b040fa2c30abb100a09da403724a6f105317292d9c0073df7"],
});
export function validateConfig(input) {
  // b23_asset_id remains an internal compatibility key for signed-action adapters.
  const config = Object.fromEntries(B23_CONFIG_FIELDS.map(key => [key, input?.[key]]));
  config.b23_asset_id = input?.nav_asset_id ?? config.b23_asset_id;
  config.symbol ??= "B23";
  config.slug ??= config.symbol.toLowerCase();
  config.description ??= PUBLISHED_CONFIG.description;
  config.methodology ??= PUBLISHED_CONFIG.methodology;
  config.redemption_mode ??= config.symbol === "B23" ? "two-credit" : "unsupported";
  if (!/^[A-Z0-9]{2,12}$/.test(config.symbol) || !/^[a-z0-9-]+$/.test(config.slug)) throw new Error("Invalid NAVCoin name");
  if (!["two-credit", "unsupported"].includes(config.redemption_mode)) throw new Error("Unsupported redemption mode");
  for (const key of ["description", "methodology"]) if (typeof config[key] !== "string" || config[key].length > 4000) throw new Error("Invalid NAVCoin description");
  for (const key of ["issue_multiplier_bps", "redeem_multiplier_bps"]) if (config[key] != null && (!Number.isSafeInteger(config[key]) || config[key] < 9500 || config[key] > 10500)) throw new Error("Invalid NAVCoin fee terms");
  const eth = input?.ethereum;
  const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || "") && !/^0x0{40}$/.test(value);
  const available = eth?.available === true && address(eth.wrapped_token) && address(eth.pool);
  config.ethereum = { available, wrapped_token: available ? eth.wrapped_token : null, pool: available ? eth.pool : null };
  config.retired_assets = (input?.retired_assets || []).map(coin => {
    if (!/^[0-9a-f]{96}$/.test(coin.asset_id || "") || !/^[A-Z0-9]{2,12}$/.test(coin.symbol || "") || !/^[a-z0-9-]+$/.test(coin.slug || "") || coin.asset_id === config.b23_asset_id) throw new Error("Invalid retired NAVCoin");
    return { asset_id: coin.asset_id, symbol: coin.symbol, slug: coin.slug, route_id: typeof coin.route_id === "string" ? coin.route_id : null };
  });
  for (const key of ["b23_asset_id", "pfusdc_asset_id"]) {
    if (!/^[0-9a-f]{96}$/.test(config[key] || "")) throw new Error(`NAVCoin configuration unavailable: ${key}`);
  }
  for (const key of ["issuer_address", "alice_holder_address"]) {
    if (!/^pf[0-9a-f]{40}$/.test(config[key] || "")) throw new Error(`NAVCoin configuration unavailable: ${key}`);
  }
  if (config.proof_profile != null && !/^[0-9a-f]{96}$/.test(config.proof_profile)) throw new Error("Invalid proof profile");
  if (config.management_address != null && !/^pf[0-9a-f]{40}$/.test(config.management_address)) throw new Error("Invalid management address");
  if (!config.route_id || typeof config.route_id !== "string") throw new Error("NAVCoin route is unavailable");
  if (config.b23_asset_id === config.pfusdc_asset_id) throw new Error("NAVCoin and PFUSDC must be different assets");
  config.pfusdc_source_asset_ids ??= [];
  if (!Array.isArray(config.pfusdc_source_asset_ids) || config.pfusdc_source_asset_ids.some(id => !/^[0-9a-f]{96}$/.test(id))) throw new Error("Invalid PFUSDC source asset list");
  config.market_quote_asset_id ??= config.pfusdc_source_asset_ids[0];
  if (!/^[0-9a-f]{96}$/.test(config.market_quote_asset_id || "") || [config.b23_asset_id, config.pfusdc_asset_id].includes(config.market_quote_asset_id)) throw new Error("Invalid market quote asset; publish the credited PFUSDC source asset");
  return Object.freeze({ ...config, nav_asset_id: config.b23_asset_id, g1_passed: config.g1_passed === true });
}
export async function loadConfig(fetcher = fetch) {
  const response = await fetcher("/api/l1/navcoin/config", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("NAVCoin configuration has not been published by the operator");
  return validateConfig(await response.json());
}

export function deploymentConfig(env = {}) {
  const override = JSON.parse(env.NAVCOIN_CONFIG_JSON || env.B23_NAVCOIN_CONFIG_JSON || "{}");
  return validateConfig({ ...PUBLISHED_CONFIG, ...override });
}
export function marketReady(config, state) {
  return Boolean(config.market_only || (config.g1_passed && ((config.redemption_mode || "two-credit") !== "two-credit" || (config.management_address && state?.pool?.spread_recipient === config.management_address))));
}
export function assetSymbols(config) {
  return { [config.b23_asset_id]: config.symbol, [config.pfusdc_asset_id]: "PFUSDC", ...Object.fromEntries(config.pfusdc_source_asset_ids.map(id => [id, "PFUSDC"])), ...Object.fromEntries(config.retired_assets.map(coin => [coin.asset_id, coin.symbol])) };
}
