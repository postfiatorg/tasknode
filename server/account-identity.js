import { createHash } from "node:crypto";
import { projectLeaderAccessForHandle } from "./project-leader-badge.js";

const hiveHandleMinLength = 3;
const hiveHandleMaxLength = 30;
const reservedHiveHandles = new Set([
  "admin",
  "api",
  "billing",
  "chat",
  "docs",
  "help",
  "hive",
  "login",
  "logout",
  "me",
  "profile",
  "settings",
  "support",
  "task",
  "tasks",
  "wallet",
]);

function stableId(value, prefix) {
  const digest = createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function providerLabel(provider) {
  if (provider === "github") return "GitHub";
  if (provider === "x") return "X";
  if (provider === "discord") return "Discord";
  if (provider === "telegram") return "Telegram";
  return "Provider";
}

export function normalizeHiveHandle(value = "") {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, hiveHandleMaxLength);
}

function hiveHandleValidationError(handle) {
  const unsliced = String(handle || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const normalized = normalizeHiveHandle(handle);
  if (!normalized) return "handle_required";
  if (unsliced.length < hiveHandleMinLength) return "handle_too_short";
  if (unsliced.length > hiveHandleMaxLength) return "handle_too_long";
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(normalized)) return "handle_format_invalid";
  if (reservedHiveHandles.has(normalized)) return "handle_reserved";
  return "";
}

function findAccountIdByHiveHandle(accounts = {}, handle = "") {
  const normalized = normalizeHiveHandle(handle);
  if (!normalized) return "";
  return Object.values(accounts || {}).find((account) => (
    normalizeHiveHandle(account?.hiveHandle || "") === normalized
  ))?.id || "";
}

function publicAccountDisplayName(account, handle = "") {
  const publicDisplayName = String(account?.publicDisplayName || "").trim();
  if (publicDisplayName) return publicDisplayName.slice(0, 80);
  if (handle) return `@${handle}`;
  return String(account?.displayName || "").trim().slice(0, 80);
}

function handleSuggestionBase(accounts = {}, account = {}, explicitBase = "") {
  const linked = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const candidates = [
    explicitBase,
    account.hiveHandle,
    account.publicDisplayName,
    account.displayName,
    account.primaryEmailCanonical ? String(account.primaryEmailCanonical).split("@")[0] : "",
    ...linked.map((provider) => provider?.username || ""),
    ...linked.map((provider) => provider?.displayName || ""),
    `node-${stableId(account.id || "anonymous", "hive").slice(-8)}`,
  ];
  return candidates.map(normalizeHiveHandle).find((candidate) => (
    candidate.length >= hiveHandleMinLength &&
    checkHiveHandleAvailability({ accounts, handle: candidate, accountId: account.id }).ok
  )) || "task-node";
}

export function checkHiveHandleAvailability({ accounts = {}, handle = "", accountId = "" } = {}) {
  const normalized = normalizeHiveHandle(handle);
  const validationError = hiveHandleValidationError(handle);
  if (validationError) {
    return {
      ok: false,
      available: false,
      handle: normalized,
      error: validationError,
      message: "Choose a Hive handle with 3 to 30 letters, numbers, underscores, or hyphens.",
    };
  }

  const ownerAccountId = findAccountIdByHiveHandle(accounts, normalized);
  const available = !ownerAccountId || ownerAccountId === String(accountId || "").trim();
  return {
    ok: true,
    available,
    handle: normalized,
    error: available ? "" : "handle_taken",
    message: available ? "Handle is available." : "That Hive handle is already taken.",
  };
}

