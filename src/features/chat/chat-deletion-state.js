function conversationId(chat) {
  return chat?.conversationId || chat?.id || "";
}

export function removeRecentChat(state, accountId, id) {
  if (state?.session?.accountId !== accountId || !state?.chat) return state;
  return {
    ...state,
    chat: { ...state.chat, recents: (state.chat.recents || []).filter((chat) => conversationId(chat) !== id) },
  };
}

export function restoreRecentChat(state, accountId, chat, index) {
  if (state?.session?.accountId !== accountId || !state?.chat) return state;
  const recents = [...(state.chat.recents || [])];
  if (recents.some((item) => conversationId(item) === conversationId(chat))) return state;
  recents.splice(Math.min(Math.max(index, 0), recents.length), 0, chat);
  return { ...state, chat: { ...state.chat, recents } };
}

// A response that started before a delete completed can still contain the row.
// Later responses remain authoritative, including an intentionally re-enabled Hive.
export function createChatDeletionState() {
  let revision = 0;
  const accounts = new Map();
  return {
    capture: () => revision,
    begin(accountId, id) {
      if (!accountId || !id) return false;
      const entries = accounts.get(accountId) || new Map();
      if (entries.get(id)?.pending) return false;
      entries.set(id, { pending: true, revision: ++revision });
      accounts.set(accountId, entries);
      return true;
    },
    complete(accountId, id) {
      accounts.get(accountId)?.set(id, { pending: false, revision: ++revision });
    },
    fail(accountId, id) {
      accounts.get(accountId)?.delete(id);
      revision++;
    },
    reconcile(state, capturedRevision) {
      const entries = accounts.get(state?.session?.accountId);
      if (!entries || !state?.chat) return state;
      const recents = (state.chat.recents || []).filter((chat) => {
        const deletion = entries.get(conversationId(chat));
        return !deletion || (!deletion.pending && capturedRevision >= deletion.revision);
      });
      return { ...state, chat: { ...state.chat, recents } };
    },
  };
}
