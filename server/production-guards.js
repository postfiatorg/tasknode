function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function hostnameOf(value = "") {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isProductionEnvironment(env = process.env) {
  return safeText(env.TASKNODE_ENV || env.NODE_ENV, 40).toLowerCase() === "production";
}

export function productionOriginIssues(env = process.env) {
  const publicOrigin = safeText(env.TASKNODE_PUBLIC_URL || env.VITE_SITE_ORIGIN, 300);
  const publicHost = hostnameOf(publicOrigin);
  if (!publicHost) return [];
  const issues = [];

  const siteOrigin = safeText(env.VITE_SITE_ORIGIN, 300);
  if (siteOrigin && hostnameOf(siteOrigin) !== publicHost) {
    issues.push({
      code: "site_origin_host_mismatch",
      detail: `VITE_SITE_ORIGIN host ${hostnameOf(siteOrigin)} does not match public origin host ${publicHost}`,
    });
  }

  for (const [envKey, code] of [
    ["DISCORD_REDIRECT_URI", "discord_redirect_host_mismatch"],
    ["X_REDIRECT_URI", "x_redirect_host_mismatch"],
  ]) {
    const configured = safeText(env[envKey], 300);
    if (configured && hostnameOf(configured) !== publicHost) {
      issues.push({
        code,
        detail: `${envKey} host ${hostnameOf(configured)} does not match public origin host ${publicHost}`,
      });
    }
  }

  const widgetDomain = safeText(env.TELEGRAM_AUTH_WIDGET_DOMAIN, 200).toLowerCase();
  if (widgetDomain && widgetDomain !== publicHost) {
    issues.push({
      code: "telegram_widget_domain_mismatch",
      detail: `TELEGRAM_AUTH_WIDGET_DOMAIN ${widgetDomain} does not match public origin host ${publicHost}`,
    });
  }

  return issues;
}

export function legacyRedirectHosts(env = process.env) {
  return safeText(env.TASKNODE_LEGACY_REDIRECT_HOSTS, 600)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function legacyHostRedirectTarget({
  host = "",
  method = "GET",
  pathname = "/",
  search = "",
  env = process.env,
} = {}) {
  const normalizedMethod = safeText(method, 12).toUpperCase();
  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") return "";
  const requestHost = safeText(host, 300).toLowerCase().split(":")[0];
  if (!requestHost) return "";
  if (pathname === "/health" || pathname === "/api/health") return "";
  const hosts = legacyRedirectHosts(env);
  if (!hosts.includes(requestHost)) return "";
  const publicOrigin = safeText(env.TASKNODE_PUBLIC_URL || env.VITE_SITE_ORIGIN, 300);
  const publicHost = hostnameOf(publicOrigin);
  if (!publicHost || publicHost === requestHost) return "";
  return `${publicOrigin.replace(/\/+$/, "")}${pathname}${search}`;
}

export function moneySeedFromEnv({ env = process.env, primaryKeys = [], fallbackKeys = [] } = {}) {
  for (const key of primaryKeys) {
    const seed = safeText(env[key], 200);
    if (seed) return { seed, source: key, fallback: false };
  }
  // Production payouts must name their signing wallet explicitly: a fallback
  // seed silently signs from a different wallet (authority/service/faucet),
  // which pollutes that wallet's history and bypasses operator intent.
  if (isProductionEnvironment(env)) {
    return { seed: "", source: "", fallback: false };
  }
  for (const key of fallbackKeys) {
    const seed = safeText(env[key], 200);
    if (seed) return { seed, source: key, fallback: true };
  }
  return { seed: "", source: "", fallback: false };
}

export function moneySeedStartupIssues(env = process.env) {
  if (!isProductionEnvironment(env)) return [];
  const issues = [];
  if (!safeText(env.TASKNODE_REWARD_SEED, 200) && env.TASKNODE_TASK_REVIEW_WORKER_ENABLED === "true") {
    issues.push({
      code: "reward_seed_not_explicit",
      detail: "TASKNODE_REWARD_SEED is unset; production reward payouts will fail until it is set explicitly",
    });
  }
  if (!safeText(env.TASKNODE_DAILY_AIRDROP_SEED, 200) && env.TASKNODE_DAILY_AIRDROP_WORKER_ENABLED === "true") {
    issues.push({
      code: "daily_airdrop_seed_not_explicit",
      detail:
        "TASKNODE_DAILY_AIRDROP_SEED is unset; production airdrop issuance will fail until it is set explicitly",
    });
  }
  return issues;
}
