import {
  decodeEvidenceDataUrl,
  extractEvidenceFileContent,
} from "./evidence-file-extraction.js";
import { normalizeChatAttachments } from "./chat-attachment-utils.js";

function textDataUrl(value = "") {
  return `data:text/plain;base64,${Buffer.from(String(value || ""), "utf8").toString("base64")}`;
}

export async function prepareAmbientChatAttachments(attachments = []) {
  const prepared = [];
  for (const attachment of normalizeChatAttachments(attachments)) {
    if (attachment.kind === "image" || attachment.kind === "text") {
      prepared.push(attachment);
      continue;
    }

    const decoded = decodeEvidenceDataUrl(attachment.dataUrl);
    const extracted = await extractEvidenceFileContent({
      buffer: decoded.buffer,
      fileName: attachment.name,
      mimeType: attachment.mimeType || decoded.mimeType,
    });
    const metadata = [
      `Locally extracted attachment: ${attachment.name}`,
      `Parser: ${extracted.parser}`,
      extracted.warnings?.length ? `Warnings: ${extracted.warnings.join(", ")}` : "",
      "",
      extracted.text,
    ].filter((value) => value !== "").join("\n");
    if (extracted.text) {
      prepared.push({
        ...attachment,
        kind: "text",
        mimeType: "text/plain",
        dataUrl: textDataUrl(metadata),
        extraction: { parser: extracted.parser, metadata: extracted.metadata || {}, warnings: extracted.warnings || [] },
      });
    }
    for (const [index, image] of (extracted.images || []).entries()) {
      prepared.push({
        ...attachment,
        name: `${attachment.name}:${image.name || `visual-${index + 1}`}`,
        kind: "image",
        mimeType: image.mimeType,
        dataUrl: `data:${image.mimeType};base64,${Buffer.from(image.buffer).toString("base64")}`,
        extraction: { parser: extracted.parser, visualIndex: index + 1 },
      });
    }
  }
  return prepared;
}
