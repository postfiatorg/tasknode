import { htmlFragment, htmlTreeText } from "./html-tree.js";
import { looksLikeContextHtml } from "./context-html.js";

export function contextBodyText(value = "") {
  const raw = String(value || "");
  if (!looksLikeContextHtml(raw)) return raw.trim();
  const lines = htmlTreeText(htmlFragment(raw), { block: true }).split("\n").map((line) => line.trimEnd());
  let blank = 0;
  return lines.filter((line) => { blank = line ? 0 : blank+1; return blank <= 1; }).join("\n").trim();
}

export function contextLineCount(value = "") {
  const text = contextBodyText(value);
  return Math.max(1, text ? text.split("\n").length : 1);
}
