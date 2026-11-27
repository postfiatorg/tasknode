import {
  CHAIN_L1V2,
  CHAIN_LEGACY,
  MIGRATION_STATUS,
  dualChainNftCounts,
  filterDualChainNfts,
  formatIssuerCollection,
  isMigratedSerial,
  mergeDualChainNftList,
  nftChainKind,
  nftMigrationBadge,
  nftMigrationStatus,
} from "../../src/features/profile/dual-chain-nfts.js";

const DEFAULT_NFT_RPC_PAGE_LIMIT = 100;
const MAX_NFT_RPC_PAGE_LIMIT = 500;
const HEX_96_RE = /^[0-9a-f]{96}$/;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export async function fetchL1AccountNftsPaginated({
  rpc,
  account = "",
  includeBurned = false,
  limit = DEFAULT_NFT_RPC_PAGE_LIMIT,
  maxPages = 10,
} = {}) {
  const normalizedAccount = String(account || "").trim();
  if (!/^pf[0-9a-f]{40}$/.test(normalizedAccount)) {
    throw new Error("l1_nft_invalid_account");
  }
  if (typeof rpc !== "function") {
    throw new Error("l1_nft_rpc_required");
  }
  const pageLimit = clampInteger(limit, DEFAULT_NFT_RPC_PAGE_LIMIT, 1, MAX_NFT_RPC_PAGE_LIMIT);
  const pageCap = clampInteger(maxPages, 10, 1, 100);
  const nfts = [];
  let cursor = null;
  let totalCount = null;
  let truncated = false;
  let pagesRead = 0;

  for (let page = 0; page < pageCap; page += 1) {
    const params = {
      account: normalizedAccount,
      include_burned: Boolean(includeBurned),
      limit: pageLimit,
      ...(cursor ? { cursor } : {}),
    };
    const result = await rpc("account_nfts", params);
    pagesRead += 1;
    const rows = Array.isArray(result?.nfts) ? result.nfts : [];
    nfts.push(...rows);
    if (result?.total_count !== undefined && result?.total_count !== null) {
      totalCount = Number(result.total_count);
    }
    const nextCursor = result?.next_cursor ? String(result.next_cursor).trim() : null;
    if (!nextCursor || !HEX_96_RE.test(nextCursor) || nextCursor === cursor) {
      truncated = false;
      break;
    }
    cursor = nextCursor;
    truncated = page + 1 >= pageCap;
  }

  return {
    ok: true,
    chain: CHAIN_L1V2,
    account: normalizedAccount,
    includeBurned: Boolean(includeBurned),
    pagesRead,
    truncated,
    totalCount: totalCount ?? nfts.length,
    nfts,
  };
}

export function buildDualChainProfileNftsView({
  legacyNfts = [],
  l1Nfts = [],
  migrationRecords = [],
  provenanceRecords = [],
  filter = "all",
} = {}) {
  const merged = mergeDualChainNftList({
    legacyNfts,
    l1Nfts,
    migrationRecords,
    provenanceRecords,
  });
  const counts = dualChainNftCounts(merged);
  const filtered = filterDualChainNfts(merged, filter);
  return {
    nfts: filtered,
    allNfts: merged,
    counts,
    filter: String(filter || "all"),
    hasDualChain: counts.hasDualChain,
  };
}

export {
  CHAIN_L1V2,
  CHAIN_LEGACY,
  MIGRATION_STATUS,
  dualChainNftCounts,
  filterDualChainNfts,
  formatIssuerCollection,
  isMigratedSerial,
  mergeDualChainNftList,
  nftChainKind,
  nftMigrationBadge,
  nftMigrationStatus,
};
