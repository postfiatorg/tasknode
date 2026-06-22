import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const {
  buildBoardManagerSecretaryDecisionPacket,
  normalizeBoardManagerSecretaryPacket,
} = await import("../server/board-manager-secretary-packets.js");
const {
  buildHiveGenerationQualityPolicy,
  buildBoardManagerCapabilityInstrumentation,
  compactNetworkTaskOutputCorpusForBoardManager,
  extractOperatorStandingPolicy,
  normalizeBoardManagerDecision,
} = await import("../server/repositories/board-manager.js");
const {
  buildNetworkTaskGenerationSource,
  formatNetworkTaskGenerationSourceText,
} = await import("../server/repositories/network-tasks.js");
const {
  buildNetworkTaskRequestContext,
} = await import("../server/network-task-generation-worker.js");
const {
  projectTaskgenInput,
  taskgenPromptForInput,
} = await import("../server/task-generation-worker.js");
const {
  boardManagerResponseFormat,
} = await import("../server/board-manager-decision-provider.js");

const hiveContext = {
  groups: [
    {
      accountId: "acct_operator",
      displayName: "goodalexander",
      latestAt: "2026-06-15T02:53:00.000Z",
      entries: [
        {
          id: "hivectx_stop_docs",
          accountId: "acct_operator",
          displayName: "goodalexander",
          body: "Stop documentation-only network tasks. Use the prior documents and route the next output to Discord or a concrete PR/mock.",
          sourceConversationId: "conv_hive_operator",
          walletValidated: true,
          walletAddress: "rOperatorWallet",
          createdAt: "2026-06-15T02:53:00.000Z",
        },
      ],
    },
  ],
};

const operatorStandingPolicy = extractOperatorStandingPolicy({ hiveContext });
assert.equal(operatorStandingPolicy.length, 1);
assert.match(operatorStandingPolicy[0].directive, /Stop documentation-only network tasks/i);

const generationQualityPolicy = buildHiveGenerationQualityPolicy({
  operatorConstraintsSummary: operatorStandingPolicy[0].directive,
});
assert.equal(generationQualityPolicy.documentationOnlyDefault, "low_value_unless_action_coupled");
assert.equal(generationQualityPolicy.requiresConcreteActionOutput, true);

const corpus = compactNetworkTaskOutputCorpusForBoardManager([
  {
    project_id: "task_node_core",
    task_id: "task_doc_1",
    request_id: "req_doc_1",
    ref_title: "Document Three Task Node Workflow Friction Points",
    status: "rewarded",
    description: "The prior task documented three acceptance and evidence workflow problems.",
    subject_wallet: "rContributorWallet",
    candidate_account_id: "acct_contributor",
    candidate_wallet_address: "rContributorWallet",
    project_need_summary: "Document three workflow friction points.",
    allocation_reason_summary: "Contributor can inspect Task Node UX.",
    latest_event_type: "pf.reward.v1",
    latest_source_cid: "bafypriorworkflowdoc",
    latest_source_tx_hash: "ABC123PRIOR",
    latest_event_payload: {
      reward_score: {
        reason: "Structured friction report with three reproducible workflow points and recommended fixes.",
      },
    },
    updated_at: "2026-06-15T01:00:00.000Z",
  },
  {
    project_id: "task_node_core",
    task_id: "task_doc_2",
    request_id: "req_doc_2",
    ref_title: "Document Three Task Node Workflow Friction Points Again",
    status: "rewarded",
    description: "A second task repeated the same workflow-friction documentation shape.",
    subject_wallet: "rOtherContributorWallet",
    candidate_account_id: "acct_other",
    candidate_wallet_address: "rOtherContributorWallet",
    project_need_summary: "Document three Task Node workflow friction points.",
    allocation_reason_summary: "Contributor can inspect Task Node UX.",
    latest_event_type: "pf.task.submission.v1",
    latest_source_cid: "bafysecondworkflowdoc",
    latest_source_tx_hash: "DEF456PRIOR",
    latest_event_payload: {
      submission_summary: "Second workflow friction report covering the same task acceptance and evidence issues.",
    },
    updated_at: "2026-06-15T01:30:00.000Z",
  },
]);
assert.equal(corpus.outputs.length, 2);
assert.ok(corpus.summary.repeated_themes.length >= 1);
assert.ok(corpus.deduplicationWatchlist[0].prior_task_ids.includes("task_doc_1"));

