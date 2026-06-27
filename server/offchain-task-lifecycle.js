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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
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

function eventSchemaForTransition(transition = "", providedPayload = {}) {
  const providedSchema = safeText(providedPayload.schema, 120);
  if (providedSchema.startsWith("pf.")) return providedSchema;
  if (transition === "proposed") return "pf.task.offer.v1";
  if (transition === "submitted") return "pf.task.submission.v1";
  if (transition === "verification_response_submitted") return "pf.task.verification_response.v1";
  if (transition === "rewarded") return "pf.reward.v1";
  return "pf.task.update.v1";
}

function sourceRefForEvent(eventId = "") {
  return `postgres:${eventId}`;
}

function txRefForEvent(eventId = "", payload = {}, providedPayload = {}) {
  return safeText(
    payload?.sourceTxHash ||
      payload?.source_tx_hash ||
      payload?.txHash ||
      payload?.tx_hash ||
      providedPayload.sourceTxHash ||
      providedPayload.source_tx_hash ||
      providedPayload.txHash ||
      providedPayload.tx_hash,
    240
  ) || `offchain:${eventId}`;
}

function cidRefForEvent(eventId = "", payload = {}, providedPayload = {}, eventPayload = {}) {
  return safeText(
    payload?.sourceCid ||
      payload?.source_cid ||
      payload?.cid ||
      payload?.eventCid ||
      payload?.event_cid ||
      providedPayload.sourceCid ||
      providedPayload.source_cid ||
      providedPayload.cid ||
      eventPayload.cid,
    240
  ) || sourceRefForEvent(eventId);
}

function isSubmissionTransition(transition = "") {
  return ["submitted", "verification_response_submitted"].includes(safeText(transition, 80));
}

function directEvidenceItem(item = {}, fallback = {}) {
  const source = safeObject(item);
  const fallbackSource = safeObject(fallback);
  const rawResponse = typeof source.response === "string" ? source.response : "";
  const rawEvidence = typeof source.evidence === "string" ? source.evidence : "";
  const rawSubmission = typeof source.submission === "string" ? source.submission : "";
  const artifactType = safeText(
    source.artifact_type ||
      source.artifactType ||
      source.evidence_type ||
      source.evidenceType ||
      source.method ||
      fallbackSource.artifact_type ||
      fallbackSource.artifactType ||
      fallbackSource.evidence_type ||
      fallbackSource.evidenceType ||
      fallbackSource.method ||
      "text",
    80
  ) || "text";
  return {
    artifact_type: artifactType,
    value: safeText(
      source.value ||
        source.text ||
        source.body ||
        source.response_text ||
        source.responseText ||
        rawResponse ||
        rawEvidence ||
        rawSubmission ||
        fallbackSource.value ||
        fallbackSource.text ||
        fallbackSource.response_text ||
        fallbackSource.responseText ||
        "",
      120000
    ),
    notes: safeText(source.notes || source.note || fallbackSource.notes || fallbackSource.note || "", 8000),
    file: safeObject(source.file || source.processedFile || source.processed_file),
  };
}

function itemHasEvidence(item = {}) {
  return Boolean(
    safeText(item.value, 120000) ||
      safeText(item.notes, 8000) ||
      Object.keys(safeObject(item.file)).length > 0
  );
}

function evidenceTextFromItem(item = {}) {
  return safeText(
    item.value ||
      item.notes ||
      safeObject(item.file).description ||
      safeObject(item.file).text ||
      "",
    120000
  );
}

function directEvidenceItemsFromPayload(payload = {}, providedPayload = {}) {
  const items = [
    ...safeArray(payload.evidence_items),
    ...safeArray(payload.evidenceItems),
    ...safeArray(providedPayload.evidence_items),
    ...safeArray(providedPayload.evidenceItems),
  ];
  if (items.length > 0) {
    return items.slice(0, 2).map((item, index) => ({
      index: Number(item?.index || index + 1),
      ...directEvidenceItem(item, payload),
    })).filter(itemHasEvidence);
  }
  const item = directEvidenceItem(payload, providedPayload);
  return itemHasEvidence(item) ? [item] : [];
}

