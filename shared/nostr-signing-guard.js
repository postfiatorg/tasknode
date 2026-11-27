// Pillar 6 — Browser Nostr Signing Guard v1 (Contract C3)
// Centralized fail-closed guard for all Nostr event signing, relay hygiene,
// origin/domain binding, human-readable signing review, and inbound verification.
// Uses pure character checks (no regular expressions) so it is safe on inference paths.

import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  isAsciiDigit,
  isAsciiLetter,
  isDecimalDigits,
  isHexLength,
  isWhitespace,
  trimCharacters,
} from "./text-protocol.js";

export const ALLOWED_NOSTR_EVENT_KINDS = Object.freeze([0, 1, 13, 1059, 10050, 22242]);
const ALLOWED_KIND_SET = new Set(ALLOWED_NOSTR_EVENT_KINDS);
const USER_INITIATED_KINDS = new Set([0, 1, 13, 1059, 10050]);
const REVIEW_REQUIRED_KINDS = new Set([0, 10050]);

export const NOSTR_MAX_CONTENT_CHARS = 32_768;
export const NOSTR_DM_MAX_CONTENT_CHARS = 8_000;
export const NOSTR_MAX_TAGS = 64;
export const NOSTR_MAX_TAG_ELEMENT_CHARS = 1_024;
export const NOSTR_MAX_RELAY_URL_BYTES = 128;
export const NOSTR_MAX_RELAYS = 5;
export const NOSTR_TIMESTAMP_SKEW_SECONDS = 600;
export const NIP17_MAX_PAST_SECONDS = 3 * 24 * 60 * 60;

export const ALLOWED_SIGNING_SOURCES = Object.freeze([
  "messages_ui",
  "hive_ui",
  "settings_ui",
  "relay_auth",
  "identity_ui",
  "hive_mind_ui",
  "governance_ui",
  "server_bot",
]);
const ALLOWED_SOURCE_SET = new Set(ALLOWED_SIGNING_SOURCES);

const UNTRUSTED_SOURCES = new Set([
  "postmessage",
  "post_message",
  "iframe",
  "cross_origin_iframe",
  "url_param",
  "url_query",
  "url_hash",
  "clipboard",
  "paste",
  "external",
  "untrusted",
  "auto",
  "page_load",
  "incoming_event",
]);

const BLOCKED_ORIGIN_HOSTNAMES = new Set([
  "hub-viewer.postfiat.org",
]);

const NONPROD_HOST_TOKENS = new Set([
  "dev",
  "staging",
  "stage",
  "preview",
  "test",
  "sandbox",
  "local",
]);

const KIND_LABELS = Object.freeze({
  0: "Profile Metadata (kind:0)",
  1: "Hive Public Note (kind:1)",
  13: "Direct Message Seal (kind:13)",
  1059: "Direct Message Gift Wrap (kind:1059)",
  10050: "Direct Message Relay List (kind:10050)",
  22242: "Relay Authentication (kind:22242)",
});

function guardError(code, detail = "") {
  const message = detail ? `${code}: ${detail}` : code;
  const error = new Error(message);
  error.code = code;
  error.status = 403;
  return error;
}

function isLowerHexLength(value, length) {
  return typeof value === "string" && value === value.toLowerCase() && isHexLength(value, length);
}

function isIpv4Literal(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => part.length >= 1 && part.length <= 3 && isDecimalDigits(part) && Number(part) <= 255);
}

function hasOnlyRelayHostChars(host) {
  if (!host) return false;
  for (const ch of host) {
    if (!isAsciiLetter(ch) && !isAsciiDigit(ch) && ch !== "." && ch !== "-") return false;
  }
  return true;
}