const capabilityInstrumentation = buildBoardManagerCapabilityInstrumentation({
  projectRegistry: [
    {
      id: "task_node_core",
      title: "Task Node Core Product",
      metadata: {
        required_capabilities: [
          {
            capability_type: "repo_pr_access",
            scope: "github:private/tasknodeofficial",
            scope_label: "Task Node private repo PR access",
            visibility: "private",
          },
        ],
      },
    },
  ],
  networkTaskCandidates: [
    {
      accountId: "acct_contributor",
      walletAddress: "rContributorWallet",
      profileId: "netprofile_contributor",
      profileOutput: {
        capabilities: {
          declared: [{ capability_type: "docs_review", scope_label: "Documentation review" }],
        },
      },
    },
  ],
});
assert.equal(capabilityInstrumentation.enforcement, "none_context_only");
assert.equal(capabilityInstrumentation.summary.requirement_count, 1);
assert.equal(capabilityInstrumentation.summary.gap_count, 1);
assert.equal(capabilityInstrumentation.capability_gaps[0].recommended_task_work_type, "capability_gating_task");
assert.equal(JSON.stringify(capabilityInstrumentation).includes("github:private/tasknodeofficial"), false);

const secretaryPacket = normalizeBoardManagerSecretaryPacket({
  motion_state: "needs_attention",
  requires_attention: true,
  do_nothing_allowed: false,
  board_summary: "Task Node has eligible candidates and repeated documentation outputs.",
  reason_summary: "The stop-docs operator directive is active and the next task should act on prior outputs.",
  staleness_summary: "Prior documentation exists.",
  action_pressure_summary: "One eligible candidate exists.",
  recommended_context_request: { packet_type: "project_focus", target_type: "network_project", target_id: "task_node_core", reason: "Escalate documented issue." },
  network_task_summary: "Two prior rewarded documentation tasks exist for the same workflow theme.",
  candidate_summary: "One eligible contributor can act.",
  recent_run_summary: "No current run has delivered the action.",
  operator_standing_policy: operatorStandingPolicy,
  generation_quality_policy: generationQualityPolicy,
  prior_output_corpus_summary: corpus.summary,
  deduplication_watchlist: corpus.deduplicationWatchlist,
  capability_gap_summary: capabilityInstrumentation,
  facts_to_preserve: ["hivectx_stop_docs", "task_doc_1", "task_doc_2"],
});
assert.equal(secretaryPacket.operator_standing_policy[0].source_id, "hivectx_stop_docs");
assert.equal(secretaryPacket.generation_quality_policy.escalation_ladder, "document_to_action_v1");
assert.ok(secretaryPacket.deduplication_watchlist.length >= 1);
assert.equal(secretaryPacket.capability_gap_summary.gaps[0].recommended_task_work_type, "capability_gating_task");
assert.doesNotMatch(
  `${secretaryPacket.reason_summary} ${secretaryPacket.facts_to_preserve.join(" ")}`,
  /no explicit current constraints/i
);

const compressedDecisionSource = buildBoardManagerSecretaryDecisionPacket({
  sourcePacket: {
    schema: "pf.hive.board_manager.source.v0",
    scope: "global_hive",
    trigger: "hive_generation_intelligence_smoke",
    sourcePacketDigest: "source_digest_hive_generation_intelligence",
    boardActionPressure: { summary: { requiresAction: true, eligibleCandidateCount: 1 } },
    hiveContext,
    operatorStandingPolicy,
    generationQualityPolicy,
    networkTaskOutputCorpus: corpus,
    priorOutputCorpusSummary: corpus.summary,
    deduplicationWatchlist: corpus.deduplicationWatchlist,
    capabilityInstrumentation,
    networkTaskCandidates: [{ accountId: "acct_contributor", walletAddress: "rContributorWallet", displayName: "Contributor" }],
    executionPolicy: {},
  },
  secretaryPacket: {
    id: "bmsec_hive_generation_intelligence_smoke",
    sourceDigest: "source_digest_hive_generation_intelligence",
    packetDigest: "packet_digest_hive_generation_intelligence",
    packetJson: {
      motion_state: "needs_attention",
      requires_attention: true,
      do_nothing_allowed: false,
      board_summary: "Compressed packet smoke.",
      reason_summary: "Compressed wording should not erase source policy.",
      facts_to_preserve: [],
    },
    packetText: "Compressed packet smoke.",
  },
});
assert.match(compressedDecisionSource.operatorStandingPolicy[0].directive, /Stop documentation-only/i);
assert.equal(compressedDecisionSource.generationQualityPolicy.requires_concrete_action_output, true);
assert.equal(compressedDecisionSource.networkTaskOutputCorpus.outputs.length, 2);
assert.ok(compressedDecisionSource.deduplicationWatchlist.length >= 1);
assert.equal(compressedDecisionSource.capabilityGapSummary.gaps[0].capability_type, "repo_pr_access");
assert.equal(compressedDecisionSource.capabilityGapSummary.gaps[0].recommended_task_work_type, "capability_gating_task");

