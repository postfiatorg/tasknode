import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { canonicalReceiptProjection } from "../task-receipt-projection.js";
import { syncNetworkTaskProjection } from "./network-tasks.js";
import { enqueueNetworkTaskProfileForRewardThreshold } from "./network-task-profile.js";
import { enqueueRewardedTaskMemory } from "./task-reward-memory.js";
import { enqueueTeamContextReportsForRewardedAccount } from "./team-context.js";
import { normalizeTaskStatus, taskStatusTab } from "../../shared/task-lifecycle.js";
import {
  numeric,
  objectKeyCount,
  safeObject,
  safeText,
  toIso,
} from "./task-projection-contract.js";

function roleWallet(receipt, role) {
  const wallets = Array.isArray(receipt?.wallets) ? receipt.wallets : [];
  return wallets.find((wallet) => wallet?.role === role)?.address || "";
}

function projectionForReceipt(receipt) {
  const taskId = safeText(receipt?.task_id || "", 160);
  const projection = receipt?.projection?.[taskId] || {};
  const generatedTask = receipt?.generated_task || {};
  const submissionRequirement = generatedTask?.submission_requirement || {};
  const metadata = {
    runId: receipt?.run_id || "",
    fixture: receipt?.fixture || {},
    taskgen: receipt?.taskgen || {},
    generatedTask,
    submissionSummaries: receipt?.submission_summaries || [],
    cids: receipt?.cids || {},
    txs: receipt?.txs || {},
  };
  const hydratedEvents = Array.isArray(receipt?.hydrated_events) ? receipt.hydrated_events : [];
  const lastEvent = hydratedEvents[hydratedEvents.length - 1] || {};
  const canonicalProjection = canonicalReceiptProjection({ projection, hydratedEvents });
  const rewardOffer = numeric(generatedTask?.reward_offer?.amount_estimate_pft || projection.reward_offer_pft);
  const rewardActual = numeric(canonicalProjection.rewardActualPft || generatedTask?.reward_actual_pft);

  return {
    taskId,
    accountId: safeText(receipt?.fixture?.account_id || "", 180),
    subjectWallet: roleWallet(receipt, "user"),
    authorityWallet: roleWallet(receipt, "task_authority"),
    allocationWallet: roleWallet(receipt, "allocation_reward"),
    requestId: safeText(receipt?.fixture?.request_id || "", 180),
    status: safeText(canonicalProjection.status || "unknown", 80),
    title: safeText(generatedTask.title || projection.title || "", 240),
    description: safeText(generatedTask.description || projection.description || "", 8000),
    taskKind: safeText(generatedTask.task_kind || projection.task_kind || "", 80),
    rewardOffer,
    rewardActual,
    requestBundleCid: safeText(projection.request_bundle_cid || receipt?.cids?.request_bundle || "", 180),
    contextCid: safeText(receipt?.cids?.context_doc || "", 180),
    submissionType: safeText(submissionRequirement.type || "", 120),
    submissionRequirementText: safeText(submissionRequirement.criteria || submissionRequirement.description || "", 4000),
    verificationPolicy: generatedTask.verification_policy || {},
    acceptBy: toIso(generatedTask?.deadline?.accept_by),
    deadlineAt: toIso(generatedTask?.deadline?.deadline_at),
    eventCount: Number(projection.events?.length || hydratedEvents.length || 0),
    lastEventTxHash: safeText(lastEvent.tx_hash || receipt?.txs?.reward?.tx_hash || "", 180),
    lastEventCid: safeText(lastEvent.cid || receipt?.cids?.reward || "", 180),
    metadata,
    hydratedEvents,
  };
}

function pointerKindForSchema(schema = "") {
  if (schema === "pf.reward.v1") return "REWARD";
  if (schema === "pf.task.submission.v1" || schema === "pf.task.verification_response.v1") return "TASK_SUBMISSION";
  if (schema === "pf.task.update.v1") return "TASK_UPDATE";
  return "TASK";
}