export function escapeNostrText(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isPrivateOrIpHostname(hostname = "") {
  const host = trimCharacters(String(hostname || "").trim().toLowerCase(), "[]");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (isIpv4Literal(host)) return true;
  if (host.includes(":")) return true; // IPv6 literal
  return false;
}

function hasNonProdHostToken(hostname = "") {
  const tokens = [];
  let current = "";
  for (const ch of String(hostname || "").toLowerCase()) {
    if (ch === "." || ch === "-") {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens.some((token) => NONPROD_HOST_TOKENS.has(token));
}

export function isProductionSigningEnvironment({ environment = "", hostname = "" } = {}) {
  const env = String(
    environment ||
    globalThis.process?.env?.NODE_ENV ||
    ""
  ).trim().toLowerCase();

  const resolvedHost = String(
    hostname ||
    (typeof globalThis !== "undefined" && globalThis.location?.hostname) ||
    ""
  ).trim().toLowerCase();

  if (env && env !== "production") return false;
  if (!env && !resolvedHost) return false;
  if (resolvedHost) {
    if (isPrivateOrIpHostname(resolvedHost)) return false;
    if (hasNonProdHostToken(resolvedHost)) return false;
  }
  return true;
}

export function validateRelayUrl(url, { production = false } = {}) {
  if (typeof url !== "string") {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Relay URL must be a string.");
  }
  const trimmed = trimCharacters(url.trim(), "/", { start: false });
  if (!trimmed || new TextEncoder().encode(trimmed).byteLength > NOSTR_MAX_RELAY_URL_BYTES) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Relay URL exceeds 128-byte cap or is empty.");
  }
  if (!trimmed.toLowerCase().startsWith("wss://") || [...trimmed].some(isWhitespace)) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", `Relay URL must use wss:// transport: ${trimmed}`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Malformed relay URL.");
  }
  if (
    parsed.protocol !== "wss:" ||
    !parsed.hostname ||
    !hasOnlyRelayHostChars(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Relay URL contains forbidden protocol or components.");
  }
  if (parsed.port && (!isDecimalDigits(parsed.port) || parsed.port.length < 2 || parsed.port.length > 5)) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Invalid relay URL port.");
  }
  if (production && isPrivateOrIpHostname(parsed.hostname)) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "IP-literal or private relay targets are blocked in production.");
  }
  return trimmed;
}

export function sanitizeRelayList(relays = [], { production = false, strict = false } = {}) {
  const input = Array.isArray(relays) ? relays : [];
  const unique = [];
  const seen = new Set();
  for (const item of input) {
    try {
      const normalized = validateRelayUrl(String(item || ""), { production });
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    } catch (error) {
      if (strict) throw error;
    }
  }
  if (strict && unique.length > NOSTR_MAX_RELAYS) {
    throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", `Relay list exceeds max ${NOSTR_MAX_RELAYS} relays.`);
  }
  return unique.slice(0, NOSTR_MAX_RELAYS);
}

export function assertTrustedSigningOrigin(context = {}) {
  const source = String(context.source || "").trim().toLowerCase();
  if (!source || UNTRUSTED_SOURCES.has(source) || !ALLOWED_SOURCE_SET.has(source)) {
    throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", `Signing source "${source || "missing"}" is not trusted.`);
  }

  if (context.fromPostMessage || context.fromClipboard || context.fromUrlParam || context.isSrcdoc || context.inIframe) {
    throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", "Cross-origin, iframe, URL, or clipboard signing requests are blocked.");
  }

  if (typeof globalThis.window !== "undefined" && context.allowIframeForTest !== true) {
    try {
      if (globalThis.window.self !== globalThis.window.top) {
        throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", "Signing is blocked inside an iframe.");
      }
    } catch (error) {
      if (error?.code === "NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN") throw error;
      throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", "Signing is blocked inside a cross-origin iframe.");
    }
  }

  const origin = String(
    context.origin !== undefined
      ? context.origin
      : (typeof globalThis.location !== "undefined" ? globalThis.location.origin : "")
  ).trim();

  if (origin === "null" || origin.startsWith("about:") || origin.startsWith("javascript:") || origin.startsWith("data:") || origin.startsWith("file:")) {
    throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", `Blocked origin: ${origin}`);
  }

  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", `Malformed origin: ${origin}`);
    }
    if (BLOCKED_ORIGIN_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", `Isolated viewer origin cannot sign: ${parsed.hostname}`);
    }
    if (context.callerOrigin && String(context.callerOrigin).trim() !== origin) {
      throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", "Caller origin does not match active app origin.");
    }
    if (Array.isArray(context.allowedOrigins) && context.allowedOrigins.length > 0 && !context.allowedOrigins.includes(origin)) {
      throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", `Origin not in allowlist: ${origin}`);
    }
  } else if (context.callerOrigin) {
    throw guardError("NOSTR_SIGNING_GUARD_UNTRUSTED_ORIGIN", "Caller origin provided without bound app origin.");
  }
}

