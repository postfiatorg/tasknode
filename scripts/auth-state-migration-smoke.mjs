#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("auth_state_migration_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-auth-migration-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

const runtime = await import("../server/runtime-store.js");
const account = runtime.getOrCreateEmailAccount({
  email: "migration@example.test",
  canonicalEmail: "migration@example.test",
  maskedEmail: "m***@example.test",
});
const session = runtime.createAccountSession(account, { provider: "email", assurance: "medium" });
const oauth = runtime.createOAuthState({
  provider: "github",
  redirectPath: "/profile",
  redirectUri: "https://tasknode.example.test/api/auth/callback/github",
  linkAccountId: account.id,
  expiresInSeconds: 600,
  metadata: { flow: "current" },
});
const legacyOauth = runtime.createOAuthState({
  provider: "x",
  codeVerifier: "legacy-code-verifier",
  returnTo: "/wallet",
  context: { linkAccountId: account.id, flow: "legacy" },
  ttlSeconds: 600,
});
assert.equal(oauth.linkAccountId, account.id);
assert.equal(oauth.redirectPath, "/profile");
assert.equal(legacyOauth.linkAccountId, account.id);
assert.equal(legacyOauth.metadata.codeVerifier, "legacy-code-verifier");
const emailCodeHash = createHash("sha256").update("migration-code").digest("hex");
const email = runtime.createEmailChallenge({
  email: "migration@example.test",
  canonicalEmail: "migration@example.test",
  maskedEmail: "m***@example.test",
  codeHash: emailCodeHash,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  deliveryMode: "smoke",
});
const wallet = runtime.createWalletChallenge({ accountId: account.id, purpose: "wallet_link" });

delete process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { closePool, query } = await import("../server/db/pool.js");
const { migrateLegacyAuthState } = await import("../server/repositories/auth-state-migration.js");
const sessions = await import("../server/repositories/auth-sessions.js");
const challenges = await import("../server/repositories/auth-challenges.js");

try {
  const result = await migrateLegacyAuthState();
  assert.deepEqual(result.counts, { sessions: 1, oauthStates: 2, emailChallenges: 1, walletChallenges: 1 });
  assert.deepEqual(result.cleared, { sessions: 1, oauthStates: 2, emailChallenges: 1, walletChallenges: 1 });
  assert.deepEqual(runtime.legacyAuthStateSnapshotForMigration(), { sessions: {}, oauthStates: {}, emailChallenges: {}, walletChallenges: {} });

  assert.equal((await sessions.getSession(session.sessionId)).accountId, account.id);
  const migratedOauth = await challenges.consumeOAuthState({ provider: "github", stateId: oauth.id });
  assert.equal(migratedOauth.linkAccountId, account.id);
  assert.equal(migratedOauth.redirectPath, "/profile");
  assert.deepEqual(migratedOauth.metadata, { flow: "current" });
  const migratedLegacyOauth = await challenges.consumeOAuthState({ provider: "x", stateId: legacyOauth.id });
  assert.equal(migratedLegacyOauth.linkAccountId, account.id);
  assert.equal(migratedLegacyOauth.redirectPath, "/wallet");
  assert.equal(migratedLegacyOauth.metadata.codeVerifier, "legacy-code-verifier");
  assert.equal(migratedLegacyOauth.metadata.flow, "legacy");
  assert.equal((await challenges.consumeEmailChallenge({ challengeId: email.id, codeHash: emailCodeHash })).ok, true);
  assert.equal((await challenges.consumeWalletChallenge({ accountId: account.id, challengeId: wallet.challenge.id })).ok, true);

  const rawIds = [session.sessionId, oauth.id, legacyOauth.id, email.id, wallet.challenge.id];
  const persisted = await query(
    `SELECT token_hash AS stored_hash, session_json::text AS payload FROM auth_sessions WHERE account_id = $1
     UNION ALL
     SELECT challenge_hash AS stored_hash, payload_json::text AS payload FROM auth_challenges WHERE subject_key = $1`,
    [account.id]
  );
  for (const row of persisted.rows) {
    rawIds.forEach((rawId) => assert.equal(row.payload.includes(rawId), false));
  }
  console.log("legacy auth state migration smoke ok: lossless import, hashed ids, source cleared after commit");
} finally {
  await query("DELETE FROM auth_sessions WHERE account_id = $1", [account.id]).catch(() => {});
  await query("DELETE FROM auth_challenges WHERE subject_key = $1", [account.id]).catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
