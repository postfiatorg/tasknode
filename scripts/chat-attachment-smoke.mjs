import assert from "node:assert/strict";
import {
  chatInputCharacterEstimate,
  openAiInput,
  openRouterMessages,
} from "../server/chat-router.js";
import {
  maxAttachmentDataUrlBytes,
  maxChatAttachmentFileBytes,
  validateChatAttachments,
} from "../server/chat-attachment-utils.js";
import { prepareAmbientChatAttachments } from "../server/ambient-attachments.js";
import {
  decodeEvidenceDataUrl,
  MAX_EVIDENCE_FILE_BYTES,
} from "../server/evidence-file-extraction.js";

const longText = Array.from(
  { length: 12 },
  (_, index) => `Line ${index + 1}: pasted task context should be readable as model text, not sent as an opaque file.`
).join("\n");

const percentEncodedTextAttachment = {
  name: "pasted task context.txt",
  mimeType: "text/plain",
  size: Buffer.byteLength(longText),
  dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(longText)}`,
};

const base64TextAttachment = {
  name: "uploaded notes.txt",
  mimeType: "text/plain",
  size: Buffer.byteLength(longText),
  dataUrl: `data:text/plain;base64,${Buffer.from(longText, "utf8").toString("base64")}`,
};

const pdfAttachment = {
  name: "source.pdf",
  mimeType: "application/pdf",
  size: 12,
  dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
};

const invalidDataUrl = validateChatAttachments([
  {
    name: "not-data.txt",
    mimeType: "text/plain",
    dataUrl: "not-a-data-url",
  },
]);
assert.equal(invalidDataUrl.ok, false);
assert.equal(invalidDataUrl.status, 400);
assert.equal(invalidDataUrl.errors[0].code, "invalid_data_url");

const tooManyAttachments = validateChatAttachments(Array.from(
  { length: 5 },
  (_, index) => ({
    ...percentEncodedTextAttachment,
    name: `note-${index + 1}.txt`,
  })
));
assert.equal(tooManyAttachments.ok, false);
assert.equal(tooManyAttachments.status, 400);
assert.equal(tooManyAttachments.errors.some((error) => error.code === "too_many_attachments"), true);

const oversizedAttachment = validateChatAttachments([
  {
    name: "huge.txt",
    mimeType: "text/plain",
    dataUrl: `data:text/plain,${"a".repeat(maxAttachmentDataUrlBytes)}`,
  },
]);
assert.equal(oversizedAttachment.ok, false);
assert.equal(oversizedAttachment.status, 413);
assert.equal(oversizedAttachment.errors[0].code, "attachment_too_large");

const unreadableTextAttachment = validateChatAttachments([
  {
    name: "broken.txt",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;charset=utf-8,%E0%A4%A",
  },
]);
assert.equal(unreadableTextAttachment.ok, false);
assert.equal(unreadableTextAttachment.status, 400);
assert.equal(unreadableTextAttachment.errors[0].code, "text_attachment_unreadable");

const chatLimitDocumentBytes = Buffer.alloc(maxChatAttachmentFileBytes, "a");
const chatLimitDocument = {
  name: "four-megabyte-notes.md",
  mimeType: "application/octet-stream",
  size: chatLimitDocumentBytes.byteLength,
  dataUrl: `data:application/octet-stream;base64,${chatLimitDocumentBytes.toString("base64")}`,
};
assert.equal(
  maxChatAttachmentFileBytes > MAX_EVIDENCE_FILE_BYTES,
  true,
  "Chat files should no longer inherit the smaller task-evidence limit"
);
assert.equal(
  validateChatAttachments([chatLimitDocument]).ok,
  true,
  "Chat preflight should accept a decoded file at the advertised 4 MB limit"
);
const preparedChatLimitDocument = await prepareAmbientChatAttachments([chatLimitDocument]);
assert.equal(preparedChatLimitDocument[0]?.kind, "text");
assert.equal(preparedChatLimitDocument[0]?.extraction?.parser, "utf8_text");
assert.throws(
  () => decodeEvidenceDataUrl(chatLimitDocument.dataUrl),
  (error) => error?.message === "evidence_file_too_large" && error?.status === 413,
  "Task evidence should retain its independent 2.5 MB limit"
);

const aboveChatLimitBytes = Buffer.alloc(maxChatAttachmentFileBytes + 1, "a");
const aboveChatLimit = validateChatAttachments([{
  ...chatLimitDocument,
  name: "over-four-megabytes.md",
  size: aboveChatLimitBytes.byteLength,
  dataUrl: `data:application/octet-stream;base64,${aboveChatLimitBytes.toString("base64")}`,
}]);
assert.equal(aboveChatLimit.ok, false);
assert.equal(aboveChatLimit.status, 413);
assert.equal(aboveChatLimit.errors[0].code, "attachment_too_large");

const openAiTextInput = openAiInput({
  conversationId: "chat-attachment-smoke",
  message: "Can you read this?",
  attachments: [percentEncodedTextAttachment],
});
const openAiTextContent = openAiTextInput[0].content;

assert.equal(
  openAiTextContent.some((part) => part.type === "input_file"),
  false,
  "OpenAI text attachments should not be sent as file parts"
);
assert.equal(
  openAiTextContent.some((part) => part.type === "input_text" && part.text.includes("Line 1: pasted task context")),
  true,
  "OpenAI should receive percent-encoded pasted text as readable input_text"
);

const openAiPdfInput = openAiInput({
  conversationId: "chat-attachment-smoke",
  message: "Can you read this PDF?",
  attachments: [pdfAttachment],
});

assert.equal(
  openAiPdfInput[0].content.some((part) => part.type === "input_file" && part.filename === "source.pdf"),
  true,
  "OpenAI PDF attachments should still be sent as file parts"
);

const restoredHistory = [
  {
    role: "user",
    body: "can u read this",
    attachments: [
      {
        name: "restored-code.jsx",
        kind: "text",
        textContent: "export const restored = true;",
      },
    ],
  },
  {
    role: "assistant",
    body: "Yes.",
  },
];
const openAiHistoryInput = openAiInput({
  conversationId: "chat-attachment-smoke",
  message: "What code did I paste?",
  historyMessages: restoredHistory,
});

assert.equal(
  openAiHistoryInput[0].content[0].text.includes("export const restored = true;"),
  true,
  "Restored text attachments should be included in OpenAI chat history"
);

const openRouterMessagesForText = openRouterMessages({
  conversationId: "chat-attachment-smoke",
  message: "Can you read this?",
  attachments: [base64TextAttachment],
  historyMessages: [],
});
const openRouterUserContent = openRouterMessagesForText.at(-1).content;

assert.equal(Array.isArray(openRouterUserContent), true, "OpenRouter attachment content should be multipart");
assert.equal(
  openRouterUserContent.some((part) => part.type === "text" && part.text.includes("Line 1: pasted task context")),
  true,
  "OpenRouter should receive base64 text uploads as readable text"
);

const openRouterMessagesForHistory = openRouterMessages({
  conversationId: "chat-attachment-smoke",
  message: "What code did I paste?",
  historyMessages: restoredHistory,
});

assert.equal(
  openRouterMessagesForHistory.some((message) => (
    typeof message.content === "string" &&
    message.content.includes("export const restored = true;")
  )),
  true,
  "Restored text attachments should be included in OpenRouter chat history"
);

assert.equal(
  chatInputCharacterEstimate({
    message: "Can you read this?",
    attachments: [percentEncodedTextAttachment],
  }) > longText.length,
  true,
  "Text attachments should be included in chat input estimates"
);

console.log("chat attachment smoke ok");
