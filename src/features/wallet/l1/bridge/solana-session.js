import bs58 from "bs58";
import { bridgeJson } from "./bridge-relay.js";
import { checkDepositShape } from "./solana-shape.js";

const signature = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const jobId = /^0x[0-9a-f]{64}$/;
export const postSolana = (path, body) => bridgeJson("/solana/" + path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
export const readSaved = key => JSON.parse(localStorage.getItem(key));
const NOT_OPENED = "The prepared deposit does not match your request, so Phantom was not opened. Nothing was signed or sent.";
// Give the server's nonce lease back; a failure here only delays its expiry.
const release = nonce => postSolana("release", { nonce }).catch(() => {});

// Decode the server-built transaction and require exactly the deposit this browser asked for.
async function checkIntent(intent, request, ready) {
  const named = ["nonce_account", "nonce_authority", "nonce_value"].filter(field => intent[field] !== undefined);
  if (named.length && named.length !== 3) throw Error("partial nonce");
  const bytes = bs58.decode(intent.message_b58);
  const shape = await checkDepositShape(bytes, { ...request, program: ready.vault_program_id, mint: ready.mint, nonce: intent.nonce,
    ...(named.length && { nonce_account: intent.nonce_account, nonce_authority: intent.nonce_authority, nonce_value: intent.nonce_value }) });
  // The depositor's slot is empty. With a nonce the authority's slot is filled and named by the intent.
  if (!bytes.subarray(1, 65).every(byte => byte === 0) || !shape.durable !== !named.length ||
    (shape.durable && bytes.subarray(65, 129).every(byte => byte === 0))) throw Error("signature slots");
  return shape;
}

// The browser owns one durable intent per recipient. The Web Lock covers preparation
// and the first write across tabs. No recovery path calls Phantom.
export async function sendDeposit({ key, provider, request, ready, save, active }) {
  await navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock || readSaved(key)) throw Error("A Solana deposit is already in progress.");
    const intent = await postSolana("intent", request);
    // Every refusal before Phantom opens gives the server's nonce lease back.
    const refuse = async message => {
      if (/^[0-9a-f]{64}$/.test(intent?.nonce)) await release(intent.nonce);
      throw Error(message);
    };
    if (!active() || provider.publicKey?.toString() !== request.owner) await refuse("Reconnect Phantom to continue.");
    if (intent.owner !== request.owner || intent.amount_atoms !== request.amount_atoms ||
      intent.pftl_recipient !== request.pftl_recipient || intent.vault_program_id !== ready.vault_program_id ||
      !/^[0-9a-f]{64}$/.test(intent.nonce) || !Number.isSafeInteger(intent.last_valid_block_height) ||
      intent.last_valid_block_height < 1 || !/^[1-9A-HJ-NP-Za-km-z]{1,1683}$/.test(intent.message_b58)) {
      await refuse("The prepared vault deposit does not match your request.");
    }
    let shape;
    try { shape = await checkIntent(intent, request, ready); } catch { await refuse(NOT_OPENED); }
    if (!active()) await refuse("Reconnect Phantom to continue.");
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
    try { bytes = signed.serialize(); } catch { bytes = null; }
    if (!bytes?.length) { save(null); throw Error("Phantom returned an unreadable transaction. Nothing was sent."); }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    let sent;
    try {
      sent = await postSolana("send", { nonce: intent.nonce, transaction_b64: btoa(binary) });
    } catch (error) {
      // The server refused before broadcasting and keeps no copy; the signed bytes die here.
      if (error.code === "solana_deposits_closed") save(null);
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

export async function advanceDeposit(record, client) {
  if (!record.signature) {
    const recovered = await postSolana("recovery", { nonce: record.nonce, vault_program_id: record.vault_program_id,
      last_valid_block_height: record.last_valid_block_height, before: record.before,
      ...(record.nonce_account && { nonce_account: record.nonce_account, nonce_value: record.nonce_value }) });
    if (signature.test(recovered.signature || "")) return { ...record, signature: recovered.signature };
    if (recovered.expired === true) return { ...record, terminal: "expired", finished: Date.now() };
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
