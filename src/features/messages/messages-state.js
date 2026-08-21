export function mergeMessages(current = [], incoming = []) {
  const byId = new Map([...current, ...incoming].filter((item) => item?.id).map((item) => [item.id, item]));
  return [...byId.values()].sort((a, b) => a.createdAtUnix - b.createdAtUnix);
}

function nonEmptyProfileValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length ? value : null;
  }
  return String(value || "").trim() || null;
}

export function mergeMessageContact(current = {}, incoming = {}) {
  const next = { ...(current || {}) };
  for (const key of ["accountId", "displayName", "hiveHandle", "nip05"]) {
    const value = nonEmptyProfileValue(incoming?.[key]);
    if (value !== null) next[key] = value;
  }
  if (Array.isArray(incoming?.preferredRelays)) next.preferredRelays = incoming.preferredRelays;
  if (Object.hasOwn(incoming || {}, "heroNft")) {
    next.heroNft = nonEmptyProfileValue(incoming.heroNft);
  }
  return next;
}

export function conversationThreads(messages = [], contacts = {}) {
  const byPeer = new Map();
  messages.forEach((message) => {
    if (!message?.peerPublicKey) return;
    const current = byPeer.get(message.peerPublicKey) || [];
    current.push(message);
    byPeer.set(message.peerPublicKey, current);
  });
  Object.keys(contacts || {}).forEach((pubkey) => {
    if (!byPeer.has(pubkey)) byPeer.set(pubkey, []);
  });
  return [...byPeer.entries()].map(([publicKey, threadMessages]) => ({
    publicKey,
    messages: threadMessages,
    contact: contacts[publicKey] || null,
    latest: threadMessages.at(-1) || null,
  })).sort((a, b) => (b.latest?.createdAtUnix || 0) - (a.latest?.createdAtUnix || 0));
}

export function compactPublicKey(value = "") {
  const key = String(value || "");
  return key.length > 18 ? `${key.slice(0, 9)}…${key.slice(-7)}` : key;
}

export function formatMessageTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
