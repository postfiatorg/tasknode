export const escapeHtmlText = (value = "") => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const hiddenHtmlTags = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "math"]);

const blockBreaks = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "tr", "table", "ul", "ol"]);
const tableCells = new Set(["td", "th", "caption"]);
const tableStructure = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
const htmlWhitespaceOnly = /^[ \t\n\f\r]*$/;

// Block mode puts each table cell on its own line. A bare cell gets one line
// break; a cell whose paragraph (or other block) child already ended the line
// gets none, so paragraph-wrapped tables read exactly as before.
function tableCellText(text) {
  if (htmlWhitespaceOnly.test(text)) return text.includes("\n") ? "\n" : "";
  const cell = text.replace(/^[ \t\n\f\r]+/, "").replace(/[ \t\f\r]+$/, "");
  return cell.endsWith("\n") ? cell : `${cell}\n`;
}

export function htmlTreeText(node, { skip = hiddenHtmlTags, block = false } = {}) {
  if (skip.has(node.tagName)) return "";
  if (node.nodeName === "#text") return node.value;
  if (node.nodeName === "#comment") return "";
  if (node.tagName === "br") return "\n";
  let text = "";
  for (const child of node.childNodes || []) {
    // Whitespace between rows and cells is source formatting, not cell text.
    if (block && tableStructure.has(node.tagName) && child.nodeName === "#text" && htmlWhitespaceOnly.test(child.value)) continue;
    const part = htmlTreeText(child, { skip, block });
    // A nested table starts on its own line instead of joining the text before it.
    text += block && child.tagName === "table" && text && !text.endsWith("\n") ? `\n${part}` : part;
  }
  if (block && tableCells.has(node.tagName)) return tableCellText(text);
  return `${block && node.tagName === "li" ? "- " : ""}${text}${block && blockBreaks.has(node.tagName) ? "\n" : ""}`;
}

export function findHtmlElement(node, tag) {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes || []) { const found = findHtmlElement(child, tag); if (found) return found; }
  return null;
}
