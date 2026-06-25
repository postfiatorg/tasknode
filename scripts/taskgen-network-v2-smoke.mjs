import assert from "node:assert/strict";

process.env.TASKNODE_NETWORK_TASK_GENERATION_V2_ENABLED = "true";
process.env.TASKNODE_TASKGEN_PROVIDER_MOCK = "true";

const {
  generateTaskWithProvider,
  taskgenModelForInput,
  taskgenPromptForInput,
  taskgenProviderForInput,
  taskgenReplayIdentity,
} = await import("../server/task-generation-worker.js");

const taskInput = {
  schema: "pf.taskgen.input.v1",
  request_bundle: {
    bundle_id: "bundle_taskgen_v2_smoke",
    cid: "QmTaskgenV2SmokeBundle",
    digest: "sha256:bundle-v2-smoke",
  },
  request: {
    request_id: "req_taskgen_v2_smoke",
    requestedTaskKind: "network",
    source: "network_task",
  },
  context: {},
  chat: {},
  memory: {},
  task_queue: {},
  network_task: {
    schema: "pf.hive.network_task_request.v1",
    generation_job_id: "nettaskjob_v2_smoke",
    allocation_id: "netalloc_v2_smoke",
    project_id: "task_node_core_product",
    project_title: "Task Node Core Product",
    task_class: "network",
    source_payload_digest: "sha256:source-v2-smoke",
    task_work_type: "code_task",
    required_badge_id: "core_contributor",
    operating_badge_id: "core_contributor",
    badge_work_type: "code_task",
    badge_reward_cap_pft: 30000,
    reward_band_pft: { min: 100, max: 30000 },
    project_need_summary: "Patch the task page refresh state so users see current task status after an action.",
    routing_reason: "Idle Core Contributor with sanctioned repository access.",
    action_output: "PR-ready patch with test output",
    delivery_surface: "github_pull_request",
    recipient_or_reviewer: "@goodalexander",
    hive_reports: {
      schema: "pf.hive.task_generation_reports.v1",
      report_ids: ["hiverep_development_smoke", "hiverep_operative_smoke"],
      reports: [
        {
          type: "development",
          id: "hiverep_development_smoke",
          body_markdown_excerpt: "# Development\n\nTask page status freshness is the current blocker.",
        },
      ],
    },
  },
  task_lineage: {
    deduped_against: [{ task_id: "task_old", theme: "old stale status report", reason_not_repeated: "v2 asks for a patch." }],
  },
  wallet: { wallet_address: "rTaskgenV2Smoke" },
  policy: {
    task_class: "network",
    reward_policy_version: "network-reward-policy-v1",
    task_policy_version: "task-policy-network-v1",
    generation_policy_version: "taskgen-policy-network-v2",
    badge_policy_version: "network-badges-v1",
    reward_offer_min_pft: 100,
    reward_offer_max_pft: 30000,
    required_badge_id: "core_contributor",
    operating_badge_id: "core_contributor",
    badge_reward_cap_pft: 30000,
  },
};

assert.equal(taskgenPromptForInput(taskInput).version, "taskgen_network_v2");
assert.equal(taskgenProviderForInput(taskInput), "mock");
assert.equal(taskgenModelForInput(taskInput), "deepseek/deepseek-v4-pro");

const identity = taskgenReplayIdentity({
  taskInput,
  request: {
    requestId: "req_taskgen_v2_smoke",
    requestBundleCid: "QmTaskgenV2SmokeBundle",
    requestedTaskKind: "network",
  },
  requestBundle: { bundle_id: "bundle_taskgen_v2_smoke" },
  requestBundleCid: "QmTaskgenV2SmokeBundle",
  requestBundleDigest: "sha256:bundle-v2-smoke",
});
assert.equal(identity.prompt_version, "taskgen_network_v2");
assert.equal(identity.model, "deepseek/deepseek-v4-pro");

const generated = await generateTaskWithProvider(taskInput);
assert.equal(generated.output.schema, "pf.taskgen.output.v1");
assert.equal(generated.output.task_kind, "network");
assert.match(generated.output.submission_requirement.criteria, /Discord announcement proof/i);
assert.equal(generated.metadata.provider, "mock");
assert.equal(generated.metadata.prompt_version, "taskgen_network_v2");
assert.equal(generated.metadata.network_taskgen_v2_gate.requiredBadge, "core_contributor");
assert.deepEqual(generated.metadata.network_taskgen_v2_gate.reportIds, [
  "hiverep_development_smoke",
  "hiverep_operative_smoke",
]);

await assert.rejects(
  () => generateTaskWithProvider({
    ...taskInput,
    network_task: {
      ...taskInput.network_task,
      required_badge_id: "",
      operating_badge_id: "",
    },
    policy: {
      ...taskInput.policy,
      required_badge_id: "",
      operating_badge_id: "",
    },
  }),
  /network_taskgen_v2_required_badge_missing/
);

await assert.rejects(
  () => generateTaskWithProvider({
    ...taskInput,
    policy: {
      ...taskInput.policy,
      reward_offer_max_pft: 50000,
    },
  }),
  /network_taskgen_v2_reward_cap_violation/
);

console.log("taskgen-network-v2-smoke ok");
