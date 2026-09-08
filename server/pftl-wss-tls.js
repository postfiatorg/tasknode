import { splitWhitespace } from "../shared/text-protocol.js";
function isLocalOrPrivateHost(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("127.")) return true;
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "172" && Number(parts[1]) >= 16 && Number(parts[1]) <= 31;
}

function splitValues(value = "") {
  return splitWhitespace(String(value || "").replaceAll(","," "))
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
