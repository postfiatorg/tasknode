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
export { savedBurn, solanaOffered, trackingKey } from "./solana-offer.js";
// A payout still open after this long is shown as late and checked once a minute.
export const LATE_MS = 30 * 60 * 1000;
export function payoutPace(since, now, stage) {
  const late = !["paid", "failed"].includes(stage) && now - since >= LATE_MS;
  return { late, delay: late ? 60000 : 8000 };
}
export function trackedSince(burn) {
  const key = "l1-withdrawal:solana:since:" + burn;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isSafeInteger(saved) && saved > 0) return saved;
    localStorage.setItem(key, String(Date.now()));
  } catch { /* Without storage the clock starts when this screen opened. */ }
  return Date.now();
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
// The connected address, without the network check. Review checks it on Solana before any burn.
export async function phantomAddress(phantom) {
  const owner = (phantom.publicKey || (await phantom.connect()).publicKey)?.toString();
  destinationRef("", owner);
  return owner;
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

// People type ".5" and "5."; the chain amount needs digits on both sides of the point.
export function normalAmount(amount) {
  const text = String(amount ?? "").trim().replace(/,/g, "");
  if (/^\.[0-9]+$/.test(text)) return "0" + text;
  if (/^[0-9]+\.$/.test(text)) return text.slice(0, -1);
  return text;
}

export function withdrawalAtoms(amount, held, outstanding, minimum = 1n) {
  const value = atoms(normalAmount(amount), "Withdrawal amount");
  if (BigInt(value) < minimum) throw Error(`The smallest withdrawal to Solana is ${usdc(minimum)} USDC.`);
  if (BigInt(value) > held) throw Error("This exceeds your current Solana-backed balance.");
  if (BigInt(value) > integer(outstanding, "Bridge reserve")) throw Error("This exceeds the outstanding amount for this Solana series.");
  return value;
}

function usdc(value) {
  const text = BigInt(value).toString().padStart(7, "0");
  return `${text.slice(0, -6)}.${text.slice(-6).replace(/0+$/, "").padEnd(2, "0")}`;
}

// Every Solana deposit batch the payout service covers. The first exit release names one series
// at the top level; the second lists each covered bucket and a governed minimum.
function coveredSeries(ready) {
  const rows = Array.isArray(ready.buckets) ? ready.buckets
    : [{ bucket_id: ready.bucket_id, series_asset_id: ready.series_asset_id, outstanding_atoms: ready.bucket_outstanding_atoms }];
  return rows.filter(row => row && isBurnId(row.bucket_id) && isBurnId(row.series_asset_id)
    && typeof row.outstanding_atoms === "string" && /^[0-9]+$/.test(row.outstanding_atoms));
}

// One burn spends one batch, so each batch the wallet holds is its own option, largest first.
// `held` is what one withdrawal can take: the largest batch. `total` is every batch together.
// onWindow receives the readiness answer's proving window and whether the route reported ready,
// before any other check, so a wallet without a withdrawable balance still sees the right hours.
export async function withdrawalSnapshot(client, onWindow) {
  const ready = await bridgeJson(ROOT + "/readiness", { signal: AbortSignal.timeout(45000) }).catch(failure => {
    onWindow?.({ window: failure?.payload?.proving_window, open: false, answered: Boolean(failure?.payload) });
    return null;
  });
  if (ready) onWindow?.({ window: ready.proving_window, open: ready.ready === true });
  if (ready?.ready !== true || ![ready.asset_id, ready.reserve_packet_hash].every(isBurnId)
      || !/^pf[0-9a-f]{40}$/.test(ready.issuer) || !Number.isSafeInteger(ready.epoch) || ready.epoch < 0
      || ready.destination_prefix !== MAINNET_PREFIX) return null;
  const covered = coveredSeries(ready);
  if (!covered.length) return null;
  const minimum = /^[1-9][0-9]*$/.test(ready.min_withdrawal_atoms ?? "") ? BigInt(ready.min_withdrawal_atoms) : 1n;
  const options = [];
  for (const row of covered) {
    const result = rpcResult(await client.call("account_assets", { account: client.address, asset_id: row.series_asset_id, limit: 10 }));
    const rows = Array.isArray(result) ? result : result?.assets;
    // A batch this wallet does not hold is simply not offered; any other mismatch still stops.
    if (Array.isArray(rows) && !result.truncated && !rows.some(line => line.asset_id === row.series_asset_id)) continue;
    const { held, ...series } = matchedBalance(result, { ...ready, series_asset_id: row.series_asset_id, bucket_id: row.bucket_id });
    const outstanding = BigInt(row.outstanding_atoms), redeemable = held < outstanding ? held : outstanding;
    if (redeemable > 0n && redeemable >= minimum) options.push({ held: redeemable, series, outstanding: row.outstanding_atoms });
  }
  if (!options.length) throw Error("Your wallet does not hold PFUSDC from the Solana series that can be paid now.");
  options.sort((x, y) => (x.held === y.held ? 0 : x.held < y.held ? 1 : -1));
  const total = options.reduce((sum, option) => sum + option.held, 0n);
  return { ready, held: options[0].held, series: options[0].series, outstanding: options[0].outstanding, options, total, minimum };
}

// The smallest batch that covers the amount, so larger batches stay whole for larger withdrawals.
export function withdrawalOption(snapshot, amount) {
  const outstanding = snapshot.outstanding ?? snapshot.ready.bucket_outstanding_atoms;
  const value = BigInt(withdrawalAtoms(amount, snapshot.held, outstanding, snapshot.minimum ?? 1n));
  const options = snapshot.options || [{ held: snapshot.held, series: snapshot.series, outstanding }];
  return [...options].reverse().find(option => value <= option.held && value <= BigInt(option.outstanding)) || options[0];
}

export function withdrawalIntent(client, snapshot, amount, recipient) {
  const { ready } = snapshot, option = withdrawalOption(snapshot, amount);
  return { kind: "asset", operation: { operation: "vault_bridge_burn_to_redeem", owner: client.address,
    issuer: option.series.issuer, asset_id: option.series.asset_id, bucket_id: option.series.bucket_id,
    amount_atoms: withdrawalAtoms(amount, option.held, option.outstanding, snapshot.minimum ?? 1n), epoch: ready.epoch,
    reserve_packet_hash: ready.reserve_packet_hash, destination_ref: destinationRef(ready.destination_prefix, recipient) } };
}

// Every change of the shared withdrawal slot is made under the slot's Web Lock, which the claim also
// takes, so no other tab writes between the comparison and the change. change(current) returns the
// new record, null to remove it, or undefined to leave it; the result is the record found.
// In a browser without Web Locks a manual change (tracking or clearing a record by hand) is made
// directly, as before the lock existed, with no coordination between tabs; any other change, such
// as a new burn's claim, still needs the lock and fails as it did. A failure is always a rejection.
export function changeSlot(storageKey, change, { manual = false } = {}) {
  const apply = () => {
    const current = localStorage.getItem(storageKey), next = change(current);
    if (next === null) localStorage.removeItem(storageKey); else if (next !== undefined) localStorage.setItem(storageKey, next);
    return current;
  };
  try {
    if (manual && typeof globalThis.navigator?.locks?.request !== "function") return Promise.resolve(apply());
    return navigator.locks.request(storageKey, apply);
  } catch (failure) { return Promise.reject(failure); }
}

// Keep the burn ID as soon as the chain names it, before the receipt wait that can time out.
// mine() is the record the caller holds in the slot: the ID replaces only that record or an empty
// slot, never a record another tab saved meanwhile; onSaved hears when it was saved. The result or
// failure comes only once that save is done; a lost or failed save leaves the ID to the caller.
// guard: see RpcClient.call.
export async function submitBurn(client, signed, storageKey, { mine, onSaved, guard } = {}) {
  let saved = "", saving;
  const onTxId = id => {
    if (!isBurnId(id)) return;
    saved = id;
    const ours = current => !mine || !current || current === mine() || current === id;
    saving = changeSlot(storageKey, current => (ours(current) ? id : undefined)).then(current => { if (ours(current)) onSaved?.(id); }, () => {});
  };
  try { return await client.submit(signed, guard ? { onTxId, guard } : { onTxId }); }
  catch (failure) { throw Object.assign(failure, { txId: saved }); }
  finally { await saving; }
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

// The relay acts only for a burn this wallet made, so every call names the wallet.
export async function payoutJob(burn, create = false, owner = "") {
  if (!isBurnId(burn)) throw Error("Invalid Post Fiat burn ID.");
  // The first request for a burn reads it on the chain twice (ownership, then the payout service),
  // about ten seconds each, so the default fifteen-second limit is too short.
  const signal = AbortSignal.timeout(60000);
  const job = await bridgeRequest(create ? ROOT : ROOT + "/" + burn, create ? {
    method: "POST", headers: { "Content-Type": "application/json", "X-L1-Owner": owner }, body: JSON.stringify({ burn_tx_id: burn }), signal,
  } : { headers: { "X-L1-Owner": owner }, signal });
  if (job?.burn_tx_id !== burn || !Object.hasOwn(STAGES, job.stage)
      || (job.amount_atoms != null && (typeof job.amount_atoms !== "string" || !/^[0-9]+$/.test(job.amount_atoms)))
      || (job.recipient != null && !decode(job.recipient, 32))
      || [job.error, job.detail].some(value => value != null && typeof value !== "string") || (job.stage === "paid" && !decode(job.solana_tx, 64))) {
    throw Error("The payout service returned an invalid tracking record.");
  }
  return job;
}
