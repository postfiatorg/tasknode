import { BlockList, isIP } from "node:net";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeIp(value = "") {
  const raw = safeText(value, 120)
    .replace(/^\[|\]$/g, "")
    .replace(/%.+$/, "");
  if (raw.toLowerCase().startsWith("::ffff:") && isIP(raw.slice(7)) === 4) return raw.slice(7);
  return isIP(raw) ? raw : "";
}

function parsedCidr(value = "") {
  const [rawAddress, rawPrefix] = safeText(value, 160).split("/");
  const address = normalizeIp(rawAddress);
  const family = isIP(address);
  if (!family) return null;
  const defaultPrefix = family === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? defaultPrefix : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > defaultPrefix) return null;
  return { address, family, prefix };
}

export function trustedProxyConfig(env = process.env) {
  const configured = safeText(env.TASKNODE_TRUSTED_PROXY_CIDRS, 4000)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const blockList = new BlockList();
  const cidrs = [];
  const invalid = [];
  for (const value of configured) {
    const parsed = parsedCidr(value);
    if (!parsed) {
      invalid.push(value);
      continue;
    }
    blockList.addSubnet(parsed.address, parsed.prefix, parsed.family === 4 ? "ipv4" : "ipv6");
    cidrs.push(`${parsed.address}/${parsed.prefix}`);
  }
  return { blockList, cidrs, invalid };
}

export function peerIp(req) {
  return normalizeIp(req?.socket?.remoteAddress || "");
}

export function isTrustedProxyIp(ip, env = process.env) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const family = isIP(normalized);
  const { blockList } = trustedProxyConfig(env);
  return blockList.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

function forwardedIpChain(req) {
  const raw = safeText(req?.headers?.["x-forwarded-for"], 4000);
  if (!raw) return [];
  const values = raw.split(",").map((value) => normalizeIp(value));
  return values.every(Boolean) ? values : [];
}

export function clientIp(req, env = process.env) {
  let current = peerIp(req);
  if (!current || !isTrustedProxyIp(current, env)) return current;
  const chain = forwardedIpChain(req);
  if (!chain.length) return current;

  // Walk from the nearest hop toward the client. Stop at the first untrusted
  // address so a caller cannot prepend a forged identity to the chain.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyIp(current, env)) break;
    current = chain[index];
  }
  return current;
}

function trustedForwardedHeader(req, name, env = process.env) {
  if (!isTrustedProxyIp(peerIp(req), env)) return "";
  const values = safeText(req?.headers?.[name], 2000)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.at(-1) || "";
}

export function requestProtocol(req, env = process.env) {
  const forwarded = trustedForwardedHeader(req, "x-forwarded-proto", env).toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return req?.socket?.encrypted ? "https" : "http";
}

export function requestHost(req, env = process.env) {
  const forwarded = trustedForwardedHeader(req, "x-forwarded-host", env);
  const raw = forwarded || safeText(req?.headers?.host, 500);
  if (!raw || /[\s\\/]/.test(raw)) return "";
  try {
    return new URL(`http://${raw}`).host;
  } catch {
    return "";
  }
}

export function requestIsSecure(req, env = process.env) {
  const configuredOrigin = safeText(env.TASKNODE_PUBLIC_URL || env.VITE_SITE_ORIGIN, 500);
  if (configuredOrigin) {
    try {
      if (new URL(configuredOrigin).protocol === "https:") return true;
    } catch {
      // Fall through to the transport/proxy boundary.
    }
  }
  return requestProtocol(req, env) === "https";
}

export function requestOriginFromBoundary(req, env = process.env) {
  const configuredOrigin = safeText(env.TASKNODE_PUBLIC_URL || env.VITE_SITE_ORIGIN, 500);
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      return "";
    }
  }
  const host = requestHost(req, env);
  return host ? `${requestProtocol(req, env)}://${host}` : "";
}
