import { profileNftGenerateStart } from "./profile-nft-generation.js";
import { profileNftMintStart } from "./profile-nft-mint.js";
import { createHash } from "node:crypto";
import { loadPrompt } from "./prompt-registry.js";
import { runPublicProfileSnapshot } from "./profile-public-snapshot.js";
import {
  getLatestDailyAirdropRun,
  getProfileRewardHistory,
} from "./repositories/profile-daily-airdrop.js";
import { failStaleGeneratingProfileNfts, listProfileNfts } from "./repositories/profile-nfts.js";
import { getPublicProfile } from "./repositories/profile-public.js";
import {
  getRecommendedConnectionsState,
  recommendedConnectionProfileIsDiscoverable,
  recordRecommendedConnectionEvent,
  refreshRecommendedConnectionProfile,
  refreshRecommendedConnections,
} from "./repositories/recommended-connections.js";
import {
  checkHiveHandleAvailability,
  getAccountProfileVisibility,
  getAccountIdentityProfile,
  setAccountAliasVisibility,
  setAccountHiveHandle,
  setAccountProfileVisibility,
  suggestHiveHandles,
  getLinkedWallet,
} from "./runtime-store.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";

const recommendedConnectionsPrompt = loadPrompt("profile/recommended_connections_v1.md");

function promptDigest(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function safeEventText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function recordProfileObservabilityEvent({
  eventType = "",
  accountId = "",
  resultStatus = "",
  reasonCode = "",
  walletAddress = "",
  sourceRoute = "",
  metadata = {},
  metrics = {},
} = {}) {
  if (!eventType || !accountId) return;
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    walletAddress,
    walletScope: walletAddress ? "active" : "",
    sourceSurface: "profile",
    sourceRoute: sourceRoute || "server/profile-routes.js",
    resultStatus,
    reasonCode,
    metadata,
    metrics,
  }).catch(() => {});
}

