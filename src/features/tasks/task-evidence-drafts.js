const evidenceMethodByStructuredType = {
  code: "code",
  file: "file",
  github_commit: "commit",
  mixed: "text",
  screenshot: "screenshot",
  text: "text",
  url: "url",
};

export const MAX_TASK_EVIDENCE_ITEMS = 2;

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
  return [createEvidenceDraft(method)];
}

export function addUserRequestedEvidenceDraft(current = [], method = "text") {
  const drafts = Array.isArray(current) && current.length > 0 ? current : resetEvidenceDrafts(method);
  if (drafts.length >= MAX_TASK_EVIDENCE_ITEMS) return drafts;
  return [...drafts, createEvidenceDraft(method)];
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
