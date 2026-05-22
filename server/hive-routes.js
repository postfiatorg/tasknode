import { appendChatTurn } from "./repositories/chat-billing.js";
import { getHiveContextDocument, saveHiveContextEntry } from "./repositories/hive-context.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeAttachments(items = []) {
  return Array.isArray(items)
    ? items.slice(0, 4).map((item) => ({
        name: safeText(item?.name || "attachment", 160),
        mimeType: safeText(item?.mimeType || "", 120),
        size: Math.max(0, Number(item?.size || 0)),
        source: safeText(item?.source || "", 80),
        dataUrl: typeof item?.dataUrl === "string" ? item.dataUrl : undefined,
      }))
    : [];
}

export async function handleHiveRoute({ json, readJson, req, res, session, url }) {
  if (url.pathname !== "/api/hive/context") return false;

  if (!session?.accountId) {
    json(res, 401, {
      ok: false,
      error: "hive_context_login_required",
      message: "Sign in before writing or reading Hive Context.",
    });
    return true;
  }

  if (req.method === "GET") {
    json(res, 200, {
      ok: true,
      context: await getHiveContextDocument({ limit: url.searchParams.get("limit") || 120 }),
    });
    return true;
  }

  if (req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "hive_context_method_not_allowed",
      message: "Hive Context supports GET and POST.",
    });
    return true;
  }

  const payload = await readJson(req, 8 * 1024 * 1024);
  const body = safeText(payload?.body || payload?.message || "", 24_000);
  const sourceConversationId = safeText(payload?.conversationId || "", 180);
  const sourceConversationTitle = safeText(payload?.conversationTitle || "", 160);
  const attachments = safeAttachments(payload?.attachments || []);
  const hiveContextAttachments = attachments.map(({ name, mimeType, size, source }) => ({
    name,
    mimeType,
    size,
    source,
  }));
  const entry = await saveHiveContextEntry({
    accountId: session.accountId,
    displayName: session.displayName || session.primaryProvider || session.accountId,
    body,
    sourceConversationId,
    sourceConversationTitle,
    attachments: hiveContextAttachments,
    metadata: {
      kind: "hive_input",
      source: "user_chat",
    },
  });
  const assistantMessage = "Hive input saved to Hive Context.";
  let chatTurn = null;
  let chatHistoryWarning = "";
  if (sourceConversationId) {
    try {
      chatTurn = await appendChatTurn({
        accountId: session.accountId,
        conversationId: sourceConversationId,
        mode: "Hive Input",
        provider: "tasknode",
        model: "hive_context_store",
        userMessage: body,
        assistantMessage,
        userMessageId: safeText(payload?.userMessageId || "", 180),
        assistantMessageId: safeText(payload?.assistantMessageId || "", 180),
        userMetadata: {
          kind: "hive_input",
          hiveContextEntryId: entry.id,
        },
        assistantMetadata: {
          kind: "hive_input_ack",
          hiveContextEntryId: entry.id,
        },
        runMetadata: {
          kind: "hive_input",
          hiveContextEntryId: entry.id,
        },
        attachments,
        usage: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      });
    } catch (error) {
      chatHistoryWarning = error?.message || "chat_history_write_failed";
    }
  }

  json(res, 200, {
    ok: true,
    message: assistantMessage,
    entry,
    chatHistoryWarning,
    user: chatTurn?.user || null,
    assistant: chatTurn?.assistant || {
      id: safeText(payload?.assistantMessageId || "", 180) || `hive-input-ack-${Date.now()}`,
      role: "assistant",
      body: assistantMessage,
      metadata: {
        kind: "hive_input_ack",
        hiveContextEntryId: entry.id,
      },
    },
    context: await getHiveContextDocument({ limit: 120 }),
  });
  return true;
}
