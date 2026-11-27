// Pillar 1 — Hive Governance Session Engine Core (Contract C1: postfiat.governance.v1)
// Pure, deterministic packet builder, lifecycle state machine, carry-over accountability loader,
// session message/participant auto-snapshotter, two-pass prompt-injection-isolated minutes builder,
// and pf.ptr v5 governance anchor encoder/decoder.
//
// Locked-in design decisions:
// - Trigger: founder-triggered on demand (30-minute default room, extendable or early close).
// - Authority: 1-of-1 founder at launch; threshold-ready signer_set_id + threshold + total_signers.
// - Anchor chain: postfiatl1v2 only via payment_v2 memos carrying pf.ptr v5 (kind = 12 GOVERNANCE).
// - Follow-through: direct carry-over accountability ONLY — strictly NO automatic PFT bounties.
// - Deterministic rulings: ONLY when explicitly flagged by the founder (read-only compute).

import { canonicalJson, sha256HexAsync } from "./canonical-json.js";
import { verifyInboundNostrEvent } from "./nostr-signing-guard.js";

export const GOVERNANCE_SCHEMAS = Object.freeze({
  SNAPSHOT: "pf.governance.snapshot.v1",
  PACKET: "pf.governance.packet.v1",
  TRANSCRIPT: "pf.governance.transcript.v1",
  MINUTES: "pf.governance.minutes.v1",
  RULING: "pf.governance.ruling.v1",
  ELIGIBLE_PUBKEYS: "pf.governance.eligible_pubkeys.v1",
  ENVELOPE: "pf.message.v1",
});

export const GOVERNANCE_CONTENT_KIND = 12;
export const GOVERNANCE_POINTER_PUBLIC_FLAG = 0x02;
export const GOVERNANCE_POINTER_MAX_BYTES = 256;
export const GOVERNANCE_DEFAULT_CHAIN_ID = "postfiat-l1-v2";
export const GOVERNANCE_DEFAULT_DURATION_MINUTES = 30;
export const GOVERNANCE_DEFAULT_RATE_LIMIT_SECONDS = 15;
export const GOVERNANCE_DEFAULT_MAX_NON_FOUNDER_MESSAGES = 10;
export const GOVERNANCE_DEFAULT_MAX_FACILITATOR_TURNS = 25;
export const GOVERNANCE_DEFAULT_RESERVED_FOUNDER_TURNS = 15;
export const AUTO_BOUNTY_GENERATION_ENABLED = false;

export const GOVERNANCE_LIFECYCLE_STATES = Object.freeze([
  "scheduled",
  "live",
  "closing",
  "anchored",
  "archived",
  "aborted",
]);

export const GOVERNANCE_PROTO_STATE_MAP = Object.freeze({
  scheduled: "SESSION_STATE_DRAFT",
  live: "SESSION_STATE_LIVE",
  closing: "SESSION_STATE_IN_REVIEW",
  anchored: "SESSION_STATE_PUBLISHED",
  archived: "SESSION_STATE_PUBLISHED",
  aborted: "SESSION_STATE_ABORTED",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  scheduled: new Set(["live", "aborted"]),
  live: new Set(["closing", "aborted"]),
  closing: new Set(["anchored", "aborted"]),
  anchored: new Set(["archived"]),
  archived: new Set([]),
  aborted: new Set([]),
});

export const DELIVERABLE_STATUSES = Object.freeze([
  "done",
  "in_progress",
  "not_done",
  "dropped",
]);
const DELIVERABLE_STATUS_SET = new Set(DELIVERABLE_STATUSES);

export const POSTING_POLICIES = Object.freeze([
  "founder_only",
  "allowlist",
  "all_members",
]);
const POSTING_POLICY_SET = new Set(POSTING_POLICIES);

export const FACILITATOR_MODES = Object.freeze([
  "off",
  "agenda",
  "interactive",
]);
const FACILITATOR_MODE_SET = new Set(FACILITATOR_MODES);

export const EXCLUSION_REASONS = Object.freeze({
  INVALID_SIGNATURE: "invalid_signature",
  WRONG_ROOM: "wrong_room",
  INELIGIBLE_AUTHOR: "ineligible_author",
  OUTSIDE_WINDOW: "outside_window",
  RATE_LIMITED: "rate_limited",
  ACCOUNT_CAP_EXCEEDED: "account_cap_exceeded",
});

const FORBIDDEN_BOUNTY_KEYS = new Set([
  "auto_bounty",
  "autoBounty",
  "auto_bounties",
  "autoBounties",
  "bounty_pft",
  "bountyPft",
  "pft_bounty",
  "pftBounty",
  "reward_pft",
  "rewardPft",
  "auto_reward",
  "autoReward",
  "bounty_amount",
  "bountyAmount",
]);

const ALLOWED_ATTACHMENT_MIME_PREFIXES = [
  "text/plain",
  "text/markdown",
  "application/json",
];

const HEX_64_REGEX = /^[0-9a-f]{64}$/;

function govError(code, detail = "", status = 400) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  error.status = status;
  return error;
}

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