async function projectionWithDurableOwner(projection = {}) {
  const requestId = safeText(projection.requestId, 180);
  const subjectWallet = safeText(projection.subjectWallet, 120);
  if (!requestId && !subjectWallet) return projection;

  const result = await query(
    `SELECT account_id, subject_wallet, request_id
       FROM task_requests
      WHERE ($1::text <> '' AND request_id = $1)
         OR ($1::text = '' AND $2::text <> '' AND subject_wallet = $2)
      ORDER BY CASE WHEN request_id = $1 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [requestId, subjectWallet]
  );
  const row = result.rows[0];
  if (!row?.account_id) return projection;

  const ownerAccountId = safeText(row.account_id, 180);
  const ownerWallet = safeText(row.subject_wallet || subjectWallet, 120);
  const ownerRequestId = safeText(row.request_id || requestId, 180);
  const metadata = safeObject(projection.metadata);
  const fixture = { ...safeObject(metadata.fixture), account_id: ownerAccountId, request_id: ownerRequestId };
  return { ...projection, accountId: ownerAccountId, subjectWallet: ownerWallet || projection.subjectWallet, requestId: ownerRequestId, metadata: { ...metadata, fixture } };
}

async function maybeQueueNetworkTaskProfileAfterReward(projection = {}) {
  const accountId = safeText(projection.accountId, 180);
  const rewardActual = numeric(projection.rewardActual);
  const statusTab = taskStatusTab(normalizeTaskStatus(projection.status));
  if (!accountId || rewardActual <= 0 || statusTab !== "rewarded") {
    return { queued: false, reason: "not_positive_reward_projection" };
  }
  return enqueueNetworkTaskProfileForRewardThreshold({
    accountId,
    reason: "rewarded_task_projection",
  }).catch((error) => ({
    queued: false,
    reason: "reward_threshold_enqueue_failed",
    error: safeText(error?.message || error, 1000),
  }));
}

export async function importTaskReplayReceipt(receipt, { sourceRef = "", source = "pftl_replay_receipt" } = {}) {
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const projection = await projectionWithDurableOwner(projectionForReceipt(receipt));
  if (!projection.taskId) throw new Error("receipt_missing_task_id");
  if (!projection.subjectWallet) throw new Error("receipt_missing_subject_wallet");

  const syncRunId = `task_sync_${randomUUID()}`;
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO pftl_task_sync_runs (
         id, account_id, wallet_address, source, source_ref, status, task_count,
         pointer_event_count, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, 'completed', 1, $6, $7::jsonb)`,
      [
        syncRunId,
        projection.accountId,
        projection.subjectWallet,
        source,
        sourceRef,
        projection.hydratedEvents.length,
        JSON.stringify({ runId: receipt?.run_id || "", taskId: projection.taskId, importedFrom: sourceRef }),
      ]
    );

    for (const [index, event] of projection.hydratedEvents.entries()) {
      const eventId = `ptr_evt_${randomUUID()}`;
      const taskEventId = `task_evt_${randomUUID()}`;
      const eventTaskId = safeText(event.task_id || projection.taskId, 180);
      const eventSchema = safeText(event.schema || "", 120);
      const txHash = safeText(event.tx_hash || "", 180);
      const cid = safeText(event.cid || "", 180);
      if (!txHash || !cid) continue;
      const eventPayload = safeObject(event.payload);
      const pointerEnvelope = { schema: eventSchema, task_id: eventTaskId, tx_hash: txHash, cid };
      const payloadJson = objectKeyCount(eventPayload) > objectKeyCount(pointerEnvelope)
        ? eventPayload
        : pointerEnvelope;
      await client.query(
        `
          INSERT INTO pftl_task_pointer_events (
            id,
            sync_run_id,
            account_id,
            wallet_address,
            task_id,
            event_schema,
            pointer_kind,
            source_tx_hash,
            source_cid,
            memo_index,
            event_digest,
            payload_json,
            pointer_json,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
          ON CONFLICT (account_id, wallet_address, source_tx_hash, memo_index, source_cid)
          DO UPDATE SET
            sync_run_id = EXCLUDED.sync_run_id,
            task_id = EXCLUDED.task_id,
            event_schema = EXCLUDED.event_schema,
            event_digest = EXCLUDED.event_digest,
            payload_json = EXCLUDED.payload_json,
            pointer_json = EXCLUDED.pointer_json,
            observed_at = now()
        `,
        [
          eventId,
          syncRunId,
          projection.accountId,
          projection.subjectWallet,
          eventTaskId,
          eventSchema,
          pointerKindForSchema(eventSchema),
          txHash,
          cid,
          index,
          safeText(event.event_digest || "", 180),
          JSON.stringify(payloadJson),
          JSON.stringify(event),
          source,
        ]
      );
      if (eventTaskId) {
        await client.query(
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
              pointer_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
            ON CONFLICT (task_id, event_type, source_tx_hash, source_cid)
            DO UPDATE SET
              account_id = EXCLUDED.account_id,
              wallet_address = EXCLUDED.wallet_address,
              event_digest = EXCLUDED.event_digest,
              payload_json = EXCLUDED.payload_json,
              pointer_json = EXCLUDED.pointer_json
          `,
          [
            taskEventId,
            eventTaskId,
            projection.accountId,
            projection.subjectWallet,
            eventSchema,
            txHash,
            cid,
            safeText(event.event_digest || "", 180),
            JSON.stringify(payloadJson),
            JSON.stringify(event),
          ]
        );
      }
    }

    await client.query(
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
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17::jsonb, $18, $19, $20, $21,
          $22, $23, $24::jsonb
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          account_id = EXCLUDED.account_id,
          subject_wallet = EXCLUDED.subject_wallet,
          authority_wallet = EXCLUDED.authority_wallet,
          allocation_wallet = EXCLUDED.allocation_wallet,
          request_id = EXCLUDED.request_id,
          status = CASE
            -- A Board-Manager-cancelled task is server-terminal: the reducer may
            -- never revive it, including to 'rewarded'. agent_cancelled is only
            -- ever written together with a terminal cancelled/refused status, so
            -- a later cache replay (even a stale reward pointer) must not change
            -- the status or mark the task rewarded.
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.status
            ELSE EXCLUDED.status
          END,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          task_kind = EXCLUDED.task_kind,
          reward_offer_pft = EXCLUDED.reward_offer_pft,
          reward_actual_pft = CASE
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.reward_actual_pft
            ELSE EXCLUDED.reward_actual_pft
          END,
          request_bundle_cid = EXCLUDED.request_bundle_cid,
          context_cid = EXCLUDED.context_cid,
          submission_type = EXCLUDED.submission_type,
          submission_requirement_text = EXCLUDED.submission_requirement_text,
          verification_policy_json = EXCLUDED.verification_policy_json,
          accept_by = EXCLUDED.accept_by,
          deadline_at = EXCLUDED.deadline_at,
          event_count = EXCLUDED.event_count,
          last_event_tx_hash = EXCLUDED.last_event_tx_hash,
          last_event_cid = EXCLUDED.last_event_cid,
          source = EXCLUDED.source,
          metadata_json = CASE
            WHEN task_projections.metadata_json ? 'agent_cancelled'
            THEN task_projections.metadata_json || EXCLUDED.metadata_json
            ELSE EXCLUDED.metadata_json
          END,
          updated_at = now()
        WHERE task_projections.metadata_json ? 'agent_cancelled'
           OR NOT EXISTS (
             SELECT 1
               FROM pftl_transactions current_tx
               JOIN pftl_transactions incoming_tx
                 ON incoming_tx.tx_hash = EXCLUDED.last_event_tx_hash
              WHERE current_tx.tx_hash = task_projections.last_event_tx_hash
                AND (
                  current_tx.ledger_index > incoming_tx.ledger_index
                  OR (
                    current_tx.ledger_index = incoming_tx.ledger_index
                    AND current_tx.close_time > incoming_tx.close_time
                  )
                  OR (
                    current_tx.ledger_index = incoming_tx.ledger_index
                    AND current_tx.close_time = incoming_tx.close_time
                    AND task_projections.last_event_tx_hash > EXCLUDED.last_event_tx_hash
                  )
                )
           )
      `,
      [
        projection.taskId,
        projection.accountId,
        projection.subjectWallet,
        projection.authorityWallet,
        projection.allocationWallet,
        projection.requestId,
        projection.status,
        projection.title,
        projection.description,
        projection.taskKind,
        projection.rewardOffer,
        projection.rewardActual,
        projection.requestBundleCid,
        projection.contextCid,
        projection.submissionType,
        projection.submissionRequirementText,
        JSON.stringify(projection.verificationPolicy),
        projection.acceptBy,
        projection.deadlineAt,
        projection.eventCount,
        projection.lastEventTxHash,
        projection.lastEventCid,
        source,
        JSON.stringify(projection.metadata),
      ]
    );
  });

  await syncNetworkTaskProjection({ taskId: projection.taskId }).catch(() => null);
  const [networkTaskProfile, rewardedTaskMemory, teamContext] = await Promise.all([
    maybeQueueNetworkTaskProfileAfterReward(projection),
    enqueueRewardedTaskMemory({
      projection,
      events: projection.hydratedEvents,
    }).catch((error) => ({
      queued: false,
      reason: "rewarded_task_memory_enqueue_failed",
      error: safeText(error?.message || error, 1000),
    })),
    enqueueTeamContextReportsForRewardedAccount({
      subjectAccountId: projection.accountId,
    }).catch((error) => ({
      queuedCount: 0,
      reason: "team_context_enqueue_failed",
      error: safeText(error?.message || error, 1000),
    })),
  ]);

  return {
    ok: true,
    syncRunId,
    taskId: projection.taskId,
    accountId: projection.accountId,
    walletAddress: projection.subjectWallet,
    status: projection.status,
    pointerEventCount: projection.hydratedEvents.length,
    networkTaskProfile,
    rewardedTaskMemory,
    teamContext,
  };
}
