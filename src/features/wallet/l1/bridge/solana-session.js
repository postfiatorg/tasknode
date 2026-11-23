import bs58 from "bs58";
import { bridgeJson } from "./bridge-relay.js";
import { CHECK_MISMATCH, knownRefusal, refusalText, RECONNECT_PHANTOM, RELOAD_DEPOSIT } from "./solana-refusal.js";
import { checkDepositShape, DEPOSIT_CHECK_VERSION, instructionLayout, validLayout } from "./solana-shape.js";

const signature = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const jobId = /^0x[0-9a-f]{64}$/;
const pageBuild = import.meta.env?.VITE_WALLET_BUILD_ID ?? "dev";
const buildHeader = { "X-Tasknode-Build": pageBuild };
export async function solanaReadiness() {
  const ready = await bridgeJson("/solana/readiness", { headers: buildHeader });
  if (ready.build_id !== pageBuild) throw Error(RELOAD_DEPOSIT);
  return ready;
}
export const postSolana = (path, body) => bridgeJson("/solana/" + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...(path === "intent" && buildHeader) }, body: JSON.stringify(body),
});
export const readSaved = key => JSON.parse(localStorage.getItem(key));
// /solana/send refused before broadcasting: nothing reached Solana, so the pending deposit is dropped.
const UNSENT = ["solana_deposits_closed", "solana_deposit_shape_mismatch"];
// While a durable deposit's lease is held and its nonce unchanged, recovery sends the signed copy again this often.
export const RESEND_SIGNED_MS = 10000;
// A durable deposit whose lease is gone but whose nonce is unchanged can still land. It is never final
// then: the card checks it this often, for this long after the lease went, and shows its credit if it lands.
export const RECOVERY_POLL_MS = 30_000;
export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const pollDelay = record => record.lapsed && !record.signature ? RECOVERY_POLL_MS : 1000;
// The user started another deposit: the open one is kept aside, once, and still checked. Past MAX_SET_ASIDE
// rows the oldest ended ones go first, then the oldest past their day; a row that can still land is never dropped.
export const MAX_SET_ASIDE = 10;
export function setAside(earlier, record) {
  const list = [...(earlier ?? []).filter(row => row.nonce !== record.nonce), record];
  for (const done of [row => row.terminal, row => dayOver(row)]) {
    for (let i; list.length > MAX_SET_ASIDE && (i = list.findIndex(done)) >= 0;) list.splice(i, 1);
  }
  return list;
}
// Give the server's nonce lease back; a failure here only delays its expiry.
// A refused layout goes along so the relay log shows it, only within the relay's schema and request limit.
const release = (nonce, reason, layout) => postSolana("release", { nonce, reason,
  layout: reason && validLayout(layout) && JSON.stringify(layout).length <= 3000 ? layout : undefined }).catch(() => {});
const base64 = bytes => { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
// A record that reached a signature or an end no longer needs the signed copy.
const settled = ({ transaction_b64: _bytes, resent: _resent, ...record }) => record;
// A deposit Solana has not recorded RECOVERY_WINDOW_MS after its lease went ends once a read finds nothing or fails.
const dayOver = record => record.lapsed && !record.signature && Date.now() - record.lapsed >= RECOVERY_WINDOW_MS
  ? { ...settled(record), terminal: "lapsed", finished: Date.now() } : null;

// The fields of the intent that name a durable nonce, all three or none.
function nonceFields(intent) {
  const named = ["nonce_account", "nonce_authority", "nonce_value"].filter(field => intent[field] !== undefined);
  if (named.length && named.length !== 3) throw Error(refusalText("partial nonce"));
  if (named.some(field => typeof intent[field] !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(intent[field]))) throw Error(refusalText("nonce account"));
  return named.length ? { nonce_account: intent.nonce_account, nonce_authority: intent.nonce_authority, nonce_value: intent.nonce_value } : null;
}

// Decode the server-built transaction and require exactly the deposit this browser asked for.
async function checkIntent(intent, request, ready) {
  if (intent.owner !== request.owner) throw Error(refusalText("prepared owner"));
  if (intent.amount_atoms !== request.amount_atoms) throw Error(refusalText("prepared amount"));
  if (intent.pftl_recipient !== request.pftl_recipient) throw Error(refusalText("prepared recipient"));
  if (intent.vault_program_id !== ready.vault_program_id) throw Error(refusalText("prepared vault program"));
  if (!/^[0-9a-f]{64}$/.test(intent.nonce)) throw Error(refusalText("deposit nonce"));
  if (!Number.isSafeInteger(intent.last_valid_block_height) || intent.last_valid_block_height < 1) throw Error(refusalText("validity height"));
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,1683}$/.test(intent.message_b58)) throw Error(refusalText("invalid deposit encoding"));
  const named = nonceFields(intent);
  const bytes = bs58.decode(intent.message_b58);
  const shape = await checkDepositShape(bytes, { ...request, program: ready.vault_program_id, mint: ready.mint, nonce: intent.nonce, ...named });
  // Nothing is signed yet: Phantom signs first, and with a nonce the authority named by the intent signs on send.
  if (!bytes.subarray(1, 1 + 64 * bytes[0]).every(byte => byte === 0) || !shape.durable !== !named) throw Error(refusalText("signature slots"));
  return shape;
}

