// Pillar 1 — Hive Governance Session Engine (Orchestration Layer)
// Lifecycle: scheduled -> live -> closing -> anchored -> archived (plus aborted before anchoring).
// Enforces:
// - Dedicated multi-channel Hive governance rooms (never locking main Hive chat)
// - Single-block-pinned protocol snapshot + direct carry-over accountability (zero PFT bounties)
// - 30-minute default live session window + eligible-pubkey snapshot
// - Frozen server-receipt-ordered transcript + participant auto-snapshot
// - Two-pass prompt-injection-isolated minutes drafting & revision tracking
// - Idempotent postfiatl1v2 pf.ptr v5 (kind = 12 GOVERNANCE) anchor tracking

import { randomUUID } from "node:crypto";
import { governanceChannelId, HIVE_CHANNEL_KINDS } from "../shared/hive-group.js";
import {
  assertGovernanceTransition,
  assertNoAutoBountyFields,
  buildEligiblePubkeysSnapshot,
  buildGovernanceMinutes,
  buildGovernancePacket,
  buildProtocolSnapshot,
  encodeGovernancePointerV5,
  freezeSessionTranscript,
  GOVERNANCE_DEFAULT_CHAIN_ID,
  GOVERNANCE_DEFAULT_DURATION_MINUTES,
  GOVERNANCE_DEFAULT_MAX_FACILITATOR_TURNS,
  GOVERNANCE_DEFAULT_MAX_NON_FOUNDER_MESSAGES,
  GOVERNANCE_DEFAULT_RATE_LIMIT_SECONDS,
  GOVERNANCE_DEFAULT_RESERVED_FOUNDER_TURNS,
  GOVERNANCE_PROTO_STATE_MAP,
  GOVERNANCE_SCHEMAS,
  loadCarryOverDeliverables,
} from "../shared/hive-governance.js";
import { canonicalJson, sha256HexAsync } from "../shared/canonical-json.js";
import { getDefaultGovernanceStore } from "./repositories/hive-governance.js";
import {
  createHiveGroupChannel,
  getHiveGroupChannel,
  hiveGroupMembers,
  listHiveGroupMessages,
  updateHiveGroupChannelStatus,
} from "./repositories/hive-group.js";

function engineError(code, detail = "", status = 400) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  error.status = status;
  return error;
}

async function defaultPinJson(payload, { name = "governance.json" } = {}) {
  const canonical = canonicalJson(payload);
  const sha256 = await sha256HexAsync(canonical);
  return {
    cid: `bafklocal${sha256.slice(0, 48)}`,
    sha256,
    canonical,
    pinned: false,
    name,
  };
}