const normalizedDecision = normalizeBoardManagerDecision({
  action: "initiate_network_task",
  target_type: "network_project",
  target_id: "task_node_core",
  reason: "Escalate prior workflow documentation into an action packet for review.",
  confidence: 0.82,
  decision_basis: {
    source_facts: [
      "hivectx_stop_docs says documentation-only tasks should stop.",
      "task_doc_1 / bafypriorworkflowdoc and task_doc_2 / bafysecondworkflowdoc already documented the workflow friction theme.",
    ],
    tradeoffs: ["A new documentation task would repeat prior work; an action packet moves the project forward."],
    rejected_actions: [{ action: "do_nothing", reason: "The board still needs a concrete follow-up action." }],
    risk_notes: ["Contributor should use prior summaries instead of rediscovering the same issue."],
    next_check: "Confirm the Discord handoff or PR-ready packet was delivered.",
  },
  payload: {
    summary: "Use prior workflow reports to produce a PR-ready action packet.",
    network_task: {
      task_work_type: "code_task",
      required_badge_id: "core_contributor",
      operating_badge_id: "core_contributor",
      badge_work_type: "code_task",
      badge_reason: "The selected contributor is assumed to have sanctioned code access in this prompt-level intelligence smoke.",
      badge_reward_cap_pft: 30000,
      badge_evidence_requirements: ["Submit a PR-ready packet, PR URL, commit URL, or reviewer-ready code artifact."],
      discord_evidence_required: true,
      task_class: "network",
      candidate_account_id: "acct_contributor",
      candidate_wallet_address: "rContributorWallet",
      project_need_summary: "Use task_doc_1 and task_doc_2 to prepare a PR-ready acceptance-flow patch packet and post the handoff to #tasknode-hive for Alex review.",
      routing_reason: "The contributor can convert existing Task Node workflow evidence into a concrete action packet.",
      cadence_reason: "Documented once; now escalate to action.",
      action_output: "PR-ready acceptance-flow patch packet plus Discord handoff.",
      delivery_surface: "discord_message",
      recipient_or_reviewer: "Alex in #tasknode-hive",
      escalation_stage: "document_to_action_v1:already_documented_to_action_packet",
      lineage_task_ids: ["task_doc_1", "task_doc_2"],
      referenced_outputs: [
        {
          task_id: "task_doc_1",
          cid: "bafypriorworkflowdoc",
          tx_hash: "ABC123PRIOR",
          summary: "Prior workflow friction report.",
          how_used: "Use as source evidence instead of re-documenting.",
        },
      ],
      deduped_against: [
        {
          task_id: "task_doc_2",
          theme: "workflow friction documentation",
          reason_not_repeated: "The second report already repeated the same documentation theme.",
        },
      ],
      why_not_duplicate: "The task escalates prior documentation into a named handoff and PR-ready packet.",
      reward_min_pft: 10000,
      reward_max_pft: 30000,
      accept_window_hours: 24,
      allow_over_capacity: false,
    },
  },
});
const normalizedNetworkTask = normalizedDecision.payload.network_task;
assert.equal(normalizedNetworkTask.task_work_type, "code_task");
assert.equal(normalizedNetworkTask.action_output, "PR-ready acceptance-flow patch packet plus Discord handoff.");
assert.equal(normalizedNetworkTask.delivery_surface, "discord_message");
assert.deepEqual(normalizedNetworkTask.lineage_task_ids, ["task_doc_1", "task_doc_2"]);
assert.equal(normalizedNetworkTask.referenced_outputs[0].task_id, "task_doc_1");
assert.equal(normalizedNetworkTask.deduped_against[0].task_id, "task_doc_2");
assert.match(normalizedNetworkTask.project_need_summary, /PR-ready|Discord|Alex/i);

const sourceJson = buildNetworkTaskGenerationSource({
  runId: "boardrun_hive_generation_intelligence",
  decision: normalizedDecision,
  sourcePacket: compressedDecisionSource,
  project: {
    id: "task_node_core",
    type: "product",
    title: "Task Node Core Product",
    summary: "Task Node product board.",
    objective: "Improve task lifecycle UX.",
    priority: 1,
  },
  projectDocument: {
    id: "doc_task_node_core",
    title: "Task Node Core Product",
    summary: "Improve the Task Node task lifecycle.",
    project_status: "Needs action on documented workflow issues.",
    key_points_json: ["Use prior docs as input."],
    blocked_or_unclear_json: [],
    next_actions_json: ["Deliver a concrete patch packet."],
  },
  candidate: {
    accountId: "acct_contributor",
    walletAddress: "rContributorWallet",
    profileId: "netprofile_contributor",
    profileDigest: "profile_digest",
    profileText: "Can convert workflow reports into action packets.",
  },
  normalizedTaskClass: "network",
  band: { min: 10000, max: 50000 },
  projectNeedSummary: normalizedNetworkTask.project_need_summary,
  allocationReasonSummary: normalizedNetworkTask.routing_reason,
  cadenceReason: normalizedNetworkTask.cadence_reason,
  acceptWindowHours: 24,
});
assert.equal(sourceJson.networkTask.actionOutput, normalizedNetworkTask.action_output);
assert.equal(sourceJson.networkTask.taskWorkType, "code_task");
assert.equal(sourceJson.networkTask.deliverySurface, "discord_message");
assert.equal(sourceJson.taskLineage.referencedOutputs[0].task_id, "task_doc_1");
assert.equal(sourceJson.taskLineage.dedupedAgainst[0].task_id, "task_doc_2");
assert.equal(sourceJson.operatorStandingPolicy[0].source_id, "hivectx_stop_docs");
assert.equal(sourceJson.priorOutputCorpus.outputs.length, 2);

