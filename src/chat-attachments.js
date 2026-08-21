export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

export function byteSize(text = "") {
  return new Blob([String(text || "")]).size;
}

export function createPastedTextAttachment(text, size = byteSize(text)) {
  const firstLine = String(text || "").split("\n").find((line) => line.trim()) || "Pasted text";
  const trimmed = firstLine.trim().replace(/\s+/g, " ");
  return {
    id: `paste-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: `${trimmed.slice(0, 28)}${trimmed.length > 28 ? " .." : ""}`,
    mimeType: "text/plain",
    size,
    dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(String(text || ""))}`,
    source: "paste",
  };
}

export function textFromAttachment(attachment) {
  const dataUrl = String(attachment?.dataUrl || "");
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:text/plain") || comma === -1) return "";

  try {
    const metadata = dataUrl.slice(0, comma).toLowerCase();
    const body = dataUrl.slice(comma + 1);
    if (metadata.includes(";base64")) return atob(body);
    return decodeURIComponent(body);
  } catch {
    return "";
  }
}

export function promptForAttachments(attachments = []) {
  const hasPastedText = attachments.some((attachment) => attachment?.source === "paste");
  return hasPastedText ? "Review the attached pasted text." : "Review the attached file.";
}

export function formatFileSize(bytes) {
  const numeric = Number(bytes || 0);
  if (numeric >= 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
  if (numeric >= 1024) return `${Math.round(numeric / 1024)} KB`;
  return `${Math.max(0, numeric)} B`;
}

export function mimeTypeFromFilename(name = "") {
  const filename = String(name || "").toLowerCase();
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (filename.endsWith(".doc")) return "application/msword";
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".csv")) return "text/csv";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  return "text/plain";
}
