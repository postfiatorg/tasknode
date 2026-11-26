// Review is followed by quote, local signing, submission, then independent read-back.
export function assertWallet(client, identity) {
  if (!client.unlocked || !client.address || client.address !== identity.address || client.accountId !== identity.accountId) throw new Error("Wallet changed or locked; review this action again");
}
export async function prepareAction(client, intent, read) {
  const identity = { address: client.address, accountId: client.accountId };
  assertWallet(client, identity);
  const before = await read();
  assertWallet(client, identity);
  const quote = await client.quote(intent);
  assertWallet(client, identity);
  return { identity, intent: structuredClone(intent), before, quote };
}
export async function submitAction(client, prepared, read, verify, isCurrent = () => true, preflight = () => {}, retry = { attempts: 5, delayMs: 1500 }) {
  const guard = () => { if (!isCurrent()) throw new Error("Review expired; prepare this action again"); assertWallet(client, prepared.identity); };
  guard();
  const before = await read();
  guard();
  await preflight(prepared.intent, before, prepared.before);
  guard();
  const signed = await client.sign(prepared.intent, prepared.quote);
  guard();
  const submitted = await client.submit(signed);
  guard();
  if (submitted?.receipt?.accepted !== true) throw new Error(`Transaction not accepted: ${submitted?.receipt?.reject_reason || submitted?.receipt?.message || "accepted receipt missing"}`);
  // The read-back can land on a validator that has not applied the block yet, so a first mismatch
  // is not final: read again a few times before reporting the result as unverified.
  let verificationError = "";
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, retry.delayMs));
    try {
      const after = await read();
      guard();
      const effects = await verify(prepared.intent, before, after, submitted.receipt, submitted.txId);
      return { verified: true, ...submitted, before, after, effects };
    } catch (error) {
      verificationError = error.message;
      if (!isCurrent()) break;
    }
  }
  return { verified: false, ...submitted, before, verificationError };
}
