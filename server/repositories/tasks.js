import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { canonicalReceiptProjection } from "../task-receipt-projection.js";
import { taskEventExpectation, taskEventMeaning } from "../task-event-meaning.js";
import { fetchAndDecryptTasknodePayload } from "../task-payloads.js";
import { taskProductConfig } from "../task-product-config.js";
import { taskRewardOutcome } from "../task-reward-outcome.js";
import { currentVerificationRequest } from "../task-verification-view.js";
import { summarizeEvidenceItems } from "../task-evidence-summary.js";
import { emptyTaskRequestState, listTaskRequests } from "./task-requests.js";
import { normalizeTaskStatus, taskLifecycleActions, taskRefreshMetadata, taskStatusInfo, taskStatusLabel, taskStatusTab } from "../../shared/task-lifecycle.js";
import { formatTaskDeadline, formatTaskTimestamp } from "../../shared/task-time-format.js";

const pointerEnvelopeKeys = new Set(["schema", "task_id", "tx_hash", "cid"]);

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

function hasNumericValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function titleCase(value = "") {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function emptyTaskState({ walletLinked = false, walletAddress = "" } = {}) {
  return {
    ...taskProductConfig(),
    requests: emptyTaskRequestState({ walletLinked, walletAddress }),
    outstanding: [], verification: [], refused: [], rewarded: [],
    sync: {
      source: "task_projections",
      status: walletLinked ? "empty" : "wallet_required",
      walletAddress: walletAddress || null,
      projectionCount: 0, lastSyncedAt: null, requiresRefresh: false, nextPollMs: null,
      refreshReason: "", activeRequestCount: 0, refreshTaskIds: [],
    },
  };
}

function taskSteps(row, generatedTask = {}) {
  const generatedSteps = Array.isArray(generatedTask.steps)
    ? generatedTask.steps.map((step) => safeText(step, 1000)).filter(Boolean).slice(0, 5)
    : [];
  if (generatedSteps.length) return generatedSteps;
  const requirement = safeText(row.submission_requirement_text || "", 2000);
  if (!requirement) return [];
  return [requirement];
}

function publicTask(row) {
  const rewardActual = numeric(row.reward_actual_pft);
  const rewardOffer = numeric(row.reward_offer_pft);
  const actualRewardRecorded = hasNumericValue(row.reward_actual_pft);
  const statusKey = normalizeTaskStatus(row.status);
  const statusInfo = taskStatusInfo(statusKey);
  const pft = statusKey === "rewarded" && actualRewardRecorded ? rewardActual : rewardOffer;
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const verification = safeObject(row.verification_policy_json);
  const acceptBy = toIso(row.accept_by);
  const deadlineAt = toIso(row.deadline_at);
  const dueAt = deadlineAt || acceptBy;
  const formattedDue = formatTaskDeadline(dueAt, { locale: "en-US" });

  return {
    id: String(row.task_id || "").slice(0, 12),
    fullId: row.task_id,
    taskId: row.task_id,
    title: row.title || "Untitled task",
    kind: titleCase(row.task_kind || "task"),
    status: taskStatusLabel(statusKey),
    statusKey,
    statusTone: statusInfo.tone,
    statusColor: statusInfo.color,
    statusTab: statusInfo.tab,
    lifecycle: statusInfo,
    due: formattedDue,
    fullDue: formattedDue,
    dueAt,
    acceptBy,
    deadlineAt,
    ago: relativeAge(row.updated_at || row.last_event_at),
    pft,
    description: row.description || "",
    steps: taskSteps(row, generatedTask),
    verification: {
      title: row.submission_type ? `Submit ${titleCase(row.submission_type)}` : "Submit evidence",
      body:
        row.submission_requirement_text ||
        verification.criteria ||
        generatedTask?.submission_requirement?.criteria ||
        "Submit evidence that satisfies the task requirement.",
      policy: verification,
    },
    submissionRequirement: {
      type: row.submission_type || generatedTask?.submission_requirement?.type || "",
      criteria:
        row.submission_requirement_text ||
        generatedTask?.submission_requirement?.criteria ||
        generatedTask?.submission_requirement?.description ||
        "",
    },
    verificationPolicy: verification,
    submissionType: row.submission_type || generatedTask?.submission_requirement?.type || "",
    requestBundleCid: row.request_bundle_cid || "",
    contextCid: row.context_cid || "",
    txHash: row.last_event_tx_hash || "",
    source: row.source || "pftl_replay",
    updatedAt: toIso(row.updated_at),
    updatedAtDisplay: formatTaskTimestamp(row.updated_at, { locale: "en-US" }),
    lastEventAt: toIso(row.last_event_at),
    lastEventAtDisplay: formatTaskTimestamp(row.last_event_at, { locale: "en-US" }),
    metadata: {
      requestId: row.request_id || undefined, eventCount: Number(row.event_count || 0),
      sourceRunId: metadata.runId || undefined, openaiResponseId: metadata.taskgen?.openai_response_id || undefined,
      model: metadata.taskgen?.model || undefined,
    },
  };
}

function groupTasks(tasks) {
  const outstanding = [];
  const verification = [];
  const refused = [];
  const rewarded = [];

  for (const task of tasks) {
    const tab = taskStatusTab(task.statusKey);
    if (tab === "rewarded") {
      rewarded.push(task);
    } else if (tab === "refused") {
      refused.push(task);
    } else if (tab === "verification") {
      verification.push(task);
    } else {
      outstanding.push(task);
    }
  }

  return { outstanding, verification, refused, rewarded };
}

function schemaLabel(schema = "", payload = {}) {
  const normalized = String(schema || "").trim();
  const transition = safeText(payload.transition || payload.status, 80);
  if (normalized === "pf.task.update.v1" && transition) {
    return {
      accepted: "Task accepted",
      refused: "Task refused",
      rejected: "Task rejected",
      expired: "Task expired",
      cancelled: "Task cancelled",
      verification_requested: "Verification requested",
    }[transition] || `Task update: ${titleCase(transition)}`;
  }
  return {
    "pf.task.request.v1": "Task requested",
    "pf.task.offer.v1": "Task offered",
    "pf.task.acceptance.v1": "Task accepted",
    "pf.task.refusal.v1": "Task refused",
    "pf.task.submission.v1": "Evidence submitted",
    "pf.task.verification_request.v1": "Verification requested",
    "pf.task.verification_response.v1": "Verification response submitted",
    "pf.reward.v1": "Reward paid",
    "pf.task.reward_decision.v1": "Reward decision",
    "pf.task.update.v1": "Task updated",
  }[normalized] || titleCase(normalized.replace(/^pf\./, "") || "Task event");
}

function objectKeyCount(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function bestPayload({ payloadJson = {}, pointerJson = {} } = {}) {
  const direct = safeObject(payloadJson);
  const pointerPayload = safeObject(pointerJson.payload);
  return objectKeyCount(pointerPayload) > objectKeyCount(direct) ? pointerPayload : direct;
}

function bestPointer({ row = {}, pointerJson = {} } = {}) {
  return {
    kind: row.pointer_kind || pointerJson.pointer_kind || pointerJson.kind || pointerJson.pointer?.kind || "",
    cid: row.source_cid || pointerJson.cid || pointerJson.pointer?.cid || "",
    txHash: row.source_tx_hash || pointerJson.tx_hash || pointerJson.pointer?.tx_hash || "",
    ledgerIndex:
      row.ledger_index ??
      pointerJson.ledger_index ??
      pointerJson.ledgerIndex ??
      pointerJson.pointer?.ledger_index ??
      pointerJson.pointer?.ledgerIndex ??
      null,
    memoIndex:
      row.memo_index ??
      pointerJson.memo_index ??
      pointerJson.memoIndex ??
      pointerJson.pointer?.memo_index ??
      pointerJson.pointer?.memoIndex ??
      null,
  };
}

function safeError(error) {
  return safeText(error?.code || error?.message || error || "task_event_payload_error", 500);
}

function isPointerEnvelopePayload(payload = {}) {
  const objectPayload = safeObject(payload);
  const keys = Object.keys(objectPayload);
  if (!keys.length) return false;
  return keys.every((key) => pointerEnvelopeKeys.has(key));
}

function detailValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return safeText(value, 12000);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeText(JSON.stringify(value), 12000);
}

function addDetail(details, label, value) {
  const rendered = detailValue(value);
  if (!rendered) return;
  details.push({ label, value: rendered });
}

function summarizeEvidenceRefs(refs = []) {
  if (!Array.isArray(refs)) return "";
  return refs
    .map((ref, index) => {
      const artifactType = safeText(ref?.artifact_type || ref?.type || "artifact", 80);
      const cid = safeText(ref?.artifact_cid || ref?.cid || "", 180);
      const digest = safeText(ref?.artifact_digest || ref?.digest || "", 220);
      return [
        `${Number(ref?.index || index + 1)}. ${artifactType}`,
        cid ? `CID ${cid}` : "",
        digest ? `Digest ${digest}` : "",
      ].filter(Boolean).join(" - ");
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeProcessedArtifacts(artifacts = []) {
  if (!Array.isArray(artifacts)) return "";
  return artifacts
    .map((artifact, index) => {
      const source = safeObject(artifact?.source);
      const sourceLabel = source.url || source.path || source.file_name || source.host || "";
      return [
        `${index + 1}. ${safeText(artifact?.artifact_type || artifact?.source_type || "artifact", 80)}`,
        safeText(artifact?.status || "", 80),
        safeText(sourceLabel, 260),
        safeText(artifact?.excerpt || "", 360),
      ].filter(Boolean).join(" - ");
    })
    .filter(Boolean)
    .join("\n");
}

function payloadDetails(schema = "", payload = {}, pointer = {}) {
  const details = [];
  addDetail(details, "What happened", taskEventMeaning(schema, payload));
  addDetail(details, "Task ID", payload.task_id || pointer.task_id);
  addDetail(details, "Event ID", payload.event_id);
  addDetail(details, "Request ID", payload.request_id);
  addDetail(details, "Phase", payload.phase);
  addDetail(details, "Transition", payload.transition || payload.status);
  addDetail(details, "Status after", payload.status_after);
  addDetail(details, "Title", payload.title);
  addDetail(details, "Kind", payload.task_kind || payload.kind);
  addDetail(details, "Reward offer", payload.reward_offer?.amount_estimate_pft || payload.reward_offer_pft);
  addDetail(details, "Reward paid", payload.reward_pft || payload.reward_actual_pft || payload.score?.reward_pft);
  addDetail(details, "Reward tier", payload.reward_tier || payload.score?.decision);
  addDetail(details, "Reward score", payload.reward_score || payload.score?.completion);
  addDetail(details, "Evidence quality", payload.score?.evidence_quality);
  addDetail(details, "Reward summary", payload.reward_summary || payload.summary || payload.score?.user_feedback);
  addDetail(details, "Reward reason", payload.score?.reason);
  addDetail(details, "Submission type", payload.submission_requirement?.type || payload.submission_type);
  addDetail(details, "Evidence type", payload.evidence_type || payload.artifact_type);
  addDetail(details, "Evidence count", payload.evidence_count);
  addDetail(details, "Evidence items", summarizeEvidenceItems(payload.evidence_items || payload.evidence?.evidence_items));
  addDetail(details, "Verification type", payload.verification_policy?.verification_type || payload.verification_type || payload.verification_request?.verification_type);
  addDetail(details, "Verification assessment", payload.verification_request?.assessment);
  addDetail(details, "Verification ask", payload.verification_ask || payload.verification_request?.verification_ask);
  addDetail(details, "Verification reason", payload.verification_request?.reason);
  addDetail(details, "Response text", payload.response_text || payload.response);
  addDetail(details, "Response CID", payload.response_cid || payload.verification_response_cid);
  addDetail(details, "Submission CID", payload.submission_cid);
  addDetail(details, "Evidence artifact CID", payload.artifact_cid);
  addDetail(details, "Evidence artifact digest", payload.artifact_digest);
  addDetail(details, "Evidence refs", summarizeEvidenceRefs(payload.evidence_refs));
  addDetail(details, "Processed artifacts", summarizeProcessedArtifacts(payload.processed_evidence?.artifacts));
  addDetail(details, "Reward pointer CID", payload.reward_pointer_cid);
  addDetail(details, "Actor wallet", payload.actor_wallet);
  addDetail(details, "Subject wallet", payload.subject_wallet);
  addDetail(details, "Authority wallet", payload.authority_wallet);
  addDetail(details, "Allocation wallet", payload.allocation_wallet);
  addDetail(details, "Created at", formatTaskTimestamp(payload.created_at, { locale: "en-US" }));
  addDetail(details, "Submitted at", formatTaskTimestamp(payload.submitted_at, { locale: "en-US" }));
  addDetail(details, "Responded at", formatTaskTimestamp(payload.responded_at, { locale: "en-US" }));
  addDetail(details, "Prompt version", payload.generation?.prompt_version);
  addDetail(details, "Model", payload.generation?.model);
  addDetail(details, "Provider", payload.generation?.provider);
  addDetail(details, "Provider response", payload.generation?.provider_response_id);
  addDetail(details, "Description", payload.description);
  addDetail(details, "Submission requirement", payload.submission_requirement?.criteria || payload.submission_requirement?.description);
  addDetail(details, "Verification criteria", payload.verification_policy?.criteria || payload.verification_criteria);
  addDetail(details, "Schema", schema);
  return details;
}

function appendDetail(event, label, value) {
  return {
    ...event,
    details: [
      ...(Array.isArray(event.details) ? event.details : []),
      { label, value: detailValue(value) || "" },
    ].filter((detail) => detail.value),
  };
}

function publicCidEntries(cids = {}) {
  return Object.entries(safeObject(cids))
    .map(([label, cid]) => ({
      label: titleCase(label),
      cid: safeText(cid, 240),
    }))
    .filter((entry) => entry.cid);
}

function publicTransactionEntries(txs = {}) {
  return Object.entries(safeObject(txs))
    .map(([label, value]) => {
      const tx = safeObject(value);
      const txHash = typeof value === "string" ? value : tx.tx_hash || tx.hash || tx.transaction_hash;
      return {
        label: titleCase(label),
        txHash: safeText(txHash, 240),
        ledgerIndex: tx.ledger_index || tx.ledgerIndex || null,
      };
    })
    .filter((entry) => entry.txHash);
}

function dedupeAuditEntries(entries = [], valueKey = "value") {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const value = safeText(entry?.[valueKey], 300);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function eventCidEntries(events = []) {
  return events
    .map((event) => ({
      label: `${event.label || "Event"} CID`,
      cid: event.cid,
    }))
    .filter((entry) => entry.cid);
}

function eventTransactionEntries(events = []) {
  return events
    .map((event) => ({
      label: `${event.label || "Event"} TX`,
      txHash: event.txHash,
      ledgerIndex: event.ledgerIndex ?? null,
      memoIndex: event.memoIndex ?? null,
    }))
    .filter((entry) => entry.txHash);
}

function publicPointerEvent(row, index = 0) {
  const pointerJson = safeObject(row.pointer_json);
  const payload = bestPayload({ payloadJson: row.payload_json, pointerJson });
  const pointer = bestPointer({ row, pointerJson });
  const schema = safeText(row.event_schema || pointerJson.schema || payload.schema, 120);
  return {
    id: row.id || `event_${index + 1}`,
    index: Number(pointer.memoIndex ?? index),
    label: schemaLabel(schema, payload),
    schema,
    pointerKind: safeText(pointer.kind, 120),
    txHash: safeText(pointer.txHash || payload.tx_hash, 240),
    cid: safeText(pointer.cid || payload.cid, 240),
    ledgerIndex: pointer.ledgerIndex,
    memoIndex: pointer.memoIndex,
    eventDigest: safeText(row.event_digest || pointerJson.event_digest || "", 240),
    details: payloadDetails(schema, payload, pointerJson.pointer || pointerJson),
    rawPayload: payload,
    pointer,
    source: row.source || "",
    observedAt: toIso(row.observed_at),
  };
}

function publicReducerEvent(row, index = 0) {
  const pointerJson = safeObject(row.pointer_json);
  const payload = bestPayload({ payloadJson: row.payload_json, pointerJson });
  const pointer = bestPointer({
    row: {
      ...row,
      source_tx_hash: row.source_tx_hash || row.tx_hash,
      source_cid: row.source_cid || row.cid,
      memo_index: row.memo_index,
    },
    pointerJson,
  });
  const schema = safeText(row.event_type || pointerJson.schema || payload.schema, 120);
  return {
    id: row.id || `reducer_event_${index + 1}`,
    index,
    label: schemaLabel(schema, payload),
    schema,
    pointerKind: safeText(pointer.kind, 120),
    txHash: safeText(pointer.txHash || payload.tx_hash, 240),
    cid: safeText(pointer.cid || payload.cid, 240),
    ledgerIndex: pointer.ledgerIndex,
    memoIndex: pointer.memoIndex,
    eventDigest: safeText(row.event_digest || pointerJson.event_digest || "", 240),
    details: payloadDetails(schema, payload, pointerJson.pointer || pointerJson),
    rawPayload: payload,
    pointer,
    observedAt: toIso(row.occurred_at),
  };
}

async function hydrateForensicsEvent(event = {}) {
  const cid = safeText(event.cid, 240);
  const rawPayload = safeObject(event.rawPayload);
  if (!cid || !isPointerEnvelopePayload(rawPayload)) return event;
  try {
    const result = await fetchAndDecryptTasknodePayload({ cid });
    const hydratedPayload = safeObject(result.payload);
    const hydratedTaskId = safeText(hydratedPayload.task_id, 180);
    const eventTaskId = safeText(rawPayload.task_id || event.pointer?.task_id, 180);
    if (hydratedTaskId && eventTaskId && hydratedTaskId !== eventTaskId) {
      return appendDetail(event, "Payload content", "Encrypted IPFS payload belongs to a different task ID.");
    }
    const schema = safeText(hydratedPayload.schema || event.schema || rawPayload.schema, 120);
    return {
      ...event,
      label: schemaLabel(schema, hydratedPayload),
      schema,
      details: payloadDetails(schema, hydratedPayload, event.pointer || {}),
      rawPayload: hydratedPayload,
      payloadHydration: {
        status: "hydrated",
        cid: result.cid || cid,
        gateway: result.gateway || "",
      },
    };
  } catch (error) {
    return appendDetail(
      event,
      "Payload content",
      `Encrypted IPFS payload could not be read by this service: ${safeError(error)}`
    );
  }
}

function taskActionState(status = "") {
  return taskLifecycleActions(status);
}

export async function listTaskState({ accountId = "", walletAddress = "" } = {}) {
  const linked = Boolean(String(walletAddress || "").trim());
  if (!linked) return emptyTaskState({ walletLinked: false });
  const requests = await listTaskRequests({ accountId, walletAddress }).catch((error) => ({
    ...emptyTaskRequestState({ walletLinked: true, walletAddress }),
    sync: {
      source: "task_requests",
      status: "error",
      walletAddress,
      requestCount: 0,
      lastUpdatedAt: null,
      error: safeText(error?.message || error, 500),
    },
  }));

  if (!databaseEnabled()) {
    return {
      ...emptyTaskState({ walletLinked: true, walletAddress }),
      requests,
      sync: {
        source: "task_projections",
        status: "database_not_configured",
        walletAddress,
        projectionCount: 0, lastSyncedAt: null, requiresRefresh: false, nextPollMs: null,
        refreshReason: "", activeRequestCount: 0, refreshTaskIds: [],
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
  const taskItems = result.rows.map(publicTask);
  const grouped = groupTasks(taskItems);
  const rows = result.rows;
  const lastSyncedAt = rows[0]?.updated_at ? toIso(rows[0].updated_at) : null;
  const refresh = taskRefreshMetadata({
    tasks: taskItems,
    activeRequestCount: Array.isArray(requests?.items)
      ? requests.items.filter((request) => request?.isActive).length
      : 0,
  });

  return {
    ...emptyTaskState({ walletLinked: true, walletAddress }),
    requests,
    ...grouped,
    sync: {
      source: "task_projections",
      status: rows.length > 0 ? "ready" : "empty",
      walletAddress,
      projectionCount: rows.length,
      lastSyncedAt,
      ...refresh,
    },
  };
}

export async function getTaskDetail({ accountId = "", walletAddress = "", taskId = "" } = {}) {
  const linked = Boolean(String(walletAddress || "").trim());
  const normalizedTaskId = safeText(taskId, 180);
  if (!linked || !normalizedTaskId) return null;
  if (!databaseEnabled()) {
    const error = new Error("database_not_configured");
    error.code = "TASKNODE_DATABASE_NOT_CONFIGURED";
    throw error;
  }

  const taskResult = await query(
    `
      SELECT *
      FROM task_projections
      WHERE task_id = $1
        AND subject_wallet = $2
        AND ($3::text = '' OR account_id = $3)
      LIMIT 1
    `,
    [normalizedTaskId, walletAddress, accountId || ""]
  );
  const row = taskResult.rows[0];
  if (!row) return null;

  const [pointerResult, reducerResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM pftl_task_pointer_events
        WHERE task_id = $1
          AND wallet_address = $2
          AND ($3::text = '' OR account_id = $3)
        ORDER BY observed_at ASC, memo_index ASC, id ASC
        LIMIT 200
      `,
      [normalizedTaskId, walletAddress, accountId || ""]
    ),
    query(
      `
        SELECT *
        FROM task_events
        WHERE task_id = $1
          AND wallet_address = $2
          AND ($3::text = '' OR account_id = $3)
        ORDER BY occurred_at ASC, id ASC
        LIMIT 200
      `,
      [normalizedTaskId, walletAddress, accountId || ""]
    ),
  ]);

  const metadata = safeObject(row.metadata_json);
  const submissionSummaries = Array.isArray(metadata.submissionSummaries)
    ? metadata.submissionSummaries
    : [];
  const task = publicTask(row);
  const pointerTimeline = await Promise.all(pointerResult.rows.map((eventRow, index) => (
    hydrateForensicsEvent(publicPointerEvent(eventRow, index))
  )));
  const reducerTimeline = await Promise.all(reducerResult.rows.map((eventRow, index) => (
    hydrateForensicsEvent(publicReducerEvent(eventRow, index))
  )));
  const timeline = pointerTimeline.length ? pointerTimeline : reducerTimeline;
  const cidEntries = dedupeAuditEntries([
    ...publicCidEntries(metadata.cids),
    ...eventCidEntries(timeline),
  ], "cid");
  const transactionEntries = dedupeAuditEntries([
    ...publicTransactionEntries(metadata.txs),
    ...eventTransactionEntries(timeline),
  ], "txHash");
  const expectedEventCount = Number(row.event_count || 0);

  return {
    ok: true,
    task,
    wallets: {
      user: row.subject_wallet || "",
      authority: row.authority_wallet || "",
      allocation: row.allocation_wallet || "",
    },
    actions: taskActionState(row.status),
    submission: {
      summaries: submissionSummaries.slice(0, 12),
      generatedTask: safeObject(metadata.generatedTask),
      verificationPolicy: safeObject(row.verification_policy_json),
    },
    currentVerificationRequest: currentVerificationRequest(timeline),
    rewardOutcome: taskRewardOutcome({ offeredPft: row.reward_offer_pft, task, timeline }),
    forensics: {
      source: row.source || "task_projections",
      eventCount: Number(row.event_count || 0),
      requestBundleCid: row.request_bundle_cid || "",
      contextCid: row.context_cid || "",
      lastEventTxHash: row.last_event_tx_hash || "",
      lastEventCid: row.last_event_cid || "",
      cids: cidEntries,
      transactions: transactionEntries,
      timeline,
      pointerEvents: pointerTimeline,
      reducerEvents: reducerTimeline,
      reviewState: taskEventExpectation({ status: row.status, timeline }),
      integrity: {
        expectedEventCount,
        pointerEventCount: pointerTimeline.length,
        reducerEventCount: reducerTimeline.length,
        renderedEventCount: timeline.length,
        missingTimelineRows: expectedEventCount > 0 && timeline.length === 0,
      },
    },
    sync: {
      updatedAt: toIso(row.updated_at),
      lastEventAt: toIso(row.last_event_at),
      ...taskRefreshMetadata({ tasks: [task] }),
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
  if (schema === "pf.task.update.v1" || schema === "pf.task.reward_decision.v1") return "TASK_UPDATE";
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
      const eventPayload = safeObject(event.payload);
      const pointerEnvelope = {
        schema: eventSchema,
        task_id: eventTaskId,
        tx_hash: txHash,
        cid,
      };
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
