function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function summarizeEvidenceItems(items = []) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item, index) => {
      const file = safeObject(item?.file);
      return [
        `${Number(item?.index || index + 1)}. ${safeText(item?.artifact_type || item?.type || "artifact", 80)}`,
        safeText(file.name || item?.value || "", 260),
        safeText(file.description || file.text || item?.notes || "", 360),
      ].filter(Boolean).join(" - ");
    })
    .filter(Boolean)
    .join("\n");
}
