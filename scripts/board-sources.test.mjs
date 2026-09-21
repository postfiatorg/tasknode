import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import pg from "pg";

process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";
const { readBoardSources, resolveRepoFullName, sourceDescriptorsForBoard, normalizeOperatorActions, fetchGitHubRepoSnapshot, fetchXAccountSnapshot, summarizeSources } = await import("../server/board-sources.js");
const { closePool } = await import("../server/db/pool.js");

const board = { id: "board_community_promotion", metadata_json: { sources: { repos: ["postfiatorg.github.io", "unknown-repo"], x_accounts: ["@PostFiatOrg"], websites: ["https://postfiatorg.github.io"] } } };

test("board sources resolve to canonical remotes and report unmapped repos", () => {
  assert.equal(resolveRepoFullName("postfiatl1v2"), "postfiatorg/postfiatl1v2");
  assert.equal(resolveRepoFullName("PfTerminal"), "CorbanuCore/CorbanuTerminal");
  assert.equal(resolveRepoFullName("owner/explicit"), "owner/explicit");
  assert.equal(resolveRepoFullName("custom", { TASKNODE_BOARD_SOURCE_REPO_MAP: JSON.stringify({ custom: "org/custom" }) }), "org/custom");
  const descriptors = sourceDescriptorsForBoard(board);
  assert.deepEqual(descriptors.map((item) => item.id), ["repo:postfiatorg.github.io", "repo:unknown-repo", "x:@PostFiatOrg", "web:https://postfiatorg.github.io"]);
  assert.equal(descriptors[1].unresolved, true);
  assert.equal(descriptors[2].reference, "PostFiatOrg");
});

test("sources are cached, served stale on refresh failure, and unavailable when never fetched", async () => {
  const store = new Map();
  const queryImpl = async (sql, params) => {
    if (sql.startsWith("SELECT status,payload_json")) { const row = store.get(params[0]); return { rows: row ? [row] : [] }; }
    if (sql.includes("INSERT INTO board_source_snapshots")) {
      const existing = store.get(params[0]);
      if (sql.includes("'fresh',$4::jsonb")) store.set(params[0], { status: "fresh", payload_json: JSON.parse(params[3]), error: "", fetched_at: params[4] });
      else store.set(params[0], { status: params[3], payload_json: existing?.payload_json || {}, error: params[4], fetched_at: existing?.fetched_at || null });
      return { rows: [] };
    }
    throw new Error("unexpected " + sql);
  };
  let githubCalls = 0;
  const fetchers = {
    github: async (name) => { githubCalls += 1; return { full_name: name, head_sha: "abc123", recent_commits: [{ sha: "abc123", message: "Fix" }], open_issues: [], open_pulls: [] }; },
    x: async () => { throw Object.assign(new Error("x_api_not_configured"), { status: 409 }); },
    website: async (url) => ({ url, http_status: 200, title: "Post Fiat" }),
  };
  const t0 = Date.parse("2026-09-21T03:00:00.000Z");
  const first = await readBoardSources(board, { queryImpl, fetchers, now: t0 });
  assert.deepEqual(first.map((item) => [item.id, item.status]), [["repo:postfiatorg.github.io", "fresh"], ["repo:unknown-repo", "unavailable"], ["x:@PostFiatOrg", "unavailable"], ["web:https://postfiatorg.github.io", "fresh"]]);
  assert.equal(first[0].head_sha, "abc123");
  assert.equal(first[2].error, "x_api_not_configured");
  assert.ok(first[1].error.startsWith("repo_not_mapped"));
  // Within the TTL nothing is refetched.
  await readBoardSources(board, { queryImpl, fetchers, now: t0 + 5 * 60_000 });
  assert.equal(githubCalls, 1);
  // After the TTL a failed refresh serves the old snapshot as stale with the error attached.
  const failing = { ...fetchers, github: async () => { throw Object.assign(new Error("source_http_503"), { status: 503 }); } };
  const later = await readBoardSources(board, { queryImpl, fetchers: failing, now: t0 + 31 * 60_000 });
  assert.equal(later[0].status, "stale");
  assert.equal(later[0].head_sha, "abc123");
  assert.equal(later[0].error, "source_http_503");
  assert.equal(later[0].fetched_at, new Date(t0).toISOString());
  assert.ok(summarizeSources(later)[0].includes("stale"));
});

