export const escapeHtmlText = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const hiddenHtmlTags = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "math"]);

export function htmlTreeText(node, { skip = hiddenHtmlTags, block = false } = {}) {
  if (skip.has(node.tagName)) return "";
  if (node.nodeName === "#text") return node.value;
  if (node.nodeName === "#comment") return "";
  if (node.tagName === "br") return "\n";
  const text = (node.childNodes || []).map((child) => htmlTreeText(child, { skip, block })).join("");
  const breaks = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "tr", "table", "ul", "ol"]);
  return `${block && node.tagName === "li" ? "- " : ""}${text}${block && breaks.has(node.tagName) ? "\n" : ""}`;
}

export function findHtmlElement(node, tag) {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes || []) { const found = findHtmlElement(child, tag); if (found) return found; }
  return null;
}