export function assertNoAutoBountyFields(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertNoAutoBountyFields(item, `${path}[${idx}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_BOUNTY_KEYS.has(key)) {
      throw govError(
        "GOVERNANCE_AUTO_BOUNTIES_FORBIDDEN",
        `Automatic PFT bounty field "${key}" is forbidden at ${path}; governance uses direct carry-over accountability only.`
      );
    }
    assertNoAutoBountyFields(entry, `${path}.${key}`);
  }
}

export function assertGovernanceTransition(fromState, toState) {
  const from = String(fromState || "").trim().toLowerCase();
  const to = String(toState || "").trim().toLowerCase();
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw govError(
      "GOVERNANCE_INVALID_STATE_TRANSITION",
      `Cannot transition governance session from "${from || "unknown"}" to "${to || "unknown"}".`,
      409
    );
  }
  return to;
}

export function normalizeDeliverableItem(item = {}, { originSessionId = "" } = {}) {
  assertNoAutoBountyFields(item, "deliverable");
  const deliverableId = safeText(item.deliverable_id || item.deliverableId || item.id, 120);
  const title = safeText(item.title, 240);
  if (!deliverableId || !title) {
    throw govError("GOVERNANCE_DELIVERABLE_INVALID", "Each deliverable requires deliverable_id and title.");
  }
  const cited = Array.isArray(item.cited_event_ids || item.citedEventIds)
    ? [...new Set((item.cited_event_ids || item.citedEventIds).map((id) => safeText(id, 128).toLowerCase()).filter(Boolean))]
    : [];
  return {
    deliverable_id: deliverableId,
    origin_session_id: safeText(item.origin_session_id || item.originSessionId || originSessionId, 120),
    title,
    description: safeText(item.description, 2000),
    owner: safeText(item.owner, 120),
    target_date: safeText(item.target_date || item.targetDate, 64),
    cited_event_ids: cited,
  };
}

export function loadCarryOverDeliverables(previousSession = null) {
  if (!previousSession || typeof previousSession !== "object") {
    return {
      previous_session_id: "",
      previous_minutes_cid: "",
      carried_deliverables: [],
      auto_bounties_enabled: false,
    };
  }
  assertNoAutoBountyFields(previousSession, "previousSession");
  const prevId = safeText(previousSession.session_id || previousSession.sessionId, 120);
  const prevMinutesCid = safeText(previousSession.minutes_cid || previousSession.minutesCid, 200);
  const minutes = previousSession.minutes_json || previousSession.minutes || {};
  const nextDeliverables = Array.isArray(minutes.next_deliverables)
    ? minutes.next_deliverables
    : Array.isArray(previousSession.open_deliverables)
      ? previousSession.open_deliverables
      : [];
  const reviewedDeliverables = Array.isArray(minutes.previous_deliverables_review)
    ? minutes.previous_deliverables_review
    : [];

  const byId = new Map();
  for (const item of nextDeliverables) {
    const normalized = normalizeDeliverableItem(item, { originSessionId: prevId });
    byId.set(normalized.deliverable_id, normalized);
  }
  // Carry forward still-open items marked in_progress/not_done if not already superseded.
  for (const item of reviewedDeliverables) {
    if (item?.status !== "in_progress" && item?.status !== "not_done") continue;
    const id = safeText(item.deliverable_id || item.deliverableId, 120);
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      deliverable_id: id,
      origin_session_id: safeText(item.origin_session_id || item.originSessionId || prevId, 120),
      title: safeText(item.title, 240) || id,
      description: safeText(item.evidence_note || item.description, 2000),
      owner: safeText(item.owner, 120),
      target_date: safeText(item.target_date, 64),
      cited_event_ids: [],
    });
  }

  return {
    previous_session_id: prevId,
    previous_minutes_cid: prevMinutesCid,
    carried_deliverables: [...byId.values()],
    auto_bounties_enabled: false,
  };
}

export function validateCarryOverScorecard({
  carriedDeliverables = [],
  previousDeliverablesStatus = [],
} = {}) {
  assertNoAutoBountyFields(carriedDeliverables, "carriedDeliverables");
  assertNoAutoBountyFields(previousDeliverablesStatus, "previousDeliverablesStatus");
  const expectedById = new Map();
  for (const item of Array.isArray(carriedDeliverables) ? carriedDeliverables : []) {
    const normalized = normalizeDeliverableItem(item);
    expectedById.set(normalized.deliverable_id, normalized);
  }

  const scored = [];
  const seen = new Set();
  for (const entry of Array.isArray(previousDeliverablesStatus) ? previousDeliverablesStatus : []) {
    const id = safeText(entry?.deliverable_id || entry?.deliverableId, 120);
    const status = safeText(entry?.status, 40).toLowerCase();
    if (!id || !DELIVERABLE_STATUS_SET.has(status)) {
      throw govError(
        "GOVERNANCE_CARRYOVER_STATUS_INVALID",
        `Carry-over item "${id || "missing"}" must have status in [${DELIVERABLE_STATUSES.join(", ")}].`
      );
    }
    if (seen.has(id)) {
      throw govError("GOVERNANCE_CARRYOVER_DUPLICATE", `Duplicate carry-over review entry "${id}".`);
    }
    seen.add(id);
    const expected = expectedById.get(id);
    scored.push({
      deliverable_id: id,
      origin_session_id: safeText(entry.origin_session_id || expected?.origin_session_id, 120),
      title: safeText(entry.title || expected?.title, 240),
      status,
      evidence_note: safeText(entry.evidence_note || entry.evidenceNote, 2000),
      evidence_refs: Array.isArray(entry.evidence_refs || entry.evidenceRefs)
        ? (entry.evidence_refs || entry.evidenceRefs).map((ref) => safeText(ref, 300)).filter(Boolean).slice(0, 16)
        : [],
    });
  }

  for (const id of expectedById.keys()) {
    if (!seen.has(id)) {
      throw govError(
        "GOVERNANCE_CARRYOVER_MISSING_ITEM",
        `Previous session deliverable "${id}" must be explicitly scored (done, in_progress, not_done, or dropped).`
      );
    }
  }
  return scored;
}

export async function buildProtocolSnapshot({
  sessionId = "",
  chainId = GOVERNANCE_DEFAULT_CHAIN_ID,
  finalizedBlockHeight = 0,
  finalizedBlockHash = "",
  capturedAtUnixMs = Date.now(),
  activeValidatorCount = 0,
  bridgeStatusSummary = "",
  navcoinSupplySummary = "",
  cobaltVerdictSummary = "",
  tasknodeHealthSummary = "",
  previousSessionId = "",
  previousMinutesCid = "",
  carriedDeliverables = [],
  sources = [],
} = {}) {
  const normalizedSessionId = safeText(sessionId, 120);
  if (!normalizedSessionId) throw govError("GOVERNANCE_SESSION_ID_REQUIRED", "sessionId is required.");
  const height = Number(finalizedBlockHeight);
  if (!Number.isSafeInteger(height) || height < 0) {
    throw govError("GOVERNANCE_SNAPSHOT_HEIGHT_INVALID", "finalizedBlockHeight must be a non-negative integer.");
  }

  const normalizedSources = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    const sourceId = safeText(src?.source_id || src?.sourceId, 120);
    const endpoint = safeText(src?.endpoint, 300);
    const srcHeight = src?.block_height !== undefined ? Number(src.block_height) : height;
    const isL1Source = src?.is_l1 !== false && sourceId.startsWith("l1_");
    if (isL1Source && srcHeight !== height) {
      throw govError(
        "GOVERNANCE_SNAPSHOT_TORN_READ",
        `L1 snapshot source "${sourceId}" height ${srcHeight} does not match pinned finalized height ${height}.`
      );
    }
    let rawSha256 = safeText(src?.raw_response_sha256 || src?.rawResponseSha256, 64).toLowerCase();
    if (!rawSha256 && src?.raw_response !== undefined) {
      rawSha256 = await sha256HexAsync(
        typeof src.raw_response === "string" ? src.raw_response : canonicalJson(src.raw_response)
      );
    }
    if (!HEX_64_REGEX.test(rawSha256)) {
      throw govError("GOVERNANCE_SNAPSHOT_SOURCE_HASH_INVALID", `Source "${sourceId}" requires a 64-hex raw_response_sha256.`);
    }
    normalizedSources.push({
      source_id: sourceId,
      endpoint,
      block_height: srcHeight,
      captured_at_unix_ms: Number(src?.captured_at_unix_ms || capturedAtUnixMs),
      raw_response_sha256: rawSha256,
      raw_response_cid: safeText(src?.raw_response_cid || src?.rawResponseCid, 200),
    });
  }

  const normalizedCarried = (Array.isArray(carriedDeliverables) ? carriedDeliverables : []).map((item) =>
    normalizeDeliverableItem(item, { originSessionId: previousSessionId })
  );

  const snapshot = {
    schema: GOVERNANCE_SCHEMAS.SNAPSHOT,
    schema_version: 1,
    session_id: normalizedSessionId,
    chain_id: safeText(chainId, 80) || GOVERNANCE_DEFAULT_CHAIN_ID,
    finalized_block_height: height,
    finalized_block_hash: safeText(finalizedBlockHash, 128).toLowerCase(),
    captured_at_unix_ms: Math.trunc(Number(capturedAtUnixMs)),
    active_validator_count: Math.max(0, Math.trunc(Number(activeValidatorCount) || 0)),
    bridge_status_summary: safeText(bridgeStatusSummary, 1000),
    navcoin_supply_summary: safeText(navcoinSupplySummary, 1000),
    cobalt_verdict_summary: safeText(cobaltVerdictSummary, 1000),
    tasknode_health_summary: safeText(tasknodeHealthSummary, 1000),
    previous_session_id: safeText(previousSessionId, 120),
    previous_minutes_cid: safeText(previousMinutesCid, 200),
    carried_deliverables: normalizedCarried,
    sources: normalizedSources,
  };
  const canonical = canonicalJson(snapshot);
  const sha256 = await sha256HexAsync(canonical);
  return { snapshot, canonical, sha256 };
}

export async function buildEligiblePubkeysSnapshot({
  sessionId = "",
  channelId = "",
  postingPolicy = "all_members",
  founderPubkey = "",
  facilitatorPubkey = "",
  eligibleMembers = [],
  capturedAtUnixMs = Date.now(),
} = {}) {
  const normalizedPolicy = safeText(postingPolicy, 40).toLowerCase();
  if (!POSTING_POLICY_SET.has(normalizedPolicy)) {
    throw govError("GOVERNANCE_POSTING_POLICY_INVALID", `Unsupported posting policy "${postingPolicy}".`);
  }
  const normalizedFounder = safeText(founderPubkey, 64).toLowerCase();
  if (!HEX_64_REGEX.test(normalizedFounder)) {
    throw govError("GOVERNANCE_FOUNDER_PUBKEY_INVALID", "founderPubkey must be 64 lowercase hex characters.");
  }
  const normalizedFacilitator = safeText(facilitatorPubkey, 64).toLowerCase();
  if (normalizedFacilitator && !HEX_64_REGEX.test(normalizedFacilitator)) {
    throw govError("GOVERNANCE_FACILITATOR_PUBKEY_INVALID", "facilitatorPubkey must be 64 lowercase hex characters.");
  }

  const byPubkey = new Map();
  byPubkey.set(normalizedFounder, { pubkey: normalizedFounder, role: "founder", handle: "" });
  if (normalizedFacilitator && normalizedFacilitator !== normalizedFounder) {
    byPubkey.set(normalizedFacilitator, { pubkey: normalizedFacilitator, role: "facilitator", handle: "" });
  }

  if (normalizedPolicy !== "founder_only") {
    for (const member of Array.isArray(eligibleMembers) ? eligibleMembers : []) {
      const pubkey = safeText(typeof member === "string" ? member : member?.pubkey, 64).toLowerCase();
      if (!HEX_64_REGEX.test(pubkey)) continue;
      if (byPubkey.has(pubkey)) {
        const existing = byPubkey.get(pubkey);
        if (typeof member === "object" && member?.handle && !existing.handle) {
          existing.handle = safeText(member.handle, 80);
        }
        continue;
      }
      byPubkey.set(pubkey, {
        pubkey,
        role: "community",
        handle: safeText(typeof member === "object" ? member?.handle : "", 80),
      });
    }
  }

  const entries = [...byPubkey.values()].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const payload = {
    schema: GOVERNANCE_SCHEMAS.ELIGIBLE_PUBKEYS,
    schema_version: 1,
    session_id: safeText(sessionId, 120),
    channel_id: safeText(channelId, 80),
    posting_policy: normalizedPolicy,
    captured_at_unix_ms: Math.trunc(Number(capturedAtUnixMs)),
    pubkeys: entries,
  };
  const canonical = canonicalJson(payload);
  const sha256 = await sha256HexAsync(canonical);
  return { payload, canonical, sha256 };
}

export async function buildGovernancePacket({
  sessionId = "",
  chainId = GOVERNANCE_DEFAULT_CHAIN_ID,
  sessionNumber = 1,
  title = "",
  summary = "",
  authority = {},
  snapshot = null,
  snapshotCid = "",
  snapshotSha256 = "",
  previousDeliverablesStatus = [],
  openQuestions = [],
  proposedDecisions = [],
  attachments = [],
  sessionConfig = {},
  createdAtUnixMs = Date.now(),
} = {}) {
  assertNoAutoBountyFields(
    { previousDeliverablesStatus, proposedDecisions, summary, title, sessionConfig },
    "governancePacket"
  );
  const normalizedSessionId = safeText(sessionId, 120);
  const normalizedTitle = safeText(title, 240);
  if (!normalizedSessionId || !normalizedTitle) {
    throw govError("GOVERNANCE_PACKET_INVALID", "sessionId and title are required.");
  }
  const num = Number(sessionNumber);
  if (!Number.isSafeInteger(num) || num < 1) {
    throw govError("GOVERNANCE_PACKET_INVALID", "sessionNumber must be a positive integer.");
  }

  const authorizedAccounts = Array.isArray(authority.authorized_accounts || authority.authorizedAccounts)
    ? (authority.authorized_accounts || authority.authorizedAccounts).map((addr) => safeText(addr, 128)).filter(Boolean)
    : [];
  const founderNostrPubkey = safeText(authority.founder_nostr_pubkey || authority.founderNostrPubkey, 64).toLowerCase();
  const threshold = Math.max(1, Math.trunc(Number(authority.threshold || 1)));
  const totalSigners = Math.max(threshold, Math.trunc(Number(authority.total_signers || authority.totalSigners || authorizedAccounts.length || 1)));
  if (!authorizedAccounts.length || !HEX_64_REGEX.test(founderNostrPubkey)) {
    throw govError("GOVERNANCE_AUTHORITY_INVALID", "AuthorityBinding requires authorized_accounts and 64-hex founder_nostr_pubkey.");
  }

  const resolvedSnapshotSha = safeText(snapshotSha256, 64).toLowerCase()
    || (snapshot ? await sha256HexAsync(canonicalJson(snapshot)) : "");
  if (!HEX_64_REGEX.test(resolvedSnapshotSha)) {
    throw govError("GOVERNANCE_SNAPSHOT_HASH_REQUIRED", "Valid 64-hex snapshot_sha256 is required.");
  }

  const carried = Array.isArray(snapshot?.carried_deliverables) ? snapshot.carried_deliverables : [];
  const validatedCarryOver = validateCarryOverScorecard({
    carriedDeliverables: carried,
    previousDeliverablesStatus,
  });

  const normalizedDecisions = (Array.isArray(proposedDecisions) ? proposedDecisions : []).map((dec, idx) => {
    assertNoAutoBountyFields(dec, `proposed_decisions[${idx}]`);
    const decisionId = safeText(dec?.decision_id || dec?.decisionId || `dec-${idx + 1}`, 80);
    const decTitle = safeText(dec?.title, 240);
    if (!decTitle) throw govError("GOVERNANCE_DECISION_INVALID", "Each proposed decision requires a title.");
    return {
      decision_id: decisionId,
      title: decTitle,
      summary: safeText(dec?.summary, 2000),
      run_deterministic_ruling: dec?.run_deterministic_ruling === true,
    };
  });

  const normalizedAttachments = (Array.isArray(attachments) ? attachments : []).map((att) => {
    const cid = safeText(typeof att === "string" ? att : att?.cid, 200);
    const mimeType = safeText(typeof att === "object" ? att?.mime_type || att?.mimeType : "text/markdown", 100).toLowerCase();
    if (!cid) throw govError("GOVERNANCE_ATTACHMENT_INVALID", "Attachment CID is required.");
    if (!ALLOWED_ATTACHMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
      throw govError("GOVERNANCE_ATTACHMENT_TYPE_FORBIDDEN", `Only text/Markdown/JSON attachments are allowed, got "${mimeType}".`);
    }
    return { cid, mime_type: mimeType };
  });

  const postingPolicy = safeText(sessionConfig.posting_policy || sessionConfig.postingPolicy || "all_members", 40).toLowerCase();
  if (!POSTING_POLICY_SET.has(postingPolicy)) {
    throw govError("GOVERNANCE_POSTING_POLICY_INVALID", `Unsupported posting_policy "${postingPolicy}".`);
  }
  const facilitatorMode = safeText(sessionConfig.facilitator_mode || sessionConfig.facilitatorMode || "agenda", 40).toLowerCase();
  if (!FACILITATOR_MODE_SET.has(facilitatorMode)) {
    throw govError("GOVERNANCE_FACILITATOR_MODE_INVALID", `Unsupported facilitator_mode "${facilitatorMode}".`);
  }
  const eligiblePubkeysSha = safeText(sessionConfig.eligible_pubkeys_sha256 || sessionConfig.eligiblePubkeysSha256, 64).toLowerCase();
  const eligiblePubkeysCid = safeText(sessionConfig.eligible_pubkeys_cid || sessionConfig.eligiblePubkeysCid, 200);
  if (postingPolicy !== "founder_only" && !HEX_64_REGEX.test(eligiblePubkeysSha)) {
    throw govError(
      "GOVERNANCE_ELIGIBLE_PUBKEYS_REQUIRED",
      "eligible_pubkeys_sha256 is required when posting_policy is allowlist or all_members."
    );
  }

  const maxFacilitatorTurns = Math.min(50, Math.max(0, Math.trunc(Number(sessionConfig.max_facilitator_turns ?? GOVERNANCE_DEFAULT_MAX_FACILITATOR_TURNS))));
  const reservedFounderTurns = Math.min(maxFacilitatorTurns, Math.max(0, Math.trunc(Number(sessionConfig.reserved_founder_turns ?? GOVERNANCE_DEFAULT_RESERVED_FOUNDER_TURNS))));

  const packet = {
    schema: GOVERNANCE_SCHEMAS.PACKET,
    schema_version: 1,
    session_id: normalizedSessionId,
    chain_id: safeText(chainId, 80) || GOVERNANCE_DEFAULT_CHAIN_ID,
    session_number: num,
    title: normalizedTitle,
    summary: safeText(summary, 8000),
    authority: {
      signer_set_id: safeText(authority.signer_set_id || authority.signerSetId || "founder-1of1-v1", 120),
      threshold,
      total_signers: totalSigners,
      authorized_accounts: authorizedAccounts,
      founder_nostr_pubkey: founderNostrPubkey,
      identity_handle: safeText(authority.identity_handle || authority.identityHandle, 120),
    },
    snapshot_cid: safeText(snapshotCid, 200),
    snapshot_sha256: resolvedSnapshotSha,
    previous_deliverables_status: validatedCarryOver,
    open_questions: (Array.isArray(openQuestions) ? openQuestions : []).map((q) => safeText(q, 500)).filter(Boolean).slice(0, 32),
    proposed_decisions: normalizedDecisions,
    attachments: normalizedAttachments,
    session_config: {
      channel_id: safeText(sessionConfig.channel_id || sessionConfig.channelId, 80),
      posting_policy: postingPolicy,
      facilitator_mode: facilitatorMode,
      duration_minutes: Math.min(240, Math.max(5, Math.trunc(Number(sessionConfig.duration_minutes ?? GOVERNANCE_DEFAULT_DURATION_MINUTES)))),
      rate_limit_seconds: Math.min(300, Math.max(1, Math.trunc(Number(sessionConfig.rate_limit_seconds ?? GOVERNANCE_DEFAULT_RATE_LIMIT_SECONDS)))),
      max_non_founder_messages: Math.min(100, Math.max(1, Math.trunc(Number(sessionConfig.max_non_founder_messages ?? GOVERNANCE_DEFAULT_MAX_NON_FOUNDER_MESSAGES)))),
      max_facilitator_turns: maxFacilitatorTurns,
      reserved_founder_turns: reservedFounderTurns,
      eligible_pubkeys_cid: eligiblePubkeysCid,
      eligible_pubkeys_sha256: eligiblePubkeysSha,
    },
    auto_bounties_enabled: false,
    created_at_unix_ms: Math.trunc(Number(createdAtUnixMs)),
  };
  const canonical = canonicalJson(packet);
  const sha256 = await sha256HexAsync(canonical);
  return { packet, canonical, sha256 };
}

export async function freezeSessionTranscript({
  sessionId = "",
  channelId = "",
  rootEventId = "",
  openingPacketCid = "",
  eligiblePubkeysSnapshot = null,
  eligiblePubkeysCid = "",
  founderPubkey = "",
  facilitatorPubkey = "",
  postingPolicy = "all_members",
  openedAtUnixMs = 0,
  frozenAtUnixMs = Date.now(),
  rateLimitSeconds = GOVERNANCE_DEFAULT_RATE_LIMIT_SECONDS,
  maxNonFounderMessages = GOVERNANCE_DEFAULT_MAX_NON_FOUNDER_MESSAGES,
  observedEvents = [],
} = {}) {
  const normalizedRootId = safeText(rootEventId, 64).toLowerCase();
  const normalizedFounder = safeText(founderPubkey, 64).toLowerCase();
  const normalizedFacilitator = safeText(facilitatorPubkey, 64).toLowerCase();
  if (!HEX_64_REGEX.test(normalizedRootId)) {
    throw govError("GOVERNANCE_TRANSCRIPT_INVALID", "rootEventId must be 64 lowercase hex characters.");
  }
  const eligibleMap = new Map();
  if (Array.isArray(eligiblePubkeysSnapshot?.pubkeys)) {
    for (const item of eligiblePubkeysSnapshot.pubkeys) {
      if (item?.pubkey) eligibleMap.set(String(item.pubkey).toLowerCase(), item);
    }
  }
  if (normalizedFounder) eligibleMap.set(normalizedFounder, { pubkey: normalizedFounder, role: "founder" });
  if (normalizedFacilitator) eligibleMap.set(normalizedFacilitator, { pubkey: normalizedFacilitator, role: "facilitator" });

  // Order strictly by Task Node server receipt sequence (never client created_at).
  const ordered = [...(Array.isArray(observedEvents) ? observedEvents : [])].sort((a, b) => {
    const seqDiff = Number(a?.receipt_seq || 0) - Number(b?.receipt_seq || 0);
    if (seqDiff !== 0) return seqDiff;
    const tsDiff = Number(a?.server_received_at_unix_ms || 0) - Number(b?.server_received_at_unix_ms || 0);
    if (tsDiff !== 0) return tsDiff;
    return String(a?.event?.id || "").localeCompare(String(b?.event?.id || ""));
  });

  const includedEntries = [];
  const excludedEvents = [];
  const rawEventsById = {};
  const participantStats = new Map();
  const lastAcceptedMsByPubkey = new Map();
  const acceptedCountByPubkey = new Map();
  const seenEventIds = new Set();

  const touchParticipant = (pubkey, role, included, receiptSeq) => {
    if (!pubkey) return;
    const current = participantStats.get(pubkey) || {
      pubkey,
      role,
      handle: eligibleMap.get(pubkey)?.handle || "",
      included_count: 0,
      excluded_count: 0,
      first_receipt_seq: null,
      last_receipt_seq: null,
    };
    if (included) {
      current.included_count += 1;
      if (current.first_receipt_seq === null) current.first_receipt_seq = receiptSeq;
      current.last_receipt_seq = receiptSeq;
    } else {
      current.excluded_count += 1;
    }
    participantStats.set(pubkey, current);
  };

  let nextSeq = 0;
  for (const obs of ordered) {
    const rawEvent = obs?.event || obs;
    const eventId = safeText(rawEvent?.id, 64).toLowerCase();
    const authorPubkey = safeText(rawEvent?.pubkey, 64).toLowerCase();
    if (eventId && seenEventIds.has(eventId)) continue;
    if (eventId) seenEventIds.add(eventId);

    const role = authorPubkey === normalizedFounder
      ? "founder"
      : authorPubkey === normalizedFacilitator
        ? "facilitator"
        : "community";

    const reject = (reason, detail) => {
      excludedEvents.push({
        nostr_event_id: eventId,
        author_pubkey: authorPubkey,
        reason,
        detail,
      });
      touchParticipant(authorPubkey, role, false, null);
    };

    // 1. Valid Nostr signature & hash.
    let verified;
    try {
      verified = verifyInboundNostrEvent(rawEvent, { expectedKind: 1 });
    } catch {
      reject(EXCLUSION_REASONS.INVALID_SIGNATURE, "Nostr event id or Schnorr signature failed verification.");
      continue;
    }

    // 2. Targets the session room root event.
    const roots = verified.tags.filter((tag) => Array.isArray(tag) && tag[0] === "e" && tag[3] === "root");
    if (roots.length !== 1 || roots[0][1] !== normalizedRootId) {
      reject(EXCLUSION_REASONS.WRONG_ROOM, "Event does not target the governance session root event.");
      continue;
    }

    // 3. Author eligibility per pinned eligible-pubkey snapshot & posting policy.
    const isEligible = postingPolicy === "founder_only"
      ? (role === "founder" || role === "facilitator")
      : eligibleMap.has(authorPubkey);
    if (!isEligible) {
      reject(EXCLUSION_REASONS.INELIGIBLE_AUTHOR, "Author is not in the session-open eligible pubkey snapshot.");
      continue;
    }

    // 4. Server receipt window check [openedAtUnixMs, frozenAtUnixMs].
    const receivedMs = Number(obs?.server_received_at_unix_ms ?? (verified.created_at * 1000));
    if (!Number.isFinite(receivedMs) || receivedMs < openedAtUnixMs || receivedMs > frozenAtUnixMs) {
      reject(EXCLUSION_REASONS.OUTSIDE_WINDOW, "Event was not received within the live governance window.");
      continue;
    }

    // 5. Anti-spam rate limit & per-account cap for non-founder/non-facilitator accounts.
    if (role === "community") {
      const priorCount = acceptedCountByPubkey.get(authorPubkey) || 0;
      if (priorCount >= maxNonFounderMessages) {
        reject(EXCLUSION_REASONS.ACCOUNT_CAP_EXCEEDED, `Exceeded max ${maxNonFounderMessages} messages per session.`);
        continue;
      }
      const lastMs = lastAcceptedMsByPubkey.get(authorPubkey);
      if (lastMs !== undefined && receivedMs - lastMs < rateLimitSeconds * 1000) {
        reject(EXCLUSION_REASONS.RATE_LIMITED, `Rate limited (${rateLimitSeconds}s between messages).`);
        continue;
      }
      acceptedCountByPubkey.set(authorPubkey, priorCount + 1);
      lastAcceptedMsByPubkey.set(authorPubkey, receivedMs);
    }

    const receiptSeq = Number.isSafeInteger(Number(obs?.receipt_seq)) && Number(obs.receipt_seq) > nextSeq
      ? Number(obs.receipt_seq)
      : nextSeq + 1;
    nextSeq = receiptSeq;

    const rawCanonical = canonicalJson(verified);
    const rawSha256 = await sha256HexAsync(rawCanonical);
    rawEventsById[verified.id] = verified;
    includedEntries.push({
      receipt_seq: receiptSeq,
      nostr_event_id: verified.id,
      author_pubkey: verified.pubkey,
      author_role: role,
      event_created_at_unix_s: verified.created_at,
      server_received_at_unix_ms: Math.trunc(receivedMs),
      raw_event_sha256: rawSha256,
      raw_event_cid: safeText(obs?.raw_event_cid || "", 200),
    });
    touchParticipant(verified.pubkey, role, true, receiptSeq);
  }

  const rootTuples = includedEntries.map((entry) => [
    entry.receipt_seq,
    entry.nostr_event_id,
    entry.raw_event_sha256,
  ]);
  const transcriptRootSha256 = await sha256HexAsync(canonicalJson(rootTuples));

  const participants = [...participantStats.values()].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const markdownLines = [
    `# Governance Session Transcript — ${safeText(sessionId, 120)}`,
    "",
    `- Channel: \`${safeText(channelId, 80)}\``,
    `- Root Event: \`${normalizedRootId}\``,
    `- Opened: ${new Date(openedAtUnixMs).toISOString()}`,
    `- Frozen: ${new Date(frozenAtUnixMs).toISOString()}`,
    `- Included Messages: ${includedEntries.length}`,
    `- Excluded Events: ${excludedEvents.length}`,
    `- Transcript Root SHA-256: \`${transcriptRootSha256}\``,
    "",
    "## Messages",
    "",
  ];
  for (const entry of includedEntries) {
    const raw = rawEventsById[entry.nostr_event_id];
    const ts = new Date(entry.server_received_at_unix_ms).toISOString();
    markdownLines.push(`### #${entry.receipt_seq} · ${entry.author_role} (\`${entry.author_pubkey.slice(0, 12)}…\`) · ${ts}`);
    markdownLines.push("");
    markdownLines.push(raw.content);
    markdownLines.push("");
  }
  const markdown = markdownLines.join("\n");

  const transcript = {
    schema: GOVERNANCE_SCHEMAS.TRANSCRIPT,
    schema_version: 1,
    session_id: safeText(sessionId, 120),
    channel_id: safeText(channelId, 80),
    root_event_id: normalizedRootId,
    opening_packet_cid: safeText(openingPacketCid, 200),
    eligible_pubkeys_cid: safeText(eligiblePubkeysCid, 200),
    opened_at_unix_ms: Math.trunc(Number(openedAtUnixMs)),
    frozen_at_unix_ms: Math.trunc(Number(frozenAtUnixMs)),
    included_entries: includedEntries,
    excluded_events: excludedEvents,
    participants,
    markdown_transcript_cid: "",
    transcript_root_sha256: transcriptRootSha256,
  };
  const canonical = canonicalJson(transcript);
  const sha256 = await sha256HexAsync(canonical);
  return {
    transcript,
    participants,
    markdown,
    rawEventsById,
    canonical,
    sha256,
  };
}

