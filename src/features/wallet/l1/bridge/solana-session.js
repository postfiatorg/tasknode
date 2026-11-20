import { bridgeJson } from "./bridge-relay.js";

const signature = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const jobId = /^0x[0-9a-f]{64}$/;
export const postSolana = (path, body) => bridgeJson("/solana/" + path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
export const readSaved = key => JSON.parse(localStorage.getItem(key));

// The browser owns one durable intent per recipient. The Web Lock covers preparation
// and the first write across tabs. No recovery path calls Phantom.
export async function sendDeposit({ key, provider, request, ready, save, active }) {
  await navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock || readSaved(key)) throw Error("A Solana deposit is already in progress.");
    const intent = await postSolana("intent", request);
    if (!active() || provider.publicKey?.toString() !== request.owner) throw Error("Reconnect Phantom to continue.");
    if (intent.owner !== request.owner || intent.amount_atoms !== request.amount_atoms ||
      intent.pftl_recipient !== request.pftl_recipient || intent.vault_program_id !== ready.vault_program_id ||
      !/^[0-9a-f]{64}$/.test(intent.nonce) || !Number.isSafeInteger(intent.last_valid_block_height) ||
      intent.last_valid_block_height < 1 || !/^[1-9A-HJ-NP-Za-km-z]{1,1683}$/.test(intent.message_b58)) {
      throw Error("The prepared vault deposit does not match your request.");
    }
    const record = { ...request, nonce: intent.nonce, last_valid_block_height: intent.last_valid_block_height,
      vault_program_id: intent.vault_program_id, started: Date.now() };
    save(record);
    // Phantom signs; this site's server broadcasts and re-sends within the short validity window.
    let signed;
    try {
      signed = await provider.request({ method: "signTransaction", params: { message: intent.message_b58 } });
    } catch (error) {
      save(null);
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
    save({ ...record, signature: sent.signature });
  });
}

export async function advanceDeposit(record, client) {
  if (!record.signature) {
    const recovered = await postSolana("recovery", { nonce: record.nonce, vault_program_id: record.vault_program_id,
      last_valid_block_height: record.last_valid_block_height, before: record.before });
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
