import {
  deviceFingerprint,
  pairingMac,
  promptPairingCode,
} from "../../../packages/tasknode-cli/lib/prompt-device.mjs";
import { requestJson } from "../../api";
import {
  decryptPrompt,
  encryptPrompt,
  newLibraryKey,
} from "../../../packages/tasknode-cli/lib/prompt-crypto.mjs";
export async function promptRequest(
  path,
  payload,
  { signal = AbortSignal.timeout(15000) } = {},
) {
  const result = await requestJson(
    `/api/docs/prompts/${path}`,
    payload === undefined
      ? { signal }
      : {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
  );
  if (!result.ok)
    throw new Error(result.body?.error || "Prompt library request failed");
  return result.body;
}
export async function unlockPromptLibrary(rootKey) {
  let { envelope } = await promptRequest("key");
  if (!envelope) {
    const key = newLibraryKey();
    const candidate = await encryptPrompt({ key }, rootKey);
    try {
      await promptRequest("key", { envelope: candidate });
    } catch {
      /* Another unlocked tab may have initialized first; always read back. */
    }
    ({ envelope } = await promptRequest("key"));
    if (!envelope) throw new Error("Prompt library setup failed");
  }
  return (await decryptPrompt(envelope, rootKey)).key;
}
export async function readPromptHistory(
  key,
  { summariesOnly = false, signal } = {},
) {
  const events = [];
  let after = "";
  do {
    const result = await promptRequest(
      `history${after ? `?after=${after}` : ""}`,
      undefined,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      },
    );
    for (const row of result.events) {
      const payload = await decryptPrompt(row.ciphertext, key);
      if (
        payload.eventId !== row.eventId ||
        payload.documentId !== row.documentId
      )
        throw new Error("Prompt history identity mismatch");
      if (summariesOnly && payload.kind === "version_saved")
        delete payload.text;
      if (summariesOnly && payload.kind === "agent_edit")
        delete payload.patches;
      events.push({ ...payload, createdAt: row.createdAt });
    }
    after = result.next;
  } while (after);
  return events;
}
export async function savePromptEvent(key, documentId, payload) {
  const eventId = crypto.randomUUID();
  const event = {
    ...payload,
    eventId,
    documentId,
    at: new Date().toISOString(),
  };
  const ciphertext = await encryptPrompt(event, key);
  await promptRequest("history", { eventId, documentId, ciphertext });
  return event;
}

export async function encryptedPromptBackup() {
  const { envelope: keyEnvelope } = await promptRequest("key");
  const history = [];
  let after = "";
  do {
    const result = await promptRequest(
      `history${after ? `?after=${after}` : ""}`,
    );
    history.push(...result.events);
    after = result.next;
  } while (after);
  return { keyEnvelope, history };
}

export async function createPromptHistoryEvent(key, documentId, payload) {
  const event = {
    ...payload,
    eventId: crypto.randomUUID(),
    documentId,
    at: new Date().toISOString(),
  };
  return {
    event,
    envelope: {
      eventId: event.eventId,
      ciphertext: await encryptPrompt(event, key),
    },
  };
}

// Devices approved from their sign-in link: wrap the library key to the key that link carried, no fingerprint check
// or pasted code needed. Returns the labels of the devices granted.
const PAIRINGS = "tasknode.promptPairings";
function pendingPairings() {
  try {
    return JSON.parse(localStorage.getItem(PAIRINGS) || "[]").filter(
      (row) => Date.now() - row.at < 86400000,
    );
  } catch {
    return [];
  }
}
export function hasPendingPairings() {
  return pendingPairings().length > 0;
}
export async function grantPendingAgentAccess({
  libraryKey,
  accountId,
  encrypt,
}) {
  const pending = pendingPairings();
  if (!pending.length || !libraryKey || !accountId) return [];
  const { devices } = await promptRequest("devices");
  const granted = [];
  const left = [];
  for (const row of pending) {
    const publicKey = row.p.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const device = devices.find(
      (candidate) => candidate.publicKey === publicKey && !candidate.revokedAt,
    );
    if (!device) {
      left.push(row);
      continue;
    }
    if (!device.approvedAt) {
      const fingerprint = await deviceFingerprint(publicKey);
      const code = await promptPairingCode(libraryKey, {
        ...device,
        publicKey,
        accountId,
      });
      const envelope = await encrypt(
        {
          key: libraryKey,
          deviceId: device.deviceId,
          fingerprint,
          accountId,
          mac: await pairingMac(row.s, code),
        },
        [publicKey],
      );
      await promptRequest("devices/approve", {
        deviceId: device.deviceId,
        envelope,
      });
      granted.push(device.label);
    }
  }
  localStorage.setItem(PAIRINGS, JSON.stringify(left));
  return granted;
}
