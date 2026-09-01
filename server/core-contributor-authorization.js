function safeHandle(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function configuredCoreContributorGithubHandles(env = process.env) {
  const configured = String(env.TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES || "")
    .split(",")
    .map(safeHandle)
    .filter(Boolean);
  return [...new Set(configured)];
}

export function githubCoreContributorAccess(username = "", env = process.env) {
  const checkedAt = new Date().toISOString();
  const normalizedUsername = safeHandle(username);
  const sanctionedHandles = configuredCoreContributorGithubHandles(env);
  const sanctioned = Boolean(normalizedUsername && sanctionedHandles.includes(normalizedUsername));
  return {
    checkedAt,
    username: String(username || "").trim(),
    sanctioned,
    matchedHandle: sanctioned ? normalizedUsername : "",
    sanctionedHandles,
    accessCount: sanctioned ? 1 : 0,
    writeAccess: sanctioned,
    scopeRecorded: sanctioned,
    repositories: [],
    proofMethod: "github_handle_allowlist",
    oauthScope: "user:email",
  };
}
