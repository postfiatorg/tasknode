import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.AMBIENT_API_KEY = "board-manager-secretary-smoke-key";
delete process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MODEL;
delete process.env.TASKNODE_BOARD_MANAGER_SECRETARY_REASONING_EFFORT;

const {
  boardManagerSecretaryModel,
  boardManagerSecretarySourceDigest,
  buildBoardManagerSecretaryDecisionPacket,
  fetchBoardManagerSecretaryPacket,
  normalizeBoardManagerSecretaryPacket,
} = await import("../server/board-manager-secretary-packets.js");

assert.equal(boardManagerSecretaryModel(), "z-ai/glm-5.2");

const rawSourcePacket = {
  schema: "pf.hive.board_manager.source.v0",
  scope: "global_hive",
  trigger: "secretary_smoke",
  database: { configured: true, enabled: true, durable: true },
  actionRegistry: ["do_nothing", "message_user", "initiate_network_task"],
  boardActionPressure: {
    summary: {
      requiresAction: true,
      staleHiveSecretary: true,
      projectsWithoutLiveTasks: 1,
      eligibleCandidateCount: 1,
    },
  },
  freshness: {
    hiveSecretaryAgeMs: 5000,
    latestProjectGenerationAgeMs: 7000,
  },
  hiveSecretarySource: {
    digest: "volatile_hive_secretary_source_digest_a",
    counts: { entryCount: 1, userCount: 1 },
    sourceJson: {
      schema: "pf.hive.secretary.source.v1",
      generated_at: "2026-05-24T01:00:00.000Z",
      validated_entry_count: 1,
      user_count: 1,
      groups: [
        {
          account_id: "acct_1",
          display_name: "goodalexander",
          entries: [{ id: "hivectx_1", created_at: "2026-05-24T00:30:00.000Z", body: "Task Node needs motion." }],
        },
      ],
    },
    sourceText: [
      "HIVE SECRETARY SOURCE PACKET",
      "",
      "Generated At: 2026-05-24T01:00:00.000Z",
      "Validated wallet inputs: 1",
      "Task Node needs motion.",
    ].join("\n"),
  },
  hiveContext: {
    groups: [
      {
        accountId: "acct_1",
        displayName: "goodalexander",
        entries: [
          {
            id: "hivectx_1",
            accountId: "acct_1",
            displayName: "goodalexander",
            sourceConversationId: "conv_hive_1",
            walletValidated: true,
            walletAddress: "rHiveValidatedWallet",
            createdAt: "2026-05-24T00:30:00.000Z",
          },
        ],
      },
    ],
  },
  networkTaskCandidates: [
    {
      accountId: "acct_1",
      displayName: "goodalexander",
      walletAddress: "rHiveValidatedWallet",
    },
  ],
  badgeEligibility: {
    schema: "pf.task_node.badge_eligibility.v1",
    catalogVersion: "network_badges_v1",
    enforcement: "executor_required",
    candidateCount: 1,
    badgeEligibleCandidateCount: 1,
    candidates: [
      {
        accountId: "acct_1",
        walletAddress: "rHiveValidatedWallet",
        verifiedBadges: ["qa_worker"],
        defaultBadge: "qa_worker",
        allowedWorkTypes: ["qa_report"],
        rewardCaps: { qa_report: 5000 },
      },
    ],
  },
  projectLeaderInputs: [
    {
      sourceEntryId: "hivectx_1",
      accountId: "acct_1",
      displayName: "goodalexander",
      hiveHandle: "goodalexander",
      walletAddress: "rHiveValidatedWallet",
      sourceConversationId: "conv_hive_1",
      createdAt: "2026-05-24T00:30:00.000Z",
      authority: ["define_special_projects", "define_open_source_projects"],
      bodyExcerpt: "Task Node needs motion.",
    },
  ],
  orcOperations: {
    schema: "pf.hive.board_manager.orc_operations.v1",
    enforcement: "none_context_only",
    summary: {
      agentCount: 1,
      activeAgentCount: 1,
      availableForRoutingCount: 1,
      outstandingOrcNetworkTaskCount: 0,
      pendingOrcGenerationCount: 0,
      actionRequiredReviewCount: 1,
      recentInteractionCount: 1,
    },
    agents: [
      {
        handle: "grashnuk",
        agentId: "agent_grashnuk",
        accountId: "acct_orc_grashnuk",
        walletAddress: "rGrashnukWallet",
        status: "active",
        active: true,
        routingEligible: true,
        currentTasks: {
          outstandingNetworkTaskCount: 0,
          pendingGenerationCount: 0,
        },
        reviews: {
          actionRequiredCount: 1,
        },
      },
    ],
    routingCandidates: [
      {
        source: "orc_agents",
        role: "orc_operator",
        handle: "grashnuk",
        agentId: "agent_grashnuk",
        accountId: "acct_orc_grashnuk",
        walletAddress: "rGrashnukWallet",
      },
    ],
    reviewQueue: {
      recent: [
        {
          taskId: "task_orc_review",
          disposition: "reviewed_follow_up",
          actionRequired: true,
          reviewerHandle: "grashnuk",
          summary: "Needs operator follow-up.",
        },
      ],
    },
    operatorInteractions: {
      recent: [
        {
          orcHandle: "grashnuk",
          interactionType: "directive",
          status: "recorded",
          directive: "Review duplicate reward evidence.",
        },
      ],
    },
  },
  capabilityInstrumentation: {
    schema: "pf.hive.board_manager.capability_instrumentation.v1",
    status: "phase_a_instrumentation_only_no_enforcement",
    enforcement: "none_context_only",
    task_work_type_vocabulary: [
      { id: "code_task", label: "Code task", definition: "Requires code/PR proof." },
      { id: "capability_gating_task", label: "Capability-gating task", definition: "Requires access proof before substantive work." },
      { id: "evidence_evaluation_packet", label: "Evidence-evaluation packet", definition: "Classifies evidence without deciding rewards." },
    ],
    summary: { requirement_count: 1, candidate_count: 1, gap_count: 1 },
    capability_gaps: [
      {
        project_id: "task_node",
        candidate_account_id: "acct_1",
        capability_type: "repo_pr_access",
        scope_label: "Task Node private repo PR access",
        scope_digest: "scope_digest_smoke",
        candidate_status: "missing_verified_capability",
        recommended_task_work_type: "capability_gating_task",
        privacy_note: "Do not expose private repo/channel membership.",
      },
    ],
    open_questions_reserved_for_alex: ["who can mark a capability verified"],
  },
  hiveProjects: {
    generatedAt: "2026-05-24T01:00:00.000Z",
    projects: {
      task_node: {
        id: "task_node",
        title: "Task Node",
        taskCount: 2,
        contributorCount: 1,
      },
    },
  },
  networkTaskContent: {
    outstanding: [],
    stopped: [{ taskId: "task_refused", state: "refused", projectId: "task_node" }],
  },
  executionPolicy: {
    dryRunDefault: true,
    implementedActionHooks: ["do_nothing", "message_user", "initiate_network_task"],
  },
  recentBoardManagerRuns: [
    {
      id: "boardrun_noop_a",
      trigger: "periodic_tick",
      action: "do_nothing",
      dryRun: false,
      reason: "No material board mutation was needed.",
      completedAt: "2026-05-24T01:00:00.000Z",
    },
    {
      id: "boardrun_action_stable",
      trigger: "network_task_completed",
      action: "refresh_project_document",
      dryRun: false,
      targetId: "task_node",
      reason: "Refresh Task Node project after completed network task.",
      completedAt: "2026-05-23T23:00:00.000Z",
    },
  ],
  sourcePacketDigest: "source_digest_secretary_smoke",
};
assert.equal(
  boardManagerSecretarySourceDigest(rawSourcePacket),
  boardManagerSecretarySourceDigest({
    ...rawSourcePacket,
    trigger: "different_periodic_tick",
    generatedAt: "2026-05-24T01:00:00.000Z",
    sourcePacketDigest: "different_digest_because_trigger_changed",
    freshness: {
      hiveSecretaryAgeMs: 6000,
      latestProjectGenerationAgeMs: 9000,
    },
    hiveSecretarySource: {
      ...rawSourcePacket.hiveSecretarySource,
      digest: "volatile_hive_secretary_source_digest_b",
      sourceJson: {
        ...rawSourcePacket.hiveSecretarySource.sourceJson,
        generated_at: "2026-05-24T01:01:00.000Z",
      },
      sourceText: rawSourcePacket.hiveSecretarySource.sourceText.replace(
        "Generated At: 2026-05-24T01:00:00.000Z",
        "Generated At: 2026-05-24T01:01:00.000Z"
      ),
    },
    hiveProjects: {
      ...rawSourcePacket.hiveProjects,
      generatedAt: "2026-05-24T01:01:00.000Z",
    },
    recentBoardManagerRuns: [
      {
        id: "boardrun_noop_b",
        trigger: "different_periodic_tick",
        action: "do_nothing",
        dryRun: false,
        reason: "Different no-op wording should not force a new secretary packet.",
        completedAt: "2026-05-24T01:01:00.000Z",
      },
      rawSourcePacket.recentBoardManagerRuns[1],
    ],
  }),
  "secretary source digest should ignore run labels, generated timestamps, age counters, source text timestamps, and no-op run churn"
);
assert.notEqual(
  boardManagerSecretarySourceDigest(rawSourcePacket),
  boardManagerSecretarySourceDigest({
    ...rawSourcePacket,
    boardActionPressure: {
      summary: {
        ...rawSourcePacket.boardActionPressure.summary,
        eligibleCandidateCount: 0,
      },
    },
  }),
  "secretary source digest should still change for material board state"
);

