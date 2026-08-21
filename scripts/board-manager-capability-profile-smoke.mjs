import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  buildBoardManagerCapabilityInstrumentation,
} = await import("../server/repositories/board-manager.js");
const {
  capabilityScopeDigest,
  normalizeCapabilityProfileInput,
} = await import("../server/repositories/capability-profiles.js");

const projectId = "task_node_core_product";
const accountId = "acct_capability_smoke";
const walletAddress = "rCapabilitySmoke";
const privateRepoScope = "github:private/postfiatorg/tasknode";
const scopeDigest = capabilityScopeDigest(privateRepoScope);

const projectRegistry = [
  {
    id: projectId,
    title: "Task Node Core Product",
    metadata: {
      required_capabilities: [
        {
          capability_type: "repo_pr_access",
          scope: privateRepoScope,
          scope_label: "Task Node private repo PR access",
          visibility: "private",
        },
      ],
    },
  },
];

const candidateWithSelfReportedCapability = [
  {
    accountId,
    walletAddress,
    profileId: "netprofile_capability_smoke",
    profileOutput: {
      verified_capabilities: [
        {
          capability_type: "repo_pr_access",
          scope: privateRepoScope,
          scope_label: "Task Node private repo PR access",
          status: "verified",
        },
      ],
    },
  },
];

const withoutDurableProfile = buildBoardManagerCapabilityInstrumentation({
  projectRegistry,
  networkTaskCandidates: candidateWithSelfReportedCapability,
});
assert.equal(withoutDurableProfile.enforcement, "none_context_only");
assert.equal(withoutDurableProfile.summary.verified_capability_count, 0);
assert.equal(withoutDurableProfile.summary.gap_count, 1);
assert.equal(withoutDurableProfile.candidate_capabilities[0].verified_capabilities.length, 0);
assert.equal(withoutDurableProfile.candidate_capabilities[0].declared_capabilities.length, 1);
assert.equal(
  JSON.stringify(withoutDurableProfile).includes(privateRepoScope),
  false,
  "capability instrumentation must not expose raw private repo scope"
);

const durableProfile = {
  account_id: accountId,
  project_id: projectId,
  capability_type: "repo_pr_access",
  scope_label: "Task Node private repo PR access",
  scope_digest: scopeDigest,
  status: "verified",
  effective_status: "verified",
  evidence_task_id: "task_capability_proof",
  verified_by: "operator",
  verified_at: "2026-06-17T00:00:00.000Z",
};
const withDurableProfile = buildBoardManagerCapabilityInstrumentation({
  projectRegistry,
  networkTaskCandidates: candidateWithSelfReportedCapability,
  capabilityProfiles: [durableProfile],
});
assert.equal(withDurableProfile.summary.verified_capability_count, 1);
assert.equal(withDurableProfile.summary.gap_count, 0);
assert.equal(withDurableProfile.candidate_capabilities[0].verified_capabilities[0].source, "board_manager_capability_profile");

const unscopedCapability = buildBoardManagerCapabilityInstrumentation({
  projectRegistry,
  networkTaskCandidates: candidateWithSelfReportedCapability,
  capabilityProfiles: [
    {
      ...durableProfile,
      scope_digest: "",
    },
  ],
});
assert.equal(unscopedCapability.summary.verified_capability_count, 1);
assert.equal(unscopedCapability.summary.gap_count, 1, "scoped requirements require an exact verified scope digest");

for (const status of ["expired", "revoked"]) {
  const blocked = buildBoardManagerCapabilityInstrumentation({
    projectRegistry,
    networkTaskCandidates: candidateWithSelfReportedCapability,
    capabilityProfiles: [
      {
        ...durableProfile,
        status,
        effective_status: status,
      },
    ],
  });
  assert.equal(blocked.summary.verified_capability_count, 0);
  assert.equal(blocked.summary.gap_count, 1);
}

const normalizedInput = normalizeCapabilityProfileInput({
  accountId,
  projectId,
  capabilityType: "Repo PR Access",
  scope: privateRepoScope,
  scopeLabel: "Task Node private repo PR access",
  evidenceTaskId: "task_capability_proof",
  verifiedBy: "operator",
});
assert.equal(normalizedInput.capabilityType, "repo_pr_access");
assert.equal(normalizedInput.scopeDigest, scopeDigest);
assert.equal(normalizedInput.accountId, accountId);

console.log("board-manager-capability-profile-smoke ok");
