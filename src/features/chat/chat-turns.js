import { markdownToBlocks, plainTextFromBlocks } from "./chat-markdown";

export function newClientConversationId() {
  const entropy =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `chat_${Date.now().toString(36)}_${entropy}`;
}

export function newClientCorrelationId(prefix) {
  const entropy =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${entropy}`.slice(0, 96);
}

export function normalizeChatMessages(messages) {
  return (messages || [])
    .map((message, index) => normalizeChatMessage(message, index))
    .filter(Boolean);
}

export function normalizeChatMessage(message, index = 0) {
  if (!message) return null;
  const metadata = message.metadata;
  const agent = agentMessageIdentity(metadata);
  const role = message.role === "user" || message.role === "agent" ? "user" : "assistant";
  const text = String(message.text || message.content || message.body || "");

  if (agent && role === "user") {
    return {
      id: message.id || `agent-${index}`,
      role: "agent",
      text,
      metadata,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      agentHandle: agent.handle,
      agentLabel: agent.label,
      agentClient: agent.client,
    };
  }

  if (role === "user") {
    return {
      id: message.id || `user-${index}`,
      role,
      text,
      metadata,
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
    };
  }

  return {
    id: message.id || `assistant-${index}`,
    role,
    metadata,
    thinking: message.thinking || message.metadata?.thinking,
    blocks: Array.isArray(message.blocks) ? message.blocks : markdownToBlocks(text),
  };
}

export function agentMessageIdentity(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return null;
  const origin = metadata.agentOrigin && typeof metadata.agentOrigin === "object" ? metadata.agentOrigin : {};
  const machineSender = metadata.senderType === "machine_agent" || origin.actorType === "machine_agent" || origin.agent === true;
  if (!machineSender) return null;
  const rawHandle = String(origin.agentHandle || origin.handle || metadata.agentHandle || "").trim();
  const handle = rawHandle.replace(/^@+/, "").slice(0, 80);
  const label = handle ? `@${handle}` : "Orc agent";
  return {
    handle,
    label,
    client: String(origin.client || metadata.client || "").trim().slice(0, 120),
  };
}

export function createUserTurn(text, id, attachments = [], metadata = undefined) {
  return {
    id,
    role: "user",
    text,
    metadata,
    attachments: redactAttachmentData(attachments),
  };
}

export function createPendingAssistantTurn(id, startedAt, metadata = undefined) {
  return {
    id,
    role: "assistant",
    metadata,
    pending: true,
    thinking: {
      state: "running",
      startedAt,
    },
    blocks: [],
  };
}

export function createErrorAssistantTurn(id, message, startedAt) {
  return {
    id,
    role: "assistant",
    error: true,
    thinking: {
      state: "stopped",
      duration: formatElapsedSeconds(Date.now() - startedAt),
    },
    blocks: [
      {
        type: "p",
        inline: [{ text: message || "Chat execution is unavailable." }],
      },
    ],
  };
}

export function replaceTurnById(turns, id, replacement) {
  return turns.map((turn) => (turn.id === id ? replacement : turn));
}

export function appendAssistantDelta(turns, id, delta, startedAt) {
  return turns.map((turn) => {
    if (turn.id !== id) return turn;
    const text = `${turn.text || plainTextFromBlocks(turn.blocks)}${delta}`;
    return {
      ...turn,
      pending: true,
      text,
      thinking: turn.thinking || {
        state: "running",
        startedAt,
      },
      blocks: markdownToBlocks(text),
    };
  });
}

export function formatElapsedSeconds(ms) {
  const seconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
  return `${seconds}s`;
}

export function createRecentPlaceholderThread(title) {
  return [
    { role: "user", text: `Open ${title}` },
    {
      role: "assistant",
      blocks: [
        {
          type: "p",
          inline: [
            {
              text: "This chat row could not be hydrated from the app server.",
            },
          ],
        },
      ],
    },
  ];
}

export function chatTitleFromPrompt(prompt) {
  const title = String(prompt || "").trim().replace(/\s+/g, " ").slice(0, 48);
  return title || "New chat";
}

export function titleFromTurns(turns) {
  const firstUser = turns.find((turn) => turn.role === "user" && turn.text);
  return chatTitleFromPrompt(firstUser?.text || "Untitled chat");
}

export function transcriptTextFromThread(thread, title = "Untitled chat") {
  const rows = [title || "Untitled chat"];

  for (const message of thread || []) {
    if (message.role === "user") {
      rows.push(`User: ${message.text || ""}`.trim());
      continue;
    }

    if (message.role === "agent") {
      rows.push(`${message.agentLabel || "Orc agent"}: ${message.text || ""}`.trim());
      continue;
    }

    const text = plainTextFromBlocks(message.blocks || []);
    if (text) rows.push(`Task Node: ${text}`);
  }

  return rows.filter(Boolean).join("\n\n");
}

function redactAttachmentData(attachments = []) {
  return attachments.map(({ id, name, mimeType, size }) => ({
    id,
    name,
    mimeType,
    size,
  }));
}
