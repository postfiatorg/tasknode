#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("auth_challenge_smoke_database_url_required");
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_WALLET_LOGIN_CHALLENGE_CAP = "3";

const { closePool, query } = await import("../server/db/pool.js");
const {
  authChallengeStorageStatus,
  consumeEmailChallenge,
  consumeOAuthState,
  consumeWalletChallenge,
  consumeWalletLoginChallenge,
  createEmailChallenge,
  createOAuthState,
  createWalletChallenge,
  createWalletLoginChallenge,
  getEmailChallenge,
} = await import("../server/repositories/auth-challenges.js");

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const accountId = `acct_challenge_smoke_${suffix}`;
const email = `challenge-${suffix}@example.test`;
const walletAddress = `rChallengeSmoke${suffix}`;
const hashes = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");

try {
  assert.equal(authChallengeStorageStatus().adapter, "postgres");

  const oauth = await createOAuthState({ provider: "github", linkAccountId: accountId, metadata: { flow: "smoke" } });
  hashes.push(hash(oauth.id));
  assert.equal((await consumeOAuthState({ provider: "github", stateId: oauth.id, peek: true })).metadata.flow, "smoke");
  assert.ok(await consumeOAuthState({ provider: "github", stateId: oauth.id }));
  assert.equal(await consumeOAuthState({ provider: "github", stateId: oauth.id }), null);

  const firstEmail = await createEmailChallenge({
    email,
    canonicalEmail: email,
    maskedEmail: "c***@example.test",
    codeHash: hash("first-code"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deliveryMode: "smoke",
  });
  hashes.push(hash(firstEmail.id));
  const secondEmail = await createEmailChallenge({
    email,
    canonicalEmail: email,
    maskedEmail: "c***@example.test",
    codeHash: hash("second-code"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deliveryMode: "smoke",
  });
  hashes.push(hash(secondEmail.id));
  assert.equal(await getEmailChallenge(firstEmail.id), null, "a newer email challenge must replace the prior one");
  assert.equal((await consumeEmailChallenge({ challengeId: secondEmail.id, codeHash: hash("wrong-code") })).ok, false);
  assert.equal((await getEmailChallenge(secondEmail.id)).attempts, 1);
  assert.equal((await consumeEmailChallenge({ challengeId: secondEmail.id, codeHash: hash("second-code") })).ok, true);
  assert.equal((await consumeEmailChallenge({ challengeId: secondEmail.id, codeHash: hash("second-code") })).ok, false);

  const walletProof = await createWalletChallenge({ accountId, purpose: "wallet_link" });
  hashes.push(hash(walletProof.challenge.id));
  assert.equal((await consumeWalletChallenge({ accountId: "acct_other", challengeId: walletProof.challenge.id })).error, "wallet_challenge_mismatch");
  assert.equal((await consumeWalletChallenge({ accountId, challengeId: walletProof.challenge.id })).ok, true);
  assert.equal((await consumeWalletChallenge({ accountId, challengeId: walletProof.challenge.id })).ok, false);

  const walletLogin = await createWalletLoginChallenge({ address: walletAddress });
  hashes.push(hash(walletLogin.challenge.id));
  assert.equal((await consumeWalletLoginChallenge({ challengeId: walletLogin.challenge.id, address: "rWrong" })).ok, false);
  assert.equal((await consumeWalletLoginChallenge({ challengeId: walletLogin.challenge.id, address: walletAddress })).ok, false, "address mismatch must consume the one-time login challenge");

  const stored = await query(
    "SELECT challenge_hash, payload_json::text AS payload_text FROM auth_challenges WHERE challenge_hash = ANY($1::text[])",
    [hashes]
  );
  assert.equal(stored.rows.length, hashes.length);
  for (const row of stored.rows) {
    assert.equal(hashes.includes(row.challenge_hash), true);
    for (const rawId of [oauth.id, firstEmail.id, secondEmail.id, walletProof.challenge.id, walletLogin.challenge.id]) {
      assert.equal(row.payload_text.includes(rawId), false, "raw challenge ids must not be retained in payload JSON");
    }
  }
  console.log("auth challenge repository smoke ok: hashed ids, replacement, attempts, one-time consume");
} finally {
  await query("DELETE FROM auth_challenges WHERE challenge_hash = ANY($1::text[])", [hashes]).catch(() => {});
  await closePool();
}
