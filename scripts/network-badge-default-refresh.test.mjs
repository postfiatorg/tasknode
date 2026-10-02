import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const fixtureUrl = process.env.TASKNODE_BADGE_TEST_DATABASE_URL;
test("default badge survives refresh in PostgreSQL", {
  skip: !fixtureUrl && "Set TASKNODE_BADGE_TEST_DATABASE_URL to a local tasknode_badge_test_* database",
}, async (t) => {
  const url = new URL(fixtureUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.ok(url.pathname.startsWith("/tasknode_badge_test_"));
  const schema = "badge_fixture_" + randomUUID().split("-").join("");
  const directory = await mkdtemp(path.join(tmpdir(), "badge-default-"));
  const admin = new pg.Client({ connectionString: fixtureUrl });
  await admin.connect();
  await admin.query('CREATE SCHEMA "' + schema + '"');
  url.searchParams.set("options", "-c search_path=" + schema);
  process.env.DATABASE_URL = url.toString();
  process.env.TASKNODE_DATABASE_ENABLED = "true";
  process.env.TASKNODE_DATABASE_DISABLED = "false";
  process.env.TASKNODE_POSTGRES_DISABLED = "false";
  process.env.TASKNODE_STORE_PATH = path.join(directory, "store.json");
  process.env.TASKNODE_CORE_CONTRIBUTOR_GITHUB_HANDLES = "badgefixture";
  const { query, closePool, getPool } = await import("../server/db/pool.js");
  t.after(async () => {
    await closePool();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network access is forbidden in badge fixtures"); });
  for (const file of ["072_network_badges_identity_approvals.sql", "073_network_badge_verifier_jobs.sql"]) {
    await query(await readFile(new URL("../server/db/migrations/" + file, import.meta.url), "utf8"));
  }
  await query("CREATE TABLE app_accounts (account_id text PRIMARY KEY, account_json jsonb NOT NULL)");
  await query("CREATE TABLE task_projections (account_id text, task_kind text, status text)");
  const {
    approveNetworkBadge, refreshIdentityApprovalsFromProjection,
    setDefaultNetworkBadge, revokeNetworkBadge, approvalRecordsFromNetworkBadgeProjection,
  } = await import("../server/repositories/identity-approvals.js");
  const { networkBadgeProjectionForAccount } = await import("../server/repositories/network-badges.js");
  const { approveNetworkBadgeFromVerifierJob } = await import("../server/repositories/network-badge-verifier-jobs.js");

  async function account({ x = true, github = true } = {}) {
    const id = "acct_" + randomUUID();
    const data = { id, linkedProviders: [
      ...(x ? [{ id: "x", kind: "oauth", username: "badgefixture", metadata: { publicMetrics: { followersCount: 12000 } } }] : []),
      ...(github ? [{ id: "github", kind: "oauth", username: "badgefixture" }] : []),
    ] };
    await query("INSERT INTO app_accounts VALUES ($1,$2::jsonb)", [id, JSON.stringify(data)]);
    return data;
  }
  const approve = (id, badgeId, selectedDefault = false) => approveNetworkBadge({
    accountId: id, badgeId, selectedDefault, publicHandle: "badgefixture",
    approvedByOperator: "badge_default_regression",
  });
  const refresh = (id) => refreshIdentityApprovalsFromProjection({ accountId: id });
  async function defaults(id) {
    return (await query("SELECT badge_id FROM account_network_badges WHERE account_id=$1 AND selected_default ORDER BY badge_id", [id])).rows.map((row) => row.badge_id);
  }
  async function expectDefault(id, badgeId) {
    assert.deepEqual(await defaults(id), badgeId ? [badgeId] : []);
    const projection = await networkBadgeProjectionForAccount({ accountId: id });
    assert.equal(projection.defaultBadge, badgeId);
  }

  await t.test("selected non-first badge remains selected through repeated profile refresh", async () => {
    const a = await account();
    await approve(a.id, "kol");
    await approve(a.id, "core_contributor", true);
    for (let i = 0; i < 3; i++) {
      const result = await refresh(a.id);
      await expectDefault(a.id, "core_contributor");
      assert.deepEqual(result.materialized.accountBadges.filter((b) => b.selectedDefault).map((b) => b.badgeId), ["core_contributor"]);
    }
    const rows = (await query("SELECT evidence_json->>'source' AS source FROM account_network_badges WHERE account_id=$1", [a.id])).rows;
    assert.ok(rows.every((row) => row.source === "runtime_projection_refresh"), "the refresh really updated evidence");
  });
  await t.test("newly earned earlier badge does not become a second default", async () => {
    const a = await account({ x: false });
    await refresh(a.id);
    await expectDefault(a.id, "core_contributor");
    a.linkedProviders.unshift({ id: "x", kind: "oauth", username: "badgefixture", metadata: { publicMetrics: { followersCount: 12000 } } });
    await query("UPDATE app_accounts SET account_json=$2::jsonb WHERE account_id=$1", [a.id, JSON.stringify(a)]);
    await refresh(a.id);
    await expectDefault(a.id, "core_contributor");
  });
  await t.test("durable manual default outside the runtime projection is retained", async () => {
    const a = await account();
    await approve(a.id, "expert", true);
    const result = await refresh(a.id);
    await expectDefault(a.id, "expert");
    assert.equal(result.materialized.accountBadges.some((b) => b.selectedDefault), false);
  });
  await t.test("first refresh still selects an eligible default", async () => {
    const a = await account();
    await refresh(a.id);
    await expectDefault(a.id, "kol");
  });
  await t.test("a runtime default that loses eligibility is revoked and replaced", async () => {
    const a = await account();
    await refresh(a.id);
    await setDefaultNetworkBadge({ accountId: a.id, badgeId: "core_contributor" });
    a.linkedProviders = a.linkedProviders.filter((p) => p.id !== "github");
    await query("UPDATE app_accounts SET account_json=$2::jsonb WHERE account_id=$1", [a.id, JSON.stringify(a)]);
    await refresh(a.id);
    await expectDefault(a.id, "kol");
    const row = (await query("SELECT status,selected_default FROM account_network_badges WHERE account_id=$1 AND badge_id='core_contributor'", [a.id])).rows[0];
    assert.deepEqual(row, { status: "revoked", selected_default: false });
  });
  await t.test("selected KOL losing its handle falls back to a materialized badge", async () => {
    const a = await account();
    await refresh(a.id);
    await expectDefault(a.id, "kol");
    a.linkedProviders.find((provider) => provider.id === "x").username = "";
    await query("UPDATE app_accounts SET account_json=$2::jsonb WHERE account_id=$1", [a.id, JSON.stringify(a)]);
    const result = await refresh(a.id);
    assert.ok(result.projection.verifiedBadgeIds.includes("kol"), "metrics still project KOL");
    assert.ok(!result.materialized.badgeIds.includes("kol"), "missing handle prevents materialization");
    await expectDefault(a.id, "core_contributor");
    const row = (await query("SELECT status,selected_default FROM account_network_badges WHERE account_id=$1 AND badge_id='kol'", [a.id])).rows[0];
    assert.deepEqual(row, { status: "revoked", selected_default: false });
  });
  await t.test("expired manual choice is not preserved as an active default", async () => {
    const a = await account();
    await approve(a.id, "expert", true);
    await query("UPDATE account_network_badges SET expires_at=now()-interval '1 day' WHERE account_id=$1 AND badge_id='expert'", [a.id]);
    await refresh(a.id);
    assert.deepEqual((await query("SELECT badge_id FROM account_network_badges WHERE account_id=$1 AND selected_default AND (expires_at IS NULL OR expires_at>now())", [a.id])).rows, [{ badge_id: "kol" }]);
  });
  await t.test("explicit user and admin choices continue to replace the prior default", async () => {
    const a = await account();
    await refresh(a.id);
    await setDefaultNetworkBadge({ accountId: a.id, badgeId: "core_contributor" });
    await refresh(a.id);
    await expectDefault(a.id, "core_contributor");
    await approve(a.id, "kol", true);
    await refresh(a.id);
    await expectDefault(a.id, "kol");
    await assert.rejects(setDefaultNetworkBadge({ accountId: a.id, badgeId: "expert" }), { status: 404 });
    await expectDefault(a.id, "kol");
    await revokeNetworkBadge({ accountId: a.id, badgeId: "kol" });
    assert.deepEqual(await defaults(a.id), []);
  });

  await t.test("concurrent refreshes preserve an explicit choice with exactly one default", async () => {
    const a = await account();
    await refresh(a.id);
    await Promise.all([
      refresh(a.id),
      setDefaultNetworkBadge({ accountId: a.id, badgeId: "core_contributor" }),
      refresh(a.id),
    ]);
    await expectDefault(a.id, "core_contributor");
  });
  await t.test("explicit choice waits for a refresh paused after its default read", async () => {
    const a = await account();
    await refresh(a.id);
    await expectDefault(a.id, "kol");
    const pool = getPool();
    const originalConnect = pool.connect;
    let interceptRefresh = true;
    let selectionPid;
    let reachedRead;
    let releaseRead;
    const readReached = new Promise((resolve) => { reachedRead = resolve; });
    const readRelease = new Promise((resolve) => { releaseRead = resolve; });
    const operations = [];
    const track = (operation) => {
      operations.push(operation);
      operation.catch(() => {}); // Cleanup observes every rejection through allSettled.
      return operation;
    };
    pool.connect = async (...args) => {
      if (typeof args[0] === "function") return originalConnect.apply(pool, args);
      const client = await originalConnect.apply(pool, args);
      if (!interceptRefresh) {
        selectionPid = client.processID;
        return client;
      }
      interceptRefresh = false;
      const originalQuery = client.query;
      const originalRelease = client.release;
      client.query = async (...queryArgs) => {
        const result = await originalQuery.apply(client, queryArgs);
        if (/SELECT\s+badge\.badge_id\s+FROM account_network_badges/.test(String(queryArgs[0]))) {
          reachedRead();
          await readRelease;
        }
        return result;
      };
      client.release = (...releaseArgs) => {
        client.query = originalQuery;
        client.release = originalRelease;
        return originalRelease.apply(client, releaseArgs);
      };
      return client;
    };
    let readTimer;
    let outcomes;
    try {
      const refreshing = track(refresh(a.id));
      await Promise.race([
        readReached,
        refreshing.then(() => { throw new Error("refresh finished without pausing at its default read"); }),
        new Promise((_, reject) => { readTimer = setTimeout(() => reject(new Error("default read not reached")), 3000); }),
      ]);
      clearTimeout(readTimer);
      let selectionFinished = false;
      const choosing = track(setDefaultNetworkBadge({ accountId: a.id, badgeId: "core_contributor" }));
      choosing.then(() => { selectionFinished = true; }, () => { selectionFinished = true; });
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (!selectionFinished && !blocked && Date.now() < deadline) {
        const result = await admin.query({
          text: "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'",
          values: [selectionPid || 0],
          query_timeout: 3000,
        });
        blocked = result.rowCount > 0;
        if (!blocked && !selectionFinished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(selectionFinished, false, "explicit choice must not finish while refresh owns the lock");
      assert.equal(blocked, true, "explicit choice must demonstrably wait on the account advisory lock");
    } finally {
      clearTimeout(readTimer);
      releaseRead();
      pool.connect = originalConnect;
      outcomes = await Promise.allSettled(operations);
    }
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    await expectDefault(a.id, "core_contributor");
  });
  await t.test("concurrent initial refreshes choose only one default", async () => {
    const a = await account();
    await Promise.all([refresh(a.id), refresh(a.id), refresh(a.id)]);
    await expectDefault(a.id, "kol");
  });
  await t.test("losing every runtime badge removes the default", async () => {
    const a = await account();
    await refresh(a.id);
    a.linkedProviders = [];
    await query("UPDATE app_accounts SET account_json=$2::jsonb WHERE account_id=$1", [a.id, JSON.stringify(a)]);
    await refresh(a.id);
    await expectDefault(a.id, "");
  });
  await t.test("a skipped invalid badge cannot prevent selecting the first valid badge", () => {
    const result = approvalRecordsFromNetworkBadgeProjection({
      projection: { accountId: "acct_fixture", verifiedBadges: [
        { badgeId: "kol", evidence: { followersCount: 12000 } },
        { badgeId: "core_contributor", evidence: { handle: "badgefixture" } },
      ] },
    });
    assert.deepEqual(result.accountBadges.filter((b) => b.selectedDefault).map((b) => b.badgeId), ["core_contributor"]);
  });

  const verifierCases = [
    ["kol", "x_user_metrics", { username: "badgefixture", metrics: { followersCount: 12000 }, qualifications: { kolXFull: true } }],
    ["core_contributor", "github_collaborator_permission", { username: "badgefixture", writeAccess: true }],
    ["qa_worker", "qa_worker_access", { qualifications: { qaWorker: true } }],
    ["expert", "expert_access", { qualifications: { expert: true }, recommendedExpertLabel: "Fixture expert" }],
  ];
  for (const [badgeId, verifierType, resolverResult] of verifierCases) {
    await t.test("verifier reapproval preserves selected default: " + badgeId, async () => {
      const a = await account();
      await approve(a.id, badgeId, true);
      const id = "nbvj_" + randomUUID();
      await query("INSERT INTO network_badge_verifier_jobs (id,idempotency_key,account_id,badge_id,verifier_type,status,result_json) VALUES ($1,$1,$2,$3,$4,'succeeded',$5::jsonb)", [id, a.id, badgeId, verifierType, JSON.stringify({ resolverResult })]);
      await approveNetworkBadgeFromVerifierJob({ jobId: id, selectedDefault: false });
      assert.deepEqual(await defaults(a.id), [badgeId]);
    });
  }
});
