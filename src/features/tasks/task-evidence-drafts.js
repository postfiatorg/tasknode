const evidenceMethodByStructuredType = {
  code: "code",
  file: "file",
  github_commit: "commit",
  mixed: "mixed",
  screenshot: "screenshot",
  text: "text",
  url: "url",
};

export const MAX_TASK_EVIDENCE_ITEMS = 2;
const EVIDENCE_DRAFT_STORAGE_SCHEMA = "tasknode.task_evidence_drafts.v1";
const evidenceDraftMethods = new Set(["code", "commit", "file", "screenshot", "text", "url"]);

function safeText(value = "", max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function boundedText(value = "", max = 5000) {
  return String(value || "").slice(0, max);
}

function evidenceDraftMethod(value = "") {
  const method = String(value || "").trim();
  return evidenceDraftMethods.has(method) ? method : "text";
}

export function createEvidenceDraft(method = "text") {
  return {
    id: globalThis.crypto?.randomUUID?.() || `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    code: "",
    commit: "",
    file: null,
    fileName: "",
    method,
    screenshotFile: null,
    screenshot: "",
    text: "",
    url: "",
  };
}

export function resetEvidenceDrafts(method = "text") {
  if (method === "mixed") {
    return [createEvidenceDraft("text")];
  }
  return [createEvidenceDraft(method)];
}

export function addUserRequestedEvidenceDraft(current = [], method = "text") {
  const drafts = Array.isArray(current) && current.length > 0 ? current : resetEvidenceDrafts(method);
  if (drafts.length >= MAX_TASK_EVIDENCE_ITEMS) return drafts;
  const nextMethod = method === "mixed"
    ? (drafts.some((draft) => draft.method === "screenshot") ? "text" : "screenshot")
    : method;
  return [...drafts, createEvidenceDraft(nextMethod)];
}

export function evidenceMethodFromContract(task = {}, verification = {}) {
  const structuredTypes = [
    task?.submissionRequirement?.type,
    task?.submission_type,
    task?.submissionType,
    task?.metadata?.submissionType,
    verification?.submissionRequirement?.type,
    verification?.policy?.verification_type,
    verification?.policy?.type,
  ];
  for (const value of structuredTypes) {
    const method = evidenceMethodByStructuredType[String(value || "").trim()];
    if (method) return method;
  }
  return "text";
}

export function evidenceValueForDraft(draft = {}) {
  return {
    code: draft.code,
    commit: draft.commit,
    file: draft.fileName,
    screenshot: draft.screenshot,
    text: draft.text,
    url: draft.url,
  }[draft.method] || "";
}

export function evidenceFileForDraft(draft = {}) {
  return draft.method === "screenshot" ? draft.screenshotFile : draft.method === "file" ? draft.file : null;
}

export function taskEvidenceDraftStorageKey({
  accountId = "",
  submissionModeKey = "",
  taskId = "",
} = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return "";
  return [
    "tasknode_task_evidence_drafts_v1",
    encodeURIComponent(safeText(accountId, 180) || "anonymous"),
    encodeURIComponent(normalizedTaskId),
    encodeURIComponent(safeText(submissionModeKey, 300) || "default"),
  ].join(":");
}

function draftHasUserInput(draft = {}) {
  return ["code", "commit", "text", "url"].some((field) => boundedText(draft[field], 10000).trim());
}

export function evidenceDraftStateHasUserInput({ evidenceDrafts = [], notes = "" } = {}) {
  return Boolean(boundedText(notes, 10000).trim() || (Array.isArray(evidenceDrafts) && evidenceDrafts.some(draftHasUserInput)));
}

export function serializeEvidenceDraftState({ evidenceDrafts = [], notes = "" } = {}) {
  const drafts = (Array.isArray(evidenceDrafts) ? evidenceDrafts : [])
    .slice(0, MAX_TASK_EVIDENCE_ITEMS)
    .map((draft) => {
      const method = evidenceDraftMethod(draft?.method);
      return {
        id: safeText(draft?.id, 120) || createEvidenceDraft(method).id,
        code: method === "code" ? boundedText(draft?.code, 20000) : "",
        commit: method === "commit" ? safeText(draft?.commit, 1000) : "",
        fileName: "",
        method,
        screenshot: "",
        text: method === "text" ? boundedText(draft?.text, 20000) : "",
        url: method === "url" ? safeText(draft?.url, 2000) : "",
      };
    });
  return {
    schema: EVIDENCE_DRAFT_STORAGE_SCHEMA,
    notes: boundedText(notes, 10000),
    drafts,
    updatedAt: new Date().toISOString(),
  };
}

export function restoreEvidenceDraftState(value = null, defaultMethod = "text") {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || parsed.schema !== EVIDENCE_DRAFT_STORAGE_SCHEMA || !Array.isArray(parsed.drafts)) {
    return {
      evidenceDrafts: resetEvidenceDrafts(defaultMethod),
      notes: "",
    };
  }

  const drafts = parsed.drafts
    .slice(0, MAX_TASK_EVIDENCE_ITEMS)
    .map((draft) => {
      const method = evidenceDraftMethod(draft?.method);
      const fallback = createEvidenceDraft(method);
      return {
        ...fallback,
        id: safeText(draft?.id, 120) || fallback.id,
        code: method === "code" ? boundedText(draft?.code, 20000) : "",
        commit: method === "commit" ? safeText(draft?.commit, 1000) : "",
        text: method === "text" ? boundedText(draft?.text, 20000) : "",
        url: method === "url" ? safeText(draft?.url, 2000) : "",
      };
    });

  return {
    evidenceDrafts: drafts.length > 0 ? drafts : resetEvidenceDrafts(defaultMethod),
    notes: boundedText(parsed.notes, 10000),
  };
}
