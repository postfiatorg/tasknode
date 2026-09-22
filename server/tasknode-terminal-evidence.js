// Keep the report as the primary artifact even when the CLI also extracts URLs.
export function terminalTaskEvidenceSubmission(payload = {}, taskId = "") {
  const value = payload.summary || payload.value || "";
  const items = (Array.isArray(payload.evidence) ? payload.evidence : []).map((item) => ({
    artifact_type: item?.type || item?.artifact_type || "text",
    value: item?.url || item?.value || item?.text || "",
    notes: item?.notes || "",
  }));
  if (value) {
    const duplicate = items.findIndex((item) => item.artifact_type === "text" && item.value === value);
    if (duplicate >= 0) items.splice(duplicate, 1);
    items.unshift({ artifact_type: payload.method || "text", value, notes: "" });
  }
  return {
    ...payload,
    phase: "submit",
    taskId,
    method: payload.method || "text",
    value,
    evidence_items: items.map((item, index) => ({ index: index + 1, ...item })),
    source: "pfterminal",
  };
}
