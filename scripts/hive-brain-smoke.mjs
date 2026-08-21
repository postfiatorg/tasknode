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
  listHiveBrainTaskGenerationHistory,
  listHiveBrainRuns,
} = await import("../server/repositories/hive-brain.js");

const suffix = `${Date.now()}`;
const trigger = `hive_brain_smoke_${suffix}`;
const rawDigest = `raw_hive_brain_smoke_${suffix}`;
const secretaryPacketId = `bmsec_hive_brain_smoke_${suffix}`;
const secretaryPacketDigest = `bmsec_digest_hive_brain_smoke_${suffix}`;
const taskManagerRunId = `hivetaskmgr_hive_brain_smoke_${suffix}`;
const projectId = `project_hive_brain_history_${suffix}`;
const allocationId = `alloc_hive_brain_history_${suffix}`;
const jobId = `nettaskjob_hive_brain_history_${suffix}`;
const requestId = `req_hive_brain_history_${suffix}`;
const taskId = `task_hive_brain_history_${suffix}`;

async function cleanup(runId = "") {
  if (runId) await query("DELETE FROM board_manager_runs WHERE id = $1", [runId]);
  await query("DELETE FROM board_manager_runs WHERE trigger = $1", [trigger]);
  await query("DELETE FROM board_manager_secretary_packets WHERE id = $1", [secretaryPacketId]);
  await query("DELETE FROM hive_decision_runs WHERE id = $1", [taskManagerRunId]);
  await query("DELETE FROM task_projections WHERE task_id = $1", [taskId]);
  await query("DELETE FROM network_task_generation_jobs WHERE id = $1", [jobId]);
  await query("DELETE FROM network_task_allocations WHERE id = $1", [allocationId]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
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

    const selection = {
      action: "create_task",
      explanation: "Select the history smoke board and eligible operator for one concrete Network Task.",
      boardSelection: {
        projectId,
        projectTitle: "Hive Brain Task History Smoke",
      },
      operatorSelection: {
        accountId: "acct_hive_brain_history",
        walletAddress: "rHiveBrainHistory",
        requiredBadgeId: "core_contributor",
        operatingBadgeId: "core_contributor",
        badgeWorkType: "code_task",
        taskWorkType: "code_task",
      },
      taskIntent: {
        title: "Ship Hive Brain Task Generation History",
        projectNeedSummary: "Expose Task Manager selections and queued generation jobs in Hive Brain.",
        routingReason: "Smoke operator is idle and badge-eligible.",
        rewardMinPft: 100,
        rewardMaxPft: 150,
      },
    };
    await query(
      `
        INSERT INTO network_projects (
          id, type, title, summary, objective, about, status, priority, proposed_by, proposed_at
        )
        VALUES ($1, 'protocol_development', 'Hive Brain Task History Smoke', 'Smoke board', 'Validate task generation history', 'Smoke board for Hive Brain history.', 'active', 999, 'hive', current_date)
      `,
      [projectId]
    );
    await query(
      `
        INSERT INTO network_task_allocations (
          id, idempotency_key, project_id, task_class, allocation_status,
          candidate_account_id, candidate_wallet_address,
          allocation_reason_summary, project_need_summary,
          reward_min_pft, reward_max_pft
        )
        VALUES ($1, $2, $3, 'network', 'queued', 'acct_hive_brain_history', 'rHiveBrainHistory', $4, $5, 100, 150)
      `,
      [
        allocationId,
        `idem_hive_brain_history_${suffix}`,
        projectId,
        "Smoke operator is idle and badge-eligible.",
        "Expose Task Manager selections and queued generation jobs in Hive Brain.",
      ]
    );
    await query(
      `
        INSERT INTO network_task_generation_jobs (
          id, idempotency_key, allocation_id, project_id, task_class,
          candidate_account_id, candidate_wallet_address, reward_min_pft,
          reward_max_pft, status, trigger, board_manager_run_id,
          request_id, source_payload_digest, source_payload_json,
          source_payload_text, generated_task_payload, task_id,
          offer_cid, offer_tx_hash
        )
        VALUES ($1, $2, $3, $4, 'network', 'acct_hive_brain_history',
          'rHiveBrainHistory', 100, 150, 'generated', 'hive_task_manager',
          $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13)
      `,
      [
        jobId,
        `job_idem_hive_brain_history_${suffix}`,
        allocationId,
        projectId,
        taskManagerRunId,
        requestId,
        `source_digest_hive_brain_history_${suffix}`,
        JSON.stringify({
          schema: "pf.hive.network_task_generation_source.v1",
          project: { id: projectId, title: "Hive Brain Task History Smoke", type: "protocol_development" },
          candidate: { accountId: "acct_hive_brain_history", walletAddress: "rHiveBrainHistory" },
          networkTask: {
            requiredBadgeId: "core_contributor",
            badgeWorkType: "code_task",
            projectNeedSummary: "Expose Task Manager selections and queued generation jobs in Hive Brain.",
            allocationReasonSummary: "Smoke operator is idle and badge-eligible.",
            rewardMinPft: 100,
            rewardMaxPft: 150,
          },
          taskManager: { selection },
        }),
        "NETWORK TASK GENERATION SOURCE\nProject: Hive Brain Task History Smoke",
        JSON.stringify({ title: "Ship Hive Brain Task Generation History" }),
        taskId,
        "QmHiveBrainHistorySmoke",
        "TXHIVEBRAINHISTORYSMOKE",
      ]
    );
    await query(
      `
        INSERT INTO task_projections (
          task_id, account_id, subject_wallet, request_id, status, title,
          task_kind, reward_offer_pft, reward_actual_pft, source
        )
        VALUES ($1, 'acct_hive_brain_history', 'rHiveBrainHistory', $2, 'proposed',
          'Ship Hive Brain Task Generation History', 'network', 150, 0, 'hive_brain_smoke')
      `,
      [taskId, requestId]
    );
    await query(
      `
        INSERT INTO hive_decision_runs (
          id, scope, trigger, status, shadow, source_packet_digest,
          action_payload_json, decision_json, guardrail_result_json,
          result_json, reasoning_text, selected_action, provider, model,
          reasoning_effort, output_text, completed_at
        )
        VALUES ($1, 'hive_task_manager:global_hive', $2, 'completed', false,
          $3, $4::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, 'create_task',
          'mock', 'z-ai/glm-5.2', 'high', $8, now())
      `,
      [
        taskManagerRunId,
        `task_manager_history_smoke_${suffix}`,
        `source_digest_hive_brain_history_${suffix}`,
        JSON.stringify(selection),
        JSON.stringify({ ok: true, blocked: false, reasons: [] }),
        JSON.stringify({
          executed: true,
          executionResult: { executed: true, jobId, allocationId, requestId, taskId, status: "generated" },
          usage: { totalTokens: 1 },
        }),
        selection.explanation,
        JSON.stringify(selection),
      ]
    );
    const history = await listHiveBrainTaskGenerationHistory({ limit: 10 });
    assert.equal(history.ok, true);
    assert.ok(history.items.some((item) => item.kind === "task_manager_run" && item.id === taskManagerRunId), "Task Manager run should appear in task generation history");
    assert.ok(history.items.some((item) => item.kind === "generation_job" && item.jobId === jobId && item.taskId === taskId), "generation job should appear in task generation history");

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