export async function buildGovernanceMinutes({
  sessionId = "",
  revision = 1,
  state = "closing",
  authority = {},
  openingPacketCid = "",
  transcript = null,
  transcriptCid = "",
  summary = "",
  previousDeliverablesReview = [],
  decisions = [],
  nextDeliverables = [],
  communityInput = [],
  approvals = [],
  finalizedAtUnixMs = Date.now(),
} = {}) {
  assertNoAutoBountyFields(
    { previousDeliverablesReview, decisions, nextDeliverables, communityInput, summary },
    "governanceMinutes"
  );
  if (!transcript || typeof transcript !== "object" || !HEX_64_REGEX.test(String(transcript.transcript_root_sha256 || ""))) {
    throw govError("GOVERNANCE_TRANSCRIPT_REQUIRED", "A frozen transcript with transcript_root_sha256 is required.");
  }

  const roleByEventId = new Map();
  for (const entry of Array.isArray(transcript.included_entries) ? transcript.included_entries : []) {
    roleByEventId.set(entry.nostr_event_id, entry.author_role);
  }

  // Structural prompt-injection boundary (Pass 1):
  // Decisions and next deliverables MUST ONLY cite founder or facilitator messages — NEVER community events.
  const assertPass1Citations = (eventIds = [], label = "") => {
    const normalized = [];
    for (const rawId of Array.isArray(eventIds) ? eventIds : []) {
      const id = safeText(rawId, 64).toLowerCase();
      if (!id) continue;
      const role = roleByEventId.get(id);
      if (!role) {
        throw govError("GOVERNANCE_MINUTES_UNKNOWN_CITATION", `${label} cites event "${id}" not present in frozen transcript.`);
      }
      if (role === "community") {
        throw govError(
          "GOVERNANCE_PROMPT_INJECTION_CITATION_VIOLATION",
          `Pass 1 ${label} cannot cite community event "${id}"; community messages are isolated to Pass 2.`
        );
      }
      normalized.push(id);
    }
    return [...new Set(normalized)];
  };

  const normalizedDecisions = (Array.isArray(decisions) ? decisions : []).map((dec, idx) => {
    const decisionId = safeText(dec?.decision_id || dec?.decisionId || `dec-${idx + 1}`, 80);
    const title = safeText(dec?.title, 240);
    const resolution = safeText(dec?.resolution, 4000);
    if (!title || !resolution) {
      throw govError("GOVERNANCE_MINUTES_DECISION_INVALID", `Decision "${decisionId}" requires title and resolution.`);
    }
    return {
      decision_id: decisionId,
      title,
      resolution,
      cited_event_ids: assertPass1Citations(dec?.cited_event_ids || dec?.citedEventIds, `decision:${decisionId}`),
      run_deterministic_ruling: dec?.run_deterministic_ruling === true,
    };
  });

  const normalizedNextDeliverables = (Array.isArray(nextDeliverables) ? nextDeliverables : []).map((item) => {
    const normalized = normalizeDeliverableItem(item, { originSessionId: sessionId });
    normalized.cited_event_ids = assertPass1Citations(normalized.cited_event_ids, `deliverable:${normalized.deliverable_id}`);
    return normalized;
  });

  // Pass 2: community messages summarized strictly as quoted data.
  const normalizedCommunity = (Array.isArray(communityInput) ? communityInput : []).map((item, idx) => {
    const cited = [];
    for (const rawId of Array.isArray(item?.cited_event_ids || item?.citedEventIds) ? (item.cited_event_ids || item.citedEventIds) : []) {
      const id = safeText(rawId, 64).toLowerCase();
      if (roleByEventId.has(id)) cited.push(id);
    }
    return {
      topic: safeText(item?.topic || `Community Input ${idx + 1}`, 240),
      summary: safeText(item?.summary, 4000),
      cited_event_ids: [...new Set(cited)],
    };
  });

  const validatedReview = validateCarryOverScorecard({
    carriedDeliverables: [],
    previousDeliverablesStatus: previousDeliverablesReview,
  });

  const normalizedApprovals = (Array.isArray(approvals) ? approvals : []).map((sig) => ({
    signer_account: safeText(sig?.signer_account || sig?.signerAccount, 128),
    signature_algorithm: safeText(sig?.signature_algorithm || sig?.signatureAlgorithm || "ML_DSA_65", 64),
    signer_pubkey: safeText(sig?.signer_pubkey || sig?.signerPubkey, 8192),
    signature: safeText(sig?.signature, 16384),
    signed_at_unix_ms: Math.trunc(Number(sig?.signed_at_unix_ms || sig?.signedAtUnixMs || finalizedAtUnixMs)),
  }));

  const minutes = {
    schema: GOVERNANCE_SCHEMAS.MINUTES,
    schema_version: 1,
    session_id: safeText(sessionId, 120),
    revision: Math.max(1, Math.trunc(Number(revision) || 1)),
    state: safeText(state, 40).toLowerCase(),
    proto_state: GOVERNANCE_PROTO_STATE_MAP[safeText(state, 40).toLowerCase()] || "SESSION_STATE_IN_REVIEW",
    authority: {
      signer_set_id: safeText(authority.signer_set_id || "founder-1of1-v1", 120),
      threshold: Math.max(1, Math.trunc(Number(authority.threshold || 1))),
      total_signers: Math.max(1, Math.trunc(Number(authority.total_signers || 1))),
      authorized_accounts: Array.isArray(authority.authorized_accounts) ? authority.authorized_accounts : [],
      founder_nostr_pubkey: safeText(authority.founder_nostr_pubkey, 64).toLowerCase(),
      identity_handle: safeText(authority.identity_handle, 120),
    },
    opening_packet_cid: safeText(openingPacketCid, 200),
    transcript_cid: safeText(transcriptCid, 200),
    transcript_root_sha256: transcript.transcript_root_sha256,
    summary: safeText(summary, 8000),
    previous_deliverables_review: validatedReview,
    decisions: normalizedDecisions,
    next_deliverables: normalizedNextDeliverables,
    community_input: normalizedCommunity,
    approvals: normalizedApprovals,
    auto_bounties_enabled: false,
    finalized_at_unix_ms: Math.trunc(Number(finalizedAtUnixMs)),
  };
  const canonical = canonicalJson(minutes);
  const sha256 = await sha256HexAsync(canonical);
  return { minutes, canonical, sha256 };
}

