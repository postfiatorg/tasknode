function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function inferenceProviderUsage(body = {}) {
  const usage = body.usage || {};
  const gateway = body.choices?.[0]?.message?.provider_metadata?.gateway || {};
  const cost = finiteNumber(gateway.cost ?? usage.cost ?? usage.total_cost);
  const calls = gateway.gatewayToolCalls;
  const searchNames = new Set(["exa_search", "parallel_search", "perplexity_search", "tako_search"]);
  let searchCalls = null;
  if (typeof calls === "number") searchCalls = finiteNumber(calls);
  else if (calls && typeof calls === "object" && !Array.isArray(calls)) {
    searchCalls = Object.entries(calls).reduce((sum, [name, count]) => sum + (searchNames.has(name) ? finiteNumber(count) || 0 : 0), 0);
  }
  searchCalls ??= finiteNumber(usage.server_tool_use?.web_search_requests);
  return {
    providerCostUsd: cost === null ? null : Number(cost.toFixed(6)),
    webSearchCalls: searchCalls === null ? 0 : Math.floor(searchCalls),
    searchUsageReported: searchCalls !== null,
  };
}
