export function publicOrigin(requestMeta = {}, env = process.env) {
  const explicit = env.TASKNODE_PUBLIC_URL || env.VITE_SITE_ORIGIN || "";
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      // Fall through to request metadata when configured origin is invalid.
    }
  }
  if (requestMeta.origin) {
    try {
      return new URL(requestMeta.origin).origin;
    } catch {
      // Public origin is optional; callers handle an empty value.
    }
  }
  return "";
}

function isLocalHostname(hostname = "") {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith(".localhost");
}

function isLocalOrigin(value = "") {
  try {
    return isLocalHostname(new URL(String(value || "")).hostname);
  } catch {
    return false;
  }
}

function isPublicOrigin(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function hostnameFromOrigin(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const withProtocol = raw.includes("://") ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function redirectUriForOrigin(providerId, origin = "") {
  return origin ? new URL(`/api/auth/callback/${providerId}`, origin).toString() : "";
}

export function providerRedirectUri(providerId, requestMeta = {}, envKey = "", env = process.env) {
  const configured = envKey ? String(env[envKey] || "").trim() : "";
  const origin = publicOrigin(requestMeta, env);
  if (!configured) return redirectUriForOrigin(providerId, origin);
  return origin && isPublicOrigin(origin) && isLocalOrigin(configured)
    ? redirectUriForOrigin(providerId, origin)
    : configured;
}

export function oauthBasicCredentialPart(value = "") {
  return encodeURIComponent(String(value || ""));
}
