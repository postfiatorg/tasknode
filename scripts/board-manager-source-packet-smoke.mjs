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
const candidateAccountId = `acct_board_packet_candidate_${suffix}`;
const candidateWallet = `rBoardPacketCandidate${suffix.slice(-8)}`;
const candidateProfileId = `netprofile_board_packet_${suffix}`;
const privateRepoScope = "github:private/tasknodeofficial";
const orcAgentId = `orc_board_packet_${suffix}`;
const orcAccountId = `acct_board_packet_orc_${suffix}`;
const orcWallet = `rBoardPacketOrc${suffix.slice(-8)}`;
const orcTaskId = `task_board_packet_orc_${suffix}`;
const rollupAccountId = `acct_board_packet_rollup_${suffix}`;
const rollupWallet = `rBoardPacketRollup${suffix.slice(-8)}`;
const rollupTaskA = `task_board_packet_rollup_a_${suffix}`;
const rollupTaskB = `task_board_packet_rollup_b_${suffix}`;
const rollupRawText = `ROLLUP RAW REVIEW TEXT ${suffix} MUST NOT SURFACE`;

async function cleanup() {
  await query("DELETE FROM orc_operator_interactions WHERE orc_handle = $1", ["grashnuk_smoke"]);
  await query("DELETE FROM orc_run_journal WHERE orc_handle = $1", ["grashnuk_smoke"]);
  await query("DELETE FROM orc_task_review_states WHERE task_id = ANY($1::text[])", [[completedTaskId, rollupTaskA, rollupTaskB]]);
  await query("DELETE FROM orc_agents WHERE id = $1 OR handle = $2", [orcAgentId, "grashnuk_smoke"]);
  await query("DELETE FROM task_events WHERE task_id = ANY($1::text[])", [[completedTaskId, outstandingTaskId, orcTaskId, rollupTaskA, rollupTaskB]]);
  await query("DELETE FROM task_projections WHERE task_id = ANY($1::text[])", [[completedTaskId, outstandingTaskId, orcTaskId, rollupTaskA, rollupTaskB]]);
  await query("DELETE FROM network_task_profiles WHERE account_id = $1 OR id = $2", [candidateAccountId, candidateProfileId]);
  await query("DELETE FROM pftl_sync_wallets WHERE wallet_address = ANY($1::text[])", [[candidateWallet, orcWallet]]);
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
        UPDATE network_projects
        SET metadata_json = $2::jsonb
        WHERE id = $1
      `,
      [
        projectId,
        JSON.stringify({
          required_capabilities: [
            {
              capability_type: "repo_pr_access",
              scope: privateRepoScope,
              scope_label: "Task Node private repo PR access",
              visibility: "private",
            },
          ],
        }),
      ]
    );

    await query(
      `
        INSERT INTO pftl_sync_wallets (wallet_address, account_id, role, status, priority, last_hot_sync_at)
        VALUES ($1, $2, 'user', 'active', 100, now())
        ON CONFLICT (wallet_address) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          last_hot_sync_at = EXCLUDED.last_hot_sync_at
      `,
      [candidateWallet, candidateAccountId]
    );

    await query(
      `
        INSERT INTO pftl_sync_wallets (wallet_address, account_id, role, status, priority, last_hot_sync_at)
        VALUES ($1, $2, 'user', 'active', 100, now())
        ON CONFLICT (wallet_address) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          last_hot_sync_at = EXCLUDED.last_hot_sync_at
      `,
      [orcWallet, orcAccountId]
    );

    await query(
      `
        INSERT INTO orc_agents (
          id, handle, agent_id, account_id, wallet_address, role, status, active,
          runtime_kind, tmux_target, capacity_limit, metadata_json
        )
        VALUES ($1, 'grashnuk_smoke', 'agent_grashnuk_smoke', $2, $3, 'operator',
          'active', true, 'codex', 'grashnuk:0.0', 1, $4::jsonb)
      `,
      [
        orcAgentId,
        orcAccountId,
        orcWallet,
        JSON.stringify({ sessionPath: "/home/pfrpc/repos/tasknode_agent_sessions.json" }),
      ]
    );

    await query(
      `
        INSERT INTO task_projections (
          task_id, account_id, subject_wallet, request_id, status, title, description,
          task_kind, reward_offer_pft, reward_actual_pft, metadata_json, updated_at
        )
        VALUES ($1, $2, $3, 'req_orc_packet_smoke', 'accepted',
          'Orc Accounting Active Task Smoke',
          'Active Orc Network Task visible to Board Manager accounting.',
          'network', 10000, 0, '{}'::jsonb, now() - interval '2 minutes')
      `,
      [orcTaskId, orcAccountId, orcWallet]
    );

    await query(
      `
        INSERT INTO network_task_profiles (
          id, account_id, status, source_packet_digest, output_json, output_text,
          provider, model, prompt_version, prompt_digest, completed_at
        )
        VALUES ($1, $2, 'completed', $3, $4::jsonb, $5, 'smoke', 'smoke', 'network_task_profile_v2', 'smoke_digest', now())
      `,
      [
        candidateProfileId,
        candidateAccountId,
        `profile_digest_${suffix}`,
        JSON.stringify({
          summary: "Candidate has general product review experience but no verified private repo PR capability.",
          capabilities: {
            declared: [{ capability_type: "docs_review", scope_label: "Documentation review", status: "declared" }],
          },
        }),
        "Candidate profile: docs review only; no verified private repo PR capability.",
      ]
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
        VALUES ($1, $2, 'acct_board_packet_smoke', 'rBoardPacketSmoke', 'pf.reward.v1',
          $3, $4, $5::jsonb, now() - interval '9 minutes')
      `,
      [
        `taskevt_completed_reward_${suffix}`,
        completedTaskId,
        `tx_completed_${suffix}`,
        `cid_completed_${suffix}`,
        JSON.stringify({
          schema: "pf.reward.v1",
          reward_pft: "11000",
          economic_reward_pft: "11000",
          reward_summary: "Completed task reward summary that should be available to the Board Manager.",
          reward_score: {
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
        INSERT INTO orc_task_review_states (
          task_id, disposition, action_required, action_owner, confidence,
          categories, integrity_signals, summary, recommended_action,
          reviewer_handle, reviewer_wallet, source_task_ids, source_cids,
          source_tx_hashes, reviewed_at, updated_at
        )
        VALUES ($1, 'reviewed_follow_up', true, 'operator', 'high',
          ARRAY['task_routing']::text[], ARRAY[]::text[],
          'Orc review says this completed task needs a concrete follow-up.',
          'Route a concrete action task instead of another documentation pass.',
          'grashnuk_smoke', $2, ARRAY[$1]::text[], ARRAY[$3]::text[],
          ARRAY[$4]::text[], now(), now())
      `,
      [completedTaskId, orcWallet, `cid_completed_${suffix}`, `tx_completed_${suffix}`]
    );

    await query(
      `
        INSERT INTO task_projections (
          task_id, account_id, subject_wallet, request_id, status, title, description,
          task_kind, reward_offer_pft, reward_actual_pft, metadata_json, updated_at
        )
        VALUES
          ($1, $3, $4, $5, 'rewarded',
            'Rollup Integrity Task A',
            'Reviewed rollup task A for source packet smoke.',
            'network', 10000, 10000, '{}'::jsonb, now() - interval '7 minutes'),
          ($2, $3, $4, $6, 'rewarded',
            'Rollup Integrity Task B',
            'Reviewed rollup task B for source packet smoke.',
            'network', 10000, 10000, '{}'::jsonb, now() - interval '6 minutes')
      `,
      [rollupTaskA, rollupTaskB, rollupAccountId, rollupWallet, `req_${rollupTaskA}`, `req_${rollupTaskB}`]
    );

    await query(
      `
        INSERT INTO orc_task_review_states (
          task_id, disposition, action_required, action_owner, confidence,
          categories, integrity_signals, summary, recommended_action,
          reviewer_handle, reviewer_wallet, source_task_ids, source_cids,
          source_tx_hashes, reviewed_at, updated_at
        )
        VALUES
          ($1, 'reviewed_integrity_follow_up', true, 'operator', 'high',
            ARRAY['reward_accounting']::text[], ARRAY['reward_abuse_pattern']::text[],
            $4,
            'Raw rollup recommendation must not surface in review rollups.',
            'grashnuk_smoke', $3, ARRAY[$1]::text[], ARRAY[$5]::text[],
            ARRAY[$7]::text[], now() - interval '7 minutes', now() - interval '7 minutes'),
          ($2, 'reviewed_integrity_follow_up', true, 'operator', 'high',
            ARRAY['reward_accounting']::text[], ARRAY['reward_abuse_pattern']::text[],
            $4,
            'Raw rollup recommendation must not surface in review rollups.',
            'grashnuk_smoke', $3, ARRAY[$2]::text[], ARRAY[$6]::text[],
            ARRAY[$8]::text[], now() - interval '6 minutes', now() - interval '6 minutes')
      `,
      [
        rollupTaskA,
        rollupTaskB,
        rollupWallet,
        rollupRawText,
        `cid_${rollupTaskA}`,
        `cid_${rollupTaskB}`,
        `tx_${rollupTaskA}`,
        `tx_${rollupTaskB}`,
      ]
    );

    await query(
      `
        INSERT INTO orc_run_journal (
          id, orc_handle, agent_id, command, phase, status, task_id, cid, tx_hash
        )
        VALUES ($1, 'grashnuk_smoke', 'agent_grashnuk_smoke', 'review-task',
          'complete', 'ok', $2, $3, $4)
      `,
      [`orcrun_${suffix}`, completedTaskId, `cid_completed_${suffix}`, `tx_completed_${suffix}`]
    );

    await query(
      `
        INSERT INTO orc_operator_interactions (
          id, orc_handle, interaction_type, directive, issue, status
        )
        VALUES ($1, 'grashnuk_smoke', 'directive',
          'Review duplicate documentation rewards.', '', 'recorded')
      `,
      [`orcint_${suffix}`]
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
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 100_000);

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
    assert.equal(packet.capabilityInstrumentation.schema, "pf.hive.board_manager.capability_instrumentation.v1");
    assert.equal(packet.capabilityInstrumentation.status, "phase_b_capability_profiles_context_only");
    assert.equal(packet.capabilityInstrumentation.capability_profile_status, "persistent_capability_profiles_enabled_context_only");
    assert.equal(packet.capabilityInstrumentation.enforcement, "none_context_only");
    assert.equal(packet.capabilityInstrumentation.summary.requirement_count, 1);
    assert.ok(packet.capabilityInstrumentation.task_work_type_vocabulary.some((item) => item.id === "capability_gating_task"));
    assert.ok(packet.capabilityInstrumentation.capability_gaps.some((gap) => (
      gap.project_id === projectId &&
      gap.candidate_account_id === candidateAccountId &&
      gap.capability_type === "repo_pr_access" &&
      gap.recommended_task_work_type === "capability_gating_task"
    )));
    assert.equal(
      JSON.stringify(packet.capabilityInstrumentation).includes(privateRepoScope),
      false,
      "capability instrumentation must not expose the raw private repo scope"
    );
    assert.equal(packet.orcOperations.schema, "pf.hive.board_manager.orc_operations.v1");
    assert.equal(packet.orcOperations.enforcement, "none_context_only");
    assert.equal(packet.orcOperations.summary.activeAgentCount >= 1, true);
    assert.ok(packet.orcOperations.agents.some((agent) => (
      agent.handle === "grashnuk_smoke" &&
      agent.accountId === orcAccountId &&
      agent.walletAddress === orcWallet &&
      agent.currentTasks.outstandingNetworkTaskCount === 1
    )));
    assert.ok(packet.orcOperations.reviewQueue.recent.some((review) => (
      review.taskId === completedTaskId &&
      review.actionRequired === true &&
      review.reviewerHandle === "grashnuk_smoke"
    )));
    const reviewRollup = packet.orcOperations.reviewRollups.recent.find((rollup) => (
      rollup.walletAddress === rollupWallet &&
      rollup.accountId === rollupAccountId &&
      rollup.category === "reward_accounting"
    ));
    assert.ok(reviewRollup, "expected review rollup for repeated integrity follow-up wallet");
    assert.equal(reviewRollup.integrityFollowUpCount, 2);
    assert.equal(reviewRollup.integritySignalCounts.reward_abuse_pattern, 2);
    assert.deepEqual(reviewRollup.repeatedIntegritySignals, ["reward_abuse_pattern"]);
    assert.equal(reviewRollup.lastReviewedAction.taskId, rollupTaskB);
    assert.equal(JSON.stringify(packet.orcOperations.reviewRollups).includes(rollupRawText), false);
    assert.ok(packet.orcOperations.operatorInteractions.recent.some((interaction) => (
      interaction.orcHandle === "grashnuk_smoke" &&
      interaction.interactionType === "directive"
    )));
    assert.equal(JSON.stringify(packet.orcOperations).includes("tasknode_agent_sessions"), false);
    assert.equal(JSON.stringify(packet.orcOperations).includes("grashnuk:0.0"), false);

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
