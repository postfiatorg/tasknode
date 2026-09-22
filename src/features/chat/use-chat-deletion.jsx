import { useRef, useState } from "react";
import { X } from "lucide-react";
import { requestJson } from "../../api";
import { accountBoundaryCaptureIsCurrent } from "../settings/account-transition-boundary.js";
import { removeRecentChat, restoreRecentChat } from "./chat-deletion-state.js";

// Optimistic chat deletion. The sidebar drops the chat immediately; app-state
// refreshes that started before the delete settles cannot resurrect it, and a
// failed delete restores it in place with an error banner.
export function useChatDeletion({
  accountBoundaryRef,
  activeChat,
  appState,
  chatDeletionsRef,
  session,
  setActiveChat,
  setAppState,
  setChatActionMenu,
  setChatDeleteTarget,
  setChatResetKey,
}) {
  const [chatDeleteError, setChatDeleteError] = useState(null);
  const activeChatRef = useRef(activeChat);
  activeChatRef.current = activeChat;

  async function deleteRecentChat(chat) {
    const conversationId = chat?.conversationId || chat?.id || "";
    const accountCapture = { ...accountBoundaryRef.current };
    const accountId = session?.accountId || "";
    if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture) ||
        !chatDeletionsRef.current.begin(accountId, conversationId)) return;
    const originalRecents = appState?.chat?.recents || [];
    const index = originalRecents.findIndex((item) => (item.conversationId || item.id) === conversationId);
    const originalChat = originalRecents[index] || chat;
    setChatDeleteError(null);
    setChatDeleteTarget(null);
    setChatActionMenu(null);
    setAppState((current) => removeRecentChat(current, accountId, conversationId));
    try {
      const result = await requestJson("/api/chat/conversation", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId }),
        signal: AbortSignal.timeout(15000),
      });
      const alreadyDeleted = result.status === 404 && result.body?.error === "chat_conversation_not_found";
      if (!alreadyDeleted && (!result.ok || !result.body?.ok)) {
        throw new Error(result.body?.message || "The server could not delete this chat.");
      }
      chatDeletionsRef.current.complete(accountId, conversationId);
      if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return;
      const selectedChat = activeChatRef.current;
      if ((selectedChat?.conversationId || selectedChat?.id) === conversationId) {
        setActiveChat(null);
        setChatResetKey((key) => key + 1);
      }
    } catch {
      chatDeletionsRef.current.fail(accountId, conversationId);
      if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return;
      setAppState((current) => restoreRecentChat(current, accountId, originalChat, index));
      setChatDeleteError({ accountId, message: `Could not confirm deletion of “${chat?.title || "this chat"}”. Restored it to the sidebar. Please try again.` });
    }
  }

  const chatDeleteBanner = chatDeleteError && chatDeleteError.accountId === session?.accountId ? (
    <div className="status-banner error" role="alert">
      <span>{chatDeleteError.message}</span>
      <button aria-label="Dismiss chat deletion error" className="chat-edit-close" onClick={() => setChatDeleteError(null)} type="button"><X size={16} /></button>
    </div>
  ) : null;

  return { chatDeleteBanner, deleteRecentChat };
}
