import { htmlFragment, hiddenHtmlTags, escapeHtmlText } from "./html-tree.js";
import { CONTEXT_DOCUMENT_MAX_CHARS } from "./context-budget.js";

const allowedContextTags = new Set([
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const voidContextTags = new Set(["br"]);

export { escapeHtmlText as escapeContextHtml } from "./html-tree.js";

export function looksLikeContextHtml(value = "") {
  return htmlFragment(value).childNodes.some((node) => Boolean(node.tagName));
}

export function sanitizeContextHtml(value = "") {
  const render = (node) => {
    if (hiddenHtmlTags.has(node.tagName) || node.nodeName === "#comment") return "";
    if (node.nodeName === "#text") return escapeHtmlText(node.value);
    const children = (node.childNodes || []).map(render).join("");
    if (!allowedContextTags.has(node.tagName)) return children;
    return voidContextTags.has(node.tagName) ? `<${node.tagName}>` : `<${node.tagName}>${children}</${node.tagName}>`;
  };
  return render(htmlFragment(value)).trim() || "<p><br></p>";
}

export function normalizeContextBodyForStorage(value = "") {
  const text = String(value || "").slice(0, CONTEXT_DOCUMENT_MAX_CHARS);
  return looksLikeContextHtml(text) ? sanitizeContextHtml(text) : text;
}
