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

export function escapeContextHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function looksLikeContextHtml(value = "") {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ""));
}

export function sanitizeContextHtml(value = "") {
  const input = String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<object[\s\S]*?<\/object\s*>/gi, "")
    .replace(/<embed[\s\S]*?<\/embed\s*>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg\s*>/gi, "")
    .replace(/<math[\s\S]*?<\/math\s*>/gi, "");

  let output = "";
  let offset = 0;
  const tagPattern = /<\/?[^>]+>/g;
  let match;
  const safeText = (text) => String(text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  while ((match = tagPattern.exec(input))) {
    output += safeText(input.slice(offset, match.index));
    offset = match.index + match[0].length;

    const tagMatch = /^<\s*(\/)?\s*([a-z0-9:-]+)/i.exec(match[0]);
    if (!tagMatch) continue;

    const closing = Boolean(tagMatch[1]);
    const tagName = tagMatch[2].toLowerCase();
    if (!allowedContextTags.has(tagName)) continue;
    if (closing && voidContextTags.has(tagName)) continue;
    output += closing ? `</${tagName}>` : `<${tagName}>`;
  }

  output += safeText(input.slice(offset));
  return output.trim() || "<p><br></p>";
}

export function normalizeContextBodyForStorage(value = "") {
  const text = String(value || "").slice(0, 50_000);
  return looksLikeContextHtml(text) ? sanitizeContextHtml(text) : text;
}
