#!/usr/bin/env node
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { entries: [], noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const {
    normalizeChatMessage,
    normalizeChatMessages,
    transcriptTextFromThread,
  } = await server.ssrLoadModule("/src/features/chat/chat-turns.js");
  const {
    AgentMessage,
    AssistantMessage,
  } = await server.ssrLoadModule("/src/features/chat/ChatMessages.jsx");

  const persistedAgentRow = {
    id: "msg_agent_grashnuk",
    role: "user",
    body: "I reviewed the packet and need a follow-up artifact.",
    metadata: {
      senderType: "machine_agent",
      agentOrigin: {
        agent: true,
        actorType: "machine_agent",
        agentHandle: "grashnuk",
        walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
        client: "orcctl",
      },
    },
  };
  const normalized = normalizeChatMessage(persistedAgentRow, 0);
  assert.equal(normalized.role, "agent");
  assert.equal(normalized.text, persistedAgentRow.body);
  assert.equal(normalized.agentHandle, "grashnuk");
  assert.equal(normalized.agentLabel, "@grashnuk");
  assert.equal(normalized.agentClient, "orcctl");

  const plainUser = normalizeChatMessage({ id: "msg_user", role: "user", body: "Human message." }, 1);
  assert.equal(plainUser.role, "user");

  const thread = normalizeChatMessages([
    persistedAgentRow,
    { id: "msg_assistant", role: "assistant", body: "Acknowledged." },
  ]);
  const transcript = transcriptTextFromThread(thread, "Hive");
  assert.match(transcript, /@grashnuk: I reviewed the packet/);
  assert.match(transcript, /Task Node: Acknowledged/);

  const agentMarkup = renderToStaticMarkup(React.createElement(AgentMessage, {
    agentClient: "orcctl",
    agentLabel: "@grashnuk",
    text: "Visible Orc message.",
  }));
  assert.match(agentMarkup, /@grashnuk/);
  assert.match(agentMarkup, /Visible Orc message/);

  const orcSignalMarkup = renderToStaticMarkup(React.createElement(AssistantMessage, {
    message: {
      id: "msg_orc_signal",
      role: "assistant",
      metadata: {
        kind: "orc_hive_signal",
        reviewerHandle: "grashnuk",
        taskId: "task_123",
      },
      blocks: [{ type: "p", inline: [{ text: "Orc signal body." }] }],
    },
  }));
  assert.match(orcSignalMarkup, /@grashnuk/);
  assert.match(orcSignalMarkup, /Orc signal body/);

  console.log("hive agent message rendering smoke ok");
} finally {
  await server.close();
}