export async function buildGovernanceEnvelope({
  schema = "",
  payload = {},
  sender = "",
  sessionId = "",
  timestampUnixMs = Date.now(),
} = {}) {
  const canonical = canonicalJson(payload);
  const contentSha256 = await sha256HexAsync(canonical);
  const envelope = {
    schema: GOVERNANCE_SCHEMAS.ENVELOPE,
    schema_version: 1,
    body_encoding: "BODY_ENCODING_CANONICAL_JSON",
    content_kind: GOVERNANCE_CONTENT_KIND,
    flags: GOVERNANCE_POINTER_PUBLIC_FLAG,
    payload_schema: safeText(schema || payload?.schema, 120),
    session_id: safeText(sessionId || payload?.session_id, 120),
    sender: safeText(sender, 128),
    timestamp_unix_ms: Math.trunc(Number(timestampUnixMs)),
    content_sha256: contentSha256,
    body_json: payload,
  };
  return {
    envelope,
    canonical: canonicalJson(envelope),
    contentSha256,
    envelopeSha256: await sha256HexAsync(canonicalJson(envelope)),
  };
}

// Compact pf.ptr v5 protobuf-wire encoder/decoder for postfiatl1v2 payment_v2 memos (<= 256 bytes).
// Field numbers match postfiat.message.v1.Pointer:
//   1: version (varint = 5)
//   2: cid_str / cid_bin (length-delimited UTF-8 CID or raw bytes)
//   3: kind (varint = 12 GOVERNANCE)
//   4: schema (varint = 1)
//   6: thread_id (length-delimited = session_id)
//   8: flags (varint = 0x02 PUBLIC)
function encodeVarint(value) {
  let n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw govError("GOVERNANCE_POINTER_INVALID", "Invalid varint.");
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function decodeVarint(bytes, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: pos };
    shift += 7;
    if (shift > 35) throw govError("GOVERNANCE_POINTER_INVALID", "Varint overflow.");
  }
  throw govError("GOVERNANCE_POINTER_INVALID", "Truncated varint.");
}

