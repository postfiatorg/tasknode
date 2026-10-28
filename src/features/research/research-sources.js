export function researchSourceUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function researchSources(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const text = (field) => typeof field === "string" ? field : "";
    return [{ id: text(source.id) || String(index + 1),
      label: [text(source.title) || text(source.ticker) || text(source.provider) || "Source evidence", text(source.date)].filter(Boolean).join(" · "),
      url: researchSourceUrl(source.url), evidence: source }];
  });
}
