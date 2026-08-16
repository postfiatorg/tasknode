import { publicReducerEvent } from "../task-forensics-format.js";
import { currentVerificationRequest } from "../task-verification-view.js";
import { numeric, toIso } from "./hive-project-projection.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function publicSummaryText(value = "", max = 900) {
  return safeText(value, max).replace(/\s+/g, " ");
}

export function publicSubmissionSummaries(metadata = {}) {
  return safeArray(metadata.submissionSummaries)
    .map((summary, index) => ({
      type: publicSummaryText(summary?.type || summary?.label || `Submission ${index + 1}`, 120),
      summary: publicSummaryText(summary?.summary || summary?.description || "", 900),
    }))
    .filter((summary) => summary.type || summary.summary)
    .slice(0, 6);
}

export function publicEvidenceArtifactRefs(payload = {}, event = {}) {
  const evidence = safeObject(payload.evidence || payload.submission || payload.response);
  const items = [
    ...safeArray(payload.evidence_items),
    ...safeArray(payload.evidenceItems),
    ...safeArray(evidence.evidence_items),
    ...safeArray(evidence.evidenceItems),
    ...safeArray(payload.artifacts),
    ...safeArray(evidence.artifacts),
  ];
  const refs = [];
  for (const item of items.slice(0, 8)) {
    const artifact = safeObject(item);
    const file = safeObject(artifact.file);
    const ref = {
      type: publicSummaryText(artifact.artifact_type || artifact.artifactType || artifact.type || artifact.method || "artifact", 80),
      label: publicSummaryText(artifact.label || artifact.title || file.name || artifact.fileName || artifact.filename || "", 180),
      url: publicSummaryText(artifact.url || artifact.href || artifact.link || "", 600),
      cid: publicSummaryText(artifact.cid || artifact.ipfsCid || artifact.ipfs_cid || "", 240),
      txHash: publicSummaryText(artifact.txHash || artifact.tx_hash || "", 240),
    };
    if (ref.type || ref.label || ref.url || ref.cid || ref.txHash) refs.push(ref);
  }
  const eventCid = publicSummaryText(event.cid, 240);
  const eventTxHash = publicSummaryText(event.txHash, 240);
  if (eventCid || eventTxHash) {
    refs.push({
      type: "pftl_event",
      label: "Published evidence pointer",
      url: "",
      cid: eventCid,
      txHash: eventTxHash,
    });
  }
  const seen = new Set();
  return refs.filter((ref) => {
    const key = [ref.type, ref.label, ref.url, ref.cid, ref.txHash].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

export function publicEvidenceExcerpt(payload = {}, schema = "") {
  const evidence = safeObject(payload.evidence || payload.submission || payload.response);
  const candidates = [
    payload.public_summary,
    payload.publicSummary,
    payload.evidence_summary,
    payload.evidenceSummary,
    evidence.public_summary,
    evidence.publicSummary,
    evidence.evidence_summary,
    evidence.evidenceSummary,
  ];
  if (safeText(schema, 160) === "pf.task.verification_response.v1") {
    candidates.push(payload.response_summary, payload.responseSummary, evidence.response_summary, evidence.responseSummary);
  }
  return publicSummaryText(candidates.find((candidate) => publicSummaryText(candidate, 900)) || "", 900);
}

export function publicEvidenceRows(timeline = []) {
  return safeArray(timeline)
    .filter((event) => ["pf.task.submission.v1", "pf.task.verification_response.v1"].includes(safeText(event.schema, 160)))
    .map((event) => {
      const payload = safeObject(event.rawPayload);
      const schema = safeText(event.schema, 160);
      const artifactRefs = publicEvidenceArtifactRefs(payload, event);
      return {
        type: schema === "pf.task.verification_response.v1" ? "Verification response" : "Submission",
        schema,
        excerpt: publicEvidenceExcerpt(payload, schema),
        artifactRefs,
        time: toIso(event.observedAt),
        cid: publicSummaryText(event.cid, 240),
        txHash: publicSummaryText(event.txHash, 240),
        privateContentHidden: Boolean(
          payload.encrypted ||
          payload.encrypted_payload ||
          payload.encryptedPayload ||
          payload.ciphertext ||
          payload.private ||
          payload.raw ||
          payload.file
        ),
      };
    })
    .filter((item) => item.excerpt || item.artifactRefs.length || item.cid || item.txHash)
    .slice(0, 8);
}

export function publicTimelineRows(rows = []) {
  return safeArray(rows)
    .map((row, index) => publicReducerEvent(row, index))
    .map((event) => ({
      action: safeText(event.schema || event.label, 120),
      label: safeText(event.label, 180),
      time: toIso(event.observedAt),
      txHash: safeText(event.txHash, 240),
      cid: safeText(event.cid, 240),
    }))
    .filter((event) => event.label)
    .slice(0, 40);
}

export function latestTimelineEvent(timeline = [], schema = "") {
  const normalized = safeText(schema, 120);
  for (let index = safeArray(timeline).length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (safeText(event.schema, 120) === normalized) return event;
  }
  return null;
}

export function publicVerificationSummary(timeline = []) {
  const request = currentVerificationRequest(timeline);
  const response = latestTimelineEvent(timeline, "pf.task.verification_response.v1");
  if (!request && !response) return null;
  return {
    request: request ? publicSummaryText(request.body || request.ask, 900) : "",
    response: response ? "Verification response submitted." : "",
  };
}

export function publicRewardOutcome(outcome = null) {
  if (!outcome) {
    return {
      decision: "",
      rewardPft: 0,
      reason: "",
      paymentTxHash: "",
      paymentCid: "",
      paymentObservedAt: null,
    };
  }
  return {
    decision: publicSummaryText(outcome.decision || outcome.title || outcome.status, 120),
    rewardPft: numeric(outcome.rewardPft),
    reason: publicSummaryText(outcome.reason || outcome.userFeedback || outcome.summary, 900),
    paymentTxHash: publicSummaryText(outcome.paymentTxHash, 240),
    paymentCid: publicSummaryText(outcome.paymentCid, 240),
    paymentObservedAt: toIso(outcome.paymentObservedAt),
  };
}

export function publicAssigneeNft(nft = null) {
  return {
    title: safeText(nft?.title, 180),
    status: safeText(nft?.status, 80),
    imageCid: safeText(nft?.imageCid, 180),
    imageGatewayUrl: safeText(nft?.imageGatewayUrl, 500),
  };
}