function normalizeDirectSubmissionPayload({ payload = {}, providedPayload = {}, transition = "" } = {}) {
  if (!isSubmissionTransition(transition)) return providedPayload;
  const normalized = { ...providedPayload };
  const artifactType = safeText(
    normalized.artifact_type ||
      normalized.artifactType ||
      normalized.evidence_type ||
      normalized.evidenceType ||
      payload.artifact_type ||
      payload.artifactType ||
      payload.evidence_type ||
      payload.evidenceType ||
      payload.method ||
      "text",
    80
  ) || "text";

  if (typeof normalized.evidence === "string") {
    normalized.evidence = directEvidenceItem({ value: normalized.evidence, artifact_type: artifactType }, payload);
  }
  if (typeof normalized.submission === "string") {
    normalized.submission = directEvidenceItem({ value: normalized.submission, artifact_type: artifactType }, payload);
  }
  if (typeof normalized.response === "string") {
    normalized.response_text = safeText(normalized.response_text || normalized.response, 120000);
    normalized.response = directEvidenceItem({ value: normalized.response, artifact_type: artifactType }, payload);
  }

  const providedHasStructuredEvidence = Boolean(
    safeObject(normalized.evidence).artifact_type ||
      safeObject(normalized.submission).artifact_type ||
      safeObject(normalized.response).artifact_type ||
      safeText(normalized.response_text, 120000) ||
      safeArray(normalized.evidence_items).length > 0
  );
  if (providedHasStructuredEvidence) return normalized;

  const evidenceItems = directEvidenceItemsFromPayload(payload, providedPayload);
  if (evidenceItems.length < 1) return normalized;

  normalized.artifact_type = evidenceItems.length > 1 ? "mixed" : evidenceItems[0].artifact_type || artifactType;
  normalized.evidence_type = normalized.artifact_type;
  normalized.evidence_count = evidenceItems.length;
  normalized.evidence_items = evidenceItems;
  const primaryEvidence =
    evidenceItems.length === 1
      ? evidenceItems[0]
      : {
          artifact_type: "mixed",
          notes: safeText(payload.notes || payload.note || "", 8000),
          evidence_items: evidenceItems,
        };
  if (transition === "verification_response_submitted") {
    normalized.response = primaryEvidence;
    normalized.response_text = evidenceItems.map(evidenceTextFromItem).filter(Boolean).join("\n\n");
  } else {
    normalized.evidence = primaryEvidence;
    normalized.submission = primaryEvidence;
  }
  return normalized;
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
  const rawProvidedPayload = safeObject(
    payload?.offchainPayload || payload?.offchain_payload || payload?.eventPayload || payload?.event_payload
  );
  const providedPayload = normalizeDirectSubmissionPayload({
    payload,
    providedPayload: rawProvidedPayload,
    transition,
  });
  const schema = eventSchemaForTransition(transition, providedPayload);
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
  const result = {
    eventId,
    schema,
    sourceTxHash: txRefForEvent(eventId, payload, providedPayload),
    sourceCid: cidRefForEvent(eventId, payload, providedPayload, eventPayload),
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
  return result;
}

function taskOfferProjectionMetadata({ event = {}, offerPayload = {}, metadata = {} } = {}) {
  return {
    generatedTask: safeObject(offerPayload),
    taskgen: safeObject(offerPayload.generation),
    cids: {
      offer: event.sourceCid,
    },
    txs: {
      offer: {
        tx_hash: event.sourceTxHash,
        source: DIRECT_WRITE_SOURCE,
      },
    },
    offchainLifecycle: {
      enabled: true,
      lastEventId: event.eventId,
      lastTransition: "proposed",
      lastRecordedAt: event.provenanceJson.recordedAt,
      lastEventInserted: true,
      dualWrite: false,
    },
    ...safeObject(metadata),
  };
}

export async function applyOffchainTaskOfferWithClient(client, {
  accountId = "",
  walletAddress = "",
  offerPayload = {},
  metadata = {},
} = {}) {
  const payload = safeObject(offerPayload);
  const taskId = safeText(payload.task_id, 180);
  const subjectWallet = safeText(walletAddress || payload.subject_wallet, 180);
  if (!taskId) throw new Error("offchain_offer_task_id_required");
  if (!subjectWallet) throw new Error("offchain_offer_subject_wallet_required");
  const task = {
    task_id: taskId,
    request_id: safeText(payload.request_id, 180),
    status: "",
  };
  const event = offchainTaskEventPayload({
    accountId,
    walletAddress: subjectWallet,
    task,
    transition: "proposed",
    payload: { offchainPayload: payload },
    metadata,
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
      taskId,
      safeText(accountId, 180),
      subjectWallet,
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
  const metadataJson = taskOfferProjectionMetadata({
    event: {
      ...event,
      provenanceJson: {
        ...event.provenanceJson,
        lastEventInserted: eventInserted,
      },
    },
    offerPayload: payload,
    metadata,
  });
  metadataJson.offchainLifecycle.lastEventInserted = eventInserted;
  const projectionResult = await client.query(
    `
      INSERT INTO task_projections (
        task_id,
        account_id,
        subject_wallet,
        authority_wallet,
        allocation_wallet,
        request_id,
        status,
        title,
        description,
        task_kind,
        reward_offer_pft,
        reward_actual_pft,
        request_bundle_cid,
        context_cid,
        submission_type,
        submission_requirement_text,
        verification_policy_json,
        accept_by,
        deadline_at,
        event_count,
        last_event_tx_hash,
        last_event_cid,
        source,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 'proposed', $7, $8, $9,
        $10, 0, $11, $12, $13, $14, $15::jsonb, $16, $17,
        CASE WHEN $24::boolean THEN 1 ELSE 0 END, $18, $19, $20, $21::jsonb
      )
      ON CONFLICT (task_id)
      DO UPDATE SET
        account_id = EXCLUDED.account_id,
        subject_wallet = EXCLUDED.subject_wallet,
        authority_wallet = EXCLUDED.authority_wallet,
        allocation_wallet = EXCLUDED.allocation_wallet,
        request_id = EXCLUDED.request_id,
        status = CASE
          WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
            OR task_projections.status = ANY($22::text[])
          THEN task_projections.status
          ELSE EXCLUDED.status
        END,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        task_kind = EXCLUDED.task_kind,
        reward_offer_pft = EXCLUDED.reward_offer_pft,
        request_bundle_cid = EXCLUDED.request_bundle_cid,
        context_cid = EXCLUDED.context_cid,
        submission_type = EXCLUDED.submission_type,
        submission_requirement_text = EXCLUDED.submission_requirement_text,
        verification_policy_json = EXCLUDED.verification_policy_json,
        accept_by = EXCLUDED.accept_by,
        deadline_at = EXCLUDED.deadline_at,
        event_count = CASE
          WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
            OR task_projections.status = ANY($22::text[])
          THEN task_projections.event_count
          ELSE COALESCE(task_projections.event_count, 0) + CASE WHEN $24::boolean THEN 1 ELSE 0 END
        END,
        last_event_tx_hash = CASE
          WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
            OR task_projections.status = ANY($22::text[])
          THEN task_projections.last_event_tx_hash
          ELSE EXCLUDED.last_event_tx_hash
        END,
        last_event_cid = CASE
          WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
            OR task_projections.status = ANY($22::text[])
          THEN task_projections.last_event_cid
          ELSE EXCLUDED.last_event_cid
        END,
        source = CASE
          WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
            OR task_projections.status = ANY($22::text[])
          THEN task_projections.source
          ELSE EXCLUDED.source
        END,
        metadata_json = COALESCE(task_projections.metadata_json, '{}'::jsonb) || $21::jsonb ||
          CASE
            WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
              OR task_projections.status = ANY($22::text[])
            THEN jsonb_build_object(
              'offchainLifecycleTerminalGuard',
              jsonb_build_object(
                'preserved', true,
                'lastSkippedEventId', $23::text,
                'lastSkippedTransition', 'proposed',
                'lastSkippedAt', $25::text,
                'reason',
                  CASE
                    WHEN COALESCE(task_projections.metadata_json, '{}'::jsonb) ? 'agent_cancelled'
                    THEN 'agent_cancelled_terminal'
                    ELSE 'terminal_status'
                  END
              )
            )
            ELSE '{}'::jsonb
          END,
        updated_at = now()
      RETURNING task_id, status, event_count
    `,
    [
      taskId,
      safeText(accountId, 180),
      subjectWallet,
      safeText(payload.authority_wallet || payload.actor_wallet, 180),
      safeText(payload.allocation_wallet, 180),
      safeText(payload.request_id, 180),
      safeText(payload.title, 240),
      safeText(payload.description, 12000),
      safeText(payload.task_kind, 80),
      numeric(payload.reward_offer?.amount_estimate_pft),
      safeText(payload.generation?.request_bundle_cid, 240),
      safeText(safeObject(payload.context_refs?.[0]).cid, 240),
      safeText(payload.submission_requirement?.type, 120),
      safeText(payload.submission_requirement?.criteria || payload.submission_requirement?.description, 4000),
      JSON.stringify(safeObject(payload.verification_policy)),
      safeText(payload.accept_by, 80) || null,
      safeText(payload.deadline_at, 80) || null,
      event.sourceTxHash,
      event.sourceCid,
      DIRECT_WRITE_SOURCE,
      JSON.stringify(metadataJson),
      TERMINAL_PROJECTION_STATUSES,
      event.eventId,
      eventInserted,
      event.provenanceJson.recordedAt,
    ]
  );
  if (projectionResult.rowCount < 1) throw new Error("offchain_task_offer_projection_missed");
  return {
    ok: true,
    source: DIRECT_WRITE_SOURCE,
    transition: "proposed",
    eventInserted,
    event,
    projection: projectionResult.rows[0],
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
  const rewardActualPft =
    normalizedTransition === "rewarded"
      ? numeric(event.payloadJson.economic_reward_pft || event.payloadJson.reward_pft)
      : 0;
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
             reward_actual_pft = CASE
               WHEN current_projection.preserve_terminal THEN task_projections.reward_actual_pft
               WHEN $13::numeric > 0 THEN $13::numeric
               ELSE task_projections.reward_actual_pft
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
      rewardActualPft,
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

export async function applyOffchainTaskOffer(input = {}) {
  let result = null;
  await transaction(async (client) => {
    result = await applyOffchainTaskOfferWithClient(client, input);
  });
  return result;
}
