import { parse, parseFragment } from "parse5";
import { htmlTreeText } from "./html-tree-core.js";
export * from "./html-tree-core.js";
export const htmlFragment = value => parseFragment(String(value || ""));
export const htmlDocument = value => parse(String(value || ""));

export function decodeHtmlEntities(value = "") {
  // A text fragment decodes references without treating literal angle brackets
  // as markup. This is a single HTML tokenizer pass, not iterative decoding.
  return htmlTreeText(htmlFragment(String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;")), { skip: new Set() });
}
