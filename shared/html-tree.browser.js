// Browsers already provide the HTML parser. Only server runtimes load parse5,
// keeping the server parser out of the application's initial download.
import { htmlTreeText } from "./html-tree-core.js";
export * from "./html-tree-core.js";
function nativeTree(node) {
  if (node.nodeType === 3) return { nodeName: "#text", value: node.nodeValue };
  if (node.nodeType === 8) return { nodeName: "#comment" };
  return {
    nodeName: node.nodeName.toLowerCase(),
    tagName: node.nodeType === 1 ? node.localName : undefined,
    attrs: Array.from(node.attributes || [], attribute => ({ name: attribute.name, value: attribute.value })),
    childNodes: Array.from(node.childNodes || [], nativeTree),
  };
}
export function htmlFragment(value) {
  const text = String(value || "");
  const template = document.createElement("template");
  template.innerHTML = text;
  return nativeTree(template.content);
}
export function htmlDocument(value) {
  const text = String(value || "");
  return nativeTree(new DOMParser().parseFromString(text, "text/html"));
}

export function decodeHtmlEntities(value = "") {
  // A text fragment decodes references without treating literal angle brackets
  // as markup. This is a single HTML tokenizer pass, not iterative decoding.
  return htmlTreeText(htmlFragment(String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;")), { skip: new Set() });
}