export function buildSigningReviewSummary(eventTemplate = {}, context = {}) {
  const kind = eventTemplate?.kind;
  const kindLabel = KIND_LABELS[kind] || `Unknown Event (kind:${String(kind)})`;
  const tags = Array.isArray(eventTemplate?.tags) ? eventTemplate.tags : [];
  const relayUrls = tags
    .filter((tag) => Array.isArray(tag) && (tag[0] === "relay" || tag[0] === "r") && typeof tag[1] === "string")
    .map((tag) => tag[1]);
  const rawContent = typeof eventTemplate?.content === "string" ? eventTemplate.content : "";
  const previewRaw = kind === 13 || kind === 1059
    ? "[Encrypted NIP-17 private message payload]"
    : rawContent.slice(0, 160);
  const warnings = [];
  if (kind === 0) warnings.push("Publishes public profile metadata to Nostr relays.");
  if (kind === 1) warnings.push("Publishes a public message visible on Nostr relays.");
  if (kind === 10050) warnings.push("Updates your public DM relay list.");

  return Object.freeze({
    kind,
    kindLabel,
    actionSummary: `Sign ${kindLabel}`,
    source: String(context.source || ""),
    origin: String(context.origin || (typeof globalThis.location !== "undefined" ? globalThis.location.origin : "") || "local"),
    contentPreview: escapeNostrText(previewRaw),
    contentLength: rawContent.length,
    tagCount: tags.length,
    relayUrls: Object.freeze(relayUrls),
    warnings: Object.freeze(warnings),
    requiresExplicitReview: REVIEW_REQUIRED_KINDS.has(kind) || Boolean(context.requireReview),
  });
}

export function validateNostrEventForSigning(eventTemplate, {
  expectedPubkey = "",
  context = {},
  now = Date.now(),
} = {}) {
  if (!eventTemplate || typeof eventTemplate !== "object" || Array.isArray(eventTemplate)) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Event draft must be an object.");
  }

  assertTrustedSigningOrigin(context);

  if (eventTemplate.sig !== undefined && eventTemplate.sig !== null && eventTemplate.sig !== "") {
    throw guardError("NOSTR_SIGNING_GUARD_EXTERNAL_FIELDS_FORBIDDEN", "External callers must not supply event.sig.");
  }
  if (eventTemplate.id !== undefined && eventTemplate.id !== null && eventTemplate.id !== "") {
    throw guardError("NOSTR_SIGNING_GUARD_EXTERNAL_FIELDS_FORBIDDEN", "External callers must not supply event.id.");
  }
  if (eventTemplate.pubkey !== undefined && eventTemplate.pubkey !== null && eventTemplate.pubkey !== "") {
    if (!expectedPubkey || String(eventTemplate.pubkey).toLowerCase() !== String(expectedPubkey).toLowerCase()) {
      throw guardError("NOSTR_SIGNING_GUARD_EXTERNAL_FIELDS_FORBIDDEN", "Event pubkey does not match local derived key.");
    }
  }

  const { kind, content, tags, created_at: createdAt } = eventTemplate;
  if (!Number.isInteger(kind) || !ALLOWED_KIND_SET.has(kind)) {
    throw guardError("NOSTR_SIGNING_GUARD_KIND_BLOCKED", `Event kind ${String(kind)} is not allowlisted.`);
  }

  if (USER_INITIATED_KINDS.has(kind) && context.source !== "server_bot" && context.userInitiated !== true) {
    throw guardError("NOSTR_SIGNING_GUARD_SILENT_SIGNING_BLOCKED", `Kind ${kind} requires an explicit user action.`);
  }

  const production = isProductionSigningEnvironment({
    environment: context.environment,
    hostname: context.hostname || (context.origin ? new URL(context.origin).hostname : ""),
  });

  if (kind === 0 && !production) {
    throw guardError("NOSTR_SIGNING_GUARD_NONPROD_KIND0_BLOCKED", "Publishing kind:0 profile metadata is blocked on non-production builds.");
  }

  if (typeof content !== "string") {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Event content must be a string.");
  }
  if (content.length > NOSTR_MAX_CONTENT_CHARS) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", `Event content exceeds ${NOSTR_MAX_CONTENT_CHARS} chars.`);
  }
  if (!Array.isArray(tags) || tags.length > NOSTR_MAX_TAGS) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", `Event tags must be an array of at most ${NOSTR_MAX_TAGS} items.`);
  }
  for (const tag of tags) {
    if (!Array.isArray(tag)) {
      throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Each Nostr tag must be an array.");
    }
    for (const item of tag) {
      if (typeof item !== "string" || item.length > NOSTR_MAX_TAG_ELEMENT_CHARS) {
        throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", `Tag element must be a string <= ${NOSTR_MAX_TAG_ELEMENT_CHARS} chars.`);
      }
    }
  }

  const nowSec = Math.floor(Number(now) / 1000);
  if (!Number.isInteger(createdAt) || createdAt < 0) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Event created_at must be a non-negative integer.");
  }
  if (kind === 1059) {
    if (createdAt < nowSec - NIP17_MAX_PAST_SECONDS || createdAt > nowSec + NOSTR_TIMESTAMP_SKEW_SECONDS) {
      throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "NIP-17 gift wrap timestamp is outside the permitted privacy window.");
    }
  } else if (Math.abs(createdAt - nowSec) > NOSTR_TIMESTAMP_SKEW_SECONDS) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Event created_at is outside the permitted +-600s window.");
  }

  if (kind === 10050) {
    const relayTags = tags.filter((tag) => tag[0] === "relay");
    if (relayTags.length === 0 || relayTags.length > NOSTR_MAX_RELAYS) {
      throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", `kind:10050 requires 1..${NOSTR_MAX_RELAYS} relay tags.`);
    }
    const seen = new Set();
    for (const tag of relayTags) {
      const normalized = validateRelayUrl(tag[1], { production });
      if (seen.has(normalized)) {
        throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "Duplicate relay URL in kind:10050.");
      }
      seen.add(normalized);
    }
  }

  if (kind === 22242) {
    const relayTag = tags.find((tag) => tag[0] === "relay");
    const challengeTag = tags.find((tag) => tag[0] === "challenge");
    if (!relayTag?.[1] || !challengeTag?.[1]?.trim()) {
      throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "NIP-42 kind:22242 requires non-empty relay and challenge tags.");
    }
    const normalizedRelay = validateRelayUrl(relayTag[1], { production });
    const allowlist = Array.isArray(context.allowlistedRelays)
      ? context.allowlistedRelays.map((entry) => validateRelayUrl(entry, { production }))
      : [];
    if (!allowlist.length || !allowlist.includes(normalizedRelay)) {
      throw guardError("NOSTR_SIGNING_GUARD_INVALID_RELAY", "NIP-42 relay tag is not in the allowlisted relay set.");
    }
  }

  const review = buildSigningReviewSummary(eventTemplate, context);
  if (review.requiresExplicitReview && context.source !== "server_bot") {
    const approved = typeof context.reviewHandler === "function"
      ? Boolean(context.reviewHandler(review))
      : context.reviewApproved === true;
    if (!approved) {
      throw guardError("NOSTR_SIGNING_GUARD_REVIEW_REJECTED", `Explicit human review approval is required for ${review.kindLabel}.`);
    }
  }

  return { review, production };
}