let capturedUrl = "";
let capturedBody = null;
const result = await fetchBoardManagerSecretaryPacket({
  sourcePacket: rawSourcePacket,
  fetchImpl: async (url, options = {}) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          id: "deepseek_secretary_smoke_response",
          model: "deepseek-v4-pro",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema: "pf.hive.board_manager.secretary_packet.v1",
                  motion_state: "needs_attention",
                  requires_attention: true,
                  do_nothing_allowed: false,
                  board_summary: "Task Node has a refused task and one active project requiring a follow-up.",
                  reason_summary: "The deterministic pressure block says action is required.",
                  staleness_summary: "A refused task changed the board state.",
                  action_pressure_summary: "One project has no live task motion and one eligible contributor exists.",
                  recommended_context_request: {
                    packet_type: "project_focus",
                    target_type: "network_project",
                    target_id: "task_node",
                    reason: "Task Node needs a concrete replacement task or user follow-up.",
                  },
                  attention_targets: [
                    {
                      target_type: "network_project",
                      target_id: "task_node",
                      title: "Task Node",
                      priority: 1,
                      reason: "The project has stalled task motion.",
                      recommended_context_request: "Inspect project state and initiate a replacement Network Task.",
                    },
                  ],
                  project_summaries: [
                    {
                      project_id: "task_node",
                      title: "Task Node",
                      state: "needs_attention",
                      live_task_count: 0,
                      contributor_count: 1,
                      status: "The project needs one concrete next task.",
                      next_needed: "Initiate or clarify a replacement task.",
                    },
                  ],
                  network_task_summary: "One refused Network Task exists.",
                  candidate_summary: "One eligible contributor exists.",
                  recent_run_summary: "No recent run already handled this source state.",
                  project_leader_inputs: [
                    {
                      source_entry_id: "hivectx_1",
                      account_id: "acct_1",
                      display_name: "goodalexander",
                      hive_handle: "goodalexander",
                      wallet_address: "rHiveValidatedWallet",
                      source_conversation_id: "conv_hive_1",
                      authority: ["define_special_projects", "define_open_source_projects"],
                      body_excerpt: "Task Node needs motion.",
                    },
                  ],
                  capability_gap_summary: {
                    status: "phase_a_instrumentation_only_no_enforcement",
                    enforcement: "none_context_only",
                    requirement_count: 1,
                    candidate_count: 1,
                    gap_count: 1,
                    task_work_types: [
                      { id: "code_task", label: "Code task", definition: "Requires code/PR proof." },
                      { id: "capability_gating_task", label: "Capability-gating task", definition: "Requires access proof before substantive work." },
                    ],
                    gaps: [
                      {
                        project_id: "task_node",
                        candidate_account_id: "acct_1",
                        capability_type: "repo_pr_access",
                        scope_label: "Task Node private repo PR access",
                        candidate_status: "missing_verified_capability",
                        recommended_task_work_type: "capability_gating_task",
                        privacy_note: "Do not expose private repo/channel membership.",
                      },
                    ],
                    open_questions_reserved_for_alex: ["who can mark a capability verified"],
                  },
                  badge_eligibility: {
                    schema: "pf.task_node.badge_eligibility.v1",
                    catalog_version: "network_badges_v1",
                    enforcement: "executor_required",
                    candidate_count: 1,
                    badge_eligible_candidate_count: 1,
                    candidates: [
                      {
                        account_id: "acct_1",
                        wallet_address: "rHiveValidatedWallet",
                        verified_badges: ["qa_worker"],
                        default_badge: "qa_worker",
                        allowed_work_types: ["qa_report"],
                        reward_caps: { qa_report: 5000 },
                      },
                    ],
                  },
                  facts_to_preserve: ["task_refused", "task_node"],
                  redaction_count: 0,
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
        });
      },
    };
  },
});

