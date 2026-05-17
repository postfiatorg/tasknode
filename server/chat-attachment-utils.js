export const maxChatAttachments = 4;
export const maxAttachmentDataUrlBytes = 6 * 1024 * 1024;
export const maxTextAttachmentCharacters = 40_000;

function chatAttachmentType(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/csv"
  ) {
    return "text";
  }
  return "file";
}

function normalizedSource(source = "") {
  const value = String(source || "").trim().toLowerCase().slice(0, 40);
  if (["paste", "upload", "drag_drop"].includes(value)) return value;
  return "";
}

export function normalizeChatAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .slice(0, maxChatAttachments)
    .map((attachment) => {
      const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl.trim() : "";
      if (!dataUrl.startsWith("data:") || dataUrl.length > maxAttachmentDataUrlBytes) return null;

      const mimeType = String(attachment?.mimeType || attachment?.type || "")
        .trim()
        .toLowerCase()
        .slice(0, 120);
      const name = String(attachment?.name || "attachment")
        .trim()
        .replace(/[^\w.\- ()[\]]+/g, "_")
        .slice(0, 160) || "attachment";
      const size = Math.max(0, Number(attachment?.size || 0));

      return {
        name,
        mimeType,
        size,
        source: normalizedSource(attachment?.source),
        dataUrl,
        kind: chatAttachmentType(mimeType),
      };
    })
    .filter(Boolean);
}

export function decodeTextDataUrl(dataUrl) {
  const match = /^data:([^,]*),(.*)$/is.exec(String(dataUrl || ""));
  if (!match) return "";

  try {
    const metadata = match[1].toLowerCase();
    const body = match[2] || "";
    const decoded = metadata.includes(";base64")
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    return decoded.replace(/\u0000/g, "").trim();
  } catch {
    return "";
  }
}

export function textAttachmentPrompt(attachment) {
  const text = decodeTextDataUrl(attachment.dataUrl);
  const safeText = text.slice(0, maxTextAttachmentCharacters);
  const truncated = text.length > safeText.length;
  return [
    `Attached text: ${attachment.name}`,
    truncated
      ? `Showing the first ${safeText.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.`
      : null,
    safeText || "[The attached text could not be decoded.]",
  ].filter(Boolean).join("\n\n");
}

export function chatInputCharacterEstimate({ message = "", attachments = [] } = {}) {
  const attachmentCharacters = normalizeChatAttachments(attachments).reduce((total, attachment) => {
    if (attachment.kind === "text") return total + textAttachmentPrompt(attachment).length;
    return total + `Attached ${attachment.kind}: ${attachment.name} ${attachment.mimeType}`.length;
  }, 0);

  return String(message || "").length + attachmentCharacters;
}
