export const webSearchUsdPerCall = 0.01;
export const maxOpenAiWebSearchToolCalls = 4;

export function openAiTools() {
  return [
    {
      type: "web_search",
      search_context_size: process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE || "low",
    },
  ];
}