assert.match(capturedUrl, /\/chat\/completions$/);
assert.equal(capturedBody.model, "z-ai/glm-5.2");
assert.deepEqual(capturedBody.reasoning, { effort: "high", exclude: true });
assert.equal(capturedBody.thinking, undefined);
assert.equal(capturedBody.reasoning_effort, undefined);
assert.equal(capturedBody.response_format.type, "json_object");
assert.equal(capturedBody.stream, undefined);
assert.match(capturedBody.messages[0].content, /Output valid JSON only/);
assert.match(capturedBody.messages[0].content, /do not summarize the board as globally capacity-blocked/);
assert.match(capturedBody.messages[1].content, /BOARD MANAGER SOURCE PACKET JSON/);
assert.match(capturedBody.messages[1].content, /capabilityInstrumentation/);
assert.match(capturedBody.messages[1].content, /capability_gating_task/);
assert.match(capturedBody.messages[1].content, /projectLeaderInputs/);

assert.equal(result.provider, "ambient");
assert.equal(result.model, "deepseek-v4-pro");
assert.equal(result.packet.motion_state, "needs_attention");
assert.equal(result.packet.recommended_context_request.target_id, "task_node");
assert.equal(result.packet.project_leader_inputs[0].hive_handle, "goodalexander");
assert.equal(result.packet.project_leader_inputs[0].authority[1], "define_open_source_projects");
assert.equal(result.packet.capability_gap_summary.gaps[0].recommended_task_work_type, "capability_gating_task");
assert.equal(result.packet.capability_gap_summary.enforcement, "none_context_only");
assert.equal(result.packet.badge_eligibility.enforcement, "executor_required");
assert.equal(result.packet.badge_eligibility.candidates[0].verified_badges[0], "qa_worker");
assert.equal(result.usage.inputTokens, 1000);

