import assert from "node:assert/strict";
import {
  evaluateTaskRequestUnlockPolicy,
  TASK_REQUEST_UNLOCK_STATES,
} from "../src/features/tasks/task-request-unlock-policy.js";

const accountId = "acct_smoke";
const wallet = "rSmokeWallet";
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function policy(input) {
  return evaluateTaskRequestUnlockPolicy({
    accountId,
    linkedWalletAddress: wallet,
    ...input,
  });
}

const locked = policy({
  walletVault: { available: true, address: wallet, unlocked: false },
  walletSecret: null,
});
assert.equal(locked.state, TASK_REQUEST_UNLOCK_STATES.LOCKED);
assert.equal(locked.allowed, false);
assert.equal(locked.action, "unlock");

const unlockPending = policy({
  unlockPending: true,
  walletVault: { available: true, address: wallet, unlocked: false },
  walletSecret: null,
});
assert.equal(unlockPending.state, TASK_REQUEST_UNLOCK_STATES.UNLOCK_PENDING);
assert.equal(unlockPending.allowed, false);
assert.equal(unlockPending.action, "wait");

const unlocked = policy({
  walletVault: { available: true, address: wallet, unlocked: true },
  walletSecret: { accountId, address: wallet, mnemonic },
});
assert.equal(unlocked.state, TASK_REQUEST_UNLOCK_STATES.UNLOCKED);
assert.equal(unlocked.allowed, true);
assert.equal(unlocked.action, "submit");

const invalidUnlock = policy({
  walletVault: { available: true, address: wallet, unlocked: true },
  walletSecret: { accountId, address: "rDifferentWallet", mnemonic },
});
assert.equal(invalidUnlock.state, TASK_REQUEST_UNLOCK_STATES.INVALID_UNLOCK);
assert.equal(invalidUnlock.allowed, false);
assert.equal(invalidUnlock.action, "unlock");

const missingVault = policy({
  walletVault: { available: false, address: wallet, unlocked: false },
  walletSecret: null,
});
assert.equal(missingVault.state, TASK_REQUEST_UNLOCK_STATES.NEEDS_LOCAL_VAULT);
assert.equal(missingVault.allowed, false);
assert.equal(missingVault.action, "open_wallet");

console.log("task request unlock policy smoke ok");
console.log(JSON.stringify({ locked, unlockPending, unlocked, invalidUnlock, missingVault }, null, 2));
