import { getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import { wrapManyEvents } from "nostr-tools/nip17";
import { decrypt, getConversationKey } from "nostr-tools/nip44";
import * as walletCore from "../../wallet-core.js";

export const TASKNODE_NOSTR_PURPOSE = "tasknode.private-messages.v1";
export const TASKNODE_MESSAGE_SUBJECT = "tasknode-dm:";
export const DEFAULT_MESSAGE_RELAYS = Object.freeze([
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.damus.io",
]);

const textEncoder = new TextEncoder();
const NIP17_GIFT_WRAP_LOOKBACK_SECONDS = (2 * 24 * 60 * 60) + (5 * 60);

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value));
}

export function buildNostrDerivationMessage({ accountId = "", walletAddress = "" } = {}) {
  return [
    "Task Node private messaging identity",
    "Version: 1",
    `Account: ${String(accountId).trim()}`,
    `Wallet: ${String(walletAddress).trim()}`,
    `Purpose: ${TASKNODE_NOSTR_PURPOSE}`,
    "This signature derives a local Nostr key. It is not a transaction.",
  ].join("\n");
}

export async function deriveNostrMessagingIdentity({ accountId = "", walletSecret } = {}) {
  const mnemonic = String(walletSecret?.mnemonic || "").trim();
  if (!mnemonic) throw new Error("Unlock your wallet to use Messages.");
  const wallet = walletCore.deriveWalletSummary(mnemonic);
  const message = buildNostrDerivationMessage({ accountId, walletAddress: wallet.address });
  const signed = walletCore.signWalletChallenge(mnemonic, message);
  const seed = textEncoder.encode(stableJson({
    domain: "tasknode.nostr.private-messages",
    version: 1,
    accountId: String(accountId).trim(),
    walletAddress: wallet.address,
    walletPublicKey: signed.publicKey,
    walletSignature: signed.signature,
  }));
  let privateKey = await sha256(seed);
  for (let attempt = 0; attempt < 256; attempt += 1) {
    try {
      const publicKeyHex = getPublicKey(privateKey);
      return {
        privateKey,
        publicKeyHex,
        npub: npubEncode(publicKeyHex),
        walletAddress: wallet.address,
      };
    } catch {
      privateKey = await sha256(new Uint8Array([...seed, attempt + 1]));
    }
  }
  throw new Error("Could not derive a valid Nostr identity.");
}

export function normalizeMessageRelays(relays = []) {
  return Array.from(new Set((Array.isArray(relays) ? relays : [])
    .map((relay) => String(relay || "").trim().replace(/\/+$/, ""))
    .filter((relay) => /^wss:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?(?:\/[^\s]*)?$/i.test(relay))))
    .slice(0, 5);
}

export function createDirectMessageEvents({ privateKey, recipientPublicKey, recipientRelay = "", message = "" } = {}) {
  const recipient = String(recipientPublicKey || "").trim().toLowerCase();
  const content = String(message || "").trim();
  if (!/^[0-9a-f]{64}$/.test(recipient)) throw new Error("Invalid recipient identity.");
  if (!content || content.length > 8000) throw new Error("Messages must be between 1 and 8,000 characters.");
  const sender = getPublicKey(privateKey);
  if (sender === recipient) throw new Error("Choose another Task Node member.");
  const wrapped = wrapManyEvents(
    privateKey,
    [{ publicKey: recipient, relayUrl: recipientRelay || undefined }],
    content,
    `${TASKNODE_MESSAGE_SUBJECT}${recipient}`
  );
  return { senderCopy: wrapped[0], recipientCopy: wrapped[1] };
}

function parseEncryptedJson(event, privateKey) {
  const conversationKey = getConversationKey(privateKey, event.pubkey);
  return JSON.parse(decrypt(event.content, conversationKey));
}