function deepSeekResponse({ content, id = "deepseek_secretary_response", inputTokens = 10, outputTokens = 5 } = {}) {
  return {
    ok: true,
    async text() {
      return JSON.stringify({
        id,
        model: "deepseek-v4-pro",
        choices: [{ message: { content } }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    },
  };
}

const repairedPacketJson = {
  schema: "pf.hive.board_manager.secretary_packet.v1",
  motion_state: "needs_attention",
  requires_attention: true,
  do_nothing_allowed: false,
  board_summary: "Repair packet preserved the active operator policy.",
  reason_summary: "The first secretary response was malformed, then repaired.",
  staleness_summary: "Prior documentation exists.",
  action_pressure_summary: "Eligible candidate exists.",
  network_task_summary: "Use prior outputs as lineage.",
  candidate_summary: "One candidate is eligible.",
  recent_run_summary: "No recent run handled this.",
  operator_standing_policy: [
    {
      source_id: "hivectx_stop_docs",
      directive: "Stop documentation-only network tasks; escalate prior docs to action.",
      active_scope: "global",
      generation_implication: "Preserve as non-compressible task-shape policy.",
    },
  ],
  generation_quality_policy: {
    documentation_only_default: "low_value_unless_action_coupled",
    requires_concrete_action_output: true,
    escalation_ladder: "document_to_action_v1",
  },
  prior_output_corpus_summary: {
    recent_outputs: [{ task_id: "task_doc_1", title: "Document workflow friction", summary: "Prior doc exists." }],
    repeated_themes: ["workflow friction: task_doc_1"],
  },
  deduplication_watchlist: [
    {
      theme: "workflow friction",
      prior_task_ids: ["task_doc_1"],
      why_not_repeat: "The theme was already documented.",
      next_action_suggestion: "Convert the prior document into a PR-ready handoff.",
    },
  ],
  project_leader_inputs: [
    {
      source_entry_id: "hivectx_1",
      account_id: "acct_1",
      display_name: "goodalexander",
      hive_handle: "goodalexander",
      wallet_address: "rHiveValidatedWallet",
      source_conversation_id: "conv_hive_1",
      authority: ["define_special_projects", "define_open_source_projects"],
      body_excerpt: "Task Node needs motion.",
    },
  ],
  capability_gap_summary: {
    status: "phase_a_instrumentation_only_no_enforcement",
    enforcement: "none_context_only",
    requirement_count: 1,
    candidate_count: 1,
    gap_count: 1,
    task_work_types: [{ id: "capability_gating_task", label: "Capability-gating task", definition: "Prove access first." }],
    gaps: [
      {
        project_id: "task_node",
        candidate_account_id: "acct_1",
        capability_type: "repo_pr_access",
        scope_label: "Task Node private repo PR access",
        candidate_status: "missing_verified_capability",
        recommended_task_work_type: "capability_gating_task",
      },
    ],
  },
  facts_to_preserve: ["hivectx_stop_docs", "task_doc_1"],
};

const repairCalls = [];
const repairedResult = await fetchBoardManagerSecretaryPacket({
  sourcePacket: rawSourcePacket,
  fetchImpl: async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    repairCalls.push(body);
    if (repairCalls.length === 1) {
      return deepSeekResponse({
        content: '{"schema":"pf.hive.board_manager.secretary_packet.v1","motion_state":"needs_attention","board_summary":',
        id: "deepseek_secretary_invalid_then_repair_a",
        inputTokens: 20,
        outputTokens: 8,
      });
    }
    return deepSeekResponse({
      content: JSON.stringify(repairedPacketJson),
      id: "deepseek_secretary_invalid_then_repair_b",
      inputTokens: 30,
      outputTokens: 12,
    });
  },
});
assert.equal(repairCalls.length, 2);
assert.match(repairCalls[1].messages.at(-1).content, /previous assistant message was not valid JSON/i);
assert.equal(repairedResult.packet.motion_state, "needs_attention");
assert.equal(repairedResult.packet.operator_standing_policy[0].source_id, "hivectx_stop_docs");
assert.equal(repairedResult.packet.project_leader_inputs[0].source_entry_id, "hivectx_1");
assert.equal(repairedResult.usage.inputTokens, 50);
assert.equal(repairedResult.usage.outputTokens, 20);
assert.equal(repairedResult.usage.repairAttempted, true);
assert.equal(repairedResult.usage.repairFailed, false);

const fallbackSourcePacket = {
  ...rawSourcePacket,
  operatorStandingPolicy: repairedPacketJson.operator_standing_policy,
  generationQualityPolicy: {
    documentationOnlyDefault: "low_value_unless_action_coupled",
    requiresConcreteActionOutput: true,
    escalationLadder: "document_to_action_v1",
    operatorConstraintsSummary: "Stop documentation-only network tasks; escalate prior docs to action.",
  },
  priorOutputCorpusSummary: repairedPacketJson.prior_output_corpus_summary,
  deduplicationWatchlist: repairedPacketJson.deduplication_watchlist,
  networkTaskOutputCorpus: {
    outputs: [{ taskId: "task_doc_1", title: "Document workflow friction" }],
    summary: repairedPacketJson.prior_output_corpus_summary,
    deduplicationWatchlist: repairedPacketJson.deduplication_watchlist,
  },
};
let fallbackCallCount = 0;
const fallbackResult = await fetchBoardManagerSecretaryPacket({
  sourcePacket: fallbackSourcePacket,
  fetchImpl: async () => {
    fallbackCallCount += 1;
    return deepSeekResponse({
      content: fallbackCallCount === 1
        ? '{"schema":"pf.hive.board_manager.secretary_packet.v1","motion_state":'
        : '{"schema":"pf.hive.board_manager.secretary_packet.v1","motion_state":"needs_attention","reason_summary":',
      id: `deepseek_secretary_invalid_fallback_${fallbackCallCount}`,
      inputTokens: 11,
      outputTokens: 7,
    });
  },
});
assert.equal(fallbackCallCount, 2);
assert.equal(fallbackResult.packet.motion_state, "needs_attention");
assert.match(fallbackResult.packet.board_summary, /fallback packet/i);
assert.equal(fallbackResult.packet.operator_standing_policy[0].source_id, "hivectx_stop_docs");
assert.equal(fallbackResult.packet.generation_quality_policy.requires_concrete_action_output, true);
assert.equal(fallbackResult.packet.prior_output_corpus_summary.recent_outputs[0].task_id, "task_doc_1");
assert.equal(fallbackResult.packet.deduplication_watchlist[0].prior_task_ids[0], "task_doc_1");
assert.equal(fallbackResult.packet.project_leader_inputs[0].hive_handle, "goodalexander");
assert.equal(fallbackResult.packet.capability_gap_summary.gaps[0].recommended_task_work_type, "capability_gating_task");
assert.equal(fallbackResult.packet.badge_eligibility.candidates[0].reward_caps.qa_report, 5000);
assert.equal(fallbackResult.packet.orc_operations_summary.active_agent_count, 1);
assert.equal(fallbackResult.packet.orc_operations_summary.agents[0].handle, "grashnuk");
assert.ok(fallbackResult.packet.facts_to_preserve.some((fact) => fact.includes("capability_gap:task_node:repo_pr_access:acct_1")));
assert.ok(fallbackResult.packet.facts_to_preserve.some((fact) => fact.includes("orc_agent:grashnuk")));
assert.ok(fallbackResult.packet.facts_to_preserve.some((fact) => fact.includes("source_packet_digest")));
assert.ok(fallbackResult.packet.facts_to_preserve.some((fact) => fact.includes("project_leader_input:hivectx_1:goodalexander")));
assert.equal(fallbackResult.usage.repairAttempted, true);
assert.equal(fallbackResult.usage.repairFailed, true);
assert.doesNotThrow(() => JSON.parse(fallbackResult.outputText));

const normalized = normalizeBoardManagerSecretaryPacket({
  motionState: "moving",
  doNothingAllowed: true,
  boardSummary: "Board is moving.",
});
assert.equal(normalized.motion_state, "moving");
assert.equal(normalized.do_nothing_allowed, true);

const decisionPacket = buildBoardManagerSecretaryDecisionPacket({
  sourcePacket: rawSourcePacket,
  secretaryPacket: {
    id: "bmsec_smoke",
    packetType: "board_triage",
    sourceDigest: boardManagerSecretarySourceDigest(rawSourcePacket),
    packetDigest: "packet_digest_smoke",
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    packetJson: result.packet,
    packetText: result.packetText,
    usage: result.usage,
    createdAt: "2026-05-24T00:00:00.000Z",
  },
  reused: false,
});
assert.equal(decisionPacket.schema, "pf.hive.board_manager.decision_source.v1");
assert.equal(decisionPacket.sourceMode, "ambient_secretary_packet");
assert.equal(decisionPacket.rawSourcePacketDigest, rawSourcePacket.sourcePacketDigest);
assert.equal(decisionPacket.secretarySourceDigest, boardManagerSecretarySourceDigest(rawSourcePacket));
assert.equal(decisionPacket.secretaryPacket.packetJson.motion_state, "needs_attention");
assert.equal(decisionPacket.actionTargetRegistry.accounts[0]?.accountId, "acct_1");
assert.equal(decisionPacket.actionTargetRegistry.hiveContextEntries[0]?.sourceConversationId, "conv_hive_1");
assert.equal(decisionPacket.actionTargetRegistry.contributorCandidates[0]?.walletAddress, "rHiveValidatedWallet");
assert.ok(decisionPacket.actionTargetRegistry.contributorCandidates.some((candidate) => (
  candidate.accountId === "acct_orc_grashnuk" &&
  candidate.walletAddress === "rGrashnukWallet"
)));
assert.equal(decisionPacket.capabilityGapSummary.gaps[0].capability_type, "repo_pr_access");
assert.equal(decisionPacket.capabilityGapSummary.gaps[0].recommended_task_work_type, "capability_gating_task");
assert.equal(decisionPacket.badgeEligibility.candidates[0].default_badge, "qa_worker");
assert.equal(decisionPacket.projectLeaderInputs[0].hive_handle, "goodalexander");
assert.equal(decisionPacket.orcOperationsSummary.active_agent_count, 1);
assert.ok(decisionPacket.sourcePacketDigest.length >= 40);
assert.ok(JSON.stringify(decisionPacket).length < JSON.stringify(rawSourcePacket).length + result.packetText.length + 8000);

console.log("board manager secretary packet smoke ok");
