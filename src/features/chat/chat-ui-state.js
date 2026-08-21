export function chatSurfaceDisplayState({ activeChat = null, turns = [], historyLoading = false } = {}) {
  if (historyLoading && activeChat) return "loading";
  return Array.isArray(turns) && turns.length > 0 ? "thread" : "empty";
}

export function loginProviderDisplayState({ authLoading = false, providers = [] } = {}) {
  if (authLoading) return "loading";
  return Array.isArray(providers) && providers.length > 0 ? "providers" : "fallback";
}
