export function explicitConversationId(value = "") {
  return String(value || "").trim().slice(0, 180);
}

export async function conversationIdForChatWrite({
  conversationIdForSession,
  existsForAccount,
  requestedId = "",
  session = null,
} = {}) {
  const requested = explicitConversationId(requestedId);
  if (!requested) return conversationIdForSession(session);
  if (session?.accountId && typeof existsForAccount === "function") {
    const exists = await existsForAccount({
      accountId: session.accountId,
      conversationId: requested,
    });
    if (exists) return requested;
  }
  return conversationIdForSession(session, requested);
}
