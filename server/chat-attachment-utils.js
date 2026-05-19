export const maxChatAttachments = 4;
export const maxAttachmentDataUrlBytes = 6 * 1024 * 1024;
export const maxTextAttachmentCharacters = 40_000;

function dataUrlParts(dataUrl = "") {
  const match = /^data:([^,]*),(.*)$/is.exec(String(dataUrl || ""));
  if (!match) return null;
  return {
    metadata: match[1].toLowerCase(),
    body: match[2] || "",
  };
}

function mimeTypeFromAttachment(attachment, metadata = "") {
  const explicit = String(attachment?.mimeType || attachment?.type || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  if (explicit) return explicit;
  return String(metadata || "").split(";")[0].trim().toLowerCase().slice(0, 120);
}

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

function safeAttachmentName(name = "") {
  return String(name || "attachment")
    .trim()
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .slice(0, 160) || "attachment";
}

function normalizedSource(source = "") {
  const value = String(source || "").trim().toLowerCase().slice(0, 40);
  if (["paste", "upload", "drag_drop"].includes(value)) return value;
  return "";
}

function attachmentError({ attachment, code, index, message }) {
  return {
    index,
    name: safeAttachmentName(attachment?.name),
    code,
    message,
  };
}

function hasValidBase64Body(body = "") {
  const normalized = String(body || "").replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
}

export function validateChatAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return { ok: true, attachments: [], errors: [], status: 200 };

  const errors = [];
  if (attachments.length > maxChatAttachments) {
    errors.push({
      index: null,
      name: "",
      code: "too_many_attachments",
      message: `Attach up to ${maxChatAttachments} files at a time.`,
      count: attachments.length,
      max: maxChatAttachments,
    });
  }

  for (const [index, attachment] of attachments.entries()) {
    const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl.trim() : "";
    const name = safeAttachmentName(attachment?.name);
    if (!dataUrl.startsWith("data:")) {
      errors.push(attachmentError({
        attachment,
        code: "invalid_data_url",
        index,
        message: `${name} is not a valid attachment payload.`,
      }));
      continue;
    }

    if (Buffer.byteLength(dataUrl, "utf8") > maxAttachmentDataUrlBytes) {
      errors.push(attachmentError({
        attachment,
        code: "attachment_too_large",
        index,
        message: `${name} is larger than the server attachment limit.`,
      }));
      continue;
    }

    const parts = dataUrlParts(dataUrl);
    if (!parts) {
      errors.push(attachmentError({
        attachment,
        code: "invalid_data_url",
        index,
        message: `${name} is not a valid attachment payload.`,
      }));
      continue;
    }

    const mimeType = mimeTypeFromAttachment(attachment, parts.metadata);
    if (!mimeType) {
      errors.push(attachmentError({
        attachment,
        code: "missing_mime_type",
        index,
        message: `${name} is missing a file type.`,
      }));
      continue;
    }

    if (parts.metadata.includes(";base64") && !hasValidBase64Body(parts.body)) {
      errors.push(attachmentError({
        attachment,
        code: "invalid_base64",
        index,
        message: `${name} could not be decoded.`,
      }));
      continue;
    }

    if (chatAttachmentType(mimeType) === "text" && !decodeTextDataUrl(dataUrl)) {
      errors.push(attachmentError({
        attachment,
        code: "text_attachment_unreadable",
        index,
        message: `${name} could not be read as text.`,
      }));
    }
  }

  return {
    ok: errors.length === 0,
    attachments: errors.length === 0 ? normalizeChatAttachments(attachments) : [],
    errors,
    status: errors.some((error) => error.code === "attachment_too_large") ? 413 : errors.length > 0 ? 400 : 200,
  };
}

export function normalizeChatAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .slice(0, maxChatAttachments)
    .map((attachment) => {
      const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl.trim() : "";
      if (!dataUrl.startsWith("data:") || dataUrl.length > maxAttachmentDataUrlBytes) return null;

      const parts = dataUrlParts(dataUrl);
      const mimeType = mimeTypeFromAttachment(attachment, parts?.metadata || "");
      const name = safeAttachmentName(attachment?.name);
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
  const parts = dataUrlParts(dataUrl);
  if (!parts) return "";

  try {
    const decoded = parts.metadata.includes(";base64")
      ? Buffer.from(parts.body, "base64").toString("utf8")
      : decodeURIComponent(parts.body);
    return decoded.split("\u0000").join("").trim();
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
