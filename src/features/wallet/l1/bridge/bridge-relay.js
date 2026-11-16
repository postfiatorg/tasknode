// Same-origin job transport; browser custody material is never part of a request.
export const ROUTE_ID = "ethereum-mainnet-usdc-v1";
export async function bridgeJson(path, options = {}) {
  const response = await fetch(`/api/l1/bridge${path}`, {
    credentials: "same-origin", cache: "no-store", ...options,
    signal: options.signal || AbortSignal.timeout(15000),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.message || payload.code || `Bridge HTTP ${response.status}`);
  }
  return payload;
}
export function loadBridgeReadiness() {
  return bridgeJson(`/readiness?route=${ROUTE_ID}`);
}
export function assertBridgeReadinessMatchesRoute(readiness, route) {
  const profile = route?.profile || {};
  if (readiness?.ready !== true) throw new Error(readiness?.message || "Bridge readiness is unavailable.");
  if (readiness.route_id !== profile.route_id || readiness.source_chain_id !== 1
      || readiness.source_proof_kind !== "sp1-ethereum-finality-v1"
      || readiness.route_profile_hash !== route.profileHash || readiness.asset_id !== profile.asset_id
      || readiness.vault_address !== route.vaultAddress || readiness.token_address !== route.tokenAddress
      || readiness.vault_runtime_code_hash !== route.vaultRuntimeCodeHash
      || readiness.token_runtime_code_hash !== route.tokenRuntimeCodeHash
      || readiness.program_vkey !== profile.verifier_program_vkey
      || readiness.observer_attestor_enabled !== false
      || readiness.prover_authenticated !== true || readiness.prover_healthy !== true
      || readiness.beacon_anchor_authenticated !== true
      || readiness.beacon_anchor_route_profile_hash !== route.profileHash
      || readiness.beacon_anchor_route_epoch !== route.routeEpoch
      || readiness.route_epoch !== route.routeEpoch) {
    throw new Error("Authenticated beacon anchor or relay identity does not match the active route.");
  }
  return readiness;
}
export function createBridgeJob(request) {
  return bridgeJson("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
}
export function loadBridgeJob(jobId, signal) {
  if (!/^0x[0-9a-f]{64}$/.test(jobId)) throw new Error("Malformed bridge job id");
  return bridgeJson(`/jobs/${jobId}`, { signal });
}