const sourceText = formatNetworkTaskGenerationSourceText(sourceJson);
assert.match(sourceText, /Operator standing policy/);
assert.match(sourceText, /Concrete action\/output/);
assert.match(sourceText, /Lineage and referenced prior outputs/);
assert.match(sourceText, /Deduped against/);
assert.match(sourceText, /task_doc_1/);
assert.match(sourceText, /task_doc_2/);

const requestContext = buildNetworkTaskRequestContext({
  source: sourceJson,
  job: {
    id: "nettaskjob_hive_generation_intelligence",
    allocation_id: "netalloc_hive_generation_intelligence",
    project_id: "task_node_core",
    task_class: "network",
    source_payload_digest: "source_payload_digest",
  },
  reward: { min: 10000, max: 50000 },
});
assert.equal(requestContext.action_output, normalizedNetworkTask.action_output);
assert.equal(requestContext.task_work_type, "code_task");
assert.equal(requestContext.task_lineage.referenced_outputs[0].task_id, "task_doc_1");
assert.equal(requestContext.operator_standing_policy[0].source_id, "hivectx_stop_docs");
assert.equal(requestContext.prior_output_corpus.outputs.length, 2);

const taskInput = projectTaskgenInput({
  request: { source: "network_task", requestedTaskKind: "network" },
  context: { primary_context_doc: { summary: "Contributor context." } },
  recent_chat: { summary: "" },
  relevant_history: { items: [] },
  memory: {},
  task_queue: {},
  network_task: requestContext,
  wallet: { wallet_address: "rContributorWallet" },
  policy: { task_class: "network" },
});
assert.equal(taskInput.hive_policy.operator_standing_policy[0].source_id, "hivectx_stop_docs");
assert.equal(taskInput.task_lineage.referenced_outputs[0].task_id, "task_doc_1");
assert.equal(taskInput.operator_transparency.deduped_against[0].task_id, "task_doc_2");
assert.equal(taskInput.prior_output_corpus.outputs.length, 2);
assert.equal(taskgenPromptForInput(taskInput).version, "taskgen_network_v1");

const boardManagerPrompt = readFileSync(join(repoRoot, "prompts/hive/board_manager_v1.md"), "utf8");
const taskgenPrompt = readFileSync(join(repoRoot, "prompts/task_engine/taskgen_network_v1.md"), "utf8");
const secretaryPrompt = readFileSync(join(repoRoot, "prompts/hive/board_manager_secretary_v1.md"), "utf8");
assert.match(secretaryPrompt, /non-compressible/i);
assert.match(secretaryPrompt, /capability_gap_summary/);
assert.match(boardManagerPrompt, /Network Task Generation Intelligence/);
assert.match(boardManagerPrompt, /document-to-action ladder/i);
assert.match(boardManagerPrompt, /capability_gating_task/);
assert.match(boardManagerPrompt, /evidence_evaluation_packet/);
assert.match(taskgenPrompt, /Document-To-Action Network Tasks/);
assert.match(taskgenPrompt, /Do not generate a task whose only deliverable is a report/i);
assert.match(taskgenPrompt, /task_lineage\.referenced_outputs/);

const responseFormat = boardManagerResponseFormat();
const networkTaskSchema = responseFormat.schema.properties.payload.properties.network_task;
for (const field of [
  "action_output",
  "task_work_type",
  "delivery_surface",
  "recipient_or_reviewer",
  "escalation_stage",
  "lineage_task_ids",
  "referenced_outputs",
  "deduped_against",
  "why_not_duplicate",
]) {
  assert.ok(
    networkTaskSchema.required.includes(field),
    `board manager response schema must require network_task.${field}`
  );
  assert.ok(
    networkTaskSchema.properties[field],
    `board manager response schema must define network_task.${field}`
  );
}
assert.equal(networkTaskSchema.properties.referenced_outputs.items.required.length, 5);
assert.equal(networkTaskSchema.properties.deduped_against.items.required.length, 3);

console.log("hive generation intelligence smoke passed");
