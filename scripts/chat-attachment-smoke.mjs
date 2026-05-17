import assert from "node:assert/strict";
import {
  chatInputCharacterEstimate,
  openAiInput,
  openRouterMessages,
} from "../server/chat-router.js";

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
