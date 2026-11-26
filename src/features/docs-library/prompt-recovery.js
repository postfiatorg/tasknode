import { decryptPrompt } from "../../../packages/tasknode-cli/lib/prompt-crypto.mjs";

export function docsRecoveryPackage({ account, documents, prompts }) {
  if (documents.some((document) => document.owned && document.documentType === "prompt") && !prompts.keyEnvelope) {
    throw new Error("Prompt recovery key is unavailable. Retry before exporting.");
  }
  return {
    schema: "tasknode.docs.recovery.v2",
    exportedAt: new Date().toISOString(),
    account,
    documents,
    prompts,
    note: "Capabilities, prompt library key and history remain encrypted. Recovery requires your Docs wallet.",
  };
}

// Offline recovery: unwrap account.encryptedRootKeyEnvelope with the Docs wallet,
// then pass its rootKey here. This function performs no network requests.
export async function recoverPromptLibrary(backup, rootKey) {
  if (backup.schema !== "tasknode.docs.recovery.v2") throw new Error("Unsupported recovery package");
  if (!backup.prompts.keyEnvelope) return { documents: [], events: [] };
  const { key } = await decryptPrompt(backup.prompts.keyEnvelope, rootKey);
  const documents = [];
  for (const row of backup.documents) {
    if (!row.owned || row.documentType !== "prompt") continue;
    const metadata = await decryptPrompt(row.encryptedMetadata, key);
    if (metadata.documentId !== row.documentId) throw new Error("Prompt metadata identity mismatch");
    documents.push(metadata);
  }
  const events = [];
  for (const row of backup.prompts.history) {
    const event = await decryptPrompt(row.ciphertext, key);
    if (event.eventId !== row.eventId || event.documentId !== row.documentId)
      throw new Error("Prompt history identity mismatch");
    events.push(event);
  }
  return { documents, events };
}
