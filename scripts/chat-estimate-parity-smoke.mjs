import { chatEstimate } from "../server/chat-estimate.js";

const baseEstimate = chatEstimate({
  mode: "Frontier Instant",
  message: "Hello.",
});

const smokeHistory = Array.from({ length: 8 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "assistant",
  body: `Historical turn ${index + 1} with enough text to affect billing estimates materially.`,
}));
const historyEstimate = chatEstimate(
  {
    mode: "Frontier Instant",
    message: "Continue the thread.",
  },
  { historyMessages: smokeHistory }
);
if (
  historyEstimate.historyInputTokens <= 0 ||
  historyEstimate.inputTokens <= baseEstimate.inputTokens ||
  historyEstimate.estimatedUsd <= baseEstimate.estimatedUsd
) {
  throw new Error(`Chat estimate should include conversation history tokens: ${JSON.stringify({ baseEstimate, historyEstimate })}`);
}

const bareAttachmentEstimate = chatEstimate({
  mode: "Frontier Instant",
  message: "Describe this image.",
});
const imageAttachmentEstimate = chatEstimate({
  mode: "Frontier Instant",
  message: "Describe this image.",
  attachments: [{
    kind: "image",
    name: "photo.png",
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${"A".repeat(20_000)}`,
  }],
});
if (imageAttachmentEstimate.inputTokens <= bareAttachmentEstimate.inputTokens) {
  throw new Error(`Chat estimate should reserve multimodal attachment budget: ${JSON.stringify({ bareAttachmentEstimate, imageAttachmentEstimate })}`);
}

console.log("chat estimate parity smoke ok");
