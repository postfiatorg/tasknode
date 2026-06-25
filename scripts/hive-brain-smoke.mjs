import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const { closePool, databaseEnabled, query } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const {
  completeBoardManagerRun,
  recordBoardManagerActionResult,
  startBoardManagerRun,
  updateBoardManagerRunOutput,
} = await import("../server/repositories/board-manager.js");
const {
  getHiveBrainLive,
  getHiveBrainRunDetail,
  listHiveBrainRuns,
} = await import("../server/repositories/hive-brain.js");

const suffix = `${Date.now()}`;
const trigger = `hive_brain_smoke_${suffix}`;
const rawDigest = `raw_hive_brain_smoke_${suffix}`;
const secretaryPacketId = `bmsec_hive_brain_smoke_${suffix}`;
const secretaryPacketDigest = `bmsec_digest_hive_brain_smoke_${suffix}`;

async function cleanup(runId = "") {
  if (runId) await query("DELETE FROM board_manager_runs WHERE id = $1", [runId]);
  await query("DELETE FROM board_manager_runs WHERE trigger = $1", [trigger]);
  await query("DELETE FROM board_manager_secretary_packets WHERE id = $1", [secretaryPacketId]);
}

async function main() {
  if (!databaseEnabled()) {
    console.log("hive brain smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  let runId = "";
  try {
    const sourcePacket = {
      schema: "pf.hive.board_manager.decision_source.v1",
      sourcePacketDigest: `decision_hive_brain_smoke_${suffix}`,
      rawSourcePacketDigest: rawDigest,
      scope: "global_hive",
      trigger,
      boardActionPressure: {
        requiresAction: true,
        motionState: "needs_routing",
        projectsWithoutLiveTasks: ["task_node_core_product"],
      },
      badgeEligibility: {
        eligibleCandidateCount: 2,
        candidates: [
          { accountId: "acct_hive_brain_smoke_1", handle: "operator_one", verifiedBadges: ["core_contributor"] },
          { accountId: "acct_hive_brain_smoke_2", handle: "operator_two", verifiedBadges: ["qa_worker"] },
        ],
      },
      taskState: {
        summary: {
          outstandingNetworkTaskCount: 3,
        },
      },
      openFollowups: [{ taskId: "task_hive_brain_followup", status: "open" }],
      operatorStandingPolicy: [{ sourceId: "hive_context_smoke", body: "Route code tasks only to Core Contributors." }],
      recentBoardManagerRuns: [],
      secretaryPacket: {
        id: secretaryPacketId,
        sourceDigest: rawDigest,
        packetDigest: secretaryPacketDigest,
      },
    };

    await query(
      `
        INSERT INTO board_manager_secretary_packets (
          id, scope, packet_type, source_digest, packet_digest,
          packet_json, packet_text, provider, model, prompt_version,
          response_id, usage_json, status
        )
        VALUES ($1, 'global_hive', 'board_triage', $2, $3, $4::jsonb, $5, 'deepseek', 'deepseek/deepseek-v4-pro', 'board_manager_secretary_v1', $6, $7::jsonb, 'current')
      `,
      [
        secretaryPacketId,
        rawDigest,
        secretaryPacketDigest,
        JSON.stringify({
          motion_state: "needs_routing",
          requires_attention: true,
          operator_standing_policy: ["Route code tasks only to Core Contributors."],
          facts_to_preserve: ["acct_hive_brain_smoke_1 has core_contributor"],
          deduplication_watchlist: ["task_hive_brain_followup"],
        }),
        "Secretary report preserves badge eligibility and routing pressure.",
        `resp_hive_brain_smoke_${suffix}`,
        JSON.stringify({ totalTokens: 42, costUsd: 0.0001 }),
      ]
    );

    const started = await startBoardManagerRun({
      scope: "global_hive",
      managerId: "hive_brain_smoke_manager",
      trigger,
      sourcePacket,
      dryRun: false,
      model: "z-ai/glm-5.2",
      reasoningEffort: "high",
      provider: "openrouter",
      sessionMode: "deepseek_secretary_packet",
    });
    runId = started.run.id;
    await updateBoardManagerRunOutput({
      runId,
      outputText: "{\"action\":\"initiate_network_task\"",
    });

    const live = await getHiveBrainLive();
    assert.equal(live.run.id, runId);
    assert.match(live.run.outputText, /initiate_network_task/);

    await completeBoardManagerRun({
      runId,
      decision: {
        action: "initiate_network_task",
        target_type: "network_project",
        target_id: "task_node_core_product",
        reason: "Smoke validates Hive Brain full audit detail.",
        confidence: 0.9,
        decision_basis: {
          source_facts: ["requiresAction=true", "eligibleCandidateCount=2"],
          tradeoffs: ["Read-only audit view does not execute actions."],
          rejected_actions: [],
          risk_notes: [],
          next_check: "Inspect Hive Brain run detail.",
        },
        payload: {
          summary: "Hive Brain smoke task generation proof.",
          network_task: {
            task_work_type: "code_task",
            required_badge_id: "core_contributor",
            operating_badge_id: "core_contributor",
            candidate_account_id: "acct_hive_brain_smoke_1",
            candidate_wallet_address: "rHiveBrainSmoke",
            reward_min_pft: 100,
            reward_max_pft: 100,
          },
        },
      },
      outputText: JSON.stringify({ action: "initiate_network_task", target_id: "task_node_core_product" }),
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.0002 },
    });
    await recordBoardManagerActionResult({
      runId,
      action: "initiate_network_task",
      targetType: "network_project",
      targetId: "task_node_core_product",
      result: { executed: true, jobId: `nettaskjob_hive_brain_smoke_${suffix}` },
    });

    const list = await listHiveBrainRuns({ queryText: trigger, limit: 5 });
    assert.ok(list.runs.some((run) => run.id === runId), "run list should search recent run metadata");
    const detail = await getHiveBrainRunDetail({ runId });
    assert.equal(detail.ok, true);
    assert.equal(detail.highlights.requiresAction, true);
    assert.equal(detail.highlights.eligibleCandidateCount, 2);
    assert.match(detail.secretaryReport.packetText, /badge eligibility/);
    assert.equal(detail.decision.selectedAction, "initiate_network_task");
    assert.equal(detail.result.actionResults[0].targetId, "task_node_core_product");
    assert.ok(detail.sourcePacket.badgeEligibility.candidates.length === 2);

    console.log(`hive brain smoke ok: ${runId}`);
  } finally {
    await cleanup(runId);
    await closePool();
  }
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error);
  process.exitCode = 1;
});
