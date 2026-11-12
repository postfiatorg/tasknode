// All deployment-specific IDs enter through this module, never through components.
export const SCALE = 1_000_000n;
export const B23_CONFIG_FIELDS = ["b23_asset_id", "pfusdc_asset_id", "market_quote_asset_id", "route_id", "issuer_address", "alice_holder_address", "management_address", "proof_profile", "pfusdc_source_asset_ids", "g1_passed"];
// Published by OPS in contracts/b23-constants.md v1; pending fields stay null.
export const PUBLISHED_CONFIG = Object.freeze({
  b23_asset_id: "ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627",
  pfusdc_asset_id: "02c46a36eb0da3516b4d8affea8f4028ad3f36825a3e8f0e009ea9dbbbcfb3c233f6830bd5221fe2717fb6a1a7005d7b",
  route_id: "pftl-pfdep-schwab-primary-pfusdc-v1",
  issuer_address: "pffcb93d9f87a843a8aa34e1adf241f5d58143e81b",
  alice_holder_address: "pfab9b9228942e5c529633a13aa271d5297bec6353",
  management_address: null, proof_profile: null, g1_passed: false,
  pfusdc_source_asset_ids: ["2bae082a6703375b9405af44715e1e64623265392627767b040fa2c30abb100a09da403724a6f105317292d9c0073df7"],
});
export function validateConfig(input) {
  const config = Object.fromEntries(B23_CONFIG_FIELDS.map(key => [key, input?.[key]]));
  for (const key of ["b23_asset_id", "pfusdc_asset_id"]) {
    if (!/^[0-9a-f]{96}$/.test(config[key] || "")) throw new Error(`B23 configuration unavailable: ${key}`);
  }
  for (const key of ["issuer_address", "alice_holder_address"]) {
    if (!/^pf[0-9a-f]{40}$/.test(config[key] || "")) throw new Error(`B23 configuration unavailable: ${key}`);
  }
  if (config.proof_profile != null && !/^[0-9a-f]{96}$/.test(config.proof_profile)) throw new Error("Invalid proof profile");
  if (config.management_address != null && !/^pf[0-9a-f]{40}$/.test(config.management_address)) throw new Error("Invalid management address");
  if (!config.route_id || typeof config.route_id !== "string") throw new Error("B23 route is unavailable");
  if (config.b23_asset_id === config.pfusdc_asset_id) throw new Error("B23 and PFUSDC must be different assets");
  config.pfusdc_source_asset_ids ??= [];
  if (!Array.isArray(config.pfusdc_source_asset_ids) || config.pfusdc_source_asset_ids.some(id => !/^[0-9a-f]{96}$/.test(id))) throw new Error("Invalid PFUSDC source asset list");
  config.market_quote_asset_id ??= config.pfusdc_source_asset_ids[0];
  if (!/^[0-9a-f]{96}$/.test(config.market_quote_asset_id || "") || [config.b23_asset_id, config.pfusdc_asset_id].includes(config.market_quote_asset_id)) throw new Error("Invalid market quote asset; publish the credited PFUSDC source asset");
  return Object.freeze({ ...config, g1_passed: config.g1_passed === true });
}
export async function loadConfig(fetcher = fetch) {
  const response = await fetcher("/api/l1/navcoin/config", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("B23 configuration has not been published by the operator");
  return validateConfig(await response.json());
}
