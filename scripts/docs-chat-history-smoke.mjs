import assert from "node:assert/strict";
import { buildDocsAssistantRequest, generateDocsAssistantResponse } from "../server/docs-odv.js";

const activeConversation = [
  { author: "Alex", text: "user-message-one" },
  { author: "ODV", text: "assistant-reply-one" },
  { author: "Alex", text: "user-message-two" },
  { author: "ODV", text: "assistant-reply-two" },
  { author: "Alex", text: "user-message-three" },
  { author: "Alex", text: "user-message-four" },
  { author: "Alex", text: "user-message-five" },
];

function request(prompt, recentMessages = activeConversation) {
  return buildDocsAssistantRequest({
    persona: prompt.startsWith("@coach") ? "coach" : "odv",
    prompt,
    documentTitle: "History boundary fixture",
    documentContent: "The active encrypted document body.",
    recentMessages,
    userContext: { contextDocument: { body: "account-context-opt-in-only" } },
    includeFullContext: false,
  });
}

for (const prompt of [
  "@ODV what were the past five messages I sent?",
  "@ODV remind me what I said earlier in this conversation",
  "@coach continue from the point we reached above",
]) {
  const content = request(prompt).messages[1].content;
  let previousIndex = -1;
  for (const message of activeConversation) {
    const index = content.indexOf(message.text);
    assert.ok(index > previousIndex, `active conversation order lost for ${message.text}`);
    previousIndex = index;
  }
  assert.ok(!content.includes("account-context-opt-in-only"));
}

assert.deepEqual(request("@ODV summarize our exchange"), request("@ODV summarize our exchange"));

const boundedConversation = Array.from({ length: 15 }, (_, index) => ({
  author: "Alex",
  text: `bounded-message-${String(index + 1).padStart(2, "0")}`,
}));
const boundedContent = request("@ODV what came before?", boundedConversation).messages[1].content;
for (const excluded of boundedConversation.slice(0, 3)) assert.ok(!boundedContent.includes(excluded.text));
for (const included of boundedConversation.slice(-12)) assert.ok(boundedContent.includes(included.text));

const otherConversationContent = request("@ODV summarize this chat", [
  { author: "Other member", text: "other-conversation-only" },
]).messages[1].content;
assert.ok(otherConversationContent.includes("other-conversation-only"));
for (const message of activeConversation) assert.ok(!otherConversationContent.includes(message.text));

let contextLoadCount = 0;
let providerRequest;
const generated = await generateDocsAssistantResponse({
  accountId: "account-1",
  documentId: "document-1",
  channelHash: "channel-1",
  persona: "odv",
  prompt: "@ODV what did I say earlier?",
  documentTitle: "History boundary fixture",
  documentContent: "The active encrypted document body.",
  recentMessages: activeConversation,
  includeFullContext: false,
}, {
  authorize: async () => ({ ok: true }),
  loadUserContext: async () => {
    contextLoadCount += 1;
    return { contextDocument: { body: "must-not-be-loaded" } };
  },
  infer: async ({ body }) => {
    providerRequest = body;
    return { text: "history-aware-response", model: "test-model", id: "response-1" };
  },
});
assert.equal(generated.ok, true);
assert.equal(contextLoadCount, 0);
for (const message of activeConversation) {
  assert.ok(providerRequest.messages[1].content.includes(message.text));
}

console.log("docs chat history smoke: ok");
