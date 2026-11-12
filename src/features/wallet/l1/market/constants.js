// All deployment-specific IDs enter through this module, never through components.
export const SCALE = 1_000_000n;
export const B23_CONFIG_FIELDS = ["b23_asset_id", "pfusdc_asset_id", "route_id", "issuer_address", "alice_holder_address", "management_address", "proof_profile", "g1_passed"];
export function validateConfig(input) {
  const config = Object.fromEntries(B23_CONFIG_FIELDS.map(key => [key, input?.[key]]));
  for (const key of ["b23_asset_id", "pfusdc_asset_id", "proof_profile"]) {
    if (!/^[0-9a-f]{96}$/.test(config[key] || "")) throw new Error(`B23 configuration unavailable: ${key}`);
  }
  for (const key of ["issuer_address", "alice_holder_address", "management_address"]) {
    if (!/^pf[0-9a-f]{40}$/.test(config[key] || "")) throw new Error(`B23 configuration unavailable: ${key}`);
  }
  if (!config.route_id || typeof config.route_id !== "string") throw new Error("B23 route is unavailable");
  if (config.b23_asset_id === config.pfusdc_asset_id) throw new Error("B23 and PFUSDC must be different assets");
  return Object.freeze({ ...config, g1_passed: config.g1_passed === true });
}
export async function loadConfig(fetcher = fetch) {
  const response = await fetcher("/api/l1/navcoin/config", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("B23 configuration has not been published by the operator");
  return validateConfig(await response.json());
}