export function encodeGovernancePointerV5({
  cid = "",
  sessionId = "",
  schemaVersion = 1,
  flags = GOVERNANCE_POINTER_PUBLIC_FLAG,
} = {}) {
  const normalizedCid = safeText(cid, 128);
  const normalizedSessionId = safeText(sessionId, 96);
  if (!normalizedCid || !normalizedSessionId) {
    throw govError("GOVERNANCE_POINTER_INVALID", "cid and sessionId are required for pf.ptr v5 governance anchor.");
  }
  const enc = new TextEncoder();
  const cidBytes = Array.from(enc.encode(normalizedCid));
  const threadBytes = Array.from(enc.encode(normalizedSessionId));
  const bytes = [
    ...encodeVarint((1 << 3) | 0), ...encodeVarint(5),
    ...encodeVarint((2 << 3) | 2), ...encodeVarint(cidBytes.length), ...cidBytes,
    ...encodeVarint((3 << 3) | 0), ...encodeVarint(GOVERNANCE_CONTENT_KIND),
    ...encodeVarint((4 << 3) | 0), ...encodeVarint(schemaVersion),
    ...encodeVarint((6 << 3) | 2), ...encodeVarint(threadBytes.length), ...threadBytes,
    ...encodeVarint((8 << 3) | 0), ...encodeVarint(flags),
  ];
  if (bytes.length > GOVERNANCE_POINTER_MAX_BYTES) {
    throw govError("GOVERNANCE_POINTER_TOO_LARGE", `pf.ptr v5 memo (${bytes.length}B) exceeds 256-byte cap.`);
  }
  const memoHex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    memo_type: "pf.ptr",
    memo_format: "v5",
    kind: GOVERNANCE_CONTENT_KIND,
    flags,
    thread_id: normalizedSessionId,
    cid: normalizedCid,
    byte_length: bytes.length,
    memo_hex: memoHex,
  };
}

