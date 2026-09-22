import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "device-account-concurrency-"));
process.env.TASKNODE_STORE_PATH = join(temporary, "store.json");
process.env.TASKNODE_DATABASE_ENABLED = process.env.DATABASE_URL ? "true" : "false";
process.env.TASKNODE_INITIAL_PROVIDER_CREDIT_USD = "0";
const { query, closePool, databaseEnabled } = await import("../server/db/pool.js");
const { createAccountSession, getSession } = await import("../server/repositories/auth-sessions.js");
const { getOrCreateProviderAccount } = await import("../server/repositories/accounts.js");
const { accountList, accountLogoutCurrent, accountLogoutAll, accountSwitch, registerAuthenticatedAccountSet } = await import("../server/account-switching.js");
const { listDeviceAccounts, selectDeviceAccount } = await import("../server/repositories/device-account-sets.js");
const accountIds = [];
let setId;
try {
  const accounts = [];
  for (const name of ["alpha", "beta"]) {
    let account;
    if (databaseEnabled()) {
      account = { id: `acct_device_fixture_${Date.now()}_${name}`, displayName: name, linkedProviders: [] };
      await query("INSERT INTO app_accounts (account_id, account_json) VALUES ($1,$2::jsonb)", [account.id, JSON.stringify(account)]);
    } else {
      account = await getOrCreateProviderAccount({ provider: "github", providerUserId: name, username: name, displayName: name });
    }
    accountIds.push(account.id);
    accounts.push(account);
  }
  const [a, b] = await Promise.all(accounts.map((account) => createAccountSession(account)));
  let set = await registerAuthenticatedAccountSet({ accountId: accountIds[0], sessionId: a.sessionId });
  setId = set.setId;
  const registration = await registerAuthenticatedAccountSet({ accountSetToken: set.token, accountId: accountIds[1], sessionId: b.sessionId });
  assert.notEqual(registration.token, set.token, "fresh authentication rotates the device credential");
  set = registration;
  const listed = await Promise.all(Array.from({ length: 8 }, () => accountList({ accountSetToken: set.token, session: b.session, sessionId: b.sessionId })));
  for (const result of listed) {
    assert.equal(result.status, 200);
    assert.equal(result.accountSetToken, undefined, "a read must not overwrite the shared browser cookie");
    assert.deepEqual(new Set(result.body.accounts.map((entry) => entry.accountId)), new Set(accountIds));
  }
  const racingSelections = await Promise.all(accountIds.map((accountId) => selectDeviceAccount({ token: set.token, accountId })));
  assert.equal(racingSelections.filter((selection) => selection.ok).length, 1, "one simultaneous selection may rotate the credential");
  set = { ...set, token: racingSelections.find((selection) => selection.ok).token };
  const switched = await accountSwitch({ accountSetToken: set.token, payload: { targetAccountId: accountIds[0] }, session: b.session, sessionId: b.sessionId });
  assert.equal(switched.status, 200);
  assert.notEqual(switched.accountSetToken, set.token);
  const staleToken = set.token;
  set = { ...set, token: switched.accountSetToken };
  assert.equal((await accountList({ accountSetToken: staleToken, session: switched.body.session, sessionId: switched.sessionId })).status, 409);
  assert.equal(await getSession(b.sessionId), null, "selected session still rotates");
  assert.equal((await accountList({ accountSetToken: set.token, session: switched.body.session, sessionId: switched.sessionId })).body.accounts.length, 2);
  const loggedOut = await accountLogoutCurrent({ accountSetToken: set.token, session: switched.body.session, sessionId: switched.sessionId });
  assert.equal(loggedOut.status, 200);
  set = { ...set, token: loggedOut.accountSetToken };
  assert.equal(loggedOut.body.selectedAccountId, accountIds[1]);
  assert.equal(await getSession(switched.sessionId), null);
  const staleRead = await accountList({ accountSetToken: set.token, session: switched.body.session, sessionId: switched.sessionId });
  assert.equal(staleRead.status, 409, "an in-flight read cannot reauthenticate a removed account");
  assert.deepEqual((await listDeviceAccounts({ token: set.token })).accounts.map((entry) => entry.accountId), [accountIds[1]]);
  assert.equal((await selectDeviceAccount({ token: set.token, accountId: accountIds[0] })).ok, false);
  await accountLogoutAll({ accountSetToken: set.token, session: loggedOut.body.session, sessionId: loggedOut.sessionId });
  assert.equal(await getSession(loggedOut.sessionId), null);
  assert.equal((await listDeviceAccounts({ token: set.token })).ok, false);
  assert.equal((await accountList({ accountSetToken: "invalid", session: a.session, sessionId: a.sessionId })).status, 409);
  console.log(JSON.stringify({ ok: true, adapter: databaseEnabled() ? "postgres" : "runtime", checks: ["concurrent lists preserve profiles", "fresh authentication rotates device token", "switch rotates session", "logout current selects retained account", "stale reads cannot restore grants", "logout all revokes sessions"] }));
} finally {
  if (databaseEnabled()) {
    await query("DELETE FROM auth_sessions WHERE account_id=ANY($1)", [accountIds]);
    if (setId) await query("DELETE FROM device_account_sets WHERE set_id=$1", [setId]);
    await query("DELETE FROM app_accounts WHERE account_id=ANY($1)", [accountIds]);
    await closePool();
  }
  await rm(temporary, { recursive: true, force: true });
}