export function suggestHiveHandles({ accounts = {}, accountId = "", base = "", limit = 4 } = {}) {
  const account = accounts[String(accountId || "").trim()] || {};
  const stem = handleSuggestionBase(accounts, account, base);
  const digest = stableId(`${accountId}:${stem}`, "hive").replace(/^hive_/, "");
  const candidates = [
    stem,
    `${stem}-${digest.slice(0, 4)}`,
    `${stem}-${digest.slice(4, 8)}`,
    `node-${digest.slice(0, 8)}`,
    `hive-${digest.slice(8, 16)}`,
  ];
  const seen = new Set();
  const suggestions = [];
  for (const candidate of candidates) {
    const handle = normalizeHiveHandle(candidate);
    if (seen.has(handle)) continue;
    seen.add(handle);
    const availability = checkHiveHandleAvailability({ accounts, handle, accountId });
    if (availability.available) suggestions.push(handle);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

export function providerAliasDefaults(provider = {}) {
  const visibility = provider.aliasVisibility === "public" ? "public" : "private";
  return {
    ...provider,
    aliasVisibility: visibility,
    discloseHandle: visibility === "public" && provider.discloseHandle === true,
    discloseVerifiedBadge: visibility === "public" && provider.discloseVerifiedBadge === true,
  };
}

function safeProviderMetrics(provider = {}) {
  const metadata = provider?.metadata && typeof provider.metadata === "object" && !Array.isArray(provider.metadata)
    ? provider.metadata
    : {};
  const publicMetrics = metadata.publicMetrics && typeof metadata.publicMetrics === "object" && !Array.isArray(metadata.publicMetrics)
    ? metadata.publicMetrics
    : {};
  if (provider.id === "github") {
    const coreContributorAccess = metadata.coreContributorAccess && typeof metadata.coreContributorAccess === "object" && !Array.isArray(metadata.coreContributorAccess)
      ? metadata.coreContributorAccess
      : {};
    const sanctionedHandles = Array.isArray(coreContributorAccess.sanctionedHandles)
      ? coreContributorAccess.sanctionedHandles.map((handle) => String(handle || "").trim()).filter(Boolean)
      : [];
    return {
      coreContributorAccess: {
        checkedAt: String(coreContributorAccess.checkedAt || "").trim() || null,
        username: String(coreContributorAccess.username || provider.username || "").trim(),
        sanctioned: coreContributorAccess.sanctioned === true,
        matchedHandle: String(coreContributorAccess.matchedHandle || "").trim(),
        sanctionedHandles,
        accessCount: coreContributorAccess.sanctioned === true ? 1 : 0,
        writeAccess: coreContributorAccess.sanctioned === true,
        scopeRecorded: coreContributorAccess.sanctioned === true,
        proofMethod: String(coreContributorAccess.proofMethod || "").trim() || null,
        oauthScope: String(coreContributorAccess.oauthScope || "").trim() || null,
      },
    };
  }

  if (provider.id !== "x") return {};

  const followersCount = Number(publicMetrics.followersCount ?? publicMetrics.followers_count);
  const followingCount = Number(publicMetrics.followingCount ?? publicMetrics.following_count);
  const listedCount = Number(publicMetrics.listedCount ?? publicMetrics.listed_count);
  const tweetCount = Number(publicMetrics.tweetCount ?? publicMetrics.tweet_count);

  return {
    ...(Number.isFinite(followersCount) ? { followersCount } : {}),
    ...(Number.isFinite(followingCount) ? { followingCount } : {}),
    ...(Number.isFinite(listedCount) ? { listedCount } : {}),
    ...(Number.isFinite(tweetCount) ? { tweetCount } : {}),
    metricsCheckedAt: String(metadata.metricsCheckedAt || "").trim() || null,
  };
}

export function accountIdentityProfile(account = null, { accounts = {}, includeSuggestions = true } = {}) {
  if (!account?.id) return null;
  const handle = normalizeHiveHandle(account.hiveHandle || "");
  const linked = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const profileVisibility = account.profileVisibility === "private" ? "private" : "public";
  const aliases = linked
    .map(providerAliasDefaults)
    .filter((provider) => provider?.id && provider.kind !== "email_code" && provider.kind !== "development")
    .map((provider) => ({
      id: provider.id,
      provider: provider.id,
      label: provider.label || providerLabel(provider.id),
      status: provider.status || "linked",
      username: provider.username || "",
      displayName: provider.displayName || "",
      profileUrl: provider.profileUrl || "",
      metrics: safeProviderMetrics(provider),
      linkedAt: provider.linkedAt || null,
      verified: provider.status === "verified" || provider.emailVerified === true || provider.kind === "oauth",
      visibility: provider.aliasVisibility === "public" ? "public" : "private",
      discloseHandle: provider.aliasVisibility === "public" && provider.discloseHandle === true,
      discloseVerifiedBadge: provider.aliasVisibility === "public" && provider.discloseVerifiedBadge === true,
      canDiscloseHandle: Boolean(provider.username),
    }));
  const publicAliases = aliases
    .filter((alias) => alias.visibility === "public" && (alias.discloseHandle || alias.discloseVerifiedBadge))
    .map((alias) => ({
      provider: alias.provider,
      label: alias.label,
      handle: alias.discloseHandle ? alias.username : "",
      profileUrl: alias.discloseHandle ? alias.profileUrl : "",
      verified: alias.discloseVerifiedBadge === true,
      linkedAt: alias.linkedAt || null,
    }));

  return {
    accountId: account.id,
    hiveHandle: handle,
    handleRequired: !handle,
    displayName: publicAccountDisplayName(account, handle),
    publicDisplayName: String(account.publicDisplayName || "").trim().slice(0, 80),
    profileVisibility,
    profileDiscoverable: profileVisibility === "public",
    handlePolicy: {
      minLength: hiveHandleMinLength,
      maxLength: hiveHandleMaxLength,
      allowed: "lowercase letters, numbers, underscores, and hyphens",
    },
    aliases,
    publicAliases,
    publicTrustBadges: publicAliases
      .filter((alias) => alias.verified)
      .map((alias) => ({ provider: alias.provider, label: `${alias.label} verified` })),
    projectLeaderAccess: projectLeaderAccessForHandle(handle),
    suggestions: includeSuggestions && !handle ? suggestHiveHandles({ accounts, accountId: account.id }) : [],
  };
}

export function applyAccountProfileVisibility({
  accounts = {},
  accountId = "",
  visibility = "public",
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const account = accounts[normalizedAccountId];
  if (!account) {
    return { ok: false, status: 404, error: "account_not_found", message: "The signed-in account was not found." };
  }
  const normalizedVisibility = visibility === "private" ? "private" : "public";
  const now = new Date().toISOString();
  account.profileVisibility = normalizedVisibility;
  account.updatedAt = now;
  account.identityUpdatedAt = now;
  accounts[normalizedAccountId] = account;
  return { ok: true, identityProfile: accountIdentityProfile(account, { accounts }), account };
}

export function applyAccountHiveHandle({
  accounts = {},
  accountId = "",
  handle = "",
  displayName,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const account = accounts[normalizedAccountId];
  if (!account) {
    return { ok: false, status: 404, error: "account_not_found", message: "The signed-in account was not found." };
  }

  const availability = checkHiveHandleAvailability({ accounts, handle, accountId: normalizedAccountId });
  if (!availability.ok) {
    return {
      ok: false,
      status: 400,
      error: availability.error || "handle_invalid",
      message: availability.message,
      identityProfile: accountIdentityProfile(account, { accounts }),
    };
  }
  if (!availability.available) {
    return {
      ok: false,
      status: 409,
      error: "handle_taken",
      message: availability.message,
      suggestions: suggestHiveHandles({ accounts, accountId: normalizedAccountId, base: handle }),
      identityProfile: accountIdentityProfile(account, { accounts }),
    };
  }

  const now = new Date().toISOString();
  account.hiveHandle = availability.handle;
  if (displayName !== undefined) {
    account.publicDisplayName = String(displayName || "").trim().replace(/\s+/g, " ").slice(0, 80);
  } else if (!account.publicDisplayName) {
    account.publicDisplayName = `@${availability.handle}`;
  }
  account.updatedAt = now;
  account.identityUpdatedAt = now;
  accounts[normalizedAccountId] = account;
  return { ok: true, identityProfile: accountIdentityProfile(account, { accounts }), account };
}

export function applyAccountAliasVisibility({
  accounts = {},
  accountId = "",
  provider = "",
  visibility = "private",
  discloseHandle = false,
  discloseVerifiedBadge = false,
} = {}) {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const account = accounts[normalizedAccountId];
  if (!account) {
    return { ok: false, status: 404, error: "account_not_found", message: "The signed-in account was not found." };
  }
  if (!normalizedProvider) {
    return { ok: false, status: 400, error: "provider_required", message: "Choose a linked provider to update." };
  }

  const linked = Array.isArray(account.linkedProviders) ? account.linkedProviders : [];
  const target = linked.find((item) => item?.id === normalizedProvider);
  if (!target || target.kind !== "oauth") {
    return { ok: false, status: 404, error: "provider_not_linked", message: "That provider is not linked to this account." };
  }

  const publicVisibility = visibility === "public";
  target.aliasVisibility = publicVisibility ? "public" : "private";
  target.discloseHandle = publicVisibility && discloseHandle === true && Boolean(target.username);
  target.discloseVerifiedBadge = publicVisibility && discloseVerifiedBadge === true;
  target.updatedAt = new Date().toISOString();
  account.updatedAt = target.updatedAt;
  account.identityUpdatedAt = target.updatedAt;
  accounts[normalizedAccountId] = account;
  return { ok: true, identityProfile: accountIdentityProfile(account, { accounts }), account };
}
