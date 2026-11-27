import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transactionCommand } from "../db/pool.js";
import { assertNoAutoBountyFields, GOVERNANCE_PROTO_STATE_MAP } from "../../shared/hive-governance.js";

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createInMemoryGovernanceStore() {
  const sessions = new Map();
  const deliverables = new Map();
  const anchors = new Map();
  let nextNumber = 1;

  return {
    async nextSessionNumber() {
      return nextNumber++;
    },
    async getSession(sessionId) {
      const row = sessions.get(sessionId);
      return row ? cloneJson(row) : null;
    },
    async listSessions({ limit = 50, state = "" } = {}) {
      let rows = [...sessions.values()];
      if (state) rows = rows.filter((row) => row.state === state);
      rows.sort((a, b) => Number(b.session_number) - Number(a.session_number));
      return rows.slice(0, limit).map(cloneJson);
    },
    async getLatestCompletedSession() {
      const completed = [...sessions.values()]
        .filter((row) => row.state === "anchored" || row.state === "archived")
        .sort((a, b) => Number(b.session_number) - Number(a.session_number));
      return completed[0] ? cloneJson(completed[0]) : null;
    },
    async saveSession(session) {
      assertNoAutoBountyFields(session, "session");
      const stored = cloneJson({
        ...session,
        proto_state: session.proto_state || GOVERNANCE_PROTO_STATE_MAP[session.state] || "SESSION_STATE_DRAFT",
        updated_at: new Date().toISOString(),
      });
      sessions.set(stored.session_id, stored);
      return cloneJson(stored);
    },
    async upsertDeliverables(originSessionId, items = []) {
      assertNoAutoBountyFields(items, "deliverables");
      for (const item of items) {
        const record = {
          id: item.deliverable_id,
          origin_session_id: originSessionId,
          reviewed_in_session_id: item.reviewed_in_session_id || "",
          title: item.title,
          description: item.description || "",
          owner: item.owner || "",
          target_date: item.target_date || "",
          cited_event_ids: item.cited_event_ids || [],
          status: item.status || "open",
          evidence_note: item.evidence_note || "",
          evidence_refs: item.evidence_refs || [],
        };
        deliverables.set(record.id, cloneJson(record));
      }
      return [...deliverables.values()].filter((d) => d.origin_session_id === originSessionId).map(cloneJson);
    },
    async updateDeliverableReviews(reviewedInSessionId, reviews = []) {
      assertNoAutoBountyFields(reviews, "deliverableReviews");
      for (const review of reviews) {
        const existing = deliverables.get(review.deliverable_id);
        if (existing) {
          deliverables.set(review.deliverable_id, cloneJson({
            ...existing,
            reviewed_in_session_id: reviewedInSessionId,
            status: review.status,
            evidence_note: review.evidence_note || existing.evidence_note,
            evidence_refs: review.evidence_refs || existing.evidence_refs,
          }));
        }
      }
    },
    async listOpenDeliverables(originSessionId = "") {
      return [...deliverables.values()]
        .filter((d) => (!originSessionId || d.origin_session_id === originSessionId) && (d.status === "open" || d.status === "in_progress" || d.status === "not_done"))
        .map(cloneJson);
    },
    async upsertAnchor(anchor) {
      const key = `${anchor.session_id}::${anchor.artifact_schema}::${anchor.sha256}`;
      const existing = anchors.get(key);
      const record = cloneJson({
        id: existing?.id || anchor.id || `gov_anchor_${randomUUID()}`,
        ...existing,
        ...anchor,
        updated_at: new Date().toISOString(),
      });
      anchors.set(key, record);
      return cloneJson(record);
    },
    async listAnchors(sessionId) {
      return [...anchors.values()].filter((a) => a.session_id === sessionId).map(cloneJson);
    },
  };
}

