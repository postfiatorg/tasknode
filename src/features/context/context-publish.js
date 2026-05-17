import { requestJson } from "../../api";
import { sanitizeContextHtml } from "../../../shared/context-html";

export async function publishContextToPft({
  accountId = "",
  linkedWalletAddress = "",
  walletSecret = null,
  context = {},
  path = "/api/context/manifest/ink",
  onPublished = null,
} = {}) {
  if (!accountId || !walletSecret?.mnemonic || walletSecret.accountId !== accountId) {
    throw new Error("Unlock the local seed vault before publishing.");
  }
  if (!linkedWalletAddress || walletSecret.address !== linkedWalletAddress) {
    throw new Error("Unlocked wallet does not match the linked wallet.");
  }

  const walletCore = await import("../../wallet-core");
  const config = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: "config" }),
  });
  if (!config.ok || !config.body?.tasknodeEncryptionPubkey) {
    throw new Error(config.body?.message || "Context publishing is not configured.");
  }

  const body = sanitizeContextHtml(context.body || "");
  const contextPayload = {
    schema: "tasknode.context.v1",
    title: String(context.title || "Task Node Context").trim().slice(0, 120) || "Task Node Context",
    body,
    body_format: "html",
    revision: Number(context.revision || 0),
    published_at: new Date().toISOString(),
  };
  const userPubkey = await walletCore.deriveTaskNodePublicKey(walletSecret.mnemonic);
  const encryptedPayload = await walletCore.encryptTaskNodePayload({
    plaintext: JSON.stringify(contextPayload),
    recipientPublicKeys: [userPubkey, config.body.tasknodeEncryptionPubkey],
  });

  const prepared = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "prepare",
      encryptedPayload,
      title: contextPayload.title,
      body: contextPayload.body,
      wordCount: context.wordCount || 0,
    }),
  });
  if (!prepared.ok || !prepared.body?.txJson) {
    throw new Error(prepared.body?.message || "Context publish transaction could not be prepared.");
  }

  const signed = walletCore.signPreparedPftlTransaction({
    mnemonic: walletSecret.mnemonic,
    txJson: prepared.body.txJson,
    expectedAddress: linkedWalletAddress,
  });
  const submitted = await requestJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phase: "submit",
      cid: prepared.body.cid,
      signedTxBlob: signed.txBlob,
      pointer: prepared.body.pointer,
      context: prepared.body.context,
      transaction: prepared.body.transaction,
    }),
  });
  if (!submitted.ok || !submitted.body?.ok) {
    throw new Error(submitted.body?.message || "Context publish transaction could not be submitted.");
  }

  await onPublished?.(submitted.body);
  return submitted.body;
}
