import bs58 from "bs58";
import { rpcResult } from "../lib/rpc-client.js";
import { atoms, integer } from "../market/amounts.js";
import { bridgeJson, bridgeRequest } from "./bridge-relay.js";

const MAINNET_PREFIX = "solana-spl:45296998a6f8e2a784db5d9f95e18fc23f70441a1039446801089879b08c7ef0:";
const ROOT = "/solana/withdrawals";
const ID = /^[0-9a-f]{96}$/;
export const UNAVAILABLE = "Solana withdrawals are not available yet";
export const STAGES = { queued: "Waiting to start", reading: "Reading your burn", proving: "Building the payout proof",
  paying: "Sending USDC on Solana", paid: "USDC paid on Solana", failed: "Payout stopped" };
export const trackingKey = client => `l1-withdrawal:solana:${client.chainId}:${client.accountId}:${client.address}`;
export function savedBurn(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
export function isBurnId(value) { return typeof value === "string" && ID.test(value); }

function decode(value, size) {
  if (typeof value !== "string" || value.length < size || value.length > Math.ceil(size * 1.37)) return null;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === size && bs58.encode(bytes) === value ? bytes : null;
  } catch { return null; }
}

export function destinationRef(prefix, owner) {
  const bytes = decode(owner, 32);
  if (!bytes) throw Error("Enter a base58 Solana wallet address that decodes to 32 bytes.");
  return prefix + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function matchedBalance(result, ready) {
  const rows = Array.isArray(result) ? result : result?.assets;
  if (!Array.isArray(rows) || result.truncated) throw Error("Complete asset balances are unavailable.");
  const matches = rows.filter(row => row.asset_id === ready.series_asset_id);
  if (!matches.length) return 0n;
  const [row] = matches;
  if (matches.length !== 1 || (Object.hasOwn(row, "source_bucket_id") && row.source_bucket_id !== ready.bucket_id)) {
    throw Error("The balance does not match the current Solana reserve bucket.");
  }
  if (row.frozen === true) return 0n;
  const held = integer(row.balance, "Solana-backed balance");
  if (row.spendable_balance == null) return held;
  const spendable = integer(row.spendable_balance, "Spendable Solana-backed balance");
  return spendable < held ? spendable : held;
}

export function withdrawalAtoms(amount, held, outstanding) {
  const value = atoms(amount, "Withdrawal amount");
  if (BigInt(value) > held) throw Error("This exceeds your current Solana-backed balance.");
  if (BigInt(value) > integer(outstanding, "Bridge reserve")) throw Error("This exceeds the outstanding amount for this Solana series.");
  return value;
}

export async function withdrawalSnapshot(client) {
  const ready = await bridgeJson(ROOT + "/readiness", { signal: AbortSignal.timeout(45000) }).catch(() => null);
  if (ready?.ready !== true || ![ready.series_asset_id, ready.bucket_id, ready.asset_id, ready.reserve_packet_hash].every(isBurnId)
      || !/^pf[0-9a-f]{40}$/.test(ready.issuer) || !Number.isSafeInteger(ready.epoch) || ready.epoch < 0
      || ready.destination_prefix !== MAINNET_PREFIX || typeof ready.bucket_outstanding_atoms !== "string"
      || !/^[0-9]+$/.test(ready.bucket_outstanding_atoms)) return null;
  const result = rpcResult(await client.call("account_assets", { account: client.address, asset_id: ready.series_asset_id, limit: 10 }));
  return { ready, held: matchedBalance(result, ready) };
}

export function withdrawalIntent(client, { ready, held }, amount, recipient) {
  return { kind: "asset", operation: { operation: "vault_bridge_burn_to_redeem", owner: client.address,
    issuer: ready.issuer, asset_id: ready.asset_id, bucket_id: ready.bucket_id,
    amount_atoms: withdrawalAtoms(amount, held, ready.bucket_outstanding_atoms), epoch: ready.epoch,
    reserve_packet_hash: ready.reserve_packet_hash, destination_ref: destinationRef(ready.destination_prefix, recipient) } };
}

export async function payoutJob(burn, create = false) {
  if (!isBurnId(burn)) throw Error("Invalid Post Fiat burn ID.");
  const job = await bridgeRequest(create ? ROOT : ROOT + "/" + burn, create ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ burn_tx_id: burn }),
  } : {});
  if (job?.burn_tx_id !== burn || !Object.hasOwn(STAGES, job.stage)
      || (job.amount_atoms != null && (typeof job.amount_atoms !== "string" || !/^[0-9]+$/.test(job.amount_atoms)))
      || (job.recipient != null && !decode(job.recipient, 32))
      || [job.error, job.detail].some(value => value != null && typeof value !== "string") || (job.stage === "paid" && !decode(job.solana_tx, 64))) {
    throw Error("The payout service returned an invalid tracking record.");
  }
  return job;
}
