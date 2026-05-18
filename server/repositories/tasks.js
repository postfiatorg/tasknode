import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";

const verificationStatuses = new Set(["verification_requested", "verification_response_submitted"]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function titleCase(value = "") {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function taskStatusLabel(status = "") {
  const normalized = String(status || "unknown").trim().toLowerCase();
  if (normalized === "verification_requested") return "Verification requested";
  if (normalized === "verification_response_submitted") return "Verification submitted";
  return titleCase(normalized || "unknown");
}

function relativeAge(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDeadline(value) {
  const iso = toIso(value);
  if (!iso) return "No deadline";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function emptyTaskState({ walletLinked = false, walletAddress = "" } = {}) {
  return {
    personalRequestEnabled: true,
    networkRequestEnabled: false,
    alphaRequestEnabled: false,
    dailyRewardCap: 8,
    outstanding: [],
    verification: [],
    refused: [],
    rewarded: [],
    sync: {
      source: "task_projections",
      status: walletLinked ? "empty" : "wallet_required",
      walletAddress: walletAddress || null,
      projectionCount: 0,
      lastSyncedAt: null,
    },
  };
}

function taskSteps(row) {
  const requirement = safeText(row.submission_requirement_text || "", 2000);
  if (!requirement) return [];
  return [requirement];
}

function publicTask(row) {
  const rewardActual = numeric(row.reward_actual_pft);
  const rewardOffer = numeric(row.reward_offer_pft);
  const pft = rewardActual || rewardOffer;
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  const generatedTask = metadata.generatedTask && typeof metadata.generatedTask === "object" ? metadata.generatedTask : {};
  const verification = row.verification_policy_json && typeof row.verification_policy_json === "object"
    ? row.verification_policy_json
    : {};

  return {
    id: String(row.task_id || "").slice(0, 12),
    fullId: row.task_id,
    taskId: row.task_id,
    title: row.title || "Untitled task",
    kind: titleCase(row.task_kind || "task"),
    status: taskStatusLabel(row.status),
    statusKey: row.status || "unknown",
    due: formatDeadline(row.deadline_at || row.accept_by),
    fullDue: formatDeadline(row.deadline_at || row.accept_by),
    ago: relativeAge(row.updated_at || row.last_event_at),
    pft,
    description: row.description || "",
    steps: taskSteps(row),
    verification: {
      title: row.submission_type ? `Submit ${titleCase(row.submission_type)}` : "Submit evidence",
      body:
        row.submission_requirement_text ||
        verification.criteria ||
        generatedTask?.submission_requirement?.criteria ||
        "Submit evidence that satisfies the task requirement.",
      policy: verification,
    },
    requestBundleCid: row.request_bundle_cid || "",
    contextCid: row.context_cid || "",
    txHash: row.last_event_tx_hash || "",
    source: row.source || "pftl_replay",
    updatedAt: toIso(row.updated_at),
    metadata: {
      requestId: row.request_id || undefined,
      eventCount: Number(row.event_count || 0),
      sourceRunId: metadata.runId || undefined,
      openaiResponseId: metadata.taskgen?.openai_response_id || undefined,
      model: metadata.taskgen?.model || undefined,
    },
  };
}

function groupTasks(rows) {
  const tasks = rows.map(publicTask);
  const outstanding = [];
  const verification = [];
  const refused = [];
  const rewarded = [];

  for (const task of tasks) {
    if (task.statusKey === "rewarded") {
      rewarded.push(task);
    } else if (["rejected", "refused", "expired", "cancelled"].includes(task.statusKey)) {
      refused.push(task);
    } else if (verificationStatuses.has(task.statusKey)) {
      verification.push(task);
    } else {
      outstanding.push(task);
    }
  }

  return { outstanding, verification, refused, rewarded };
}

export async function listTaskState({ accountId = "", walletAddress = "" } = {}) {
  const linked = Boolean(String(walletAddress || "").trim());
  if (!linked) return emptyTaskState({ walletLinked: false });

  if (!databaseEnabled()) {
    return {
      ...emptyTaskState({ walletLinked: true, walletAddress }),
      sync: {
        source: "task_projections",
        status: "database_not_configured",
        walletAddress,
        projectionCount: 0,
        lastSyncedAt: null,
      },
    };
  }

  const result = await query(
    `
      SELECT *
      FROM task_projections
      WHERE subject_wallet = $1
        AND ($2::text = '' OR account_id = $2)
      ORDER BY updated_at DESC, task_id DESC
      LIMIT 200
    `,
    [walletAddress, accountId || ""]
  );
  const grouped = groupTasks(result.rows);
  const rows = result.rows;
  const lastSyncedAt = rows[0]?.updated_at ? toIso(rows[0].updated_at) : null;

  return {
    ...emptyTaskState({ walletLinked: true, walletAddress }),
    ...grouped,
    sync: {
      source: "task_projections",
      status: rows.length > 0 ? "ready" : "empty",
      walletAddress,
      projectionCount: rows.length,
      lastSyncedAt,
    },
  };
}

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
  const rewardOffer = numeric(generatedTask?.reward_offer?.amount_estimate_pft || projection.reward_offer_pft);
  const rewardActual = numeric(projection.reward_actual_pft || generatedTask?.reward_actual_pft);

  return {
    taskId,
    accountId: safeText(receipt?.fixture?.account_id || "", 180),
    subjectWallet: roleWallet(receipt, "user"),
    authorityWallet: roleWallet(receipt, "task_authority"),
    allocationWallet: roleWallet(receipt, "allocation_reward"),
    requestId: safeText(receipt?.fixture?.request_id || "", 180),
    status: safeText(projection.status || "unknown", 80),
    title: safeText(generatedTask.title || projection.title || "", 240),
    description: safeText(generatedTask.description || projection.description || "", 8000),
    taskKind: safeText(generatedTask.task_kind || projection.task_kind || "", 80),
    rewardOffer,
    rewardActual,
    requestBundleCid: safeText(projection.request_bundle_cid || receipt?.cids?.request_bundle || "", 180),
    contextCid: safeText(receipt?.cids?.context_doc || "", 180),
    submissionType: safeText(submissionRequirement.type || "", 120),
    submissionRequirementText: safeText(
      submissionRequirement.criteria || submissionRequirement.description || "",
      4000
    ),
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

export async function importTaskReplayReceipt(receipt, { sourceRef = "", source = "pftl_replay_receipt" } = {}) {
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const projection = projectionForReceipt(receipt);
  if (!projection.taskId) throw new Error("receipt_missing_task_id");
  if (!projection.subjectWallet) throw new Error("receipt_missing_subject_wallet");

  const syncRunId = `task_sync_${randomUUID()}`;
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO pftl_task_sync_runs (
          id,
          account_id,
          wallet_address,
          source,
          source_ref,
          status,
          task_count,
          pointer_event_count,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, 'completed', 1, $6, $7::jsonb)
      `,
      [
        syncRunId,
        projection.accountId,
        projection.subjectWallet,
        source,
        sourceRef,
        projection.hydratedEvents.length,
        JSON.stringify({
          runId: receipt?.run_id || "",
          taskId: projection.taskId,
          importedFrom: sourceRef,
        }),
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
      const payloadJson = {
        schema: eventSchema,
        task_id: eventTaskId,
        tx_hash: txHash,
        cid,
      };
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
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          task_kind = EXCLUDED.task_kind,
          reward_offer_pft = EXCLUDED.reward_offer_pft,
          reward_actual_pft = EXCLUDED.reward_actual_pft,
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
          metadata_json = EXCLUDED.metadata_json,
          updated_at = now()
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

  return {
    ok: true,
    syncRunId,
    taskId: projection.taskId,
    accountId: projection.accountId,
    walletAddress: projection.subjectWallet,
    status: projection.status,
    pointerEventCount: projection.hydratedEvents.length,
  };
}
