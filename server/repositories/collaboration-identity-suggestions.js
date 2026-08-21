function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function buildCollaborationIdentitySuggestions({
  identities = [],
  input = "",
  limit = 8,
  recentAccountIds = [],
  viewerAccountId = "",
} = {}) {
  const needle = safeText(input, 180).replace(/^@+/, "").toLowerCase();
  const recentRank = new Map(
    safeArray(recentAccountIds).map((accountId, index) => [safeText(accountId, 180), index])
  );
  const candidates = safeArray(identities)
    .filter((identity) => identity?.accountId && identity.accountId !== viewerAccountId)
    .map((identity) => {
      const hiveHandle = safeText(identity.hiveHandle, 80).replace(/^@+/, "");
      const displayName = safeText(identity.displayName || identity.publicDisplayName, 120);
      const walletAddress = safeText(identity.walletAddress, 120);
      const aliases = safeArray(identity.publicAliases)
        .map((alias) => safeText(alias?.handle || alias, 120).replace(/^@+/, ""))
        .filter(Boolean);
      const searchable = [hiveHandle, displayName, walletAddress, ...aliases]
        .map((value) => value.toLowerCase());
      const matches = !needle || searchable.some((value) => value.includes(needle));
      const prefixMatch = needle && searchable.some((value) => value.startsWith(needle));
      return {
        accountId: safeText(identity.accountId, 180),
        displayName: displayName || (hiveHandle ? `@${hiveHandle}` : walletAddress || "Task Node member"),
        hiveHandle,
        walletAddress,
        recentlyShared: recentRank.has(identity.accountId),
        recentRank: recentRank.get(identity.accountId) ?? Number.MAX_SAFE_INTEGER,
        prefixMatch: Boolean(prefixMatch),
        matches,
      };
    })
    .filter((identity) => identity.matches)
    .sort((a, b) => (
      Number(b.prefixMatch) - Number(a.prefixMatch) ||
      a.recentRank - b.recentRank ||
      a.displayName.localeCompare(b.displayName)
    ));

  return candidates.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map((identity) => ({
    accountId: identity.accountId,
    displayName: identity.displayName,
    hiveHandle: identity.hiveHandle,
    walletAddress: identity.walletAddress,
    recentlyShared: identity.recentlyShared,
  }));
}