export function decodeGovernancePointerV5(memoHex = "") {
  const clean = String(memoHex || "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw govError("GOVERNANCE_POINTER_INVALID", "memoHex must be valid hex.");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.length > GOVERNANCE_POINTER_MAX_BYTES) {
    throw govError("GOVERNANCE_POINTER_TOO_LARGE", "pf.ptr v5 memo exceeds 256-byte cap.");
  }
  const dec = new TextDecoder();
  const out = { version: 0, cid: "", kind: 0, schemaVersion: 0, threadId: "", flags: 0 };
  let offset = 0;
  while (offset < bytes.length) {
    const key = decodeVarint(bytes, offset);
    offset = key.offset;
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0x7;
    if (wireType === 0) {
      const val = decodeVarint(bytes, offset);
      offset = val.offset;
      if (fieldNumber === 1) out.version = val.value;
      else if (fieldNumber === 3) out.kind = val.value;
      else if (fieldNumber === 4) out.schemaVersion = val.value;
      else if (fieldNumber === 8) out.flags = val.value;
    } else if (wireType === 2) {
      const len = decodeVarint(bytes, offset);
      offset = len.offset;
      const slice = bytes.subarray(offset, offset + len.value);
      offset += len.value;
      if (fieldNumber === 2) out.cid = dec.decode(slice);
      else if (fieldNumber === 6) out.threadId = dec.decode(slice);
    } else {
      throw govError("GOVERNANCE_POINTER_INVALID", `Unsupported wire type ${wireType}.`);
    }
  }
  return out;
}