test("the GitHub and X fetchers shape their remote responses", async () => {
  const fetchImpl = async (url) => {
    const body = url.includes("/commits") ? [{ sha: "0123456789abcdef", commit: { message: "First line\nbody", author: { name: "A", date: "2026-09-20T00:00:00Z" } } }]
      : url.includes("/issues") ? [{ number: 7, title: "Bug", labels: [{ name: "bug" }], updated_at: "x", html_url: "u", comments: 2 }, { number: 8, title: "PR-as-issue", pull_request: {} }]
      : url.includes("/pulls") ? [{ number: 9, title: "Fix", draft: false, updated_at: "x", html_url: "u", user: { login: "dev" } }]
      : url.endsWith("/readme") ? "# Readme"
      : url.includes("users/by/username") ? { data: { id: "42", public_metrics: { followers_count: 1000 } } }
      : url.includes("/tweets") ? { data: [{ id: "1", text: "Hello", created_at: "2026-09-21T00:00:00Z", public_metrics: { like_count: 3, retweet_count: 1 } }] }
      : { full_name: "postfiatorg/postfiatl1v2", html_url: "https://github.com/postfiatorg/postfiatl1v2", default_branch: "main", pushed_at: "2026-09-21T00:00:00Z", open_issues_count: 1 };
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : ""), headers: { get: () => null } };
  };
  const repo = await fetchGitHubRepoSnapshot("postfiatorg/postfiatl1v2", { fetchImpl, token: "" });
  assert.equal(repo.head_sha, "0123456789abcdef");
  assert.deepEqual(repo.recent_commits[0], { sha: "0123456789ab", date: "2026-09-20T00:00:00Z", author: "A", message: "First line" });
  assert.deepEqual(repo.open_issues.map((item) => item.number), [7], "pull requests are not listed as issues");
  assert.equal(repo.open_pulls[0].author, "dev");
  assert.equal(repo.readme_excerpt, "# Readme");
  const x = await fetchXAccountSnapshot("PostFiatOrg", { fetchImpl, bearer: "token" });
  assert.equal(x.followers, 1000);
  assert.equal(x.recent_posts[0].url, "https://x.com/PostFiatOrg/status/1");
  await assert.rejects(fetchXAccountSnapshot("PostFiatOrg", { fetchImpl, bearer: "" }), { message: "x_api_not_configured" });
});

test("operator actions are recorded once, surfaced while open, and resolved explicitly", async (t) => {
  const { operatorAction } = await import("../scripts/bm/writes.mjs");
  const { withBoardAgent } = await import("../server/board-agent-context.js");
  let metadata = { sources: {} };
  const audits = [];
  t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
    if (sql.startsWith("SELECT metadata_json FROM network_projects")) return { rows: [{ metadata_json: metadata }] };
    if (sql.startsWith("UPDATE network_projects")) { metadata = { ...metadata, operator_actions: JSON.parse(params[1]) }; return { rows: [] }; }
    if (sql.includes("INSERT INTO bm_audit_log")) { audits.push(params[3]); return { rows: [{ id: "a" }] }; }
    throw new Error("unexpected " + sql);
  });
  const boardId = "board_capital_markets";
  const run = (input) => withBoardAgent({ actor: "fixture", boards: [boardId], credentialId: "c" }, () => operatorAction({ boardId, ...input }));
  const added = await run({ add: "Merge agtico/agtico.github.io PR 1 so the AGTI feed goes live.", owner: "goodalexander" });
  assert.ok(added.action.id.startsWith("opact_"));
  assert.equal(added.open.length, 1);
  const again = await run({ add: "Merge agtico/agtico.github.io PR 1 so the AGTI feed goes live." });
  assert.equal(again.duplicate, true);
  assert.equal(normalizeOperatorActions(metadata.operator_actions).length, 1);
  await assert.rejects(run({ resolve: added.action.id }), { message: "operator_action_resolution_required" });
  const resolved = await run({ resolve: added.action.id, resolution: "Merged on 2026-09-21." });
  assert.ok(resolved.action.resolved_at);
  assert.equal(resolved.open.length, 0);
  assert.deepEqual(audits, ["operator_action", "operator_action"]);
  await assert.rejects(run({}), { message: "operator_action_requires_add_or_resolve" });
});

after(async () => { mock.restoreAll(); await closePool(); });
