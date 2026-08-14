import { getChatMessages as getRuntimeChatMessages } from "./runtime-store.js";
import { taskNodeInstructions } from "./chat-memory-context.js";
import {
  normalizeChatAttachments,
  textAttachmentPrompt,
} from "./chat-attachment-utils.js";

function attachmentTranscriptText(message) {
  const textAttachments = Array.isArray(message?.attachments)
    ? message.attachments.filter((attachment) => (
        attachment?.kind === "text" &&
        typeof attachment.textContent === "string" &&
        attachment.textContent.trim()
      ))
    : [];
  if (textAttachments.length === 0) return "";

  return textAttachments
    .map((attachment) => [
      `Attached text: ${attachment.name || "attachment"}`,
      attachment.textContent.slice(0, 20_000),
    ].join("\n"))
    .join("\n\n");
}

function messageTranscriptText(message) {
  return [message?.body || "", attachmentTranscriptText(message)].filter(Boolean).join("\n\n");
}

export function chatHistoryCharacterEstimate(historyMessages = []) {
  const messages = Array.isArray(historyMessages) ? historyMessages.slice(-12) : [];
  if (messages.length === 0) return 0;

  return messages.reduce((total, message) => total + messageTranscriptText(message).length + 24, 0);
}

function recentTranscriptFromMessages(messages, currentMessage) {
  const history = messages
    .slice(-12)
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${messageTranscriptText(message)}`)
    .join("\n");

  if (!history) return currentMessage;
  return `Recent conversation:\n${history}\n\nUser: ${currentMessage}`;
}

function runtimeHistoryForRequestBuilder(conversationId) {
  if (String(conversationId || "").startsWith("account_")) return [];
  try {
    return getRuntimeChatMessages(conversationId);
  } catch (error) {
    if (error?.message === "chat_conversation_not_found") return [];
    throw error;
  }
}

function openRouterAttachmentPart(attachment) {
  if (attachment.kind === "image") {
    return {
      type: "image_url",
      image_url: {
        url: attachment.dataUrl,
      },
    };
  }

  if (attachment.kind === "text") {
    return {
      type: "text",
      text: textAttachmentPrompt(attachment),
    };
  }

  return {
    type: "file",
    file: {
      filename: attachment.name,
      file_data: attachment.dataUrl,
    },
  };
}

export function openRouterMessages({
  conversationId,
  message,
  attachments = [],
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  persona = "jobs",
}) {
  const normalizedAttachments = normalizeChatAttachments(attachments);
  const sourceHistory = Array.isArray(historyMessages)
    ? historyMessages
    : runtimeHistoryForRequestBuilder(conversationId);
  const history = sourceHistory
    .slice(-12)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: messageTranscriptText(item),
    }));
  const userContent =
    normalizedAttachments.length === 0
      ? message
      : [
          { type: "text", text: message },
          ...normalizedAttachments.map((attachment) => openRouterAttachmentPart(attachment)),
        ];

  return [
    {
      role: "system",
      content:
        instructionsOverride ||
        taskNodeInstructions({ contextDocument, memoryContext, taskContext, jobsEssence, deliveryContext, persona }),
    },
    ...history,
    { role: "user", content: userContent },
  ];
}

function deepSeekAttachmentText(attachments = []) {
  return normalizeChatAttachments(attachments)
    .map((attachment) => {
      if (attachment.kind === "text") return textAttachmentPrompt(attachment);
      return `Attached file not sent to DeepSeek API Direct: ${attachment.name} (${attachment.mimeType || attachment.kind}). Use a multimodal route for image, PDF, or binary file inspection.`;
    })
    .join("\n\n");
}

export function deepSeekMessages({
  conversationId,
  message,
  attachments = [],
  historyMessages = null,
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  instructionsOverride = "",
  persona = "jobs",
}) {
  const sourceHistory = Array.isArray(historyMessages)
    ? historyMessages
    : runtimeHistoryForRequestBuilder(conversationId);
  const history = sourceHistory
    .slice(-12)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: messageTranscriptText(item),
    }))
    .filter((item) => item.content);
  const attachmentText = deepSeekAttachmentText(attachments);
  const userContent = [message, attachmentText].filter(Boolean).join("\n\n");

  return [
    {
      role: "system",
      content:
        instructionsOverride ||
        taskNodeInstructions({ contextDocument, memoryContext, taskContext, jobsEssence, deliveryContext, persona }),
    },
    ...history,
    { role: "user", content: userContent },
  ];
}

export function openAiInput({ conversationId, message, attachments = [], historyMessages = null }) {
  const sourceHistory = Array.isArray(historyMessages)
    ? historyMessages
    : runtimeHistoryForRequestBuilder(conversationId);
  const content = [
    {
      type: "input_text",
      text: recentTranscriptFromMessages(sourceHistory, message),
    },
  ];

  for (const attachment of normalizeChatAttachments(attachments)) {
    if (attachment.kind === "image") {
      content.push({
        type: "input_image",
        image_url: attachment.dataUrl,
        detail: "auto",
      });
      continue;
    }

    if (attachment.kind === "text") {
      content.push({
        type: "input_text",
        text: textAttachmentPrompt(attachment),
      });
      continue;
    }

    content.push({
      type: "input_file",
      filename: attachment.name,
      file_data: attachment.dataUrl,
    });
  }

  return [{ role: "user", content }];
}
