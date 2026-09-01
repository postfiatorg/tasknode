#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  applyWalletBalanceResult,
  markWalletBalanceChecking,
  mergeAppStateWithClientWalletBalance,
  walletVaultPersistenceDecision,
  walletRestoreAddressDecision,
} from "../src/features/wallet/wallet-state.js";
import {
  acceptAccountBoundaryResponse,
  accountBoundaryCaptureIsCurrent,
  beginAccountBoundaryTransition,
  cancelAccountBoundaryTransition,
  initialAccountBoundary,
} from "../src/features/settings/account-transition-boundary.js";

const linkedAddress = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";

function stateWithWallet(wallet = {}) {
  return {
    wallet: {
      pftWallet: {
        status: "linked",
        address: linkedAddress,
      },
      pftBalanceDrops: null,
      pftBalanceStatus: "checking",
      pftBalanceSource: null,
      pftBalanceFetchedAt: null,
      pftBalanceError: "",
      ...wallet,
    },
  };
}

const readyState = stateWithWallet({
  pftBalanceDrops: "876328422435",
  pftBalanceStatus: "ready",
  pftBalanceSource: "pftl_wss",
  pftBalanceFetchedAt: "2026-05-17T01:27:32.293Z",
});
const appStateSnapshot = stateWithWallet({
  pftBalanceDrops: null,
  pftBalanceStatus: "checking",
});

const merged = mergeAppStateWithClientWalletBalance(readyState, appStateSnapshot);
assert.equal(merged.wallet.pftBalanceDrops, "876328422435");
assert.equal(merged.wallet.pftBalanceStatus, "ready");
assert.equal(merged.wallet.pftBalanceSource, "pftl_wss");

const changedWalletSnapshot = {
  wallet: {
    ...appStateSnapshot.wallet,
    pftWallet: {
      status: "linked",
      address: "rDifferentWalletAddress",
    },
  },
};
const changed = mergeAppStateWithClientWalletBalance(readyState, changedWalletSnapshot);
assert.equal(changed.wallet.pftBalanceDrops, null);
assert.equal(changed.wallet.pftBalanceStatus, "checking");

const checking = markWalletBalanceChecking(readyState, linkedAddress);
assert.equal(checking.wallet.pftBalanceDrops, "876328422435");
assert.equal(checking.wallet.pftBalanceStatus, "ready");

const refreshed = applyWalletBalanceResult(readyState, linkedAddress, {
  ok: true,
  body: {
    ok: true,
    balanceDrops: "900000000000",
    source: "pftl_wss",
    fetchedAt: "2026-05-17T01:30:00.000Z",
  },
});
assert.equal(refreshed.wallet.pftBalanceDrops, "900000000000");
assert.equal(refreshed.wallet.pftBalanceStatus, "ready");
assert.equal(refreshed.wallet.pftBalanceFetchedAt, "2026-05-17T01:30:00.000Z");

const vaultMatch = {
  challengeAccountId: "acct_a",
  capturedAccountId: "acct_a",
  derivedAddress: linkedAddress,
  liveAccountId: "acct_a",
  responseAccountId: "acct_a",
  responseAddress: linkedAddress,
};
assert.deepEqual(walletVaultPersistenceDecision(vaultMatch), { ok: true });
assert.equal(walletVaultPersistenceDecision({ ...vaultMatch, liveAccountId: "acct_b" }).error, "wallet_vault_account_mismatch");
assert.equal(walletVaultPersistenceDecision({ ...vaultMatch, challengeAccountId: "acct_b" }).error, "wallet_account_changed");
assert.equal(walletVaultPersistenceDecision({ ...vaultMatch, responseAddress: "rOtherWallet" }).error, "wallet_vault_address_mismatch");
assert.deepEqual(walletRestoreAddressDecision({ derivedAddress: linkedAddress, expectedAddress: linkedAddress }), { ok: true });
assert.equal(walletRestoreAddressDecision({ derivedAddress: "rOtherWallet", expectedAddress: linkedAddress }).error, "wallet_vault_address_mismatch");

const emptyBoundary = initialAccountBoundary();
const initialCapture = { ...emptyBoundary };
const acceptedA = acceptAccountBoundaryResponse(emptyBoundary, initialCapture, "acct_a");
assert.equal(acceptedA.ok, true);
const accountACapture = { ...acceptedA.boundary };
const switching = beginAccountBoundaryTransition(acceptedA.boundary);
assert.equal(accountBoundaryCaptureIsCurrent(switching, accountACapture), false);
assert.equal(acceptAccountBoundaryResponse(switching, accountACapture, "acct_a").error, "account_switch_session_changed");
const cancelled = cancelAccountBoundaryTransition(switching);
assert.equal(accountBoundaryCaptureIsCurrent(cancelled, accountACapture), false);
const freshCapture = { ...cancelled };
assert.equal(acceptAccountBoundaryResponse(cancelled, freshCapture, "acct_b").error, "account_switch_session_changed");

console.log("wallet state regression ok");
