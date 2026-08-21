import assert from "node:assert/strict";

import { handleNetworkBadgeAdminRoute } from "../server/network-badge-admin-routes.js";
import { routePolicyForPath } from "../server/route-policies.js";

async function invoke({
  method = "POST",
  token = "",
  body = {},
  envToken = "",
  fetchImpl = fetch,
} = {}) {
  const original = process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN;
  if (envToken === undefined) delete process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN;
  else process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN = envToken;
  const captured = {};
  const handled = await handleNetworkBadgeAdminRoute({
    json: (_res, status, payload, headers = {}) => {
      captured.status = status;
      captured.payload = payload;
      captured.headers = headers;
    },
    readJson: async () => body,
    req: {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
    res: {},
    url: new URL("https://tasknode.test/api/profile/network-badges/admin"),
    fetchImpl,
  });
  if (original === undefined) delete process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN;
  else process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN = original;
  return { handled, ...captured };
}

const policy = routePolicyForPath("/api/profile/network-badges/admin");
assert.equal(policy.auth, "admin_bearer");
assert.deepEqual(policy.methods, ["POST"]);

let result = await invoke({ envToken: "" });
assert.equal(result.handled, true);
assert.equal(result.status, 409);
assert.equal(result.payload.error, "network_badge_admin_not_configured");

result = await invoke({ envToken: "secret", token: "wrong" });
assert.equal(result.status, 401);
assert.equal(result.payload.error, "network_badge_admin_unauthorized");

result = await invoke({ envToken: "secret", token: "secret", method: "GET" });
assert.equal(result.status, 405);
assert.equal(result.headers.allow, "POST");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "approve",
    accountId: "acct_demo",
    badgeId: "project_leader",
    publicHandle: "goodalexander",
    approvalScope: "badge:project_leader",
    operator: "nazgul",
    reason: "smoke dry run",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.action, "approve");
assert.equal(result.payload.plannedRecords.accountBadge.badgeId, "project_leader");
assert.equal(result.payload.plannedRecords.identityApproval.approvalScope, "badge:project_leader");
assert.equal(result.payload.plannedRecords.identityApproval.approvedByOperator, "nazgul");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "approve",
    accountId: "acct_project_leader",
    badgeId: "project_leader",
    publicHandle: "project-goodalexander",
    approvalScope: "badge:project_leader:project:open_source_support",
    operator: "goodalexander",
    reason: "scoped project leader smoke dry run",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.plannedRecords.accountBadge.badgeId, "project_leader");
assert.equal(result.payload.plannedRecords.identityApproval.approvalScope, "badge:project_leader:project:open_source_support");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "revoke",
    accountId: "acct_demo",
    badgeId: "kol",
    reason: "smoke dry run",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.action, "revoke");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "set_project_requirement",
    projectId: "task_node_core_product",
    workType: "code_task",
    badgeId: "core_contributor",
    capabilityType: "repo_pr_access",
    scopeLabel: "postfiatorg/tasknode",
    scopeDigest: "scope_demo",
    maxPayoutOverridePft: 30000,
    operator: "nazgul",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.plannedRequirement.projectId, "task_node_core_product");
assert.equal(result.payload.plannedRequirement.workType, "code_task");
assert.equal(result.payload.plannedRequirement.requiredBadgeId, "core_contributor");
assert.equal(result.payload.plannedRequirement.capabilityType, "repo_pr_access");
assert.equal(result.payload.plannedRequirement.maxPayoutOverridePft, 30000);

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "disable_project_requirement",
    requirementId: result.payload.plannedRequirement.id,
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.requirementId.startsWith("npbr_"), true);

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "enqueue_verifier_job",
    accountId: "acct_demo",
    verifierType: "resolve_x",
    username: "goodalexander",
    providerToken: "must-not-persist",
    operator: "nazgul",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.plannedJob.badgeId, "kol");
assert.equal(result.payload.plannedJob.verifierType, "x_user_metrics");
assert.equal(result.payload.plannedJob.inputJson.username, "goodalexander");
assert.equal("providerToken" in result.payload.plannedJob.inputJson, false);

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "run_verifier_job",
    jobId: "nbvj_demo",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.action, "run_verifier_job");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "approve_from_verifier_job",
    jobId: "nbvj_demo",
    operator: "nazgul",
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.dryRun, true);
assert.equal(result.payload.action, "approve_from_verifier_job");
assert.equal(result.payload.jobId, "nbvj_demo");

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "resolve_x",
    username: "goodalexander",
    providerToken: "x-token",
  },
  fetchImpl: async (url, options = {}) => {
    assert.match(String(url), /\/2\/users\/by\/username\/goodalexander/);
    assert.equal(options.headers.authorization, "Bearer x-token");
    return new Response(JSON.stringify({
      data: {
        id: "123",
        username: "goodalexander",
        public_metrics: { followers_count: 134000 },
      },
    }), { status: 200 });
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.action, "resolve_x");
assert.equal(result.payload.routingImpact, "read_only_evidence_packet_no_badge_write");
assert.equal(result.payload.result.metrics.followersCount, 134000);
assert.equal(result.payload.result.qualifications.kolXFull, true);

result = await invoke({
  envToken: "secret",
  token: "secret",
  body: {
    action: "resolve_github_collab",
    owner: "postfiatorg",
    repo: "tasknode",
    username: "goodalexander",
    providerToken: "gh-token",
  },
  fetchImpl: async (url, options = {}) => {
    assert.match(String(url), /\/repos\/postfiatorg\/tasknode\/collaborators\/goodalexander\/permission$/);
    assert.equal(options.headers.authorization, "Bearer gh-token");
    return new Response(JSON.stringify({ permission: "write" }), { status: 200 });
  },
});
assert.equal(result.status, 200);
assert.equal(result.payload.action, "resolve_github_collab");
assert.equal(result.payload.result.writeAccess, true);

console.log("network badge admin route smoke ok");