export function signGuardedNostrEvent({ eventTemplate, privateKey, context = {}, now = Date.now() } = {}) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "A 32-byte local Nostr private key is required.");
  }
  const localPubkey = getPublicKey(privateKey);
  const { review } = validateNostrEventForSigning(eventTemplate, {
    expectedPubkey: localPubkey,
    context,
    now,
  });

  const cleanDraft = {
    kind: eventTemplate.kind,
    created_at: eventTemplate.created_at,
    tags: eventTemplate.tags.map((tag) => [...tag]),
    content: eventTemplate.content,
  };
  const event = finalizeEvent(cleanDraft, privateKey);
  return { event, review };
}

export function assertDirectMessageSigningAllowed({
  senderPubkey = "",
  recipientPubkey = "",
  content = "",
  recipientRelay = "",
  context = {},
} = {}) {
  const effectiveContext = {
    source: "messages_ui",
    userInitiated: true,
    ...context,
  };
  assertTrustedSigningOrigin(effectiveContext);
  if (effectiveContext.userInitiated !== true) {
    throw guardError("NOSTR_SIGNING_GUARD_SILENT_SIGNING_BLOCKED", "Direct message signing requires an explicit user send action.");
  }
  const normalizedRecipient = String(recipientPubkey || "").trim().toLowerCase();
  if (!isLowerHexLength(normalizedRecipient, 64)) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Invalid 64-hex recipient pubkey.");
  }
  const normalizedSender = String(senderPubkey || "").trim().toLowerCase();
  if (normalizedSender && normalizedSender === normalizedRecipient) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Sender and recipient pubkey must differ.");
  }
  const trimmed = String(content || "").trim();
  if (!trimmed || trimmed.length > NOSTR_DM_MAX_CONTENT_CHARS) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", `Direct message must be 1..${NOSTR_DM_MAX_CONTENT_CHARS} characters.`);
  }
  if (recipientRelay) {
    const production = isProductionSigningEnvironment({
      environment: effectiveContext.environment,
      hostname: effectiveContext.hostname || (effectiveContext.origin ? new URL(effectiveContext.origin).hostname : ""),
    });
    validateRelayUrl(recipientRelay, { production });
  }
  return buildSigningReviewSummary(
    { kind: 1059, content: "", tags: [["p", normalizedRecipient]], created_at: Math.floor(Date.now() / 1000) },
    effectiveContext
  );
}

