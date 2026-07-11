#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknode-wallet-challenge-replay-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

try {
  const {
    createWalletChallenge,
    consumeWalletChallenge,
    createWalletLoginChallenge,
    consumeWalletLoginChallenge,
  } = await import("../server/runtime-store.js");

  const accountId = "wallet-replay-account";
  const otherAccountId = "wallet-replay-other-account";
  const purpose = "wallet_link";

  const linkReplayChallenge = createWalletChallenge({ accountId, purpose });
  assert.equal(linkReplayChallenge.ok, true);

  const linkReplayChallengeId = linkReplayChallenge.challenge.id;
  assert.equal(
    consumeWalletChallenge({ accountId, challengeId: linkReplayChallengeId, purpose }).ok,
    true,
  );
  assert.equal(
    consumeWalletChallenge({ accountId, challengeId: linkReplayChallengeId, purpose }).ok,
    false,
  );

  const mismatchChallenge = createWalletChallenge({ accountId, purpose });
  assert.equal(mismatchChallenge.ok, true);

  const mismatchChallengeId = mismatchChallenge.challenge.id;
  const mismatchConsume = consumeWalletChallenge({
    accountId: otherAccountId,
    challengeId: mismatchChallengeId,
    purpose,
  });
  assert.deepEqual(
    { ok: mismatchConsume.ok, error: mismatchConsume.error },
    { ok: false, error: "wallet_challenge_mismatch" },
  );
  assert.equal(
    consumeWalletChallenge({ accountId, challengeId: mismatchChallengeId, purpose }).ok,
    true,
  );

  const address = "rWalletReplayLoginAddress";
  const loginChallenge = createWalletLoginChallenge({ address });
  assert.equal(loginChallenge.ok, true);

  const loginChallengeId = loginChallenge.challenge.id;
  assert.equal(consumeWalletLoginChallenge({ challengeId: loginChallengeId, address }).ok, true);
  assert.equal(consumeWalletLoginChallenge({ challengeId: loginChallengeId, address }).ok, false);

  console.log("PASS wallet challenge replay regression");
  console.log("wallet-link replay rejected; account mismatch preserved challenge; wallet-login replay rejected");
} catch (error) {
  console.error("FAIL wallet challenge replay regression");
  console.error(error?.stack || error);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