export function unwrapDirectMessage(wrap, privateKey) {
  if (!wrap || wrap.kind !== 1059 || getEventHash(wrap) !== wrap.id || !verifyEvent(wrap)) throw new Error("Invalid gift wrap.");
  const ownPublicKey = getPublicKey(privateKey);
  if (!wrap.tags?.some((tag) => tag[0] === "p" && tag[1] === ownPublicKey)) {
    throw new Error("Gift wrap is for another recipient.");
  }
  const seal = parseEncryptedJson(wrap, privateKey);
  if (seal?.kind !== 13 || getEventHash(seal) !== seal.id || !verifyEvent(seal)) throw new Error("Invalid message seal.");
  const rumor = parseEncryptedJson(seal, privateKey);
  if (rumor?.kind !== 14 || rumor.pubkey !== seal.pubkey || rumor.id !== getEventHash(rumor)) {
    throw new Error("Invalid private message.");
  }
  const subject = rumor.tags?.find((tag) => tag[0] === "subject")?.[1] || "";
  const addressedPeer = subject.startsWith(TASKNODE_MESSAGE_SUBJECT)
    ? subject.slice(TASKNODE_MESSAGE_SUBJECT.length)
    : "";
  const mine = rumor.pubkey === ownPublicKey;
  const peerPublicKey = mine && /^[0-9a-f]{64}$/.test(addressedPeer)
    ? addressedPeer
    : rumor.pubkey;
  return {
    id: rumor.id,
    wrapId: wrap.id,
    content: rumor.content,
    createdAt: new Date(rumor.created_at * 1000).toISOString(),
    createdAtUnix: rumor.created_at,
    mine,
    peerPublicKey,
    senderPublicKey: rumor.pubkey,
  };
}

export async function fetchDirectMessages({ privateKey, relays, since, limit = 500 } = {}) {
  const pool = new SimplePool();
  const relayUrls = normalizeMessageRelays(relays);
  const publicKey = getPublicKey(privateKey);
  try {
    const events = await pool.querySync(relayUrls, {
      kinds: [1059],
      "#p": [publicKey],
      since: Number.isInteger(since) ? since : Math.floor(Date.now() / 1000) - (180 * 24 * 60 * 60),
      limit: Math.min(1000, Math.max(1, Number(limit) || 500)),
    }, { maxWait: 9000 });
    const byId = new Map();
    for (const event of events) {
      try {
        const message = unwrapDirectMessage(event, privateKey);
        byId.set(message.id, message);
      } catch {
        // Ignore malformed, forged, or unrelated relay events.
      }
    }
    return [...byId.values()].sort((a, b) => a.createdAtUnix - b.createdAtUnix);
  } finally {
    pool.destroy();
  }
}

export function subscribeDirectMessages({
  privateKey,
  relays,
  since,
  onMessage,
  onStatus,
  poolFactory = (options) => new SimplePool(options),
} = {}) {
  const relayUrls = normalizeMessageRelays(relays);
  if (!privateKey) throw new Error("Unlock your wallet to receive Messages.");
  if (!relayUrls.length) throw new Error("No Nostr relays are available.");
  const publicKey = getPublicKey(privateKey);
  const pool = poolFactory({ enableReconnect: true });
  let closed = false;
  onStatus?.({ status: "connecting", relays: relayUrls });
  const subscription = pool.subscribeMany(relayUrls, {
    kinds: [1059],
    "#p": [publicKey],
    // NIP-17 intentionally randomizes gift-wrap timestamps up to two days into the past.
    // The live filter must cover that privacy window or a newly published wrap can look old to relays.
    since: Number.isInteger(since) ? since : Math.floor(Date.now() / 1000) - NIP17_GIFT_WRAP_LOOKBACK_SECONDS,
  }, {
    maxWait: 9000,
    onevent(event) {
      if (closed) return;
      try {
        onMessage?.(unwrapDirectMessage(event, privateKey));
      } catch {
        // Ignore malformed, forged, or unrelated relay events without interrupting the inbox.
      }
    },
    oneose() {
      if (!closed) onStatus?.({ status: "live", relays: relayUrls });
    },
    onclose(reasons) {
      if (!closed) onStatus?.({ status: "disconnected", relays: relayUrls, reasons });
    },
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      void subscription.close("Task Node Messages view closed");
      pool.destroy();
    },
  };
}

export async function publishDirectMessage({ privateKey, recipientPublicKey, recipientRelays, relays, message } = {}) {
  const ownRelays = normalizeMessageRelays(relays);
  const peerRelays = normalizeMessageRelays(recipientRelays);
  const allRelays = normalizeMessageRelays([...peerRelays, ...ownRelays]);
  const { senderCopy, recipientCopy } = createDirectMessageEvents({
    privateKey,
    recipientPublicKey,
    recipientRelay: peerRelays[0] || "",
    message,
  });
  const pool = new SimplePool();
  try {
    const deliveries = await Promise.allSettled([
      ...pool.publish(ownRelays, senderCopy, { maxWait: 9000 }),
      ...pool.publish(allRelays, recipientCopy, { maxWait: 9000 }),
    ]);
    const delivered = deliveries.filter((result) => result.status === "fulfilled").length;
    if (!delivered) throw new Error("No Nostr relay accepted the message.");
    return {
      delivered,
      attempted: deliveries.length,
      message: unwrapDirectMessage(senderCopy, privateKey),
    };
  } finally {
    pool.destroy();
  }
}
