const maxClientHistoryTurns = 10;
const maxClientHistoryCharsPerTurn = 4000;

function cleanHistoryText(value = "") {
  return String(value || "")
    .split("\u0000")
    .join("")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, maxClientHistoryCharsPerTurn);
}

export function normalizeClientChatHistory(history = []) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-maxClientHistoryTurns * 2)
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "";
      const body = cleanHistoryText(message?.body || message?.text || message?.content || "");
      if (!role || !body) return null;
      return { role, body };
    })
    .filter(Boolean)
    .slice(-maxClientHistoryTurns);
}
