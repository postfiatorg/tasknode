import { bridgeJson } from "./bridge-relay.js";
import { chainTxStatus } from "../lib/tx-status.js";

// The payout service normally takes a burn on the request sent right after it is accepted, and the screen asks
// again every 8 s. A burn the service still has not taken 5 minutes after the screen started waiting is stalled.
export const WITHDRAW_STUCK_AFTER_MS = 5 * 60 * 1000;
export function withdrawalStalled(burn, job, since, now = Date.now()) {
  return Boolean(burn) && !job && !(now - since < WITHDRAW_STUCK_AFTER_MS);
}
// "retry" when the burn is accepted on the chain, "discard" when it never reached it (missing or rejected),
// null while the chain has no final answer.
export async function stalledAction(client, burn) {
  const status = await chainTxStatus(client, burn);
  return status === "accepted" ? "retry" : status === "missing" || status === "rejected" ? "discard" : null;
}
// Sends the same burn id to the payout service again. It never signs or submits, so it cannot burn twice.
export function resendBurn(burn, post = bridgeJson) {
  return post("/withdrawals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: burn }) });
}
// Checks the chain again right before the pending burn is dropped; an accepted burn is never discarded.
export async function canDiscardBurn(client, burn) {
  if (await stalledAction(client, burn) !== "discard") throw new Error(`Burn ${burn} is not missing or rejected on the chain, so it cannot be discarded.`);
  return true;
}
