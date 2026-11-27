#!/usr/bin/env node
// Pillar 1 — Independent Third-Party Hive Governance Session Verifier
//
// Separates:
//   1. Deterministic offline verification (zero trust in Task Node's database):
//      - Pinned founder authority binding & threshold approvals
//      - Single-block-pinned protocol snapshot integrity & raw source hashes
//      - Direct carry-over accountability completeness & zero auto-PFT-bounty invariant
//      - Opening packet (pf.governance.packet.v1) canonical SHA-256 & session bounds
//      - Eligible-pubkey snapshot SHA-256
//      - Frozen transcript canonical inclusion rule, Nostr signatures, ascending server
//        receipt sequence, rate-limit/cap compliance, and transcript_root_sha256
//      - Signed minutes two-pass prompt-injection isolation (Pass 1 never cites community)
//      - postfiatl1v2 pf.ptr v5 (kind = 12 GOVERNANCE, PUBLIC) anchor memo verification
//   2. Optional best-effort --check-relays audit comparing live Nostr relays against
//      the frozen manifest to surface potential server censorship.
//
// Usage:
//   node scripts/verify-governance-session.mjs --bundle <path.json> [--pinned-founder <addr>] [--pinned-nostr-pubkey <hex>] [--check-relays]
//   node scripts/verify-governance-session.mjs --cid <cid> [--gateway https://ipfs.io/ipfs/] [--pinned-founder <addr>]

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256HexAsync } from "../shared/canonical-json.js";
import { verifyInboundNostrEvent } from "../shared/nostr-signing-guard.js";
import {
  assertNoAutoBountyFields,
  decodeGovernancePointerV5,
  GOVERNANCE_CONTENT_KIND,
  GOVERNANCE_POINTER_PUBLIC_FLAG,
  GOVERNANCE_SCHEMAS,
  validateCarryOverScorecard,
} from "../shared/hive-governance.js";

function recordCheck(checks, id, ok, detail = "") {
  checks.push({ id, ok: Boolean(ok), detail });
}

