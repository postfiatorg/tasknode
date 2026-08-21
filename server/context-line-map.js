import { createHash } from "node:crypto";
import { contextBodyText } from "../shared/context-line-map.js";

export { contextBodyText, contextLineCount } from "../shared/context-line-map.js";

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
