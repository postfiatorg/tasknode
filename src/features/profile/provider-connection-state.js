function providerKey(value = "") {
  return String(value || "").trim().toLowerCase();
}

function candidateProvider(candidate = {}) {
  return providerKey(candidate.provider || candidate.id);
}

function candidateVerified(candidate = {}) {
  if (typeof candidate.verified === "boolean") return candidate.verified;
  return candidate.status === "verified"
    || candidate.status === "linked"
    || candidate.emailVerified === true
    || candidate.kind === "oauth";
}

export function mergedProviderConnections({ aliases = [], linkedProviders = [] } = {}) {
  const merged = new Map();
  for (const candidate of [...linkedProviders, ...aliases]) {
    const provider = candidateProvider(candidate);
    if (!provider) continue;
    const prior = merged.get(provider) || {};
    merged.set(provider, {
      ...prior,
      ...candidate,
      id: provider,
      provider,
      label: candidate.label || prior.label || provider,
      verified: candidateVerified(candidate) || candidateVerified(prior),
    });
  }
  return [...merged.values()];
}

export function providerConnectionState({ aliases = [], linkedProviders = [], provider = "" } = {}) {
  const normalizedProvider = providerKey(provider);
  const accepted = normalizedProvider === "x" ? new Set(["x", "twitter"]) : new Set([normalizedProvider]);
  const connection = mergedProviderConnections({ aliases, linkedProviders })
    .find((candidate) => accepted.has(candidateProvider(candidate))) || null;
  return {
    connection,
    linked: Boolean(connection),
    verified: Boolean(connection?.verified),
  };
}
