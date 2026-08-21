import { generateIChingProfile } from "./i-ching-profile.js";
import { getIChingProfile, upsertIChingProfile } from "./repositories/i-ching-profile.js";

function publicProfile(profile = null) {
  if (!profile) return null;
  return {
    birthDate: profile.birthDate,
    birthTime: profile.birthTime,
    birthLocation: profile.birthLocation,
    gender: profile.gender,
    timezone: profile.timezone,
    trueSolarTime: profile.trueSolarTime,
    warnings: Array.isArray(profile.combined?.warnings) ? profile.combined.warnings : [],
    chartVersion: profile.chartVersion,
    updatedAt: profile.updatedAt,
  };
}

export async function handleIChingRoute({ json, readJson, req, res, session, url } = {}) {
  if (url.pathname !== "/api/i-ching/profile") return false;
  if (!session?.accountId) {
    json(res, 401, { ok: false, error: "i_ching_login_required", message: "Sign in before setting up I Ching." });
    return true;
  }

  if (req.method === "GET") {
    const profile = await getIChingProfile({ accountId: session.accountId });
    json(res, 200, { ok: true, exists: Boolean(profile), profile: publicProfile(profile) });
    return true;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "i_ching_profile_method_not_allowed", message: "Use GET or POST for I Ching profile setup." });
    return true;
  }

  try {
    const payload = await readJson(req, 16 * 1024);
    const chart = await generateIChingProfile({
      birthDate: payload?.birthDate,
      birthTime: payload?.birthTime,
      birthLocation: payload?.birthLocation,
      gender: payload?.gender,
    });
    const profile = await upsertIChingProfile({ accountId: session.accountId, chart });
    json(res, 200, {
      ok: true,
      exists: true,
      message: "I Ching birth chart saved privately.",
      profile: publicProfile(profile),
    });
  } catch (error) {
    const inputFailure = error?.code === "I_CHING_INPUT";
    console.warn("i_ching_profile_save_failed", {
      accountIdPresent: Boolean(session?.accountId),
      code: error?.code || "I_CHING_PROFILE_FAILED",
      message: String(error?.message || "unknown_error").slice(0, 240),
    });
    json(res, inputFailure ? 400 : 500, {
      ok: false,
      error: inputFailure ? "i_ching_profile_invalid" : "i_ching_profile_failed",
      message: inputFailure ? error.message : "The I Ching birth chart could not be generated.",
    });
  }
  return true;
}