// One signer: main's rule, so the source is not pinned (the relay pins none there either). Two
// signers: the relay co-signs only the leased deposit, prepared source included.
async function checkSigned(signed, intent, request, ready, prepared) {
  await checkDepositShape(signed, { ...request, program: ready.vault_program_id, mint: ready.mint,
    source: prepared.durable ? prepared.source : undefined, nonce: intent.nonce, ...prepared.durable }, { signed: true });
  if (signed[0] !== prepared.signers) throw Error(refusalText("signer count"));
  if (signed.subarray(1, 65).every(byte => byte === 0)) throw Error(refusalText("missing depositor signature"));
}

const shapeReason = error => knownRefusal(error?.message) ? error.message : refusalText("invalid deposit encoding");

// The browser owns one durable intent per recipient. The Web Lock covers preparation
// and the first write across tabs. No recovery path calls Phantom.
export async function sendDeposit({ key, provider, request, ready, save, active }) {
  await navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock || readSaved(key)) throw Error("A Solana deposit is already in progress.");
    const intent = await postSolana("intent", request);
    // The relay that prepared this deposit names the shape check it runs on /send. Where it co-signs,
    // with a durable nonce, that must be this page's, or it could refuse what Phantom signed.
    // One-signer deposits go ahead on any version, or none (an older relay).
    const current = intent?.check_version === DEPOSIT_CHECK_VERSION;
    // Every refusal before Phantom opens gives the server's nonce lease back. An older relay accepts no reason.
    const refuse = async (reason, detail = "", layout) => {
      if (/^[0-9a-f]{64}$/.test(intent?.nonce)) await release(intent.nonce, current ? reason : undefined, layout);
      throw Error(reason + detail);
    };
    if (intent.build_id !== pageBuild) await refuse(RELOAD_DEPOSIT);
    if (!active() || provider.publicKey?.toString() !== request.owner) await refuse(RECONNECT_PHANTOM);
    let shape;
    try { shape = await checkIntent(intent, request, ready); } catch (error) { await refuse(shapeReason(error), ". Phantom was not opened."); }
    if (shape.durable && !current) await refuse(CHECK_MISMATCH);
    if (!active()) await refuse(RECONNECT_PHANTOM);
    // A durable-nonce deposit expires only when its nonce moves, so keep what it signed.
    const record = { ...request, nonce: intent.nonce, last_valid_block_height: intent.last_valid_block_height,
      vault_program_id: intent.vault_program_id, started: Date.now(),
      ...(shape.durable && { nonce_account: shape.durable.nonce_account, nonce_value: shape.durable.nonce_value }) };
    save(record);
    // Phantom signs; this site's server broadcasts and re-sends within the short validity window.
    let signed;
    try {
      signed = await provider.request({ method: "signTransaction", params: { message: intent.message_b58 } });
    } catch (error) {
      save(null);
      await release(intent.nonce);
      throw Error(error.code === 4001 ? "You declined the deposit in Phantom." : "Phantom could not sign the deposit. Nothing was sent.");
    }
    let bytes;
    try {
      // Legacy web3 transactions otherwise require a signature in the still-empty authority slot.
      bytes = Uint8Array.from(signed.serialize({ requireAllSignatures: false }));
      if (!bytes.length) throw Error(refusalText("unreadable Phantom reply"));
      await checkSigned(bytes, intent, request, ready, shape);
    } catch (error) {
      save(null);
      let reason = shapeReason(error);
      if (!bytes) {
        // If the wallet serializer rejected a signature, decode an unchecked copy for logging only.
        try { bytes = Uint8Array.from(signed.serialize({ requireAllSignatures: false, verifySignatures: false })); } catch { /* no wire layout */ }
        reason = refusalText(bytes?.length ? "invalid Phantom signature" : "unreadable Phantom reply");
      }
      const layout = instructionLayout(bytes);
      console.warn(reason, layout);
      await refuse(reason, ". Nothing was sent.", layout);
    }
    const transaction = base64(bytes);
    // Keep the signed copy of a durable deposit: recovery can send it again while its lease is held.
    if (shape.durable) save({ ...record, transaction_b64: transaction });
    let sent;
    try {
      sent = await postSolana("send", { nonce: intent.nonce, transaction_b64: transaction });
    } catch (error) {
      // The server refused before broadcasting and keeps no copy; the signed bytes die here.
      if (UNSENT.includes(error.code)) {
        save(null);
        await release(intent.nonce);
      }
      throw error;
    }
    if (!signature.test(sent?.signature || "")) throw Error("Checking the vault for your transaction signature.");
    // The signature is the first one in the bytes Phantom signed; the server must report that one.
    if (sent.signature !== bs58.encode(bytes.subarray(1, 65))) {
      throw Error("The server reported a different transaction signature than the one you signed. Checking the vault for your deposit.");
    }
    save({ ...record, signature: sent.signature });
  });
}