export function createGovernanceSessionEngine({
  store = null,
  createChannel = createHiveGroupChannel,
  getChannel = getHiveGroupChannel,
  updateChannelStatus = updateHiveGroupChannelStatus,
  listMembers = hiveGroupMembers,
  listChannelMessages = listHiveGroupMessages,
  pinJson = defaultPinJson,
  now = () => Date.now(),
} = {}) {
  const resolveStore = () => store || getDefaultGovernanceStore();

  return {
    async scheduleSession({
      sessionId = "",
      title = "",
      summary = "",
      chainId = GOVERNANCE_DEFAULT_CHAIN_ID,
      founderAccountId = "",
      founderL1Address = "",
      founderNostrPubkey = "",
      identityHandle = "",
      postingPolicy = "all_members",
      facilitatorMode = "agenda",
      durationMinutes = GOVERNANCE_DEFAULT_DURATION_MINUTES,
      rateLimitSeconds = GOVERNANCE_DEFAULT_RATE_LIMIT_SECONDS,
      maxNonFounderMessages = GOVERNANCE_DEFAULT_MAX_NON_FOUNDER_MESSAGES,
      maxFacilitatorTurns = GOVERNANCE_DEFAULT_MAX_FACILITATOR_TURNS,
      reservedFounderTurns = GOVERNANCE_DEFAULT_RESERVED_FOUNDER_TURNS,
      allowlistPubkeys = [],
      snapshotInput = {},
      previousDeliverablesStatus = [],
      openQuestions = [],
      proposedDecisions = [],
      attachments = [],
    } = {}) {
      assertNoAutoBountyFields(
        { previousDeliverablesStatus, proposedDecisions, summary, title, snapshotInput },
        "scheduleSession"
      );
      const repo = resolveStore();
      const sessionNumber = await repo.nextSessionNumber();
      const resolvedSessionId = String(sessionId || "").trim() || `gov-${sessionNumber}-${randomUUID().slice(0, 8)}`;
      const channelId = governanceChannelId(resolvedSessionId);
      const nowMs = now();

      // 1. Automatically load open action items from the previous governance session (no PFT bounties!).
      const previousSession = await repo.getLatestCompletedSession();
      const carryOver = loadCarryOverDeliverables(previousSession);

      // 2. Create dedicated multi-channel Hive room for this session (main Hive chat stays untouched).
      const channel = await createChannel({
        id: channelId,
        title: title || `Governance Session #${sessionNumber}`,
        description: summary || "Founder-triggered 30-minute public governance session.",
        channelKind: HIVE_CHANNEL_KINDS.GOVERNANCE,
        sessionId: resolvedSessionId,
        postingPolicy,
        status: "scheduled",
      });

      // 3. Build single-block-pinned protocol snapshot + carried deliverables.
      const { snapshot, sha256: snapshotSha256 } = await buildProtocolSnapshot({
        sessionId: resolvedSessionId,
        chainId,
        finalizedBlockHeight: snapshotInput.finalizedBlockHeight ?? snapshotInput.finalized_block_height ?? 0,
        finalizedBlockHash: snapshotInput.finalizedBlockHash ?? snapshotInput.finalized_block_hash ?? "",
        capturedAtUnixMs: snapshotInput.capturedAtUnixMs ?? nowMs,
        activeValidatorCount: snapshotInput.activeValidatorCount ?? snapshotInput.active_validator_count ?? 0,
        bridgeStatusSummary: snapshotInput.bridgeStatusSummary ?? snapshotInput.bridge_status_summary ?? "unavailable",
        navcoinSupplySummary: snapshotInput.navcoinSupplySummary ?? snapshotInput.navcoin_supply_summary ?? "unavailable",
        cobaltVerdictSummary: snapshotInput.cobaltVerdictSummary ?? snapshotInput.cobalt_verdict_summary ?? "unavailable",
        tasknodeHealthSummary: snapshotInput.tasknodeHealthSummary ?? snapshotInput.tasknode_health_summary ?? "healthy",
        previousSessionId: carryOver.previous_session_id,
        previousMinutesCid: carryOver.previous_minutes_cid,
        carriedDeliverables: carryOver.carried_deliverables,
        sources: snapshotInput.sources || [],
      });
      const pinnedSnapshot = await pinJson(snapshot, { name: `${resolvedSessionId}-snapshot.json` });

      // 4. Snapshot eligible pubkeys for offline verification when posting policy allows non-founders.
      const allMembers = postingPolicy === "all_members" ? await listMembers() : allowlistPubkeys;
      const eligible = await buildEligiblePubkeysSnapshot({
        sessionId: resolvedSessionId,
        channelId,
        postingPolicy,
        founderPubkey: founderNostrPubkey,
        facilitatorPubkey: channel?.bot_pubkey || "",
        eligibleMembers: allMembers,
        capturedAtUnixMs: nowMs,
      });
      const pinnedEligible = await pinJson(eligible.payload, { name: `${resolvedSessionId}-eligible-pubkeys.json` });

      // 5. Build canonical pf.governance.packet.v1 opening packet.
      const { packet, sha256: packetSha256 } = await buildGovernancePacket({
        sessionId: resolvedSessionId,
        chainId,
        sessionNumber,
        title: title || `Post Fiat Governance Session #${sessionNumber}`,
        summary,
        authority: {
          signer_set_id: "founder-1of1-v1",
          threshold: 1,
          total_signers: 1,
          authorized_accounts: [founderL1Address],
          founder_nostr_pubkey: founderNostrPubkey,
          identity_handle: identityHandle,
        },
        snapshot,
        snapshotCid: pinnedSnapshot.cid,
        snapshotSha256,
        previousDeliverablesStatus,
        openQuestions,
        proposedDecisions,
        attachments,
        sessionConfig: {
          channel_id: channelId,
          posting_policy: postingPolicy,
          facilitator_mode: facilitatorMode,
          duration_minutes: durationMinutes,
          rate_limit_seconds: rateLimitSeconds,
          max_non_founder_messages: maxNonFounderMessages,
          max_facilitator_turns: maxFacilitatorTurns,
          reserved_founder_turns: reservedFounderTurns,
          eligible_pubkeys_cid: pinnedEligible.cid,
          eligible_pubkeys_sha256: eligible.sha256,
        },
        createdAtUnixMs: nowMs,
      });
      const pinnedPacket = await pinJson(packet, { name: `${resolvedSessionId}-packet.json` });

      const session = await repo.saveSession({
        session_id: resolvedSessionId,
        session_number: sessionNumber,
        channel_id: channelId,
        state: "scheduled",
        proto_state: GOVERNANCE_PROTO_STATE_MAP.scheduled,
        title: packet.title,
        summary: packet.summary,
        chain_id: packet.chain_id,
        founder_account_id: founderAccountId,
        founder_l1_address: founderL1Address,
        founder_nostr_pubkey: founderNostrPubkey,
        posting_policy: packet.session_config.posting_policy,
        facilitator_mode: packet.session_config.facilitator_mode,
        duration_minutes: packet.session_config.duration_minutes,
        rate_limit_seconds: packet.session_config.rate_limit_seconds,
        max_non_founder_messages: packet.session_config.max_non_founder_messages,
        max_facilitator_turns: packet.session_config.max_facilitator_turns,
        reserved_founder_turns: packet.session_config.reserved_founder_turns,
        previous_session_id: carryOver.previous_session_id,
        eligible_pubkeys_json: eligible.payload,
        eligible_pubkeys_cid: pinnedEligible.cid,
        eligible_pubkeys_sha256: eligible.sha256,
        snapshot_json: snapshot,
        snapshot_cid: pinnedSnapshot.cid,
        snapshot_sha256: snapshotSha256,
        packet_json: packet,
        packet_cid: pinnedPacket.cid,
        packet_sha256: packetSha256,
        transcript_json: {},
        minutes_json: {},
        minutes_revision: 0,
        anchors_json: [],
        ruling_state: "none",
        ruling_anchors_json: [],
        scheduled_at: new Date(nowMs).toISOString(),
      });

      if (packet.previous_deliverables_status.length > 0) {
        await repo.updateDeliverableReviews(resolvedSessionId, packet.previous_deliverables_status);
      }

      return { session, channel, carryOver };
    },

    async openSession(sessionId, { durationMinutes = null } = {}) {
      const repo = resolveStore();
      const existing = await repo.getSession(sessionId);
      if (!existing) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      assertGovernanceTransition(existing.state, "live");

      const nowMs = now();
      const duration = durationMinutes !== null
        ? Math.min(240, Math.max(5, Math.trunc(Number(durationMinutes))))
        : Number(existing.duration_minutes || GOVERNANCE_DEFAULT_DURATION_MINUTES);
      const openedAt = new Date(nowMs).toISOString();
      const scheduledCloseAt = new Date(nowMs + duration * 60_000).toISOString();

      await updateChannelStatus(existing.channel_id, { status: "active", openedAt });
      const session = await repo.saveSession({
        ...existing,
        state: "live",
        proto_state: GOVERNANCE_PROTO_STATE_MAP.live,
        duration_minutes: duration,
        opened_at: openedAt,
        scheduled_close_at: scheduledCloseAt,
      });
      return { session };
    },

    async closeSession(sessionId, {
      observedEvents = null,
      minutesDraft = {},
    } = {}) {
      assertNoAutoBountyFields(minutesDraft, "minutesDraft");
      const repo = resolveStore();
      const existing = await repo.getSession(sessionId);
      if (!existing) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      assertGovernanceTransition(existing.state, "closing");

      const channel = await getChannel(existing.channel_id);
      if (!channel?.root_event?.id) {
        throw engineError("GOVERNANCE_CHANNEL_NOT_FOUND", `Channel "${existing.channel_id}" not found.`, 404);
      }

      const nowMs = now();
      const openedAtUnixMs = existing.opened_at ? Date.parse(existing.opened_at) : Date.parse(existing.scheduled_at);
      let eventsToFreeze = observedEvents;
      if (!Array.isArray(eventsToFreeze)) {
        const storedRows = await listChannelMessages({ channelId: existing.channel_id, limit: 500 });
        eventsToFreeze = storedRows.map((row, idx) => ({
          receipt_seq: Number(row.sequence || idx + 1),
          server_received_at_unix_ms: row.delivered_at ? Date.parse(row.delivered_at) : Date.parse(row.created_at),
          event: row.event_json,
        }));
      }

      const frozen = await freezeSessionTranscript({
        sessionId: existing.session_id,
        channelId: existing.channel_id,
        rootEventId: channel.root_event.id,
        openingPacketCid: existing.packet_cid,
        eligiblePubkeysSnapshot: existing.eligible_pubkeys_json,
        eligiblePubkeysCid: existing.eligible_pubkeys_cid,
        founderPubkey: existing.founder_nostr_pubkey,
        facilitatorPubkey: channel.bot_pubkey || "",
        postingPolicy: existing.posting_policy,
        openedAtUnixMs,
        frozenAtUnixMs: nowMs,
        rateLimitSeconds: existing.rate_limit_seconds,
        maxNonFounderMessages: existing.max_non_founder_messages,
        observedEvents: eventsToFreeze,
      });

      const pinnedMarkdown = await pinJson(
        { schema: "pf.governance.transcript_markdown.v1", session_id: existing.session_id, markdown: frozen.markdown },
        { name: `${existing.session_id}-transcript-md.json` }
      );
      frozen.transcript.markdown_transcript_cid = pinnedMarkdown.cid;
      const pinnedTranscript = await pinJson(frozen.transcript, { name: `${existing.session_id}-transcript.json` });

      const { minutes, sha256: minutesSha256 } = await buildGovernanceMinutes({
        sessionId: existing.session_id,
        revision: 1,
        state: "closing",
        authority: existing.packet_json?.authority || {
          signer_set_id: "founder-1of1-v1",
          threshold: 1,
          total_signers: 1,
          authorized_accounts: [existing.founder_l1_address],
          founder_nostr_pubkey: existing.founder_nostr_pubkey,
        },
        openingPacketCid: existing.packet_cid,
        transcript: frozen.transcript,
        transcriptCid: pinnedTranscript.cid,
        summary: minutesDraft.summary || existing.summary,
        previousDeliverablesReview: minutesDraft.previousDeliverablesReview || existing.packet_json?.previous_deliverables_status || [],
        decisions: minutesDraft.decisions || [],
        nextDeliverables: minutesDraft.nextDeliverables || [],
        communityInput: minutesDraft.communityInput || [],
        approvals: [],
        finalizedAtUnixMs: nowMs,
      });
      const pinnedMinutes = await pinJson(minutes, { name: `${existing.session_id}-minutes-r1.json` });

      const closedAt = new Date(nowMs).toISOString();
      await updateChannelStatus(existing.channel_id, { status: "closed", closedAt });

      const session = await repo.saveSession({
        ...existing,
        state: "closing",
        proto_state: GOVERNANCE_PROTO_STATE_MAP.closing,
        transcript_json: {
          ...frozen.transcript,
          raw_events_by_id: frozen.rawEventsById,
        },
        transcript_cid: pinnedTranscript.cid,
        transcript_root_sha256: frozen.transcript.transcript_root_sha256,
        minutes_json: minutes,
        minutes_revision: 1,
        minutes_cid: pinnedMinutes.cid,
        minutes_sha256: minutesSha256,
        closed_at: closedAt,
      });

      return {
        session,
        transcript: frozen.transcript,
        participants: frozen.participants,
        markdown: frozen.markdown,
        minutes,
      };
    },

    async reviseMinutes(sessionId, {
      summary,
      previousDeliverablesReview,
      decisions,
      nextDeliverables,
      communityInput,
    } = {}) {
      assertNoAutoBountyFields(
        { summary, previousDeliverablesReview, decisions, nextDeliverables, communityInput },
        "reviseMinutes"
      );
      const repo = resolveStore();
      const existing = await repo.getSession(sessionId);
      if (!existing) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      if (existing.state !== "closing") {
        throw engineError("GOVERNANCE_MINUTES_LOCKED", "Minutes can only be edited while session is in closing state.", 409);
      }
      const nextRevision = Number(existing.minutes_revision || 0) + 1;
      const nowMs = now();
      const currentMinutes = existing.minutes_json || {};
      const { minutes, sha256: minutesSha256 } = await buildGovernanceMinutes({
        sessionId: existing.session_id,
        revision: nextRevision,
        state: "closing",
        authority: currentMinutes.authority || existing.packet_json?.authority || {},
        openingPacketCid: existing.packet_cid,
        transcript: existing.transcript_json,
        transcriptCid: existing.transcript_cid,
        summary: summary !== undefined ? summary : currentMinutes.summary,
        previousDeliverablesReview: previousDeliverablesReview !== undefined
          ? previousDeliverablesReview
          : currentMinutes.previous_deliverables_review || [],
        decisions: decisions !== undefined ? decisions : currentMinutes.decisions || [],
        nextDeliverables: nextDeliverables !== undefined ? nextDeliverables : currentMinutes.next_deliverables || [],
        communityInput: communityInput !== undefined ? communityInput : currentMinutes.community_input || [],
        approvals: [],
        finalizedAtUnixMs: nowMs,
      });
      const pinnedMinutes = await pinJson(minutes, { name: `${existing.session_id}-minutes-r${nextRevision}.json` });
      // Never rebuilds frozen transcript!
      const session = await repo.saveSession({
        ...existing,
        minutes_json: minutes,
        minutes_revision: nextRevision,
        minutes_cid: pinnedMinutes.cid,
        minutes_sha256: minutesSha256,
      });
      return { session, minutes };
    },

    async anchorSession(sessionId, {
      approval = null,
      txHash = "",
      blockHeight = null,
      pinnerConfirmations = 2,
    } = {}) {
      const repo = resolveStore();
      const existing = await repo.getSession(sessionId);
      if (!existing) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      assertGovernanceTransition(existing.state, "anchored");

      if (!approval || !approval.signer_account || !approval.signature) {
        throw engineError("GOVERNANCE_APPROVAL_REQUIRED", "Founder wallet approval signature is required before anchoring.");
      }
      const authority = existing.packet_json?.authority || {};
      const authorizedAccounts = Array.isArray(authority.authorized_accounts) ? authority.authorized_accounts : [];
      if (!authorizedAccounts.includes(approval.signer_account)) {
        throw engineError("GOVERNANCE_APPROVAL_UNAUTHORIZED", "Approval signer is not in authorized_accounts.", 403);
      }
      if (Number(pinnerConfirmations) < 2) {
        throw engineError(
          "GOVERNANCE_PINNER_CONFIRMATIONS_INSUFFICIENT",
          "Anchoring requires confirmation on at least 2 independent IPFS pinners/gateways."
        );
      }

      const nowMs = now();
      const currentMinutes = existing.minutes_json || {};
      const { minutes: signedMinutes, sha256: minutesSha256 } = await buildGovernanceMinutes({
        sessionId: existing.session_id,
        revision: Number(existing.minutes_revision || 1),
        state: "anchored",
        authority,
        openingPacketCid: existing.packet_cid,
        transcript: existing.transcript_json,
        transcriptCid: existing.transcript_cid,
        summary: currentMinutes.summary || existing.summary,
        previousDeliverablesReview: currentMinutes.previous_deliverables_review || [],
        decisions: currentMinutes.decisions || [],
        nextDeliverables: currentMinutes.next_deliverables || [],
        communityInput: currentMinutes.community_input || [],
        approvals: [approval],
        finalizedAtUnixMs: nowMs,
      });
      const pinnedSignedMinutes = await pinJson(signedMinutes, { name: `${existing.session_id}-minutes-signed.json` });

      const packetPtr = encodeGovernancePointerV5({ cid: existing.packet_cid, sessionId: existing.session_id });
      const transcriptPtr = encodeGovernancePointerV5({ cid: existing.transcript_cid, sessionId: existing.session_id });
      const minutesPtr = encodeGovernancePointerV5({ cid: pinnedSignedMinutes.cid, sessionId: existing.session_id });

      const anchorSpecs = [
        {
          session_id: existing.session_id,
          artifact_schema: GOVERNANCE_SCHEMAS.PACKET,
          sha256: existing.packet_sha256,
          cid: existing.packet_cid,
          memo_hex: packetPtr.memo_hex,
          tx_hash: txHash,
          block_height: blockHeight,
          pinner_confirmations: pinnerConfirmations,
          status: txHash ? "confirmed" : "pending",
        },
        {
          session_id: existing.session_id,
          artifact_schema: GOVERNANCE_SCHEMAS.TRANSCRIPT,
          sha256: existing.transcript_root_sha256,
          cid: existing.transcript_cid,
          memo_hex: transcriptPtr.memo_hex,
          tx_hash: txHash,
          block_height: blockHeight,
          pinner_confirmations: pinnerConfirmations,
          status: txHash ? "confirmed" : "pending",
        },
        {
          session_id: existing.session_id,
          artifact_schema: GOVERNANCE_SCHEMAS.MINUTES,
          sha256: minutesSha256,
          cid: pinnedSignedMinutes.cid,
          memo_hex: minutesPtr.memo_hex,
          tx_hash: txHash,
          block_height: blockHeight,
          pinner_confirmations: pinnerConfirmations,
          status: txHash ? "confirmed" : "pending",
        },
      ];
      const storedAnchors = [];
      for (const spec of anchorSpecs) {
        storedAnchors.push(await repo.upsertAnchor(spec));
      }

      // Persist next deliverables for automatic carry-over into the NEXT session (strictly zero PFT bounties!).
      if (signedMinutes.next_deliverables.length > 0) {
        await repo.upsertDeliverables(existing.session_id, signedMinutes.next_deliverables);
      }

      const hasFlaggedRuling = signedMinutes.decisions.some((d) => d.run_deterministic_ruling === true);
      const session = await repo.saveSession({
        ...existing,
        state: "anchored",
        proto_state: hasFlaggedRuling ? "SESSION_STATE_RULING_PENDING" : GOVERNANCE_PROTO_STATE_MAP.anchored,
        minutes_json: signedMinutes,
        minutes_cid: pinnedSignedMinutes.cid,
        minutes_sha256: minutesSha256,
        anchors_json: storedAnchors,
        ruling_state: hasFlaggedRuling ? "ruling_pending" : "none",
        anchored_at: new Date(nowMs).toISOString(),
      });
      return { session, minutes: signedMinutes, anchors: storedAnchors };
    },

    async archiveSession(sessionId) {
      const repo = resolveStore();
      const existing = await repo.getSession(sessionId);
      if (!existing) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      assertGovernanceTransition(existing.state, "archived");
      const nowMs = now();
      await updateChannelStatus(existing.channel_id, { status: "archived" });
      const session = await repo.saveSession({
        ...existing,
        state: "archived",
        proto_state: GOVERNANCE_PROTO_STATE_MAP.archived,
        archived_at: new Date(nowMs).toISOString(),
      });
      return { session };
    },

    async exportVerificationBundle(sessionId) {
      const repo = resolveStore();
      const session = await repo.getSession(sessionId);
      if (!session) throw engineError("GOVERNANCE_SESSION_NOT_FOUND", `Session "${sessionId}" not found.`, 404);
      const { raw_events_by_id: rawEventsById = {}, ...cleanTranscript } = session.transcript_json || {};
      const anchors = (await repo.listAnchors(sessionId)).length
        ? await repo.listAnchors(sessionId)
        : (session.anchors_json || []);
      return {
        bundle_schema: "pf.governance.verification_bundle.v1",
        session_id: session.session_id,
        state: session.state,
        snapshot: session.snapshot_json,
        snapshot_cid: session.snapshot_cid,
        snapshot_sha256: session.snapshot_sha256,
        eligible_pubkeys: session.eligible_pubkeys_json,
        eligible_pubkeys_cid: session.eligible_pubkeys_cid,
        eligible_pubkeys_sha256: session.eligible_pubkeys_sha256,
        packet: session.packet_json,
        packet_cid: session.packet_cid,
        packet_sha256: session.packet_sha256,
        transcript: cleanTranscript,
        transcript_cid: session.transcript_cid,
        raw_events_by_id: rawEventsById,
        minutes: session.minutes_json,
        minutes_cid: session.minutes_cid,
        minutes_sha256: session.minutes_sha256,
        anchors,
      };
    },
  };
}
