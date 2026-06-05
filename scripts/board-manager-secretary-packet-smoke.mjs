import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DEEPSEEK_API_KEY = "board-manager-secretary-smoke-key";
delete process.env.TASKNODE_BOARD_MANAGER_SECRETARY_MODEL;
delete process.env.TASKNODE_BOARD_MANAGER_SECRETARY_REASONING_EFFORT;

const {
  boardManagerSecretaryModel,
  boardManagerSecretarySourceDigest,
  buildBoardManagerSecretaryDecisionPacket,
  fetchBoardManagerSecretaryPacket,
  normalizeBoardManagerSecretaryPacket,
} = await import("../server/board-manager-secretary-packets.js");

assert.equal(boardManagerSecretaryModel(), "deepseek-v4-pro");

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
assert.equal(capturedBody.model, "deepseek-v4-pro");
assert.equal(capturedBody.thinking.type, "enabled");
assert.equal(capturedBody.reasoning_effort, "high");
assert.equal(capturedBody.response_format.type, "json_object");
assert.equal(capturedBody.stream, false);
assert.match(capturedBody.messages[0].content, /Output valid JSON only/);
assert.match(capturedBody.messages[0].content, /do not summarize the board as globally capacity-blocked/);
assert.match(capturedBody.messages[1].content, /BOARD MANAGER SOURCE PACKET JSON/);

assert.equal(result.provider, "deepseek");
assert.equal(result.model, "deepseek-v4-pro");
assert.equal(result.packet.motion_state, "needs_attention");
assert.equal(result.packet.recommended_context_request.target_id, "task_node");
assert.equal(result.usage.inputTokens, 1000);

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
assert.equal(decisionPacket.sourceMode, "deepseek_secretary_packet");
assert.equal(decisionPacket.rawSourcePacketDigest, rawSourcePacket.sourcePacketDigest);
assert.equal(decisionPacket.secretarySourceDigest, boardManagerSecretarySourceDigest(rawSourcePacket));
assert.equal(decisionPacket.secretaryPacket.packetJson.motion_state, "needs_attention");
assert.equal(decisionPacket.actionTargetRegistry.accounts[0]?.accountId, "acct_1");
assert.equal(decisionPacket.actionTargetRegistry.hiveContextEntries[0]?.sourceConversationId, "conv_hive_1");
assert.equal(decisionPacket.actionTargetRegistry.contributorCandidates[0]?.walletAddress, "rHiveValidatedWallet");
assert.ok(decisionPacket.sourcePacketDigest.length >= 40);
assert.ok(JSON.stringify(decisionPacket).length < JSON.stringify(rawSourcePacket).length + result.packetText.length + 2000);

console.log("board manager secretary packet smoke ok");
