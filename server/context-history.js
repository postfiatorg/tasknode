const CONTENT_KIND = Object.freeze({
  UNSPECIFIED: 0,
  TASK: 1,
  TASK_UPDATE: 2,
  TASK_SUBMISSION: 3,
  CHAT: 4,
  CONTEXT: 5,
  REWARD: 6,
  POLICY: 7,
  IDENTITY: 8,
  ASSET: 9,
  DOCUMENT: 10,
  SYSTEM: 11,
  TEST: 99,
});

const KIND_LABELS = Object.freeze(Object.keys(CONTENT_KIND).reduce((acc, key) => {
  acc[CONTENT_KIND[key]] = key;
  return acc;
}, {}));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickField(obj, names) {
  if (!isPlainObject(obj)) return null;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== "") return obj[name];
  }
  return null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeCid(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return text.replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "").split(/[?#]/)[0] || null;
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseMaybeJson(value) {
  if (!value) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function findCidInPayload(value) {
  const parsed = parseMaybeJson(value);
  if (!parsed) return null;
  if (typeof parsed === "string") return normalizeCid(parsed);
  if (!isPlainObject(parsed)) return null;

  const direct = normalizeCid(pickField(parsed, [
    "artifact_cid",
    "artifactCid",
    "encrypted_cid",
    "encryptedCid",
    "response_cid",
    "responseCid",
    "context_doc_cid",
    "contextDocCid",
    "cid",
  ]));
  if (direct) return direct;

  const artifact = isPlainObject(parsed.artifact) ? parsed.artifact : null;
  const artifactCid = normalizeCid(pickField(artifact, [
    "encrypted_cid",
    "encryptedCid",
    "artifact_cid",
    "artifactCid",
    "cid",
  ]));
  if (artifactCid) return artifactCid;

  for (const entry of asArray(parsed.artifacts)) {
    const entryCid = normalizeCid(pickField(entry, [
      "encrypted_cid",
      "encryptedCid",
      "artifact_cid",
      "artifactCid",
      "cid",
    ])) || normalizeCid(pickField(entry?.artifact, [
      "encrypted_cid",
      "encryptedCid",
      "artifact_cid",
      "artifactCid",
      "cid",
    ]));
    if (entryCid) return entryCid;
  }

  return null;
}

function taskEventTypeToKind(eventType) {
  switch (eventType) {
    case "submission_recorded":
    case "evidence_uploaded":
    case "verification_response_evidence":
    case "verification_responded":
      return CONTENT_KIND.TASK_SUBMISSION;
    case "reward_paid":
    case "reward_skipped":
      return CONTENT_KIND.REWARD;
    case "task_generated":
      return CONTENT_KIND.TASK;
    default:
      return CONTENT_KIND.TASK_UPDATE;
  }
}

function normalizeTaskMap(rows) {
  const taskMap = new Map();
  for (const row of asArray(rows)) {
    const id = normalizeText(pickField(row, ["id", "task_id", "taskId"]));
    if (!id) continue;
    taskMap.set(id, {
      id,
      title: normalizeText(pickField(row, ["title", "task_title", "taskTitle"])),
      status: normalizeText(pickField(row, ["status"])),
      verificationType: normalizeText(pickField(row, ["verification_type", "verificationType"])),
    });
  }
  return taskMap;
}

function pointerKey(event) {
  return [
    event.source || "unknown",
    event.txHash || "nohash",
    event.memoIndex ?? "0",
    event.cid || "nocid",
    event.taskId || "",
    event.eventType || "",
  ].join(":");
}

function sortDesc(left, right) {
  const leftTime = Date.parse(left.createdAt || "") || 0;
  const rightTime = Date.parse(right.createdAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return Number(right.ledgerIndex || 0) - Number(left.ledgerIndex || 0);
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = pointerKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeContextRows(rows, walletAddress) {
  return asArray(rows).map((row, index) => {
    const cid = normalizeCid(pickField(row, ["cid", "context_doc_cid", "contextDocCid"]));
    if (!cid) return null;
    return {
      cid,
      kind: CONTENT_KIND.CONTEXT,
      kindLabel: KIND_LABELS[CONTENT_KIND.CONTEXT],
      schema: null,
      flags: 0,
      taskId: null,
      threadId: null,
      contextId: normalizeText(pickField(row, ["id", "context_id", "contextId"])) || null,
      txHash: normalizeText(pickField(row, ["tx_hash", "txHash", "pftl_tx_hash", "pftlTxHash"])) || null,
      ledgerIndex: pickField(row, ["ledger_index", "ledgerIndex"]) || null,
      memoIndex: pickField(row, ["memo_index", "memoIndex"]) ?? index,
      createdAt: normalizeDate(pickField(row, ["created_at", "createdAt", "tx_timestamp", "txTimestamp"])),
      account: walletAddress || null,
      destination: null,
      direction: "indexed",
      source: "pftasks.context_revisions",
      version: pickField(row, ["context_version", "contextVersion"]) || null,
      wordCount: pickField(row, ["word_count", "wordCount"]) || null,
    };
  }).filter(Boolean);
}

function normalizeTaskEventRows(rows, taskMap, walletAddress) {
  return asArray(rows).map((row, index) => {
    const payload = parseMaybeJson(pickField(row, ["event_payload", "eventPayload", "payload"]));
    const taskId = normalizeText(pickField(row, ["task_id", "taskId"]));
    const eventType = normalizeText(pickField(row, ["event_type", "eventType"])) || "task_update";
    const kind = taskEventTypeToKind(eventType);
    const task = taskMap.get(taskId) || {};
    return {
      cid: findCidInPayload(payload),
      kind,
      kindLabel: KIND_LABELS[kind],
      schema: null,
      flags: 0,
      taskId: taskId || null,
      threadId: null,
      contextId: null,
      txHash: normalizeText(pickField(row, ["pftl_tx_hash", "pftlTxHash", "tx_hash", "txHash"])) || null,
      ledgerIndex: pickField(row, ["ledger_index", "ledgerIndex"]) || null,
      memoIndex: pickField(row, ["memo_index", "memoIndex"]) ?? index,
      createdAt: normalizeDate(pickField(row, ["created_at", "createdAt"])),
      account: walletAddress || null,
      destination: null,
      direction: "indexed",
      source: "pftasks.task_events",
      eventId: normalizeText(pickField(row, ["id", "event_id", "eventId"])) || null,
      eventType,
      title: task.title || "",
      status: task.status || "",
      artifactType: task.verificationType || "",
    };
  });
}

function normalizeSubmissionRows(rows, taskMap, existingEvents, walletAddress) {
  const seen = new Set(existingEvents.map((event) => [
    event.taskId || "",
    event.cid || "",
    event.txHash || "",
    "submission_recorded",
  ].join(":")));

  const normalized = [];
  asArray(rows).forEach((row, index) => {
    const taskId = normalizeText(pickField(row, ["task_id", "taskId"]));
    const cid = normalizeCid(pickField(row, ["artifact_cid", "artifactCid", "cid"]));
    const txHash = normalizeText(pickField(row, ["pftl_tx_hash", "pftlTxHash", "tx_hash", "txHash"])) || null;
    const key = [taskId || "", cid || "", txHash || "", "submission_recorded"].join(":");
    if (seen.has(key)) return;
    seen.add(key);

    const artifacts = asArray(parseMaybeJson(pickField(row, ["evidence_artifacts", "evidenceArtifacts"])));
    const task = taskMap.get(taskId) || {};
    normalized.push({
      cid,
      kind: CONTENT_KIND.TASK_SUBMISSION,
      kindLabel: KIND_LABELS[CONTENT_KIND.TASK_SUBMISSION],
      schema: null,
      flags: 0,
      taskId: taskId || null,
      threadId: null,
      contextId: null,
      txHash,
      ledgerIndex: pickField(row, ["ledger_index", "ledgerIndex"]) || null,
      memoIndex: pickField(row, ["memo_index", "memoIndex"]) ?? index,
      createdAt: normalizeDate(pickField(row, ["created_at", "createdAt"])),
      account: walletAddress || null,
      destination: null,
      direction: "indexed",
      source: "pftasks.task_submissions",
      eventId: normalizeText(pickField(row, ["id", "submission_id", "submissionId"])) || null,
      eventType: "submission_recorded",
      title: task.title || "",
      status: task.status || "",
      artifactType: normalizeText(pickField(row, ["artifact_type", "artifactType"])) || task.verificationType || "",
      artifactCount: artifacts.length || (cid ? 1 : 0),
    });
  });

  return normalized;
}

export function normalizeIndexedContextHistory(input = {}) {
  const indexedData = isPlainObject(input.indexedData) ? input.indexedData : input;
  const walletAddress = normalizeText(
    input.walletAddress ||
    pickField(indexedData.wallet, ["wallet_address", "walletAddress", "address"]) ||
    pickField(indexedData, ["wallet_address", "walletAddress", "address"])
  ) || null;
  const contextRevisions = input.contextRevisions || indexedData.contextRevisions ||
    indexedData.context_revisions || indexedData.context || [];
  const tasks = input.tasks || indexedData.tasks || [];
  const taskEvents = input.taskEvents || indexedData.taskEvents || indexedData.task_events || [];
  const taskSubmissions = input.taskSubmissions || input.submissions ||
    indexedData.taskSubmissions || indexedData.task_submissions || indexedData.submissions || [];
  const taskMap = normalizeTaskMap(tasks);
  const contextUpdates = dedupeEvents(normalizeContextRows(contextRevisions, walletAddress)).sort(sortDesc);
  const taskEventRows = normalizeTaskEventRows(taskEvents, taskMap, walletAddress);
  const submissionRows = normalizeSubmissionRows(taskSubmissions, taskMap, taskEventRows, walletAddress);
  const normalizedTaskEvents = dedupeEvents(taskEventRows.concat(submissionRows)).sort(sortDesc);
  const latestContextPointer = contextUpdates[0] || null;

  return {
    source: "pftasks_indexed_snapshot",
    normalizedAt: new Date().toISOString(),
    walletAddress,
    pointerCount: contextUpdates.length + normalizedTaskEvents.length,
    contextUpdateCount: contextUpdates.length,
    taskEventCount: normalizedTaskEvents.length,
    latestContextPointer,
    contextUpdates,
    taskEvents: normalizedTaskEvents,
    hydration: {
      plaintextHydrated: false,
      requiresWalletUnlock: true,
      ipfsFetchReady: true,
      fetchPath: "/api/context/history/ipfs/:cid",
      note:
        "This bridge stores PFDocs-compatible pointer metadata only. Encrypted CID plaintext is fetched by CID and decrypted after local wallet unlock.",
    },
  };
}
