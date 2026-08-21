import { looksLikeContextHtml } from "./context-html.js";

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

export function contextLineCount(value = "") {
  const text = contextBodyText(value);
  return Math.max(1, text ? text.split("\n").length : 1);
}
