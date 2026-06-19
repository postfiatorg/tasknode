export function safeAgentText(value = "", max = 120) {
  return Array.from(String(value || "").trim())
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, max);
}

function safeMetadataValue(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return safeAgentText(value, 240);
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => (
      typeof item === "number" && Number.isFinite(item)
        ? item
        : typeof item === "boolean"
          ? item
          : safeAgentText(item, 120)
    ));
  }
  if (depth < 1 && typeof value === "object") return safeClientMetadata(value, depth + 1);
  return "";
}

export function safeClientMetadata(value = {}, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = safeAgentText(rawKey, 80);
    if (!key) continue;
    result[key] = safeMetadataValue(rawValue, depth);
  }
  return result;
}

export function normalizeMachineAgentOrigin(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.agent !== true && value.actorType !== "machine_agent") return null;
  return {
    agent: true,
    actorType: "machine_agent",
    source: safeAgentText(value.source || "wallet_login", 80) || "wallet_login",
    sessionProvider: safeAgentText(value.sessionProvider || "wallet", 80) || "wallet",
    accountId: safeAgentText(value.accountId, 180),
    agentHandle: safeAgentText(value.agentHandle || value.agent || value.handle, 80),
    walletAddress: safeAgentText(value.walletAddress || value.address, 120),
    client: safeAgentText(value.client || "TaskNodeAgentClient", 120) || "TaskNodeAgentClient",
  };
}

export function agentOriginForWalletSession(session, payload = {}) {
  if (session?.primaryProvider !== "wallet") return null;
  const metadata = payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};
  const requested = payload?.agentOrigin && typeof payload.agentOrigin === "object" && !Array.isArray(payload.agentOrigin)
    ? payload.agentOrigin
    : metadata.agentOrigin && typeof metadata.agentOrigin === "object" && !Array.isArray(metadata.agentOrigin)
      ? metadata.agentOrigin
      : {};
  return {
    agent: true,
    actorType: "machine_agent",
    source: "wallet_login",
    sessionProvider: "wallet",
    accountId: session.accountId || "",
    agentHandle: safeAgentText(
      payload?.agentHandle || payload?.agent || metadata.agentHandle || requested.agentHandle || requested.handle,
      80
    ),
    walletAddress: safeAgentText(
      payload?.walletAddress || payload?.address || metadata.walletAddress || requested.walletAddress || requested.address,
      120
    ),
    client: safeAgentText(payload?.client || metadata.client || requested.client || "TaskNodeAgentClient", 120),
  };
}

export function metadataWithMachineAgentOrigin(payload = {}, agentOrigin = null) {
  const metadata = safeClientMetadata(payload?.metadata || payload?.metadata_json);
  const normalizedAgentOrigin = normalizeMachineAgentOrigin(agentOrigin);
  if (!normalizedAgentOrigin) {
    delete metadata.agentOrigin;
    if (metadata.senderType === "machine_agent" || metadata.senderType === "agent") {
      delete metadata.senderType;
    }
    return metadata;
  }
  return {
    ...metadata,
    senderType: "machine_agent",
    agentOrigin: normalizedAgentOrigin,
  };
}