export async function handleProfileRoute({ getState, json, readJson, req, res, session, url }) {
  if (
    ![
      "/api/profile/daily-airdrop",
      "/api/profile/handle",
      "/api/profile/handle/availability",
      "/api/profile/identity",
      "/api/profile/identity/alias",
      "/api/profile/visibility",
      "/api/profile/member",
      "/api/profile/public",
      "/api/profile/public/regenerate",
      "/api/profile/recommended-connections",
      "/api/profile/recommended-connections/refresh",
      "/api/profile/recommended-connections/event",
      "/api/profile/reward-history",
      "/api/profile/nfts",
      "/api/profile/nft/generate",
      "/api/profile/nft/mint",
    ].includes(url.pathname)
  ) {
    return false;
  }

  if (url.pathname === "/api/profile/identity") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_identity_method_not_allowed",
        message: "Profile identity requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_identity_login_required",
        message: "Sign in before editing profile identity.",
      });
      return true;
    }
    json(res, 200, {
      ok: true,
      identityProfile: getAccountIdentityProfile({ accountId: session.accountId }),
    });
    return true;
  }

  if (url.pathname === "/api/profile/handle/availability") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_handle_availability_method_not_allowed",
        message: "Handle availability requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_handle_availability_login_required",
        message: "Sign in before checking profile handles.",
      });
      return true;
    }
    const handle = url.searchParams.get("handle") || "";
    const availability = checkHiveHandleAvailability({ handle, accountId: session.accountId });
    json(res, 200, {
      ok: true,
      availability,
      suggestions: availability.available
        ? []
        : suggestHiveHandles({ accountId: session.accountId, base: handle }),
    });
    return true;
  }

  if (url.pathname === "/api/profile/handle") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "profile_handle_method_not_allowed",
        message: "Saving a Hive handle requires POST.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_handle_login_required",
        message: "Sign in before saving a Hive handle.",
      });
      return true;
    }
    const payload = await readJson(req, 8192);
    const result = setAccountHiveHandle({
      accountId: session.accountId,
      handle: payload.handle,
      displayName: payload.displayName,
    });
    await recordProfileObservabilityEvent({
      eventType: "user.profile_handle.changed",
      accountId: session.accountId,
      resultStatus: result.ok ? "saved" : "failed",
      reasonCode: result.ok ? "" : result.error || "profile_handle_save_failed",
      sourceRoute: "server/profile-routes.js::/api/profile/handle",
      metadata: {
        handle: safeEventText(result.handle || payload.handle, 120),
        displayNamePresent: Boolean(payload.displayName),
      },
    });
    json(res, result.ok ? 200 : result.status || 400, {
      ok: result.ok,
      ...result,
    });
    return true;
  }

  if (url.pathname === "/api/profile/identity/alias") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "profile_identity_alias_method_not_allowed",
        message: "Saving provider alias visibility requires POST.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_identity_alias_login_required",
        message: "Sign in before editing provider aliases.",
      });
      return true;
    }
    const payload = await readJson(req, 8192);
    const result = setAccountAliasVisibility({
      accountId: session.accountId,
      provider: payload.provider,
      visibility: payload.visibility,
      discloseHandle: payload.discloseHandle,
      discloseVerifiedBadge: payload.discloseVerifiedBadge,
    });
    await recordProfileObservabilityEvent({
      eventType: "user.alias_visibility.changed",
      accountId: session.accountId,
      resultStatus: result.ok ? "saved" : "failed",
      reasonCode: result.ok ? "" : result.error || "profile_alias_visibility_save_failed",
      sourceRoute: "server/profile-routes.js::/api/profile/identity/alias",
      metadata: {
        provider: safeEventText(payload.provider, 80),
        visibility: safeEventText(payload.visibility, 80),
        discloseHandle: payload.discloseHandle === true,
        discloseVerifiedBadge: payload.discloseVerifiedBadge === true,
      },
    });
    json(res, result.ok ? 200 : result.status || 400, {
      ok: result.ok,
      ...result,
    });
    return true;
  }

  if (url.pathname === "/api/profile/visibility") {
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_visibility_login_required",
        message: "Sign in before editing profile visibility.",
      });
      return true;
    }
    if (req.method === "GET") {
      json(res, 200, {
        ok: true,
        visibility: getAccountProfileVisibility({ accountId: session.accountId }),
        identityProfile: getAccountIdentityProfile({ accountId: session.accountId }),
      });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "profile_visibility_method_not_allowed",
        message: "Profile visibility requires GET or POST.",
      });
      return true;
    }
    const payload = await readJson(req, 8192);
    const result = setAccountProfileVisibility({
      accountId: session.accountId,
      visibility: payload.visibility,
    });
    if (result.ok) {
      await refreshRecommendedConnectionProfile({ accountId: session.accountId })
        .catch(() => null);
    }
    json(res, result.ok ? 200 : result.status || 400, {
      ok: result.ok,
      ...result,
      visibility: getAccountProfileVisibility({ accountId: session.accountId }),
    });
    return true;
  }

  if (url.pathname === "/api/profile/daily-airdrop") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_daily_airdrop_method_not_allowed",
        message: "Profile daily airdrop requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_daily_airdrop_login_required",
        message: "Sign in before viewing profile daily airdrop.",
      });
      return true;
    }
    const latest = await getLatestDailyAirdropRun({ accountId: session.accountId });
    json(res, 200, {
      ok: true,
      latest,
    });
    return true;
  }

  if (url.pathname === "/api/profile/public") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_public_method_not_allowed",
        message: "Public profile preview requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_public_login_required",
        message: "Sign in before viewing public profile.",
      });
      return true;
    }
    const profile = await getPublicProfile({ accountId: session.accountId });
    json(res, 200, {
      ok: true,
      profile,
    });
    return true;
  }

  if (url.pathname === "/api/profile/member") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_member_method_not_allowed",
        message: "Member profile preview requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_member_login_required",
        message: "Sign in before viewing member profiles.",
      });
      return true;
    }
    const targetAccountId = String(url.searchParams.get("accountId") || "").trim();
    if (!targetAccountId || targetAccountId.startsWith("deleted_account_")) {
      json(res, 400, {
        ok: false,
        error: "profile_member_account_required",
        message: "Choose a valid member profile.",
      });
      return true;
    }
    const visibility = getAccountProfileVisibility({ accountId: targetAccountId });
    const indexed = await recommendedConnectionProfileIsDiscoverable({ accountId: targetAccountId });
    if (visibility.visibility !== "public" || visibility.discoverable === false || !indexed) {
      json(res, 404, {
        ok: false,
        error: "profile_member_not_discoverable",
        message: "This member profile is not public.",
      });
      return true;
    }
    const profile = await getPublicProfile({ accountId: targetAccountId });
    json(res, 200, {
      ok: true,
      accountId: targetAccountId,
      profile,
    });
    return true;
  }

  if (url.pathname === "/api/profile/public/regenerate") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "profile_public_regenerate_method_not_allowed",
        message: "Public profile regeneration requires POST.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_public_regenerate_login_required",
        message: "Sign in before regenerating public profile.",
      });
      return true;
    }
    try {
      const result = await runPublicProfileSnapshot({ accountId: session.accountId });
      const profile = await getPublicProfile({ accountId: session.accountId });
      await recordProfileObservabilityEvent({
        eventType: "user.profile.public_snapshot_completed",
        accountId: session.accountId,
        resultStatus: result.skipped ? "skipped_current" : "completed",
        sourceRoute: "server/profile-routes.js::/api/profile/public/regenerate",
        metadata: {
          snapshotId: safeEventText(result.snapshot?.snapshotId || result.snapshot?.id, 180),
          provider: safeEventText(result.provider, 80),
          model: safeEventText(result.model, 180),
          promptDigest: safeEventText(result.promptDigest, 180),
          inputFingerprint: safeEventText(result.inputFingerprint, 180),
        },
      });
      json(res, 200, {
        ok: true,
        snapshot: result.snapshot,
        profile,
      });
    } catch (error) {
      await recordProfileObservabilityEvent({
        eventType: "user.profile.public_snapshot_completed",
        accountId: session.accountId,
        resultStatus: "failed",
        reasonCode: error?.message || "profile_public_regenerate_failed",
        sourceRoute: "server/profile-routes.js::/api/profile/public/regenerate",
      });
      json(res, error?.status || 500, {
        ok: false,
        error: "profile_public_regenerate_failed",
        message: error?.message || "Public profile regeneration failed.",
      });
    }
    return true;
  }

  if (url.pathname === "/api/profile/recommended-connections") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "recommended_connections_method_not_allowed",
        message: "Recommended connections requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "recommended_connections_login_required",
        message: "Sign in before viewing recommended connections.",
      });
      return true;
    }
    json(res, 200, await getRecommendedConnectionsState({ accountId: session.accountId }));
    return true;
  }

  if (url.pathname === "/api/profile/recommended-connections/refresh") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "recommended_connections_refresh_method_not_allowed",
        message: "Recommended connection refresh requires POST.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "recommended_connections_refresh_login_required",
        message: "Sign in before refreshing recommended connections.",
      });
      return true;
    }
    const payload = await readJson(req, 8192);
    try {
      const result = await refreshRecommendedConnections({
        accountId: session.accountId,
        force: payload.force === true,
        trigger: payload.trigger || "profile_page",
        prompt: recommendedConnectionsPrompt,
        promptDigest: promptDigest(recommendedConnectionsPrompt),
      });
      await recordProfileObservabilityEvent({
        eventType: "user.profile.recommended_connections_refreshed",
        accountId: session.accountId,
        resultStatus: result.ok === false ? "failed" : result.skipped ? "skipped" : "completed",
        reasonCode: result.ok === false ? result.error || "recommended_connections_refresh_failed" : result.reason || "",
        sourceRoute: "server/profile-routes.js::/api/profile/recommended-connections/refresh",
        metadata: {
          trigger: safeEventText(payload.trigger || "profile_page", 120),
          force: payload.force === true,
          runId: safeEventText(result.runId || result.run?.id, 180),
        },
      });
      json(res, result.ok === false ? result.status || 500 : 200, result);
    } catch (error) {
      await recordProfileObservabilityEvent({
        eventType: "user.profile.recommended_connections_refreshed",
        accountId: session.accountId,
        resultStatus: "failed",
        reasonCode: error?.message || "recommended_connections_refresh_failed",
        sourceRoute: "server/profile-routes.js::/api/profile/recommended-connections/refresh",
      });
      json(res, error?.status || 500, {
        ok: false,
        error: "recommended_connections_refresh_failed",
        message: error?.message || "Recommended connections could not be refreshed.",
      });
    }
    return true;
  }

  if (url.pathname === "/api/profile/recommended-connections/event") {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "recommended_connection_event_method_not_allowed",
        message: "Recommended connection events require POST.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "recommended_connection_event_login_required",
        message: "Sign in before recording recommended connection events.",
      });
      return true;
    }
    const payload = await readJson(req, 64 * 1024);
    const result = await recordRecommendedConnectionEvent({
      accountId: session.accountId,
      candidateAccountId: payload.candidateAccountId || payload.candidate_account_id,
      connectionId: payload.connectionId || payload.connection_id,
      eventType: payload.eventType || payload.event_type,
      metadata: payload.metadata || {},
    });
    await recordProfileObservabilityEvent({
      eventType: "user.profile.recommended_connection_interacted",
      accountId: session.accountId,
      resultStatus: result.ok ? "recorded" : "failed",
      reasonCode: result.ok ? "" : result.error || "recommended_connection_event_failed",
      sourceRoute: "server/profile-routes.js::/api/profile/recommended-connections/event",
      metadata: {
        candidateAccountId: safeEventText(payload.candidateAccountId || payload.candidate_account_id, 180),
        connectionId: safeEventText(payload.connectionId || payload.connection_id, 180),
        interactionType: safeEventText(payload.eventType || payload.event_type, 120),
      },
    });
    json(res, result.ok ? 200 : result.status || 400, result);
    return true;
  }

  if (url.pathname === "/api/profile/reward-history") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_reward_history_method_not_allowed",
        message: "Profile reward history requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_reward_history_login_required",
        message: "Sign in before viewing profile reward history.",
      });
      return true;
    }
    const history = await getProfileRewardHistory({
      accountId: session.accountId,
      range: url.searchParams.get("range") || "28d",
    });
    json(res, 200, {
      ok: true,
      history,
    });
    return true;
  }

  if (url.pathname === "/api/profile/nfts") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "profile_nfts_method_not_allowed",
        message: "Profile NFT list requires GET.",
      });
      return true;
    }
    if (!session?.accountId) {
      json(res, 401, {
        ok: false,
        error: "profile_nft_login_required",
        message: "Sign in before viewing profile NFTs.",
      });
      return true;
    }
    await failStaleGeneratingProfileNfts({ accountId: session.accountId }).catch((error) => {
      console.warn(`profile nft stale generation sweep failed: ${error?.message || error}`);
    });
    const linkedWallet = getLinkedWallet({ accountId: session.accountId });
    const nfts = await listProfileNfts({
      accountId: session.accountId,
      walletAddress: linkedWallet.address || "",
      limit: 24,
    });
    json(res, 200, {
      ok: true,
      nfts,
      latest: nfts[0] || null,
    });
    return true;
  }

  const payload = req.method === "POST" ? await readJson(req, 65536) : {};
  const state = session?.accountId ? await getState() : null;
  const result =
    url.pathname === "/api/profile/nft/mint"
      ? await profileNftMintStart({
          method: req.method,
          payload,
          session,
          state,
        })
      : await profileNftGenerateStart({
          method: req.method,
          payload,
          session,
          state,
        });
  const requestedNftPhase = safeEventText(payload?.phase || "prepare", 40);
  const nftEventType = url.pathname === "/api/profile/nft/mint"
    ? result.body?.phase === "minted" || requestedNftPhase === "submit"
      ? "user.profile.nft_minted"
      : "user.profile.nft_mint_prepared"
    : "user.profile.nft_generated";
  await recordProfileObservabilityEvent({
    eventType: nftEventType,
    accountId: session?.accountId || "",
    walletAddress: result.body?.nft?.walletAddress || "",
    resultStatus: result.body?.ok ? result.body?.phase || "completed" : "failed",
    reasonCode: result.body?.ok ? "" : result.body?.error || "profile_nft_failed",
    sourceRoute: `server/profile-routes.js::${url.pathname}`,
    metadata: {
      nftId: safeEventText(result.body?.nft?.id || payload?.nftId, 180),
      action: safeEventText(result.body?.action, 120),
      model: safeEventText(result.body?.model || result.body?.nft?.model, 180),
      promptDigest: safeEventText(result.body?.promptDigest || result.body?.nft?.promptDigest, 180),
      txHash: safeEventText(result.body?.txHash, 240),
      nftTokenIdPresent: Boolean(result.body?.nftTokenId),
    },
  });
  json(res, result.status, result.body);
  return true;
}
