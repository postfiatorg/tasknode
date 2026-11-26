// Kept light: the withdrawal page loads this before the lazy Solana screen.
import { bridgeJson } from "./bridge-relay.js";

export const trackingKey = client => `l1-withdrawal:solana:${client.chainId}:${client.accountId}:${client.address}`;
export function savedBurn(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
// The relay host's switch decides. Off, unknown or unreachable: the Solana option is not shown.
export async function solanaOffered() {
  try { return (await bridgeJson("/solana/withdrawals/readiness", { signal: AbortSignal.timeout(15000) })).enabled === true; }
  catch { return false; }
}
