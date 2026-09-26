import assert from "node:assert/strict";
import { appCallback, boundary, deferred, envelopeKey, newer, setup, synthetic, switcherFactory, walletState } from "./wallet-session-test-fixtures.mjs";

function harness(test, { core = null, walletAccountId = synthetic.accountId } = {}) {
  const state = { value: { unlocked: false }, writes: 0, deferred: false, updates: [] };
  const secretRef = { current: null };
  const boundaryRef = { current: boundary.initialAccountBoundary(walletAccountId) };
  const saves = [];
  const dependencies = {
    walletAccountId, walletSecretRef: secretRef, accountBoundaryRef: boundaryRef,
    walletUnlockIntentRef: { current: 0 },
    walletUnlockSessionForAccount: walletState.walletUnlockSessionForAccount,
    syntheticWalletCore: core || { localWalletVaultStatus: ({ accountId }) => ({ accountId, available: true, address: synthetic.address, persistence: "synthetic" }) },
    accountBoundaryCaptureIsCurrent: boundary.accountBoundaryCaptureIsCurrent,
    readUnlockedWalletSession: options => test.store.read(options),
    saveUnlockedWalletSession: unlock => { const save = test.store.save(unlock); saves.push(save); return save; },
    clearAllUnlockedWalletSessions: () => test.store.clearAll(),
    clearOtherUnlockedWalletSessions: options => test.store.clearOthers(options),
    clearUnlockedWalletSession: options => test.store.clear(options),
    touchWalletUnlockActivity: () => test.store.touchActivity(),
    setWalletVaultStatus: update => {
      const apply = () => { state.writes += 1; state.value = typeof update === "function" ? update(state.value) : update; };
      if (state.deferred) state.updates.push(apply); else apply();
    },
    EMPTY_WALLET_VAULT_STATUS: {},
  };
  return {
    state, secretRef, boundaryRef, saves,
    refresh: appCallback("refreshWalletVaultStatus", dependencies),
    lock: appCallback("lockWalletVault", dependencies),
    unlock: appCallback("handleWalletVaultUnlocked", dependencies),
  };
}

for (const action of ["lock-and-unlock", "lock", "forget-refresh", "switch", "switch-cancel", "switch-A-B-A"]) {
  const test = setup(); await test.store.save(synthetic);
  const app = harness(test);
  const gate = test.arm("decrypt");
  const refresh = app.refresh({ preserveUnlock: true }); await gate.entered;
  if (action === "forget-refresh") await app.refresh({ preserveUnlock: false });
  else app.lock();
  if (action === "lock-and-unlock") { app.unlock(newer); await Promise.all(app.saves); }
  if (action.startsWith("switch")) {
    app.boundaryRef.current = boundary.beginAccountBoundaryTransition(app.boundaryRef.current);
    if (action === "switch-cancel") app.boundaryRef.current = boundary.cancelAccountBoundaryTransition(app.boundaryRef.current);
    if (action === "switch-A-B-A") {
      app.boundaryRef.current = { accountId: "acct_synthetic_B", generation: 2, transitioning: false };
      app.boundaryRef.current = { accountId: synthetic.accountId, generation: 4, transitioning: false };
      app.unlock(newer); await Promise.all(app.saves);
    }
  }
  const expectedSecret = app.secretRef.current;
  const expectedState = { ...app.state.value };
  const expectedEnvelope = test.storage.getItem(envelopeKey);
  const previousWrites = app.state.writes;
  gate.release(); await refresh;
  assert.deepEqual(app.secretRef.current, expectedSecret, `${action}: obsolete refresh changes no secret`);
  assert.deepEqual(app.state.value, expectedState, `${action}: obsolete refresh changes no state`);
  assert.equal(app.state.writes, previousWrites, `${action}: obsolete refresh has no state callback`);
  assert.equal(test.storage.getItem(envelopeKey), expectedEnvelope, `${action}: obsolete refresh clears no envelope`);
}

