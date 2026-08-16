import { formatUsageUsd } from "../../formatters";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function chatComposerStatus({ actualUsage, message, sending, tone, turns }) {
  if (sending && turns.length === 0) return { tone: "muted", text: "Thinking..." };
  if (actualUsage) {
    return {
      tone: "muted",
      text: `Billed ${formatUsageUsd(actualUsage.costUsd)} · ${actualUsage.totalTokens} tokens`,
    };
  }
  if (message) return { tone: tone === "error" ? "error" : "muted", text: message };
  if (turns.length > 0) {
    return { tone: "muted", text: "Task Node can make mistakes. Check important info." };
  }
  return null;
}

export function buildRecentChats(serverRecents) {
  const rows = [];
  const seen = new Set();

  for (const [index, item] of (serverRecents || []).entries()) {
    const recent =
      typeof item === "string"
        ? { title: item }
        : item && typeof item === "object"
          ? item
          : null;
    if (!recent) continue;

    const conversationId = String(recent.conversationId || recent.id || "").trim();
    const title = String(recent.title || recent.lastMessagePreview || "New chat").trim();
    const unreadCount = Math.max(0, Math.round(Number(recent.unreadCount || 0)));
    const key = conversationId || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: conversationId || `server-${slugify(title) || index}`,
      conversationId: conversationId || "",
      kind: recent.kind || "",
      virtual: Boolean(recent.virtual),
      source: "server",
      title,
      lastMessagePreview: recent.lastMessagePreview || "",
      messageCount: recent.messageCount || 0,
      updatedAt: recent.updatedAt || recent.lastMessageAt || "",
      unreadCount,
      unread: Boolean(recent.unread || unreadCount > 0),
    });
  }

  return rows;
}

export function formatUnreadCount(count = 0) {
  const normalized = Math.max(0, Math.round(Number(count) || 0));
  if (normalized > 99) return "99+";
  return String(normalized);
}

export function hiveUnreadCountFromAppState(state) {
  const direct = Number(state?.chat?.hiveConversation?.unreadCount || 0);
  if (direct > 0) return Math.round(direct);
  const recentHive = (state?.chat?.recents || []).find((item) => item?.kind === "hive");
  return Math.max(0, Math.round(Number(recentHive?.unreadCount || 0)));
}

export function mergeHiveConversationIntoAppState(current, conversation) {
  if (!current?.chat || !conversation) return current;
  const normalizedConversation = {
    ...conversation,
    unreadCount: Math.max(0, Math.round(Number(conversation.unreadCount || 0))),
    unread: Boolean(conversation.unread || Number(conversation.unreadCount || 0) > 0),
  };
  const hiveId = normalizedConversation.conversationId || normalizedConversation.id;
  const existingRecents = Array.isArray(current.chat.recents) ? current.chat.recents : [];
  let found = false;
  const nextRecents = existingRecents
    .map((item) => {
      const itemId = item?.conversationId || item?.id || "";
      const itemIsHive = item?.kind === "hive" || (hiveId && itemId === hiveId);
      if (!itemIsHive) return item;
      found = true;
      return {
        ...item,
        ...normalizedConversation,
      };
    })
    .filter((item) => item?.kind !== "hive" || normalizedConversation.disabled !== true);

  if (!found && normalizedConversation.disabled !== true) {
    nextRecents.unshift(normalizedConversation);
  }

  return {
    ...current,
    chat: {
      ...current.chat,
      hiveConversation: normalizedConversation,
      recents: nextRecents,
    },
  };
}

export function chatActionMenuPosition(anchor) {
  const rect = anchor?.getBoundingClientRect?.();
  if (!rect || typeof window === "undefined") return { left: 248, top: 96 };

  const menuWidth = 228;
  const menuHeight = 134;
  const viewportPadding = 8;
  const sidebarRight =
    document.querySelector(".sidebar")?.getBoundingClientRect?.().right || rect.right;
  const left = Math.min(
    Math.max(viewportPadding, rect.right + 4, sidebarRight + 4),
    window.innerWidth - menuWidth - viewportPadding
  );
  const top = Math.min(
    Math.max(viewportPadding, rect.top - 8),
    window.innerHeight - menuHeight - viewportPadding
  );

  return { left, top };
}
