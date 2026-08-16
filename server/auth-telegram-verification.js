import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function readScalar(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "").trim();
}

function authError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function timingSafeHexEqual(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function verifyTelegramLoginPayload(rawPayload, botToken, options = {}) {
  const token = String(botToken || "").trim();
  if (!token) throw authError("Telegram auth is not configured.", "telegram_auth_not_configured", 503);
  const hash = readScalar(rawPayload?.hash).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw authError("Missing or invalid Telegram auth hash.", "telegram_auth_hash_invalid");
  }
  const data = {};
  for (const key of ["id", "first_name", "last_name", "username", "photo_url", "auth_date"]) {
    const value = readScalar(rawPayload?.[key]);
    if (value) data[key] = value;
  }
  if (!/^\d+$/.test(data.id || "")) {
    throw authError("Missing or invalid Telegram user id.", "telegram_auth_user_invalid");
  }
  if (!/^\d+$/.test(data.auth_date || "")) {
    throw authError("Missing or invalid Telegram auth date.", "telegram_auth_date_invalid");
  }
  const dataCheckString = Object.keys(data).sort().map((key) => `${key}=${data[key]}`).join("\n");
  const secretKey = createHash("sha256").update(token).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeHexEqual(hash, expected)) {
    throw authError("Telegram auth signature failed.", "telegram_auth_signature_invalid", 401);
  }
  const maxAuthAgeSec = Number.isFinite(Number(options.maxAuthAgeSec))
    ? Number(options.maxAuthAgeSec)
    : 900;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (maxAuthAgeSec > 0 && Math.abs(nowMs - Number(data.auth_date) * 1000) > maxAuthAgeSec * 1000) {
    throw authError("Telegram auth payload is expired.", "telegram_auth_expired", 401);
  }
  return {
    id: data.id,
    username: data.username || "",
    firstName: data.first_name || "",
    lastName: data.last_name || "",
    photoUrl: data.photo_url || "",
    authDate: Number(data.auth_date),
  };
}

export function telegramDisplayName(profile) {
  const username = readScalar(profile?.username);
  if (username) return username;
  const fullName = [profile?.firstName, profile?.lastName].map(readScalar).filter(Boolean).join(" ").trim();
  return fullName || `telegram:${readScalar(profile?.id)}`;
}
