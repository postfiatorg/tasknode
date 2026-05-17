#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  applyWalletBalanceResult,
  markWalletBalanceChecking,
  mergeAppStateWithClientWalletBalance,
} from "../src/features/wallet/wallet-state.js";

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

console.log("wallet state regression ok");
