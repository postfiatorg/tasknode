const supportedAuthModes = new Set([
  "none",
  "optional",
  "session",
  "bearer",
  "admin_bearer",
  "webhook_secret",
  "oauth_state",
  "handler",
]);

function headerValue(headers = {}, name = "") {
  const value = headers[String(name).toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function bearerPresent(headers = {}) {
  return /^Bearer\s+\S+$/i.test(headerValue(headers, "authorization"));
}

export function validateRouteAuthPolicy(policy = {}) {
  const auth = String(policy.auth || "").trim();
  if (!supportedAuthModes.has(auth)) {
    throw new Error(`unsupported_route_auth_mode:${policy.id || "unknown"}:${auth || "missing"}`);
  }
  return auth;
}

export function routeAuthenticationFailure({ policy = {}, session = null, headers = {} } = {}) {
  const auth = validateRouteAuthPolicy(policy);
  if (auth === "session" && !session?.accountId) {
    return {
      status: 401,
      error: policy.unauthenticatedError || `${policy.id}_login_required`,
      message: policy.unauthenticatedMessage || "Sign in before using this route.",
    };
  }

  if ((auth === "bearer" || auth === "admin_bearer") && !bearerPresent(headers)) {
    return {
      status: 401,
      error: policy.unauthenticatedError || `${policy.id}_unauthorized`,
      message: "A bearer credential is required.",
    };
  }

  if (auth === "webhook_secret" && !headerValue(headers, "x-telegram-bot-api-secret-token")) {
    return {
      status: 401,
      error: policy.unauthenticatedError || `${policy.id}_unauthorized`,
      message: "A webhook credential is required.",
    };
  }

  // OAuth state and handler-owned policies require route-specific semantic
  // verification. The central boundary still validates that the declared mode
  // is known; the owning handler must verify the state/token value itself.
  return null;
}

export function supportedRouteAuthModes() {
  return [...supportedAuthModes].sort();
}
