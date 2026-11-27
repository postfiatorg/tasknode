import { getEventHash, verifyEvent } from "nostr-tools/pure";
import {
  isAsciiDigit,
  isAsciiLetter,
  isHexLength,
  replaceCharacterRuns,
  trimCharacters,
} from "./text-protocol.js";
import { signGuardedNostrEvent } from "./nostr-signing-guard.js";

export const HIVE_GROUP_ID = "tasknode-hive-v1";
export const HIVE_BOARD_HANDLE = "hive-board";
export const HIVE_MESSAGE_MAX = 8000;
export const HIVE_CHANNEL_KINDS = Object.freeze({
  GENERAL: "general",
  GOVERNANCE: "governance",
});
const isLowerAlnum = (char) => (char >= "a" && char <= "z") || isAsciiDigit(char);
const isChannelChar = (char) => isLowerAlnum(char) || "._-".includes(char);
const handleCharacter = (char) => isAsciiLetter(char) || isAsciiDigit(char) || "._-".includes(char);

export function isValidHiveChannelId(channelId = "") {
  const value = String(channelId || "").trim();
  if (value.length < 2 || value.length > 64) return false;
  if (!isLowerAlnum(value[0])) return false;
  for (const char of value) {
    if (!isChannelChar(char)) return false;
  }
  return true;
}

export function normalizeHiveChannelId(channelId = "") {
  const normalized = String(channelId || "").trim().toLowerCase();
  if (!normalized) return HIVE_GROUP_ID;
  if (!isValidHiveChannelId(normalized)) {
    throw Object.assign(new Error("hive_group_channel_invalid"), { status: 400 });
  }
  return normalized;
}

export function governanceChannelId(sessionId = "") {
  const lowered = String(sessionId || "").trim().toLowerCase();
  const replaced = replaceCharacterRuns(lowered, (char) => !isChannelChar(char), "-");
  const cleaned = trimCharacters(replaced, "-._").slice(0, 56);
  if (!cleaned) throw Object.assign(new Error("governance_session_id_invalid"), { status: 400 });
  return `gov-${cleaned}`;
}

// Mechanical mention syntax only; decisions about conversation intent are model-based.
export function hiveMentions(content, members = []) {
  const byHandle = new Map(members.map(member => [member.handle.toLowerCase(), member]));
  const matches = [];
  for (let start = 0; start < content.length; start++) {
    if (content[start] !== "@" || (start > 0 && handleCharacter(content[start - 1]))) continue;
    let end = start + 1;
    while (end < content.length && handleCharacter(content[end])) end++;
    while (end > start + 1 && "._-".includes(content[end - 1])) end--;
    const member = byHandle.get(content.slice(start + 1, end).toLowerCase());
    if (member) matches.push({ start, end, member });
    start = Math.max(start, end - 1);
  }
  return matches;
}

export function createHiveGroupEvent({
  privateKey,
  rootId,
  relay = "",
  content,
  replyTo = "",
  mentions = [],
  now = Date.now(),
  signingContext = {},
}) {
  if (typeof content !== "string" || !content.trim() || content.length > HIVE_MESSAGE_MAX || !isHexLength(rootId, 64)) throw new Error("hive_group_message_invalid");
  if (replyTo && !isHexLength(replyTo, 64)) throw new Error("hive_group_reply_invalid");
  const tags = [["e", rootId, relay, "root"]];
  if (replyTo) tags.push(["e", replyTo, relay, "reply"]);
  for (const pubkey of [...new Set(mentions)].slice(0, 12)) {
    if (!isHexLength(pubkey, 64)) throw new Error("hive_group_mention_invalid");
    tags.push(["p", pubkey]);
  }
  const { event } = signGuardedNostrEvent({
    eventTemplate: {
      kind: 1,
      created_at: Math.floor(now / 1000),
      content: content.trim(),
      tags,
    },
    privateKey,
    now,
    context: {
      source: "hive_ui",
      userInitiated: true,
      ...signingContext,
    },
  });
  return event;
}

export function validateHiveGroupEvent(event, { rootId, authorPubkey = "", now = Date.now() } = {}) {
  if (!event || event.kind !== 1 || !isHexLength(event.id, 64) || !isHexLength(event.pubkey, 64) ||
      !isHexLength(event.sig, 128) || (authorPubkey && event.pubkey !== authorPubkey) ||
      !Number.isInteger(event.created_at) || event.created_at < 0 || event.created_at > Math.floor(now / 1000) + 120 ||
      typeof event.content !== "string" || !event.content.trim() || event.content.length > HIVE_MESSAGE_MAX ||
      !Array.isArray(event.tags) || event.tags.length > 32 || event.tags.some(tag => !Array.isArray(tag) || tag.length > 5 || tag.some(value => typeof value !== "string" || value.length > 500))) {
    throw Object.assign(new Error("hive_group_event_invalid"), { status: 400 });
  }
  const roots = event.tags.filter(tag => tag[0] === "e" && tag[3] === "root");
  // Never trust nostr-tools' cached verification symbol on a reused object.
  const signed = { id:event.id,pubkey:event.pubkey,sig:event.sig,kind:event.kind,created_at:event.created_at,content:event.content,tags:event.tags };
  if (roots.length !== 1 || roots[0][1] !== rootId || getEventHash(signed) !== event.id || !verifyEvent(signed)) {
    throw Object.assign(new Error("hive_group_signature_or_room_invalid"), { status: 400 });
  }
  return event;
}

export function hiveEventReplyId(event) {
  return event.tags.find(tag => tag[0] === "e" && tag[3] === "reply")?.[1] || "";
}

export function mergeHiveGroupMessages(current, incoming, limit = 200) {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const next of incoming) {
    const previous = messages.get(next.id);
    messages.set(next.id, { ...previous, ...next,
      actor: previous?.sequence && !next.sequence ? previous.actor : next.actor,
      delivery: previous?.delivery === "delivered" ? "delivered" : next.delivery,
      sequence: Math.max(Number(previous?.sequence || 0), Number(next.sequence || 0)),
    });
  }
  return [...messages.values()].sort((a, b) => a.event.created_at - b.event.created_at || a.id.localeCompare(b.id)).slice(-limit);
}
