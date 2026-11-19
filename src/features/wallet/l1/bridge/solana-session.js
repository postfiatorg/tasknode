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
    let sent;
    try {
      sent = await provider.request({ method: "signAndSendTransaction", params: { message: intent.message_b58 } });
    } catch (error) {
      if (error.code === 4001) {
        save(null);
        throw Error("You declined the deposit in Phantom.");
      }
      throw Error("Phantom disconnected. Checking the vault for your deposit.");
    }
    if (!signature.test(sent?.signature || "")) throw Error("Checking the vault for your transaction signature.");
    save({ ...record, signature: sent.signature });
  });
}

export async function advanceDeposit(record) {
  if (!record.signature) {
    const recovered = await postSolana("recovery", { nonce: record.nonce, last_valid_block_height: record.last_valid_block_height });
    if (signature.test(recovered.signature || "")) return { ...record, signature: recovered.signature };
    if (recovered.expired === true) return { ...record, terminal: "expired", finished: Date.now() };
    return record;
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
    terminal = "credited";
  }
  if (job.status === "failed") terminal = "failed";
  return { ...record, job, terminal, finished: terminal ? (job.updated_at_unix * 1000 || Date.now()) : undefined };
}