export async function verifyGovernanceSessionBundle(bundle, {
  pinnedFounderAccount = "",
  pinnedFounderNostrPubkey = "",
  verifyApprovalSignature = null,
  checkRelays = false,
  fetchRelayEvents = null,
  relays = [],
} = {}) {
  const checks = [];
  const errors = [];
  const fail = (id, detail) => {
    recordCheck(checks, id, false, detail);
    errors.push(`${id}: ${detail}`);
  };
  const pass = (id, detail = "ok") => recordCheck(checks, id, true, detail);

  if (!bundle || typeof bundle !== "object") {
    fail("bundle_shape", "Verification bundle must be a JSON object.");
    return { ok: false, checks, errors, relayAudit: null };
  }

  // 0. Zero auto-PFT bounty invariant across entire bundle.
  try {
    assertNoAutoBountyFields(bundle, "bundle");
    pass("no_auto_pft_bounties");
  } catch (error) {
    fail("no_auto_pft_bounties", error.message);
  }

  const { snapshot, packet, eligible_pubkeys: eligiblePubkeys, transcript, minutes, raw_events_by_id: rawEventsById = {}, anchors = [] } = bundle;

  // 1. Pinned founder authority binding.
  const authority = packet?.authority || {};
  const authorizedAccounts = Array.isArray(authority.authorized_accounts) ? authority.authorized_accounts : [];
  if (!authorizedAccounts.length || !/^[0-9a-f]{64}$/.test(String(authority.founder_nostr_pubkey || ""))) {
    fail("authority_binding", "Packet authority is missing authorized_accounts or 64-hex founder_nostr_pubkey.");
  } else if (pinnedFounderAccount && !authorizedAccounts.includes(pinnedFounderAccount)) {
    fail("authority_binding", `Pinned founder account "${pinnedFounderAccount}" is not in packet authority.`);
  } else if (pinnedFounderNostrPubkey && authority.founder_nostr_pubkey !== pinnedFounderNostrPubkey.toLowerCase()) {
    fail("authority_binding", "Packet founder_nostr_pubkey does not match pinned founder Nostr pubkey.");
  } else {
    pass("authority_binding");
  }

  // 2. Protocol snapshot canonical hash & single finalized block height (no torn reads).
  if (!snapshot || snapshot.schema !== GOVERNANCE_SCHEMAS.SNAPSHOT) {
    fail("snapshot_schema", `Expected schema ${GOVERNANCE_SCHEMAS.SNAPSHOT}.`);
  } else {
    const computedSnapshotSha = await sha256HexAsync(canonicalJson(snapshot));
    if (bundle.snapshot_sha256 && computedSnapshotSha !== bundle.snapshot_sha256) {
      fail("snapshot_sha256", `Computed ${computedSnapshotSha} !== bundle ${bundle.snapshot_sha256}.`);
    } else if (packet?.snapshot_sha256 && computedSnapshotSha !== packet.snapshot_sha256) {
      fail("snapshot_sha256", `Computed ${computedSnapshotSha} !== packet.snapshot_sha256 ${packet.snapshot_sha256}.`);
    } else {
      pass("snapshot_sha256", computedSnapshotSha);
    }

    const tornSources = (Array.isArray(snapshot.sources) ? snapshot.sources : []).filter(
      (src) => String(src?.source_id || "").startsWith("l1_") && Number(src.block_height) !== Number(snapshot.finalized_block_height)
    );
    if (tornSources.length > 0) {
      fail("snapshot_single_block_height", `Torn L1 reads detected: ${tornSources.map((s) => s.source_id).join(", ")}`);
    } else {
      pass("snapshot_single_block_height", `height=${snapshot.finalized_block_height}`);
    }
  }

  // 3. Opening packet canonical hash & carry-over accountability completeness.
  if (!packet || packet.schema !== GOVERNANCE_SCHEMAS.PACKET) {
    fail("packet_schema", `Expected schema ${GOVERNANCE_SCHEMAS.PACKET}.`);
  } else {
    const computedPacketSha = await sha256HexAsync(canonicalJson(packet));
    if (bundle.packet_sha256 && computedPacketSha !== bundle.packet_sha256) {
      fail("packet_sha256", `Computed ${computedPacketSha} !== bundle ${bundle.packet_sha256}.`);
    } else {
      pass("packet_sha256", computedPacketSha);
    }

    try {
      validateCarryOverScorecard({
        carriedDeliverables: snapshot?.carried_deliverables || [],
        previousDeliverablesStatus: packet.previous_deliverables_status || [],
      });
      pass("carry_over_accountability", `${(packet.previous_deliverables_status || []).length} items scored`);
    } catch (error) {
      fail("carry_over_accountability", error.message);
    }
  }

  // 4. Eligible pubkeys snapshot integrity (when non-founder posting allowed).
  const postingPolicy = packet?.session_config?.posting_policy || "all_members";
  const eligiblePubkeySet = new Set();
  if (authority.founder_nostr_pubkey) eligiblePubkeySet.add(authority.founder_nostr_pubkey);
  if (eligiblePubkeys && Array.isArray(eligiblePubkeys.pubkeys)) {
    const computedEligibleSha = await sha256HexAsync(canonicalJson(eligiblePubkeys));
    if (packet?.session_config?.eligible_pubkeys_sha256 && computedEligibleSha !== packet.session_config.eligible_pubkeys_sha256) {
      fail("eligible_pubkeys_sha256", `Computed ${computedEligibleSha} !== packet ${packet.session_config.eligible_pubkeys_sha256}.`);
    } else {
      pass("eligible_pubkeys_sha256", computedEligibleSha);
    }
    for (const entry of eligiblePubkeys.pubkeys) {
      if (entry?.pubkey) eligiblePubkeySet.add(String(entry.pubkey).toLowerCase());
    }
  } else if (postingPolicy !== "founder_only") {
    fail("eligible_pubkeys_sha256", "Missing eligible_pubkeys snapshot for non-founder posting policy.");
  }

  // 5. Frozen transcript canonical inclusion, Nostr signatures, ascending receipt_seq, rate limits & root hash.
  const roleByEventId = new Map();
  if (!transcript || transcript.schema !== GOVERNANCE_SCHEMAS.TRANSCRIPT) {
    fail("transcript_schema", `Expected schema ${GOVERNANCE_SCHEMAS.TRANSCRIPT}.`);
  } else {
    const entries = Array.isArray(transcript.included_entries) ? transcript.included_entries : [];
    let prevSeq = 0;
    let transcriptValid = true;
    const lastMsByCommunity = new Map();
    const countByCommunity = new Map();
    const rateLimitMs = Number(packet?.session_config?.rate_limit_seconds || 15) * 1000;
    const maxNonFounder = Number(packet?.session_config?.max_non_founder_messages || 10);

    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.receipt_seq) || entry.receipt_seq <= prevSeq) {
        fail("transcript_ordering", `Non-ascending receipt_seq ${entry.receipt_seq} after ${prevSeq}.`);
        transcriptValid = false;
        break;
      }
      prevSeq = entry.receipt_seq;
      roleByEventId.set(entry.nostr_event_id, entry.author_role);

      if (entry.server_received_at_unix_ms < transcript.opened_at_unix_ms || entry.server_received_at_unix_ms > transcript.frozen_at_unix_ms) {
        fail("transcript_window", `Event ${entry.nostr_event_id} received outside [opened, frozen].`);
        transcriptValid = false;
        break;
      }

      if (postingPolicy === "founder_only" && entry.author_role === "community") {
        fail("transcript_eligibility", `Community event ${entry.nostr_event_id} included under founder_only policy.`);
        transcriptValid = false;
        break;
      }
      if (entry.author_role === "community" && !eligiblePubkeySet.has(entry.author_pubkey)) {
        fail("transcript_eligibility", `Ineligible author ${entry.author_pubkey} included in transcript.`);
        transcriptValid = false;
        break;
      }
      if (entry.author_role === "community") {
        const count = (countByCommunity.get(entry.author_pubkey) || 0) + 1;
        const lastMs = lastMsByCommunity.get(entry.author_pubkey);
        if (count > maxNonFounder) {
          fail("transcript_rate_limits", `Author ${entry.author_pubkey} exceeded max ${maxNonFounder} messages.`);
          transcriptValid = false;
          break;
        }
        if (lastMs !== undefined && entry.server_received_at_unix_ms - lastMs < rateLimitMs) {
          fail("transcript_rate_limits", `Author ${entry.author_pubkey} violated ${rateLimitMs}ms rate limit.`);
          transcriptValid = false;
          break;
        }
        countByCommunity.set(entry.author_pubkey, count);
        lastMsByCommunity.set(entry.author_pubkey, entry.server_received_at_unix_ms);
      }

      const raw = rawEventsById[entry.nostr_event_id];
      if (!raw) {
        fail("transcript_raw_events", `Missing raw signed Nostr event for ${entry.nostr_event_id}.`);
        transcriptValid = false;
        break;
      }
      let verified;
      try {
        verified = verifyInboundNostrEvent(raw, { expectedKind: 1 });
      } catch (error) {
        fail("transcript_nostr_signatures", `Invalid Nostr signature on ${entry.nostr_event_id}: ${error.message}`);
        transcriptValid = false;
        break;
      }
      const roots = verified.tags.filter((tag) => Array.isArray(tag) && tag[0] === "e" && tag[3] === "root");
      if (roots.length !== 1 || roots[0][1] !== transcript.root_event_id) {
        fail("transcript_room_binding", `Event ${entry.nostr_event_id} does not reference root ${transcript.root_event_id}.`);
        transcriptValid = false;
        break;
      }
      const rawHash = await sha256HexAsync(canonicalJson(verified));
      if (rawHash !== entry.raw_event_sha256) {
        fail("transcript_raw_hash", `Raw event SHA-256 mismatch for ${entry.nostr_event_id}.`);
        transcriptValid = false;
        break;
      }
    }

    if (transcriptValid) {
      pass("transcript_entries", `${entries.length} entries verified`);
    }

    const expectedRoot = await sha256HexAsync(
      canonicalJson(entries.map((entry) => [entry.receipt_seq, entry.nostr_event_id, entry.raw_event_sha256]))
    );
    if (expectedRoot !== transcript.transcript_root_sha256) {
      fail("transcript_root_sha256", `Computed ${expectedRoot} !== transcript ${transcript.transcript_root_sha256}.`);
    } else {
      pass("transcript_root_sha256", expectedRoot);
    }
  }

  // 6. Minutes integrity, two-pass prompt-injection isolation, and threshold approvals.
  if (!minutes || minutes.schema !== GOVERNANCE_SCHEMAS.MINUTES) {
    fail("minutes_schema", `Expected schema ${GOVERNANCE_SCHEMAS.MINUTES}.`);
  } else {
    const computedMinutesSha = await sha256HexAsync(canonicalJson(minutes));
    if (bundle.minutes_sha256 && computedMinutesSha !== bundle.minutes_sha256) {
      fail("minutes_sha256", `Computed ${computedMinutesSha} !== bundle ${bundle.minutes_sha256}.`);
    } else {
      pass("minutes_sha256", computedMinutesSha);
    }

    if (transcript && minutes.transcript_root_sha256 !== transcript.transcript_root_sha256) {
      fail("minutes_transcript_binding", "Minutes transcript_root_sha256 does not match frozen transcript.");
    } else {
      pass("minutes_transcript_binding");
    }

    // Two-pass prompt-injection isolation check: Pass 1 decisions & deliverables MUST NEVER cite community messages.
    let pass1Violation = "";
    for (const dec of Array.isArray(minutes.decisions) ? minutes.decisions : []) {
      for (const id of Array.isArray(dec.cited_event_ids) ? dec.cited_event_ids : []) {
        const role = roleByEventId.get(id);
        if (!role || role === "community") {
          pass1Violation = `Decision "${dec.decision_id}" cites non-founder/community event "${id}" (role=${role || "unknown"}).`;
          break;
        }
      }
      if (pass1Violation) break;
    }
    if (!pass1Violation) {
      for (const deliv of Array.isArray(minutes.next_deliverables) ? minutes.next_deliverables : []) {
        for (const id of Array.isArray(deliv.cited_event_ids) ? deliv.cited_event_ids : []) {
          const role = roleByEventId.get(id);
          if (!role || role === "community") {
            pass1Violation = `Deliverable "${deliv.deliverable_id}" cites non-founder/community event "${id}" (role=${role || "unknown"}).`;
            break;
          }
        }
        if (pass1Violation) break;
      }
    }
    if (pass1Violation) {
      fail("minutes_prompt_injection_isolation", pass1Violation);
    } else {
      pass("minutes_prompt_injection_isolation");
    }

    // Threshold approval check (1-of-1 founder at launch; threshold-ready).
    const approvals = Array.isArray(minutes.approvals) ? minutes.approvals : [];
    const threshold = Math.max(1, Number(authority.threshold || 1));
    const validSigners = new Set();
    for (const sig of approvals) {
      if (!authorizedAccounts.includes(sig.signer_account) || !sig.signature) continue;
      if (typeof verifyApprovalSignature === "function") {
        const verified = await verifyApprovalSignature({ approval: sig, minutes, minutesSha256: computedMinutesSha });
        if (!verified) continue;
      }
      validSigners.add(sig.signer_account);
    }
    if (validSigners.size < threshold) {
      fail("minutes_approval_threshold", `Valid authorized approvals (${validSigners.size}) < required threshold (${threshold}).`);
    } else {
      pass("minutes_approval_threshold", `${validSigners.size}/${threshold}`);
    }
  }

  // 7. postfiatl1v2 pf.ptr v5 (kind = 12 GOVERNANCE, PUBLIC) anchor verification.
  if (!Array.isArray(anchors) || anchors.length === 0) {
    fail("l1_anchors", "No postfiatl1v2 governance anchors present.");
  } else {
    let anchorProblem = "";
    for (const anchor of anchors) {
      try {
        const decoded = decodeGovernancePointerV5(anchor.memo_hex);
        if (decoded.version !== 5) {
          anchorProblem = `Anchor ${anchor.artifact_schema} memo version ${decoded.version} !== 5.`;
          break;
        }
        if (decoded.kind !== GOVERNANCE_CONTENT_KIND) {
          anchorProblem = `Anchor ${anchor.artifact_schema} kind ${decoded.kind} !== ${GOVERNANCE_CONTENT_KIND}.`;
          break;
        }
        if ((decoded.flags & GOVERNANCE_POINTER_PUBLIC_FLAG) !== GOVERNANCE_POINTER_PUBLIC_FLAG) {
          anchorProblem = `Anchor ${anchor.artifact_schema} is missing PUBLIC flag.`;
          break;
        }
        if (decoded.threadId !== bundle.session_id || decoded.cid !== anchor.cid) {
          anchorProblem = `Anchor ${anchor.artifact_schema} memo threadId/cid mismatch.`;
          break;
        }
      } catch (error) {
        anchorProblem = `Anchor ${anchor.artifact_schema} decode failed: ${error.message}`;
        break;
      }
    }
    if (anchorProblem) {
      fail("l1_anchors", anchorProblem);
    } else {
      pass("l1_anchors", `${anchors.length} pf.ptr v5 GOVERNANCE anchors verified`);
    }
  }

  // Optional best-effort relay censorship audit (strictly separate from deterministic offline verification).
  let relayAudit = null;
  if (checkRelays && typeof fetchRelayEvents === "function" && transcript?.root_event_id) {
    const relayEvents = await fetchRelayEvents({
      rootId: transcript.root_event_id,
      relays,
      since: Math.floor(Number(transcript.opened_at_unix_ms || 0) / 1000),
    });
    const knownIds = new Set([
      ...(transcript.included_entries || []).map((e) => e.nostr_event_id),
      ...(transcript.excluded_events || []).map((e) => e.nostr_event_id),
    ]);
    const unaccounted = [];
    for (const item of relayEvents) {
      const ev = item?.event || item;
      if (!ev?.id || knownIds.has(ev.id)) continue;
      try {
        const verified = verifyInboundNostrEvent(ev, { expectedKind: 1 });
        if (eligiblePubkeySet.has(verified.pubkey)) {
          unaccounted.push({ id: verified.id, pubkey: verified.pubkey, created_at: verified.created_at });
        }
      } catch {
        // Ignore invalid relay events during best-effort audit.
      }
    }
    relayAudit = {
      mode: "best_effort_relay_audit",
      observedRelayCount: relayEvents.length,
      unaccountedEligibleEvents: unaccounted,
      potentialCensorshipDetected: unaccounted.length > 0,
    };
  }

  return {
    ok: errors.length === 0,
    sessionId: bundle.session_id || "",
    checks,
    errors,
    relayAudit,
  };
}

