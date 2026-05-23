import assert from "node:assert/strict";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const { databaseEnabled, query, closePool } = await import("../server/db/pool.js");
const { migrateDatabase } = await import("../server/db/migrate.js");
const { buildBoardManagerSourcePacket } = await import("../server/repositories/board-manager.js");

const suffix = `${Date.now()}`;
const projectId = `board_source_packet_project_${suffix}`;
const completedTaskId = `task_board_packet_completed_${suffix}`;
const outstandingTaskId = `task_board_packet_outstanding_${suffix}`;
const pendingAllocationId = `netalloc_board_packet_${suffix}`;
const pendingJobId = `nettaskjob_board_packet_${suffix}`;
const pendingRequestId = `req_board_packet_${suffix}`;

async function cleanup() {
  await query("DELETE FROM task_events WHERE task_id = ANY($1::text[])", [[completedTaskId, outstandingTaskId]]);
  await query("DELETE FROM task_projections WHERE task_id = ANY($1::text[])", [[completedTaskId, outstandingTaskId]]);
  await query("DELETE FROM network_projects WHERE id = $1", [projectId]);
}

async function main() {
  if (!databaseEnabled()) {
    console.log("board manager source packet smoke skipped: database not configured");
    return;
  }

  await migrateDatabase();
  await cleanup();

  try {
    await query(
      `
        INSERT INTO network_projects (id, type, title, summary, objective, status, origin, priority)
        VALUES ($1, 'Protocol Applications', 'Board source packet smoke', 'Smoke project.', 'Verify Board Manager task content awareness.', 'active', 'smoke', 1)
      `,
      [projectId]
    );

    await query(
      `
        INSERT INTO task_projections (
          task_id, account_id, subject_wallet, request_id, status, title, description, task_kind,
          reward_offer_pft, reward_actual_pft, submission_requirement_text, metadata_json, updated_at
        )
        VALUES ($1, 'acct_board_packet_smoke', 'rBoardPacketSmoke', 'req_completed_packet_smoke',
          'rewarded', 'Completed Network Task Content Smoke',
          'Completed task description that the Board Manager must be able to read.',
          'network', 12000, 11000,
          'Submit proof that the completed task content is in the source packet.',
          $2::jsonb, now() - interval '10 minutes')
      `,
      [
        completedTaskId,
        JSON.stringify({
          generatedTask: {
            steps: ["Write the completed content smoke.", "Submit readable proof."],
            network_task: { project_id: projectId, task_class: "network" },
          },
        }),
      ]
    );

    await query(
      `
        INSERT INTO task_events (id, task_id, account_id, wallet_address, event_type, source_tx_hash, source_cid, payload_json, occurred_at)
        VALUES ($1, $2, 'acct_board_packet_smoke', 'rBoardPacketSmoke', 'pf.task.reward_decision.v1',
          $3, $4, $5::jsonb, now() - interval '9 minutes')
      `,
      [
        `taskevt_completed_reward_${suffix}`,
        completedTaskId,
        `tx_completed_${suffix}`,
        `cid_completed_${suffix}`,
        JSON.stringify({
          score: {
            decision: "reward",
            reward_pft: "11000",
            reason: "Completed task reward summary that should be available to the Board Manager.",
            user_feedback: "Completed task outcome summary for source packet smoke.",
          },
        }),
      ]
    );

    await query(
      `
        INSERT INTO network_project_task_refs (id, project_id, task_id, request_id, title, state, assignee_wallet, reward_pft, source, updated_at)
        VALUES ($1, $2, $3, 'req_completed_packet_smoke', 'Completed Network Task Content Smoke',
          'rewarded', 'rBoardPacketSmoke', 11000, 'network_task_generation', now() - interval '9 minutes')
      `,
      [`nettaskref_${completedTaskId}`, projectId, completedTaskId]
    );

    await query(
      `
        INSERT INTO task_projections (
          task_id, account_id, subject_wallet, request_id, status, title, description, task_kind,
          reward_offer_pft, reward_actual_pft, submission_requirement_text, metadata_json, updated_at
        )
        VALUES ($1, 'acct_board_packet_smoke', 'rBoardPacketSmoke', 'req_outstanding_packet_smoke',
          'accepted', 'Outstanding Network Task Content Smoke',
          'Outstanding task description that the Board Manager must see before completion.',
          'network', 13000, 0,
          'Submit proof that the outstanding task remains visible to the Board Manager.',
          $2::jsonb, now() - interval '5 minutes')
      `,
      [
        outstandingTaskId,
        JSON.stringify({
          generatedTask: {
            steps: ["Keep outstanding task content visible."],
            network_task: { project_id: projectId, task_class: "network" },
          },
        }),
      ]
    );

    await query(
      `
        INSERT INTO network_project_task_refs (id, project_id, task_id, request_id, title, state, assignee_wallet, reward_pft, source, updated_at)
        VALUES ($1, $2, $3, 'req_outstanding_packet_smoke', 'Outstanding Network Task Content Smoke',
          'accepted', 'rBoardPacketSmoke', 13000, 'network_task_generation', now() - interval '5 minutes')
      `,
      [`nettaskref_${outstandingTaskId}`, projectId, outstandingTaskId]
    );

    await query(
      `
        INSERT INTO network_task_allocations (
          id, idempotency_key, project_id, task_class, allocation_status,
          candidate_account_id, candidate_wallet_address, allocation_reason_summary,
          project_need_summary, reward_min_pft, reward_max_pft
        )
        VALUES ($1, $2, $3, 'network', 'queued',
          'acct_board_packet_smoke', 'rBoardPacketSmoke',
          'Pending routing reason visible to Board Manager.',
          'Pending project need visible before a generated task exists.',
          10000, 15000)
      `,
      [pendingAllocationId, `board_packet:${suffix}`, projectId]
    );

    await query(
      `
        INSERT INTO network_task_generation_jobs (
          id, idempotency_key, allocation_id, project_id, task_class,
          candidate_account_id, candidate_wallet_address, reward_min_pft,
          reward_max_pft, status, request_id, source_payload_json
        )
        VALUES ($1, $2, $3, $4, 'network', 'acct_board_packet_smoke',
          'rBoardPacketSmoke', 10000, 15000, 'queued', $5, $6::jsonb)
      `,
      [
        pendingJobId,
        `board_packet:${suffix}`,
        pendingAllocationId,
        projectId,
        pendingRequestId,
        JSON.stringify({
          networkTask: {
            taskClass: "network",
            projectNeedSummary: "Pending project need visible before a generated task exists.",
            allocationReasonSummary: "Pending routing reason visible to Board Manager.",
          },
        }),
      ]
    );

    const packet = await buildBoardManagerSourcePacket({
      trigger: "board_manager_source_packet_smoke",
      scope: "global_hive",
    });

    assert.equal(packet.networkTaskContent.schema, "pf.hive.network_task_content_snapshot.v1");
    assert.ok(packet.networkTaskContent.completed.some((task) => (
      task.taskId === completedTaskId &&
      task.description.includes("Completed task description") &&
      task.rewardActualPft === 11000 &&
      task.rewardSummary.includes("Completed task outcome summary")
    )));
    assert.ok(packet.networkTaskContent.outstanding.some((task) => (
      task.taskId === outstandingTaskId &&
      task.description.includes("Outstanding task description") &&
      task.rewardOfferPft === 13000 &&
      task.state === "accepted"
    )));
    assert.ok(packet.networkTaskContent.pendingGeneration.some((task) => (
      task.generationJobId === pendingJobId &&
      task.projectNeedSummary.includes("Pending project need")
    )));
    assert.match(packet.networkTaskContent.text, /Completed task description/);
    assert.match(packet.networkTaskContent.text, /Outstanding task description/);
    assert.match(packet.networkTaskContent.text, /Pending project need/);

    console.log("board manager source packet smoke ok");
  } finally {
    await cleanup();
  }
}

try {
  await main();
} finally {
  await closePool();
}