// Run actual account-switch action ordering with a deferred synthetic API request.
for (const success of [false, true]) {
  const test = setup(); await test.store.save(synthetic);
  const app = harness(test), request = deferred(); let reloads = 0;
  const createSwitcher = switcherFactory(() => request.promise, () => { reloads += 1; });
  const actions = createSwitcher({
    selectedAccountId: synthetic.accountId, lockWalletVault: app.lock, prepareTransition() {},
    onPendingChange() {}, onMessage() {},
    onTransitionChange(active) {
      app.boundaryRef.current = active
        ? boundary.beginAccountBoundaryTransition(app.boundaryRef.current)
        : boundary.cancelAccountBoundaryTransition(app.boundaryRef.current);
    },
  });
  const gate = test.arm("decrypt"), refresh = app.refresh({ preserveUnlock: true }); await gate.entered;
  const switching = actions.switchAccount("acct_synthetic_B");
  assert.equal(app.boundaryRef.current.transitioning, true);
  const previousWrites = app.state.writes;
  gate.release(); await refresh;
  assert.equal(app.secretRef.current, null);
  assert.equal(app.state.value.unlocked, false);
  assert.equal(app.state.writes, previousWrites);
  request.resolve({ ok: success, body: {} }); await switching;
  assert.equal(reloads, success ? 1 : 0);
  assert.equal(app.boundaryRef.current.transitioning, success);
}

// A status-read failure cannot clear an intentional unlock that happened later.
{
  const test = setup(), entered = deferred(), status = deferred();
  const app = harness(test, { core: { localWalletVaultStatusAsync() { entered.resolve(); return status.promise; } } });
  const refresh = app.refresh({ preserveUnlock: true }); await entered.promise;
  app.lock(); app.unlock(newer); await Promise.all(app.saves);
  const before = app.state.writes;
  status.reject(new Error("synthetic status error")); await refresh;
  assert.deepEqual(app.secretRef.current, newer);
  assert.equal(app.state.value.unlocked, true);
  assert.equal(app.state.writes, before);
  assert.deepEqual(await test.store.read({ accountId: synthetic.accountId }), newer);
}

// React may apply the functional updater after a newer lock; it must be a no-op.
{
  const test = setup(); await test.store.save(synthetic);
  const app = harness(test); app.state.deferred = true;
  await app.refresh({ preserveUnlock: true });
  assert.equal(app.state.updates.length, 1);
  app.state.deferred = false; app.lock();
  const expected = app.state.value;
  app.state.updates.shift()();
  assert.equal(app.state.value, expected);
  assert.equal(app.state.value.unlocked, false);
}

// Reject a stale closure before clearOthers can delete the new account's cache.
{
  const test = setup(), app = harness(test);
  const other = { ...synthetic, accountId: "acct_synthetic_B" };
  await test.store.save(other);
  app.boundaryRef.current = { accountId: other.accountId, generation: 2, transitioning: false };
  const before = [...test.values];
  assert.equal(await app.refresh({ preserveUnlock: true }), null);
  assert.deepEqual([...test.values], before);
  app.unlock(synthetic); assert.equal(app.secretRef.current, null);
  // refreshAppState supplies the new ID before the React callback rerenders.
  await app.refresh({ preserveUnlock: true, accountId: other.accountId });
  assert.equal(app.secretRef.current.accountId, other.accountId);
  assert.equal(app.state.value.unlocked, true);
}

// The current signed-out callback retains its existing status-clear behavior.
{
  const test = setup(), app = harness(test, { walletAccountId: "" });
  app.secretRef.current = synthetic; app.state.value = { unlocked: true };
  assert.deepEqual(await app.refresh({ preserveUnlock: true }), {});
  assert.equal(app.secretRef.current, null);
  assert.deepEqual(app.state.value, {});
}

// Completion-time account checks reject mismatches and active transitions.
{
  const app = harness(setup());
  app.unlock({ ...synthetic, accountId: "acct_synthetic_B" });
  assert.equal(app.secretRef.current, null); assert.equal(app.saves.length, 0);
  app.boundaryRef.current = boundary.beginAccountBoundaryTransition(app.boundaryRef.current);
  app.unlock(synthetic);
  assert.equal(app.secretRef.current, null); assert.equal(app.saves.length, 0);
}

console.log("wallet refresh lock race smoke ok: exact App/switch callbacks, late unlock, forget, account generation, error and deferred state");
