import { createHash } from "node:crypto";
import { looksLikeContextHtml } from "../shared/context-html.js";

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function contextBodyText(value = "") {
  const raw = String(value || "");
  if (!looksLikeContextHtml(raw)) return raw.trim();

  return decodeHtmlEntities(
    raw
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/(p|div|h[1-6]|li|blockquote|pre|tr|table|ul|ol)\s*>/gi, "\n")
      .replace(/<\s*li\s*>/gi, "- ")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256Text(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function numberContextLines(value = "") {
  const text = contextBodyText(value);
  const lines = text ? text.split("\n") : [""];
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
}

export function contextDocumentPacket(document = {}) {
  const bodyText = contextBodyText(document?.body || "");
  return {
    title: document?.title || "Task Node Context",
    revision: Number(document?.revision || 0),
    updatedAt: document?.updatedAt || document?.updated_at || "",
    bodyText,
    bodySha256: sha256Text(bodyText),
    lineNumberedText: numberContextLines(bodyText),
  };
}
