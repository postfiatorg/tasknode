import { readFile, stat } from "node:fs/promises";
import { PUBLISHED_CONFIG, validateConfig } from "../../src/features/wallet/l1/market/constants.js";
import { navcoinRegistry } from "./navcoin-registry.js";
const PACKET_FIELDS = "schema broker_source_id account_commitment_sha256 cutoff_at_utc cutoff_time_utc observed_at_utc source_field liquidation_value_usd liquidation_value_atoms valuation_unit scale_atoms_per_usd adjustments broker_response_root_sha256 positions_root_sha256 known_posting_limits packet_hash".split(" ");
const OP_FIELDS = {
  nav_reserve_submit: "operation issuer submitter asset_id epoch nav_per_unit circulating_supply verified_net_assets proof_profile source_root attestor_root reserve_packet_hash reserve_accounts sp1_proof_bytes sp1_public_values",
  nav_epoch_finalize: "operation issuer asset_id epoch reserve_packet_hash",
  nav_mint_at_nav: "operation issuer asset_id to amount epoch reserve_packet_hash",
  pftl_uniswap_route_epoch_advance: "operation operator route_id prior_route_epoch next_route_epoch next_route_config_digest live_value_enabled next_primary_market_policy settlement_source_asset_ids",
};
const POLICY_FIELDS = "policy_hash policy_epoch issue_multiplier_bps redeem_multiplier_bps issue_capacity_atoms redeem_capacity_atoms max_order_atoms min_order_atoms valid_from_height expires_at_height max_nav_age_blocks pricing_nav_epoch pricing_reserve_packet_hash spread_recipient".split(" ");
function scalar(value) { return value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isSafeInteger(value)); }
function project(input, fields, arrays = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid public artifact");
  return Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => {
    const value = input[key];
    if (!(scalar(value) || (arrays.includes(key) && Array.isArray(value) && value.every(scalar)))) throw new Error("Invalid public field");
    return [key, value];
  }));
}
export function publicOperation(input) {
  const fields = OP_FIELDS[input?.operation];
  if (!fields) throw new Error("Unsupported prepared operation");
  const operation = project(input, fields.split(" ").filter(key => key !== "next_primary_market_policy"), ["reserve_accounts", "sp1_proof_bytes", "sp1_public_values", "settlement_source_asset_ids"]);
  if (input.next_primary_market_policy) operation.next_primary_market_policy = project(input.next_primary_market_policy, POLICY_FIELDS);
  return operation;
}
export function publicEquity(input) {
  return { ...project(input, ["current_supply_atoms", "target_supply_atoms", "additional_mint_atoms", "pfdep_retired"]),
    packet: project(input.packet, PACKET_FIELDS, ["adjustments", "known_posting_limits"]), operations: input.operations.map(publicOperation) };
}
async function artifact(path) {
  if (!path || /(?:\.private\.json|\.env)$/.test(path)) throw new Error("Public artifact unavailable");
  if ((await stat(path)).size > 128 * 1024) throw new Error("Public artifact too large");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function handleNavcoinRoutes({ req, res, url, session, json }) {
  if (!url.pathname.startsWith("/api/l1/navcoin/")) return false;
  res.setHeader("Cache-Control", "no-store");
  if (!session?.accountId) { json(res, 401, { error: "l1_login_required" }); return true; }
  if (req.method !== "GET") { json(res, 405, { error: "navcoin_read_only_route" }); return true; }
  try {
    if (["/api/l1/navcoin/config", "/api/l1/navcoin/registry"].includes(url.pathname)) {
      const override = process.env.B23_NAVCOIN_CONFIG_JSON ? JSON.parse(process.env.B23_NAVCOIN_CONFIG_JSON) : {};
      const config = validateConfig({ ...PUBLISHED_CONFIG, ...override });
      json(res, 200, url.pathname.endsWith("/registry") ? { coins: navcoinRegistry(config) } : config);
    } else if (url.pathname === "/api/l1/navcoin/equity") {
      json(res, 200, publicEquity(await artifact(process.env.B23_ACCOUNT_EQUITY_PATH)));
    } else if (url.pathname === "/api/l1/navcoin/fee") {
      const bps = url.searchParams.get("bps");
      if (!/^(0|[1-9][0-9]{0,2})$/.test(bps || "") || Number(bps) > 500) { json(res, 400, { error: "fee_must_be_0_to_500_bps" }); return true; }
      const prepared = await artifact(process.env.B23_FEE_PLANS_PATH);
      const operation = publicOperation(prepared[bps]);
      if (operation.operation !== "pftl_uniswap_route_epoch_advance" || operation.next_primary_market_policy?.redeem_multiplier_bps !== 10000 - Number(bps)) throw new Error("Missing prepared fee");
      json(res, 200, { operation });
    } else json(res, 404, { error: "navcoin_route_not_found" });
  } catch { json(res, 503, { error: "Public B23 preparation unavailable; operator must publish the matching configuration or unsigned plan." }); }
  return true;
}
