export const webSearchUsdPerCall = 0.01;

export function shouldUseWebSearch(message = "") {
  const text = String(message || "").toLowerCase();
  const currentInfoSignals = [
    "search",
    "look up",
    "web",
    "internet",
    "today",
    "current",
    "currently",
    "latest",
    "recent",
    "right now",
    "news",
    "what is going on",
    "what's going on",
  ];

  return currentInfoSignals.some((signal) => text.includes(signal));
}

export function openAiTools({ message }) {
  if (!shouldUseWebSearch(message)) return [];

  return [
    {
      type: "web_search",
      search_context_size: process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE || "low",
    },
  ];
}