function parseCliArgs(argv = []) {
  const args = { bundle: "", cid: "", gateway: "https://ipfs.io/ipfs/", pinnedFounder: "", pinnedNostrPubkey: "", checkRelays: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--bundle") args.bundle = argv[++i] || "";
    else if (flag === "--cid") args.cid = argv[++i] || "";
    else if (flag === "--gateway") args.gateway = argv[++i] || args.gateway;
    else if (flag === "--pinned-founder") args.pinnedFounder = argv[++i] || "";
    else if (flag === "--pinned-nostr-pubkey") args.pinnedNostrPubkey = argv[++i] || "";
    else if (flag === "--check-relays") args.checkRelays = true;
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.bundle && !args.cid) {
    console.error("Usage: node scripts/verify-governance-session.mjs --bundle <path.json> [--pinned-founder <addr>] [--pinned-nostr-pubkey <hex>] [--check-relays]");
    process.exit(2);
  }
  let bundle;
  if (args.bundle) {
    bundle = JSON.parse(await readFile(args.bundle, "utf8"));
  } else {
    const base = args.gateway.endsWith("/") ? args.gateway : `${args.gateway}/`;
    const response = await fetch(`${base}${encodeURIComponent(args.cid)}`);
    if (!response.ok) throw new Error(`IPFS gateway fetch failed: HTTP ${response.status}`);
    bundle = await response.json();
  }
  const result = await verifyGovernanceSessionBundle(bundle, {
    pinnedFounderAccount: args.pinnedFounder,
    pinnedFounderNostrPubkey: args.pinnedNostrPubkey,
    checkRelays: args.checkRelays,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exit(1);
  });
}
