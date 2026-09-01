#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("auth_session_smoke_database_url_required");
process.env.TASKNODE_DATABASE_ENABLED = "true";

const { closePool, query } = await import("../server/db/pool.js");
const {
  authSessionStorageStatus,
  createAccountSession,
  destroySession,
  getSession,
} = await import("../server/repositories/auth-sessions.js");

const accountId = `acct_session_smoke_${Date.now()}`;
let sessionId = "";
try {
  const created = await createAccountSession({
    id: accountId,
    displayName: "Session Smoke",
    profileVisibility: "private",
    linkedProviders: [{ id: "email", kind: "email", label: "Email" }],
  }, { provider: "email", assurance: "medium" });
  sessionId = created.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.session.accountId, accountId);
  assert.equal("id" in created.session, false, "the bearer token must not be returned in the public session payload");
  assert.equal(authSessionStorageStatus().adapter, "postgres");

  const expectedHash = createHash("sha256").update(sessionId).digest("hex");
  const stored = await query(
    "SELECT token_hash, session_json::text AS session_text FROM auth_sessions WHERE account_id = $1",
    [accountId]
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].token_hash, expectedHash);
  assert.equal(stored.rows[0].session_text.includes(sessionId), false, "the bearer token must not be stored in the display payload");
  assert.notEqual(stored.rows[0].token_hash, sessionId);

  const resumed = await getSession(sessionId);
  assert.equal(resumed.accountId, accountId);
  assert.equal(resumed.primaryProvider, "email");
  assert.equal(resumed.assurance, "medium");

  assert.equal(await destroySession(sessionId), true);
  assert.equal(await getSession(sessionId), null);
  assert.equal(await destroySession(sessionId), false);
  console.log("auth session repository smoke ok: hashed token, durable resume, idempotent revoke");
} finally {
  await query("DELETE FROM auth_sessions WHERE account_id = $1", [accountId]).catch(() => {});
  await closePool();
}