export function verifyInboundNostrEvent(event, { expectedKind = null } = {}) {
  if (!event || typeof event !== "object") {
    throw guardError("NOSTR_INBOUND_EVENT_INVALID", "Missing Nostr event.");
  }
  if (expectedKind !== null && event.kind !== expectedKind) {
    throw guardError("NOSTR_INBOUND_EVENT_INVALID", `Unexpected event kind ${String(event.kind)}.`);
  }
  if (
    !isLowerHexLength(event.id, 64) ||
    !isLowerHexLength(event.pubkey, 64) ||
    !isLowerHexLength(event.sig, 128) ||
    !Number.isInteger(event.created_at) ||
    typeof event.content !== "string" ||
    !Array.isArray(event.tags)
  ) {
    throw guardError("NOSTR_INBOUND_EVENT_INVALID", "Malformed Nostr event envelope.");
  }
  // Construct a fresh object so nostr-tools cannot reuse a cached verification symbol.
  const clean = {
    id: event.id,
    pubkey: event.pubkey,
    sig: event.sig,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  };
  if (getEventHash(clean) !== clean.id || !verifyEvent(clean)) {
    throw guardError("NOSTR_INBOUND_EVENT_INVALID", "Invalid Nostr event hash or Schnorr signature.");
  }
  return clean;
}

export function isChainBadgeValidForEvent({
  identityStatus = "active",
  revokedAtHeight = null,
  eventAnchoredHeight = null,
} = {}) {
  if (identityStatus === "active") return true;
  if (identityStatus !== "revoked" && identityStatus !== "compromised") return false;
  if (!Number.isInteger(revokedAtHeight) || !Number.isInteger(eventAnchoredHeight)) {
    return false;
  }
  return eventAnchoredHeight < revokedAtHeight;
}

export function validateIdentitySetProofPayload({
  op = "",
  chainId = "",
  account = "",
  sequence = -1,
  nostrPubkey = "",
  context = {},
} = {}) {
  const effectiveContext = { source: "identity_ui", userInitiated: true, requireReview: true, ...context };
  assertTrustedSigningOrigin(effectiveContext);
  if (effectiveContext.userInitiated !== true) {
    throw guardError("NOSTR_SIGNING_GUARD_SILENT_SIGNING_BLOCKED", "identity_set proof requires explicit user action.");
  }
  const allowedOps = new Set(["mint", "update", "link", "unlink", "rotate", "rotate_account", "revoke"]);
  if (!allowedOps.has(String(op || ""))) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Unsupported identity_set proof op.");
  }
  if (!String(chainId || "").trim() || !String(account || "").trim() || !Number.isInteger(sequence) || sequence < 0) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "identity_set proof requires chainId, account, and non-negative sequence.");
  }
  if (!isLowerHexLength(String(nostrPubkey || "").toLowerCase(), 64)) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "identity_set proof requires a 64-hex nostrPubkey.");
  }
  return {
    domain: "postfiat-l1-v2/identity-set/v1",
    op,
    chainId: String(chainId).trim(),
    account: String(account).trim(),
    sequence,
    nostrPubkey: String(nostrPubkey).toLowerCase(),
    authorizesFundMovement: false,
  };
}

export function validateHiveMindClaimSignaturePayload({
  company = "",
  claimText = "",
  stance = "",
  checkEvent = "",
  attestationId = "",
  context = {},
} = {}) {
  const effectiveContext = { source: "hive_mind_ui", userInitiated: true, requireReview: true, ...context };
  assertTrustedSigningOrigin(effectiveContext);
  if (effectiveContext.userInitiated !== true) {
    throw guardError("NOSTR_SIGNING_GUARD_SILENT_SIGNING_BLOCKED", "Hive Mind claim signature requires explicit user submission.");
  }
  if (
    !String(company || "").trim() ||
    !String(claimText || "").trim() ||
    !String(stance || "").trim() ||
    !String(checkEvent || "").trim() ||
    !String(attestationId || "").trim()
  ) {
    throw guardError("NOSTR_SIGNING_GUARD_EVENT_INVALID", "Hive Mind claim signature requires company, claimText, stance, checkEvent, and MNPI attestationId.");
  }
  return {
    domain: "postfiat.hive-mind.claim.v1",
    company: String(company).trim(),
    claimText: String(claimText).trim(),
    stance: String(stance).trim(),
    checkEvent: String(checkEvent).trim(),
    attestationId: String(attestationId).trim(),
  };
}
