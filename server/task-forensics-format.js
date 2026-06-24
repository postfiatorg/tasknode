import { taskEventMeaning } from "./task-event-meaning.js";
import { fetchAndDecryptTasknodePayload } from "./task-payloads.js";
import { summarizeEvidenceItems } from "./task-evidence-summary.js";
import { formatTaskTimestamp } from "../shared/task-time-format.js";

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
    "pf.reward.v1": "Reward outcome",
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
  addDetail(details, "Reward outcome", payload.reward_pft || payload.reward_actual_pft || payload.score?.reward_pft);
  addDetail(details, "Economic reward", payload.economic_reward_pft);
  addDetail(details, "Transaction amount drops", payload.transaction_amount_drops);
  addDetail(details, "Carrier drops", payload.carrier_amount_drops);
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

export function publicCidEntries(cids = {}) {
  return Object.entries(safeObject(cids))
    .map(([label, cid]) => ({
      label: titleCase(label),
      cid: safeText(cid, 240),
    }))
    .filter((entry) => entry.cid);
}

export function publicTransactionEntries(txs = {}) {
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

export function dedupeAuditEntries(entries = [], valueKey = "value") {
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

export function eventCidEntries(events = []) {
  return events
    .map((event) => ({
      label: `${event.label || "Event"} CID`,
      cid: event.cid,
    }))
    .filter((entry) => entry.cid);
}

export function eventTransactionEntries(events = []) {
  return events
    .map((event) => ({
      label: `${event.label || "Event"} TX`,
      txHash: event.txHash,
      ledgerIndex: event.ledgerIndex ?? null,
      memoIndex: event.memoIndex ?? null,
    }))
    .filter((entry) => entry.txHash);
}

export function publicPointerEvent(row, index = 0) {
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

export function publicReducerEvent(row, index = 0) {
  const pointerJson = safeObject(row.pointer_json);
  const payload = bestPayload({ payloadJson: row.payload_json, pointerJson });
  const signature = safeObject(row.signature_json);
  const provenance = safeObject(row.provenance_json);
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
    signature: Object.keys(signature).length ? signature : null,
    provenance: Object.keys(provenance).length ? provenance : null,
    writeSource: safeText(row.write_source || "", 80),
    observedAt: toIso(row.occurred_at),
  };
}

export async function hydrateForensicsEvent(event = {}) {
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
