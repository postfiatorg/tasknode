function isLocalOrPrivateHost(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function splitValues(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostFromUrl(value = "") {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function configuredInsecureHosts(env = {}) {
  return new Set([
    ...splitValues(env.TASKNODE_INSECURE_PFTL_TLS_HOSTS).map((host) => host.toLowerCase()),
    ...splitValues(env.PFTL_WSS_URL).map(hostFromUrl),
    ...splitValues(env.VITE_PFTL_WSS_URL).map(hostFromUrl),
    ...splitValues(env.PFTL_CACHE_WSS_URL).map(hostFromUrl),
    ...splitValues(env.PFTL_FAUCET_WSS_URL).map(hostFromUrl),
    ...splitValues(env.PFTL_RPC_URL).map(hostFromUrl),
  ].filter(Boolean));
}

export function pftlWssRejectUnauthorized({ env = process.env, url, configuredValue = env.PFTL_WSS_REJECT_UNAUTHORIZED } = {}) {
  const configured = String(configuredValue || "").trim().toLowerCase();
  if (["true", "1", "yes"].includes(configured)) return true;
  if (!["false", "0", "no"].includes(configured)) return true;

  try {
    const hostname = new URL(url).hostname;
    if (env.TASKNODE_ALLOW_INSECURE_PFTL_TLS === "true" && configuredInsecureHosts(env).has(hostname.toLowerCase())) {
      return false;
    }
    if (isLocalOrPrivateHost(hostname) && env.TASKNODE_ALLOW_INSECURE_LOCAL_PFTL_TLS === "true") return false;
    return true;
  } catch {
    return true;
  }
}
