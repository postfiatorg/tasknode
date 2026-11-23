import { isOffCurveAddress } from "@solana/addresses";
import bs58 from "bs58";
import { rpcResult } from "../lib/rpc-client.js";
import { atoms, integer } from "../market/amounts.js";
import { bridgeJson, bridgeRequest } from "./bridge-relay.js";
import { recipientRefusal, UNCHECKED, WALLET_NEEDED } from "./solana-recipient.js";

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

// A wallet address is an Ed25519 public key. Program-derived addresses, which include every
// associated token account, are off the curve and nobody can sign for them.
export function destinationRef(prefix, owner) {
  const bytes = decode(owner, 32);
  if (!bytes) throw Error(`This is not a Solana address. ${WALLET_NEEDED}`);
  if (isOffCurveAddress(owner)) throw Error(recipientRefusal("off_curve"));
  return prefix + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// The relay reads the address on Solana at finalized commitment. Only an explicit "wallet" answer
// for this exact address lets a burn be built; any failure refuses.
export async function checkRecipient(owner) {
  destinationRef("", owner);
  let answer;
  try { answer = await bridgeRequest(ROOT + "/recipient/" + owner, { signal: AbortSignal.timeout(20000) }); }
  catch { throw Error(UNCHECKED); }
  if (answer?.ok !== true || answer.recipient !== owner) throw Error(UNCHECKED);
  if (answer.allowed === true && answer.kind === "wallet") return owner;
  throw Error(answer.allowed === false ? recipientRefusal(answer.kind) : UNCHECKED);
}

export async function phantomRecipient(phantom) {
  const owner = (phantom.publicKey || (await phantom.connect()).publicKey)?.toString();
  return checkRecipient(owner);
}

// The burn's issuer, asset family and bucket come from the wallet's own balance row on the chain.
// Readiness only says which series can be paid now; it must name exactly that row.
export function matchedBalance(result, ready) {
  const rows = Array.isArray(result) ? result : result?.assets;
  if (!Array.isArray(rows) || result.truncated) throw Error("Complete asset balances are unavailable.");
  const matches = rows.filter(row => row.asset_id === ready.series_asset_id);
  if (!matches.length) throw Error("Your wallet does not hold PFUSDC from the Solana series that can be paid now.");
  const [row] = matches;
  if (matches.length !== 1) throw Error("Complete asset balances are unavailable.");
  if (!row.source_series_id || row.issuer !== ready.issuer || row.asset_family_id !== ready.asset_id || row.source_bucket_id !== ready.bucket_id) {
    throw Error("The payout service named a different Solana series or issuer than your wallet holds.");
  }
  const series = { issuer: row.issuer, asset_id: row.asset_family_id, bucket_id: row.source_bucket_id };
  if (row.frozen === true) return { held: 0n, ...series };
  const held = integer(row.balance, "Solana-backed balance");
  if (row.spendable_balance == null) return { held, ...series };
  const spendable = integer(row.spendable_balance, "Spendable Solana-backed balance");
  return { held: spendable < held ? spendable : held, ...series };
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
  const { held, ...series } = matchedBalance(result, ready);
  return { ready, held, series };
}

export function withdrawalIntent(client, { ready, held, series }, amount, recipient) {
  return { kind: "asset", operation: { operation: "vault_bridge_burn_to_redeem", owner: client.address,
    issuer: series.issuer, asset_id: series.asset_id, bucket_id: series.bucket_id,
    amount_atoms: withdrawalAtoms(amount, held, ready.bucket_outstanding_atoms), epoch: ready.epoch,
    reserve_packet_hash: ready.reserve_packet_hash, destination_ref: destinationRef(ready.destination_prefix, recipient) } };
}

// Keep the burn ID as soon as the chain names it, before the receipt wait that can time out.
export async function submitBurn(client, signed, storageKey) {
  let saved = "";
  const onTxId = id => { if (isBurnId(id)) { saved = id; localStorage.setItem(storageKey, id); } };
  try { return await client.submit(signed, { onTxId }); }
  catch (failure) { throw Object.assign(failure, { txId: saved }); }
}

// The wallet's own accepted burns from its chain history (account_tx), newest first, so a burn
// made in another browser can be tracked. The row does not carry the destination; the payout
// service answers for the burns it pays.
export async function walletBurns(client, limit = 100) {
  const result = rpcResult(await client.call("account_tx", { address: client.address, limit }));
  const rows = Array.isArray(result) ? result : result?.rows || result?.transactions || [];
  return rows.filter(row => (row.transaction_kind || row.kind) === "vault_bridge_burn_to_redeem" && row.accepted === true
    && row.from === client.address && isBurnId(row.tx_id)).sort((a, b) => (b.block_height ?? 0) - (a.block_height ?? 0)).slice(0, 5)
    .map(row => ({ id: row.tx_id, amount: row.amount, height: row.block_height }));
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
