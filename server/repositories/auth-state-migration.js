import { createHash } from "node:crypto";
import { databaseEnabled, transaction } from "../db/pool.js";
import {
  clearLegacyAuthStateAfterMigration,
  legacyAuthStateSnapshotForMigration,
} from "../runtime-store.js";

function hash(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function active(value, now) {
  return Number.isFinite(Date.parse(value?.expiresAt || "")) && Date.parse(value.expiresAt) > now;
}

function without(source = {}, fields = []) {
  const value = { ...source };
  fields.forEach((field) => delete value[field]);
  return value;
}

function canonicalOAuthState(state = {}) {
  const legacyContext = state.context && typeof state.context === "object" && !Array.isArray(state.context)
    ? state.context
    : {};
  const metadata = state.metadata && typeof state.metadata === "object" && !Array.isArray(state.metadata)
    ? state.metadata
    : {};
  const redirectPath = String(state.redirectPath || state.returnTo || "/app");
  return {
    provider: String(state.provider || "").trim().toLowerCase(),
    redirectPath: redirectPath.startsWith("/") ? redirectPath : "/app",
    redirectUri: String(state.redirectUri || ""),
    linkAccountId: String(state.linkAccountId || legacyContext.linkAccountId || "").trim(),
    metadata: {
      ...legacyContext,
      ...metadata,
      ...(state.codeVerifier && !metadata.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
    },
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  };
}

export async function migrateLegacyAuthState({ now = Date.now() } = {}) {
  if (!databaseEnabled()) return { migrated: false, adapter: "runtime" };
  const snapshot = legacyAuthStateSnapshotForMigration();
  const counts = { sessions: 0, oauthStates: 0, emailChallenges: 0, walletChallenges: 0 };
  await transaction(async (client) => {
    for (const [id, session] of Object.entries(snapshot.sessions || {})) {
      if (!active(session, now) || !session?.accountId) continue;
      await client.query(
        `INSERT INTO auth_sessions (
           token_hash, account_id, primary_provider, assurance, session_json, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (token_hash) DO NOTHING`,
        [hash(id), session.accountId, session.primaryProvider || "", session.assurance || "low", JSON.stringify(without(session, ["id"])), session.createdAt, session.expiresAt]
      );
      counts.sessions += 1;
    }
    for (const [id, state] of Object.entries(snapshot.oauthStates || {})) {
      if (!active(state, now) || !state?.provider) continue;
      const canonical = canonicalOAuthState(state);
      delete canonical.metadata.linkAccountId;
      await client.query(
        `INSERT INTO auth_challenges (
           challenge_hash, kind, provider, subject_key, payload_json, max_attempts, created_at, expires_at
         ) VALUES ($1, 'oauth_state', $2, $3, $4::jsonb, 1, $5, $6)
         ON CONFLICT (challenge_hash) DO NOTHING`,
        [hash(id), canonical.provider, canonical.linkAccountId, JSON.stringify(canonical), canonical.createdAt, canonical.expiresAt]
      );
      counts.oauthStates += 1;
    }
    for (const [id, challenge] of Object.entries(snapshot.emailChallenges || {})) {
      if (!active(challenge, now) || challenge?.consumedAt || challenge?.replacedAt) continue;
      await client.query(
        `INSERT INTO auth_challenges (
           challenge_hash, kind, subject_key, secret_hash, payload_json, attempts,
           max_attempts, created_at, expires_at
         ) VALUES ($1, 'email_login', $2, $3, $4::jsonb, $5, $6, $7, $8)
         ON CONFLICT (challenge_hash) DO NOTHING`,
        [
          hash(id), challenge.canonicalEmail || "", challenge.codeHash || "",
          JSON.stringify(without(challenge, ["id", "codeHash", "attempts", "maxAttempts", "createdAt", "expiresAt", "consumedAt", "replacedAt"])),
          Number(challenge.attempts || 0), Number(challenge.maxAttempts || 6), challenge.createdAt, challenge.expiresAt,
        ]
      );
      counts.emailChallenges += 1;
    }
    for (const [id, challenge] of Object.entries(snapshot.walletChallenges || {})) {
      if (!active(challenge, now)) continue;
      const kind = challenge.purpose === "wallet_login" ? "wallet_login" : "wallet_proof";
      const subject = kind === "wallet_login" ? challenge.address || "" : challenge.accountId || "";
      await client.query(
        `INSERT INTO auth_challenges (
           challenge_hash, kind, subject_key, payload_json, max_attempts, created_at, expires_at
         ) VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6)
         ON CONFLICT (challenge_hash) DO NOTHING`,
        [hash(id), kind, subject, JSON.stringify(without(challenge, ["id", "message", "expiresAt"])), challenge.issuedAt, challenge.expiresAt]
      );
      counts.walletChallenges += 1;
    }
  });
  const cleared = clearLegacyAuthStateAfterMigration();
  return { migrated: true, counts, cleared };
}