export async function buildDeterministicRulingExport({
  snapshot = null,
  packet = null,
  minutes = null,
  decisionId = "",
  computeBackend = "google",
} = {}) {
  const decision = (Array.isArray(minutes?.decisions) ? minutes.decisions : []).find(
    (item) => item.decision_id === decisionId
  );
  if (!decision) {
    throw govError("GOVERNANCE_RULING_DECISION_NOT_FOUND", `Decision "${decisionId}" not found in minutes.`);
  }
  if (decision.run_deterministic_ruling !== true) {
    throw govError(
      "GOVERNANCE_RULING_NOT_FLAGGED",
      `Decision "${decisionId}" was not explicitly flagged with run_deterministic_ruling=true by the founder.`
    );
  }
  const backend = safeText(computeBackend, 20).toLowerCase();
  if (backend !== "google" && backend !== "vast") {
    throw govError("GOVERNANCE_RULING_BACKEND_INVALID", "Deterministic ruling compute backend must be google or vast.");
  }
  const inputBundle = {
    schema: "pf.governance.ruling_input.v1",
    decision_id: decisionId,
    compute_backend: backend,
    read_only_compute: true,
    snapshot,
    packet,
    minutes,
  };
  const canonical = canonicalJson(inputBundle);
  const inputBundleSha256 = await sha256HexAsync(canonical);
  return {
    input_bundle: inputBundle,
    input_bundle_sha256: inputBundleSha256,
  };
}
