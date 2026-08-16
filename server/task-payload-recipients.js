import { accountMessageKey, normalizePublicKeyBase64, publicKeyBase64FromMessageKey } from "./context-publish.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function addRecipientPublicKey(list, value) {
  const raw = safeText(value, 4000);
  if (!raw) return;
  try {
    const normalized = normalizePublicKeyBase64(raw);
    if (!list.includes(normalized)) list.push(normalized);
  } catch {
    // A malformed optional user key should not block publication.
  }
}

export async function taskPayloadRecipientPublicKeys({
  tasknodeKey = null,
  accountId = "",
  walletAddress = "",
  explicitPublicKeys = [],
  env = process.env,
} = {}) {
  const recipients = [];
  addRecipientPublicKey(recipients, tasknodeKey?.publicKey);
  for (const key of Array.isArray(explicitPublicKeys) ? explicitPublicKeys : []) {
    addRecipientPublicKey(recipients, key);
  }

  const wallet = await getLinkedWallet({ accountId });
  if (
    wallet?.status === "linked" &&
    safeText(wallet.address, 120) === safeText(walletAddress, 120)
  ) {
    addRecipientPublicKey(recipients, wallet.tasknodeEncryptionPubkey || wallet.encryptionPublicKey);
  }

  const messageKey = await accountMessageKey(walletAddress, env).catch(() => "");
  if (messageKey) {
    try {
      addRecipientPublicKey(recipients, publicKeyBase64FromMessageKey(messageKey));
    } catch {
      // The wallet may not have a Task Node-compatible MessageKey.
    }
  }

  return recipients;
}