// One check of a deposit. Past its day, a failed read ends it; within the day the failure is reported.
export async function advanceDeposit(record, client) {
  try { return await advance(record, client); } catch (error) {
    const over = dayOver(record);
    if (over) return over;
    throw error;
  }
}

async function advance(record, client) {
  if (!record.signature) {
    const recovered = await postSolana("recovery", { nonce: record.nonce, vault_program_id: record.vault_program_id,
      last_valid_block_height: record.last_valid_block_height, before: record.before,
      ...(record.nonce_account && { nonce_account: record.nonce_account, nonce_value: record.nonce_value }) });
    if (signature.test(recovered.signature || "")) return { ...settled(record), signature: recovered.signature };
    if (recovered.expired === true) return { ...settled(record), terminal: "expired", finished: Date.now() };
    // The lease ended with the nonce unchanged and no receipt: it can still land, so keep checking, slowly,
    // for RECOVERY_WINDOW_MS. The signed copy is not sent again.
    if (recovered.lapsed === true && record.nonce_account) {
      const over = dayOver(record);
      if (over) return over;
      const lapsed = record.lapsed ?? Date.now();
      if (record.lapsed && record.before === recovered.before) return record;
      return { ...settled(record), lapsed, ...(recovered.before !== undefined && { before: recovered.before }) };
    }
    if (recovered.resend === true && record.transaction_b64 && Date.now() - (record.resent ?? 0) >= RESEND_SIGNED_MS) {
      const sent = await postSolana("send", { nonce: record.nonce, transaction_b64: record.transaction_b64 }).catch(() => null);
      const own = bs58.encode(Uint8Array.from(atob(record.transaction_b64), char => char.charCodeAt(0)).subarray(1, 65));
      return sent?.signature === own ? { ...settled(record), signature: own } : { ...record, resent: Date.now() };
    }
    return record.before === recovered.before ? record : { ...record, before: recovered.before };
  }
  if (!record.jobId) {
    const job = await postSolana("jobs", { signature: record.signature });
    if (!jobId.test(job.job_id)) throw Error("The proof relay returned an invalid job ID.");
    return { ...record, jobId: job.job_id };
  }
  const job = await bridgeJson("/solana/jobs/" + record.jobId);
  if (job.job_id !== record.jobId || job.signature !== record.signature) throw Error("The relay job does not match this deposit.");
  let terminal;
  if (job.status === "accepted") {
    if (job.receipt_code !== "ACCEPTED" || !/^[0-9a-f]{96}$/.test(job.receipt_id || "")) throw Error("Awaiting the Post Fiat credit receipt.");
    const matches = job.receipts?.some(row => ["vault_program_id", "nonce", "owner", "pftl_recipient", "amount_atoms"]
      .every(field => row[field] === record[field]));
    if (!matches) throw Error("The proven vault receipt does not match this deposit.");
    // The bridge receipt ID names the credit; the ledger receipt is filed under the transaction ID.
    if (!/^[0-9a-f]{96}$/.test(job.ledger_tx_id || "")) throw Error("Awaiting the Post Fiat transaction ID.");
    const response = await client.call("receipts", { tx_id: job.ledger_tx_id, limit: 1 });
    const receipts = response?.result ?? response;
    if (!Array.isArray(receipts) || !receipts.some(row => row.tx_id === job.ledger_tx_id && row.accepted === true && row.code === "accepted")) {
      throw Error("Waiting for the accepted Post Fiat receipt.");
    }
    terminal = "credited";
  }
  if (job.status === "failed") terminal = "failed";
  return { ...record, job, terminal, finished: terminal ? (job.updated_at_unix * 1000 || Date.now()) : undefined };
}

// One check of a set-aside deposit. A failed check within the day keeps the row.
export const checkEarlier = (row, client) => advanceDeposit(row, client).catch(() => row);
