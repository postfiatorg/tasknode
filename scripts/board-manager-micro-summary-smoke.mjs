import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const { databaseEnabled, query, closePool } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const {
  buildBoardManagerSourcePacket,
  completeBoardManagerRun,
  recordBoardManagerActionResult,
  startBoardManagerRun,
} = await import("../server/repositories/board-manager.js");

const suffix = `${Date.now()}`;
const trigger = `micro_summary_packet_probe_${suffix}`;

async function cleanup(runId = "") {
  if (runId) {
    await query("DELETE FROM board_manager_runs WHERE id = $1", [runId]);
  }
  await query("DELETE FROM board_manager_runs WHERE trigger = $1", [trigger]);
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager micro summary smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  let runId = "";
  try {
    const sourcePacket = {
      sourcePacketDigest: `digest_${suffix}`,
      schema: "pf.hive.board_manager.source.v0",
    };
    const started = await startBoardManagerRun({
      scope: "global_hive",
      managerId: "board_manager_micro_summary_probe",
      trigger,
      sourcePacket,
      dryRun: false,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sessionMode: "created",
    });
    runId = started.run.id;

    await completeBoardManagerRun({
      runId,
      decision: {
        action: "initiate_network_task",
        target_type: "network_project",
        target_id: "task_node",
        reason: "A live project has a clear routing need and one eligible contributor is available.",
        confidence: 0.82,
        payload: {
          summary: "Queue one Network Task for the Task Node project.",
          next_steps: ["Let the network-task worker generate the concrete offer."],
          network_task: {
            task_work_type: "code_task",
            required_badge_id: "core_contributor",
            operating_badge_id: "core_contributor",
            badge_work_type: "code_task",
            badge_reason: "Micro-summary smoke uses the Core Contributor lane.",
            badge_reward_cap_pft: 30000,
            badge_evidence_requirements: ["PR or commit URL."],
            discord_evidence_required: true,
            task_class: "network",
            candidate_account_id: "acct_micro_summary_probe",
            candidate_wallet_address: "rMicroSummaryProbe",
            project_need_summary: "Verify micro summaries make Board Manager runs compact.",
            routing_reason: "The candidate is the only eligible probe contributor.",
            reward_min_pft: 100,
            reward_max_pft: 100,
          },
        },
      },
      outputText: "{\"action\":\"initiate_network_task\"}",
    });

    await recordBoardManagerActionResult({
      runId,
      action: "initiate_network_task",
      targetType: "network_project",
      targetId: "task_node",
      result: {
        executed: true,
        allocationId: `netalloc_micro_summary_${suffix}`,
        jobId: `nettaskjob_micro_summary_${suffix}`,
        projectId: "task_node",
        rewardBandPft: [10000, 20000],
      },
    });

    const stored = await query(
      `
        SELECT micro_summary_json, micro_summary_text
        FROM board_manager_runs
        WHERE id = $1
      `,
      [runId]
    );
    const row = stored.rows[0];
    assert.equal(row.micro_summary_json.schema, "pf.hive.board_manager.run_summary.v1");
    assert.equal(row.micro_summary_json.action, "initiate_network_task");
    assert.match(row.micro_summary_text, /queued Network Task allocation/);
    assert.ok(Buffer.byteLength(row.micro_summary_text, "utf8") < 2000);

    const packet = await buildBoardManagerSourcePacket({
      trigger: "board_manager_micro_summary_packet_check",
      scope: "global_hive",
    });
    const compactRun = packet.recentBoardManagerRuns.find((item) => item.id === runId);
    assert.ok(compactRun, "new run should appear in compact recent Board Manager packet");
    assert.equal(compactRun.action, "initiate_network_task");
    assert.equal(Object.hasOwn(compactRun, "decision"), false);
    assert.equal(Object.hasOwn(compactRun, "actionPayload"), false);
    assert.match(compactRun.microSummaryText, /queued Network Task allocation/);
    assert.ok(Buffer.byteLength(JSON.stringify(compactRun), "utf8") < 3500);

    console.log("board manager micro summary smoke ok");
  } finally {
    await cleanup(runId).catch(() => null);
    await closePool();
  }
}

main().catch(async (error) => {
  await closePool().catch(() => null);
  console.error(error?.message || error);
  process.exitCode = 1;
});
