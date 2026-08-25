#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) throw new Error("terminal_auth_smoke_database_url_required");
const tempDir = mkdtempSync(join(tmpdir(), "tasknode-terminal-auth-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const runtime = await import("../server/runtime-store.js");
const account = runtime.getOrCreateProviderAccount({
  provider: "github",
  providerUserId: `terminal-smoke-${suffix}`,
  username: `terminal-smoke-${suffix}`,
});
const legacySessionRequest = runtime.createTerminalAuthRequest({ provider: "github", origin: "https://tasknode.example" });
assert.equal(runtime.completeTerminalAuthRequest({ requestId: legacySessionRequest.requestId, accountId: account.id, provider: "github" }).ok, true);
const legacySession = runtime.consumeTerminalAuthRequestSession({ requestId: legacySessionRequest.requestId, pollToken: legacySessionRequest.pollToken });
assert.equal(legacySession.ok, true);
assert.equal(legacySession.session.expiresAt, null);
const pendingRequest = runtime.createTerminalAuthRequest({ provider: "github", origin: "https://tasknode.example" });

delete process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { closePool, query } = await import("../server/db/pool.js");
const { migrateLegacyAccounts } = await import("../server/repositories/accounts.js");
const {
  completeTerminalAuthRequest,
  consumeTerminalAuthRequestSession,
  createTerminalAuthRequest,
  getTerminalAuthRequest,
  getTerminalSessionByToken,
  migrateLegacyTerminalAuth,
  revokeTerminalSessionByToken,
  terminalAuthStorageStatus,
} = await import("../server/repositories/terminal-auth.js");

const hashes = (value) => createHash("sha256").update(value).digest("hex");
const cleanupHashes = [];
try {
  assert.equal(terminalAuthStorageStatus().adapter, "postgres");
  await query("DELETE FROM runtime_state_migrations WHERE name = 'app_accounts_to_postgres_v1'");
  await query("DELETE FROM runtime_state_migrations WHERE name = 'terminal_auth_to_postgres_v1'");
  await migrateLegacyAccounts();
  const migrated = await migrateLegacyTerminalAuth();
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.requests, 1);
  assert.equal(migrated.sessions, 1);
  assert.equal((await getTerminalSessionByToken(legacySession.terminalToken)).accountId, account.id);
  assert.equal((await getTerminalAuthRequest({ requestId: pendingRequest.requestId })).status, "pending");
  assert.deepEqual(runtime.legacyTerminalAuthSnapshotForMigration(), { requests: {}, sessions: {} });
  assert.equal((await migrateLegacyTerminalAuth()).migrated, false);

  const stored = await query(
    "SELECT request_hash, poll_token_hash, request_json::text AS payload FROM terminal_auth_requests WHERE request_hash = $1",
    [hashes(pendingRequest.requestId)]
  );
  assert.equal(stored.rows[0].request_hash, hashes(pendingRequest.requestId));
  assert.equal(stored.rows[0].poll_token_hash, hashes(pendingRequest.pollToken));
  assert.equal(stored.rows[0].payload.includes(pendingRequest.requestId), false);
  assert.equal(stored.rows[0].payload.includes(pendingRequest.pollToken), false);

  assert.equal((await completeTerminalAuthRequest({ requestId: pendingRequest.requestId, accountId: account.id, provider: "github" })).ok, true);
  assert.equal((await consumeTerminalAuthRequestSession({ requestId: pendingRequest.requestId, pollToken: "wrong" })).status, 401);
  const issued = await consumeTerminalAuthRequestSession({ requestId: pendingRequest.requestId, pollToken: pendingRequest.pollToken });
  assert.equal(issued.ok, true);
  assert.equal(issued.session.expiresAt, null);
  cleanupHashes.push(hashes(issued.terminalToken));
  const storedSession = await query(
    "SELECT expires_at FROM terminal_sessions WHERE token_hash = $1",
    [hashes(issued.terminalToken)]
  );
  assert.equal(storedSession.rows[0].expires_at, null);
  assert.equal((await consumeTerminalAuthRequestSession({ requestId: pendingRequest.requestId, pollToken: pendingRequest.pollToken })).status, 404);
  assert.equal((await getTerminalSessionByToken(issued.terminalToken)).accountId, account.id);
  assert.equal(await revokeTerminalSessionByToken(issued.terminalToken), true);
  assert.equal(await getTerminalSessionByToken(issued.terminalToken), null);

  const direct = await createTerminalAuthRequest({ provider: "github", origin: "https://tasknode.example" });
  cleanupHashes.push(hashes(direct.requestId));
  assert.equal((await getTerminalAuthRequest({ requestId: direct.requestId })).status, "pending");
  console.log("terminal auth repository smoke ok: persistent sessions, hashed secrets, lossless import, one-time exchange, durable revoke");
} finally {
  await query("DELETE FROM terminal_auth_requests WHERE account_id = $1 OR request_hash = ANY($2::text[])", [account.id, [hashes(pendingRequest.requestId), ...cleanupHashes]]).catch(() => {});
  await query("DELETE FROM terminal_sessions WHERE account_id = $1", [account.id]).catch(() => {});
  await query("DELETE FROM app_accounts WHERE account_id = $1", [account.id]).catch(() => {});
  await query("DELETE FROM runtime_state_migrations WHERE name = 'app_accounts_to_postgres_v1'").catch(() => {});
  await query("DELETE FROM runtime_state_migrations WHERE name = 'terminal_auth_to_postgres_v1'").catch(() => {});
  await closePool();
  rmSync(tempDir, { recursive: true, force: true });
}
