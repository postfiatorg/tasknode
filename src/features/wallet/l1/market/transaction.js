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
export async function submitAction(client, prepared, read, verify, isCurrent = () => true, preflight = () => {}) {
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
  try {
    const after = await read();
    guard();
    const effects = await verify(prepared.intent, before, after, submitted.receipt, submitted.txId);
    return { verified: true, ...submitted, before, after, effects };
  } catch (error) {
    return { verified: false, ...submitted, before, verificationError: error.message };
  }
}
