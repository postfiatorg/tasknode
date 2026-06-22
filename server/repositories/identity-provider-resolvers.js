import { createHash } from "node:crypto";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function authHeaders(token = "") {
  const safeToken = safeText(token, 4000);
  return safeToken ? { authorization: `Bearer ${safeToken}` } : {};
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("identity_provider_invalid_json");
    error.status = response.status || 502;
    throw error;
  }
}

async function fetchJson({ url = "", headers = {}, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "tasknodeofficial-identity-provider-resolver",
      ...headers,
    },
  });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(body?.message || body?.error_description || body?.error || `identity_provider_http_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function providerResponseDigest(value = {}) {
  return `sha256:${digest(value)}`;
}

function xBearerToken(explicit = "") {
  return safeText(
    explicit ||
      process.env.X_BEARER_TOKEN ||
      process.env.TWITTER_BEARER_TOKEN ||
      process.env.X_API_BEARER_TOKEN ||
      "",
    4000
  );
}

function xApiBaseUrl() {
  return safeText(process.env.X_API_BASE_URL || process.env.TWITTER_API_BASE_URL || "https://api.x.com/2", 500).replace(/\/+$/, "");
}

export async function resolveXUserMetrics({
  username = "",
  userId = "",
  bearerToken = "",
  fetchImpl = fetch,
} = {}) {
  const token = xBearerToken(bearerToken);
  if (!token) {
    const error = new Error("x_bearer_token_required");
    error.status = 409;
    throw error;
  }
  const normalizedUsername = safeText(username, 120).replace(/^@+/, "");
  const normalizedUserId = safeText(userId, 120);
  if (!normalizedUsername && !normalizedUserId) {
    const error = new Error("x_user_identifier_required");
    error.status = 400;
    throw error;
  }
  const url = new URL(normalizedUserId
    ? `${xApiBaseUrl()}/users/${encodeURIComponent(normalizedUserId)}`
    : `${xApiBaseUrl()}/users/by/username/${encodeURIComponent(normalizedUsername)}`);
  url.searchParams.set("user.fields", "public_metrics,verified,verified_type,profile_image_url");
  const body = await fetchJson({
    url: url.toString(),
    headers: authHeaders(token),
    fetchImpl,
  });
  const data = safeObject(body.data);
  const metrics = safeObject(data.public_metrics);
  const followersCount = numeric(metrics.followers_count ?? metrics.followersCount, 0);
  return {
    schema: "pf.task_node.identity_provider.x_user_metrics.v1",
    provider: "x",
    providerUserId: safeText(data.id || normalizedUserId, 120),
    username: safeText(data.username || normalizedUsername, 120),
    name: safeText(data.name, 160),
    profileUrl: data.username ? `https://x.com/${safeText(data.username, 120)}` : "",
    checkedAt: new Date().toISOString(),
    metrics: {
      followersCount,
      followingCount: numeric(metrics.following_count ?? metrics.followingCount, 0),
      listedCount: numeric(metrics.listed_count ?? metrics.listedCount, 0),
      tweetCount: numeric(metrics.tweet_count ?? metrics.tweetCount, 0),
      verified: data.verified === true,
      verifiedType: safeText(data.verified_type, 80),
    },
    qualifications: {
      kolXMinimum: followersCount >= 1000,
      kolXFull: followersCount >= 5000,
    },
    responseDigest: providerResponseDigest(body),
  };
}

function githubToken(explicit = "") {
  return safeText(explicit || process.env.GITHUB_TOKEN || process.env.TASKNODE_GITHUB_TOKEN || "", 4000);
}

function githubApiBaseUrl() {
  return safeText(process.env.GITHUB_API_BASE_URL || "https://api.github.com", 500).replace(/\/+$/, "");
}

function githubHeaders(token = "") {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...authHeaders(token),
  };
}

function requireGithubField(value = "", field = "field") {
  const text = safeText(value, 180);
  if (text) return text;
  const error = new Error(`github_${field}_required`);
  error.status = 400;
  throw error;
}

export async function resolveGithubCollaboratorPermission({
  owner = "",
  repo = "",
  username = "",
  token = "",
  fetchImpl = fetch,
} = {}) {
  const resolvedToken = githubToken(token);
  if (!resolvedToken) {
    const error = new Error("github_token_required");
    error.status = 409;
    throw error;
  }
  const normalizedOwner = requireGithubField(owner, "owner");
  const normalizedRepo = requireGithubField(repo, "repo");
  const normalizedUsername = requireGithubField(username, "username");
  const url = `${githubApiBaseUrl()}/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepo)}/collaborators/${encodeURIComponent(normalizedUsername)}/permission`;
  const body = await fetchJson({
    url,
    headers: githubHeaders(resolvedToken),
    fetchImpl,
  });
  const permission = safeText(body.permission, 80).toLowerCase();
  const writePermissions = new Set(["admin", "maintain", "write"]);
  return {
    schema: "pf.task_node.identity_provider.github_collaborator_permission.v1",
    provider: "github",
    owner: normalizedOwner,
    repo: normalizedRepo,
    username: normalizedUsername,
    checkedAt: new Date().toISOString(),
    permission,
    hasAccess: Boolean(permission),
    writeAccess: writePermissions.has(permission),
    proofMethod: "github_collaborator_permission_api",
    responseDigest: providerResponseDigest(body),
  };
}
