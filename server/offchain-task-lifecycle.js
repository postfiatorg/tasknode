import { randomUUID, createHash } from "node:crypto";
import { transaction } from "./db/pool.js";
import { signatureRecord, taskTransitionSignatureRequired } from "./task-transition-signatures.js";

const DIRECT_WRITE_SOURCE = "direct_write";
const TERMINAL_PROJECTION_STATUSES = Object.freeze(["refused", "cancelled", "rewarded"]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function truthyEnv(value = "") {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function offchainTaskLifecycleEnabled(env = process.env) {
  return truthyEnv(env.TASKNODE_OFFCHAIN_TASK_LIFECYCLE);
}

export function offchainTaskLifecycleDualWriteEnabled(env = process.env) {
  return truthyEnv(env.TASKNODE_OFFCHAIN_TASK_LIFECYCLE_DUAL_WRITE);
}

export function transitionForTaskAction(action = "") {
  const normalized = safeText(action, 40).toLowerCase();
  if (normalized === "accept") return "accepted";
  if (normalized === "refuse") return "refused";
  if (normalized === "cancel") return "cancelled";
  return "";
}

export function transitionForSubmissionMode(mode = "") {
  const normalized = safeText(mode, 80).toLowerCase();
  if (normalized === "verification_response") return "verification_response_submitted";
  if (normalized === "initial_submission") return "submitted";
  return "";
}

function eventSchemaForTransition(transition = "") {
  if (transition === "submitted") return "pf.task.submission.v1";
  if (transition === "verification_response_submitted") return "pf.task.verification_response.v1";
  return "pf.task.update.v1";
}

function sourceRefForEvent(eventId = "") {
  return `postgres:${eventId}`;
}

function txRefForEvent(eventId = "") {
  return `offchain:${eventId}`;
}

export function offchainTaskEventPayload({
  accountId = "",
  walletAddress = "",
  task = {},
  transition = "",
  payload = {},
  metadata = {},
  dualWrite = false,
} = {}) {
  const schema = eventSchemaForTransition(transition);
  const providedPayload = safeObject(
    payload?.offchainPayload || payload?.offchain_payload || payload?.eventPayload || payload?.event_payload
  );
  const eventId = safeText(providedPayload.event_id || providedPayload.eventId, 180) || `task_evt_${randomUUID()}`;
  const recordedAt = nowIso();
  const eventPayload = {
    ...providedPayload,
    event_id: eventId,
    schema,
    task_id: safeText(providedPayload.task_id || providedPayload.taskId || task.task_id, 180),
    account_id: safeText(accountId, 180),
    wallet_address: safeText(walletAddress, 180),
    transition,
    previous_status: safeText(task.status, 80),
    request_id: safeText(task.request_id, 180),
    cid: safeText(payload?.cid || payload?.eventCid || payload?.event_cid || providedPayload.cid, 240),
    evidence_sha256:
      safeText(payload?.evidenceSha256 || payload?.evidence_sha256 || providedPayload.evidence_sha256, 180),
    recorded_at: recordedAt,
    metadata: safeObject(metadata),
  };
  const payloadDigest = sha256(JSON.stringify(eventPayload));
  const signatureJson = signatureRecord({
    payload: eventPayload,
    signature: payload?.actorSignature || payload?.actor_signature || providedPayload.actor_signature || {},
    required: taskTransitionSignatureRequired(),
  });
  return {
    eventId,
    schema,
    sourceTxHash: txRefForEvent(eventId),
    sourceCid: safeText(eventPayload.cid, 240) || sourceRefForEvent(eventId),
    eventDigest: payloadDigest,
    payloadJson: eventPayload,
    signatureJson,
    pointerJson: {
      source: DIRECT_WRITE_SOURCE,
      offchain: true,
      schema,
      task_id: eventPayload.task_id,
      cid: eventPayload.cid,
    },
    provenanceJson: {
      source: DIRECT_WRITE_SOURCE,
      mode: "server_authoritative_postgres",
      featureFlag: "TASKNODE_OFFCHAIN_TASK_LIFECYCLE",
      dualWrite: Boolean(dualWrite),
      previousStatus: eventPayload.previous_status,
      transition,
      recordedAt,
    },
  };
}

export async function applyOffchainTaskTransitionWithClient(client, {
  accountId = "",
  walletAddress = "",
  task = {},
  transition = "",
  payload = {},
  metadata = {},
  dualWrite = false,
} = {}) {
  const normalizedTransition = safeText(transition, 80);
  if (!normalizedTransition) throw new Error("offchain_transition_required");
  const event = offchainTaskEventPayload({
    accountId,
    walletAddress,
    task,
    transition: normalizedTransition,
    payload,
    metadata,
    dualWrite,
  });
  const eventInsert = await client.query(
    `
      INSERT INTO task_events (
        id,
        task_id,
        account_id,
        wallet_address,
        event_type,
        source_tx_hash,
        source_cid,
        event_digest,
        payload_json,
        pointer_json,
        write_source,
        provenance_json,
        signature_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13::jsonb)
      ON CONFLICT (task_id, event_type, source_tx_hash, source_cid)
      DO NOTHING
      RETURNING id
    `,
    [
      event.eventId,
      safeText(task.task_id, 180),
      safeText(accountId, 180),
      safeText(walletAddress, 180),
      event.schema,
      event.sourceTxHash,
      event.sourceCid,
      event.eventDigest,
      JSON.stringify(event.payloadJson),
      JSON.stringify(event.pointerJson),
      DIRECT_WRITE_SOURCE,
      JSON.stringify(event.provenanceJson),
      JSON.stringify(event.signatureJson),
    ]
  );
  const eventInserted = eventInsert.rowCount > 0;

  const metadataPatch = {
    offchainLifecycle: {
      enabled: true,
      lastEventId: event.eventId,
      lastTransition: normalizedTransition,
      lastRecordedAt: event.provenanceJson.recordedAt,
      lastEventInserted: eventInserted,
      lastSignatureVerified: event.signatureJson?.verification?.verified === true,
      dualWrite: Boolean(dualWrite),
    },
  };
  const projectionUpdate = await client.query(
    `
      WITH current_projection AS (
        SELECT task_id,
               (
                 COALESCE(metadata_json, '{}'::jsonb) ? 'agent_cancelled'
                 OR (status = ANY($10::text[]) AND status <> $2)
               ) AS preserve_terminal
        FROM task_projections
        WHERE task_id = $1
          AND account_id = $7
          AND subject_wallet = $8
        LIMIT 1
      )
      UPDATE task_projections
         SET status = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.status
               ELSE $2
             END,
             event_count = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.event_count
               ELSE COALESCE(event_count, 0) + CASE WHEN $9::boolean THEN 1 ELSE 0 END
             END,
             last_event_tx_hash = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.last_event_tx_hash
               ELSE $3
             END,
             last_event_cid = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.last_event_cid
               ELSE $4
             END,
             last_event_at = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.last_event_at
               ELSE now()
             END,
             source = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.source
               ELSE $5
             END,
             metadata_json = COALESCE(metadata_json, '{}'::jsonb) ||
               CASE
                 WHEN current_projection.preserve_terminal THEN
                   jsonb_build_object(
                     'offchainLifecycleTerminalGuard',
                     jsonb_build_object(
                       'preserved', true,
                       'lastSkippedEventId', $11::text,
                       'lastSkippedTransition', $2::text,
                       'lastSkippedAt', $12::text,
                       'reason',
                         CASE
                           WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
                           THEN 'agent_cancelled_terminal'
                           ELSE 'terminal_status'
                         END
                     )
                   )
                 ELSE $6::jsonb
               END,
             updated_at = now()
       FROM current_projection
       WHERE task_projections.task_id = current_projection.task_id
       RETURNING task_projections.task_id,
                 task_projections.status,
                 task_projections.event_count,
                 task_projections.updated_at,
                 current_projection.preserve_terminal AS terminal_preserved
    `,
    [
      safeText(task.task_id, 180),
      normalizedTransition,
      event.sourceTxHash,
      event.sourceCid,
      DIRECT_WRITE_SOURCE,
      JSON.stringify(metadataPatch),
      safeText(accountId, 180),
      safeText(walletAddress, 180),
      eventInserted,
      TERMINAL_PROJECTION_STATUSES,
      event.eventId,
      event.provenanceJson.recordedAt,
    ]
  );
  if (projectionUpdate.rowCount < 1) {
    throw new Error("offchain_task_projection_update_missed");
  }
  return {
    ok: true,
    source: DIRECT_WRITE_SOURCE,
    transition: normalizedTransition,
    eventInserted,
    terminalPreserved: projectionUpdate.rows[0]?.terminal_preserved === true,
    event,
  };
}

export async function applyOffchainTaskTransition(input = {}) {
  let result = null;
  await transaction(async (client) => {
    result = await applyOffchainTaskTransitionWithClient(client, input);
  });
  return result;
}
