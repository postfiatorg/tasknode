import { profileNftGenerateStart } from "./profile-nft-generation.js";
import { profileNftMintStart } from "./profile-nft-mint.js";
import { runPublicProfileSnapshot } from "./profile-public-snapshot.js";
import {
  getLatestDailyAirdropRun,
  getProfileRewardHistory,
} from "./repositories/profile-daily-airdrop.js";
import { listProfileNfts } from "./repositories/profile-nfts.js";
import { getPublicProfile } from "./repositories/profile-public.js";

export async function handleProfileRoute({ getState, json, readJson, req, res, session, url }) {
  if (
    ![
      "/api/profile/daily-airdrop",
      "/api/profile/public",
      "/api/profile/public/regenerate",
      "/api/profile/reward-history",
      "/api/profile/nfts",
      "/api/profile/nft/generate",
      "/api/profile/nft/mint",
    ].includes(url.pathname)
  ) {
    return false;
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
      json(res, 200, {
        ok: true,
        snapshot: result.snapshot,
        profile,
      });
    } catch (error) {
      json(res, error?.status || 500, {
        ok: false,
        error: "profile_public_regenerate_failed",
        message: error?.message || "Public profile regeneration failed.",
      });
    }
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
    const nfts = await listProfileNfts({ accountId: session.accountId, limit: 24 });
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
  json(res, result.status, result.body);
  return true;
}