export function createPostgresGovernanceStore() {
  return {
    async nextSessionNumber() {
      const res = await query("SELECT COALESCE(MAX(session_number), 0) + 1 AS next_num FROM hive_governance_sessions");
      return Number(res.rows[0]?.next_num || 1);
    },
    async getSession(sessionId) {
      const res = await query("SELECT * FROM hive_governance_sessions WHERE session_id = $1", [sessionId]);
      return res.rows[0] || null;
    },
    async listSessions({ limit = 50, state = "" } = {}) {
      const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
      if (state) {
        const res = await query(
          "SELECT * FROM hive_governance_sessions WHERE state = $1 ORDER BY session_number DESC LIMIT $2",
          [state, bounded]
        );
        return res.rows;
      }
      const res = await query(
        "SELECT * FROM hive_governance_sessions ORDER BY session_number DESC LIMIT $1",
        [bounded]
      );
      return res.rows;
    },
    async getLatestCompletedSession() {
      const res = await query(
        "SELECT * FROM hive_governance_sessions WHERE state IN ('anchored', 'archived') ORDER BY session_number DESC LIMIT 1"
      );
      return res.rows[0] || null;
    },
    async saveSession(session) {
      assertNoAutoBountyFields(session, "session");
      const protoState = session.proto_state || GOVERNANCE_PROTO_STATE_MAP[session.state] || "SESSION_STATE_DRAFT";
      const res = await query(
        `INSERT INTO hive_governance_sessions (
          session_id, session_number, channel_id, state, proto_state, title, summary, chain_id,
          founder_account_id, founder_l1_address, founder_nostr_pubkey,
          posting_policy, facilitator_mode, duration_minutes, rate_limit_seconds,
          max_non_founder_messages, max_facilitator_turns, reserved_founder_turns,
          previous_session_id, eligible_pubkeys_json, eligible_pubkeys_cid, eligible_pubkeys_sha256,
          snapshot_json, snapshot_cid, snapshot_sha256,
          packet_json, packet_cid, packet_sha256,
          transcript_json, transcript_cid, transcript_root_sha256,
          minutes_json, minutes_revision, minutes_cid, minutes_sha256,
          anchors_json, ruling_state, ruling_anchors_json,
          scheduled_at, opened_at, scheduled_close_at, closed_at, anchored_at, archived_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20::jsonb,$21,$22,$23::jsonb,$24,$25,$26::jsonb,$27,$28,$29::jsonb,$30,$31,
          $32::jsonb,$33,$34,$35,$36::jsonb,$37,$38::jsonb,$39,$40,$41,$42,$43,$44,now()
        )
        ON CONFLICT (session_id) DO UPDATE SET
          state = EXCLUDED.state,
          proto_state = EXCLUDED.proto_state,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          eligible_pubkeys_json = EXCLUDED.eligible_pubkeys_json,
          eligible_pubkeys_cid = EXCLUDED.eligible_pubkeys_cid,
          eligible_pubkeys_sha256 = EXCLUDED.eligible_pubkeys_sha256,
          snapshot_json = EXCLUDED.snapshot_json,
          snapshot_cid = EXCLUDED.snapshot_cid,
          snapshot_sha256 = EXCLUDED.snapshot_sha256,
          packet_json = EXCLUDED.packet_json,
          packet_cid = EXCLUDED.packet_cid,
          packet_sha256 = EXCLUDED.packet_sha256,
          transcript_json = EXCLUDED.transcript_json,
          transcript_cid = EXCLUDED.transcript_cid,
          transcript_root_sha256 = EXCLUDED.transcript_root_sha256,
          minutes_json = EXCLUDED.minutes_json,
          minutes_revision = EXCLUDED.minutes_revision,
          minutes_cid = EXCLUDED.minutes_cid,
          minutes_sha256 = EXCLUDED.minutes_sha256,
          anchors_json = EXCLUDED.anchors_json,
          ruling_state = EXCLUDED.ruling_state,
          ruling_anchors_json = EXCLUDED.ruling_anchors_json,
          opened_at = COALESCE(EXCLUDED.opened_at, hive_governance_sessions.opened_at),
          scheduled_close_at = COALESCE(EXCLUDED.scheduled_close_at, hive_governance_sessions.scheduled_close_at),
          closed_at = COALESCE(EXCLUDED.closed_at, hive_governance_sessions.closed_at),
          anchored_at = COALESCE(EXCLUDED.anchored_at, hive_governance_sessions.anchored_at),
          archived_at = COALESCE(EXCLUDED.archived_at, hive_governance_sessions.archived_at),
          updated_at = now()
        RETURNING *`,
        [
          session.session_id,
          session.session_number,
          session.channel_id,
          session.state,
          protoState,
          session.title,
          session.summary || "",
          session.chain_id || "postfiat-l1-v2",
          session.founder_account_id,
          session.founder_l1_address || "",
          session.founder_nostr_pubkey || "",
          session.posting_policy || "all_members",
          session.facilitator_mode || "agenda",
          session.duration_minutes || 30,
          session.rate_limit_seconds || 15,
          session.max_non_founder_messages || 10,
          session.max_facilitator_turns || 25,
          session.reserved_founder_turns || 15,
          session.previous_session_id || "",
          JSON.stringify(session.eligible_pubkeys_json || {}),
          session.eligible_pubkeys_cid || "",
          session.eligible_pubkeys_sha256 || "",
          JSON.stringify(session.snapshot_json || {}),
          session.snapshot_cid || "",
          session.snapshot_sha256 || "",
          JSON.stringify(session.packet_json || {}),
          session.packet_cid || "",
          session.packet_sha256 || "",
          JSON.stringify(session.transcript_json || {}),
          session.transcript_cid || "",
          session.transcript_root_sha256 || "",
          JSON.stringify(session.minutes_json || {}),
          Number(session.minutes_revision || 0),
          session.minutes_cid || "",
          session.minutes_sha256 || "",
          JSON.stringify(session.anchors_json || []),
          session.ruling_state || "none",
          JSON.stringify(session.ruling_anchors_json || []),
          session.scheduled_at || new Date().toISOString(),
          session.opened_at || null,
          session.scheduled_close_at || null,
          session.closed_at || null,
          session.anchored_at || null,
          session.archived_at || null,
        ]
      );
      return res.rows[0];
    },
    async upsertDeliverables(originSessionId, items = []) {
      assertNoAutoBountyFields(items, "deliverables");
      return transactionCommand(async () => {
        for (const item of items) {
          await query(
            `INSERT INTO hive_governance_deliverables (
              id, origin_session_id, reviewed_in_session_id, title, description,
              owner, target_date, cited_event_ids, status, evidence_note, evidence_refs
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              description = EXCLUDED.description,
              owner = EXCLUDED.owner,
              target_date = EXCLUDED.target_date,
              cited_event_ids = EXCLUDED.cited_event_ids,
              updated_at = now()`,
            [
              item.deliverable_id,
              originSessionId,
              item.reviewed_in_session_id || "",
              item.title,
              item.description || "",
              item.owner || "",
              item.target_date || "",
              JSON.stringify(item.cited_event_ids || []),
              item.status || "open",
              item.evidence_note || "",
              JSON.stringify(item.evidence_refs || []),
            ]
          );
        }
        const res = await query("SELECT * FROM hive_governance_deliverables WHERE origin_session_id = $1", [originSessionId]);
        return res.rows;
      });
    },
    async updateDeliverableReviews(reviewedInSessionId, reviews = []) {
      assertNoAutoBountyFields(reviews, "deliverableReviews");
      await transactionCommand(async () => {
        for (const review of reviews) {
          await query(
            `UPDATE hive_governance_deliverables
             SET reviewed_in_session_id = $2,
                 status = $3,
                 evidence_note = $4,
                 evidence_refs = $5::jsonb,
                 updated_at = now()
             WHERE id = $1`,
            [
              review.deliverable_id,
              reviewedInSessionId,
              review.status,
              review.evidence_note || "",
              JSON.stringify(review.evidence_refs || []),
            ]
          );
        }
      });
    },
    async listOpenDeliverables(originSessionId = "") {
      if (originSessionId) {
        const res = await query(
          "SELECT * FROM hive_governance_deliverables WHERE origin_session_id = $1 AND status IN ('open', 'in_progress', 'not_done') ORDER BY created_at ASC",
          [originSessionId]
        );
        return res.rows;
      }
      const res = await query(
        "SELECT * FROM hive_governance_deliverables WHERE status IN ('open', 'in_progress', 'not_done') ORDER BY created_at ASC"
      );
      return res.rows;
    },
    async upsertAnchor(anchor) {
      const id = anchor.id || `gov_anchor_${randomUUID()}`;
      const res = await query(
        `INSERT INTO hive_governance_anchors (
          id, session_id, artifact_schema, sha256, cid, memo_hex,
          tx_hash, block_height, pinner_confirmations, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (session_id, artifact_schema, sha256) DO UPDATE SET
          cid = EXCLUDED.cid,
          memo_hex = CASE WHEN EXCLUDED.memo_hex <> '' THEN EXCLUDED.memo_hex ELSE hive_governance_anchors.memo_hex END,
          tx_hash = CASE WHEN EXCLUDED.tx_hash <> '' THEN EXCLUDED.tx_hash ELSE hive_governance_anchors.tx_hash END,
          block_height = COALESCE(EXCLUDED.block_height, hive_governance_anchors.block_height),
          pinner_confirmations = GREATEST(hive_governance_anchors.pinner_confirmations, EXCLUDED.pinner_confirmations),
          status = EXCLUDED.status,
          updated_at = now()
        RETURNING *`,
        [
          id,
          anchor.session_id,
          anchor.artifact_schema,
          anchor.sha256,
          anchor.cid,
          anchor.memo_hex || "",
          anchor.tx_hash || "",
          anchor.block_height ?? null,
          Number(anchor.pinner_confirmations || 0),
          anchor.status || "pending",
        ]
      );
      return res.rows[0];
    },
    async listAnchors(sessionId) {
      const res = await query(
        "SELECT * FROM hive_governance_anchors WHERE session_id = $1 ORDER BY created_at ASC",
        [sessionId]
      );
      return res.rows;
    },
  };
}

let defaultMemoryStore = null;

export function getDefaultGovernanceStore() {
  if (databaseEnabled()) return createPostgresGovernanceStore();
  if (!defaultMemoryStore) defaultMemoryStore = createInMemoryGovernanceStore();
  return defaultMemoryStore;
}
