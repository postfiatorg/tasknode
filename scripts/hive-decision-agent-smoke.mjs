#!/usr/bin/env node

import assert from "node:assert/strict";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import { fetchHiveDecisionAgentDecision } from "../server/hive-decision-agent-provider.js";
import {
  applyHiveDecisionGuardrails,
  failStaleHiveDecisionRuns,
  getHiveDecisionRun,
  startHiveDecisionRun,
} from "../server/repositories/hive-decision-agent.js";
import { runHiveReportsWorkerOnce } from "../server/hive-reports-worker.js";
import { runHiveDecisionAgentOnce } from "../server/hive-decision-agent-worker.js";
import {
  executeHiveDecisionAgentAction,
  translateHiveDecisionToBoardDecision,
} from "../server/hive-decision-agent-actions.js";

process.env.TASKNODE_HIVE_REPORT_PROVIDER_MOCK = "true";
process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK = "true";
process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE = "false";

try {
  await migrateDatabase({ force: true });
  const reports = await runHiveReportsWorkerOnce({
    force: true,
    now: new Date("2026-06-25T13:00:00.000Z"),
  });
  assert.equal(reports.ok, true, JSON.stringify(reports.errors || []));
  assert.equal(reports.generated.length, 6, "all report types available");

  const decision = await runHiveDecisionAgentOnce({
    trigger: "smoke_shadow_tick",
    now: new Date("2026-06-25T13:05:00.000Z"),
  });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  assert.ok(decision.runId, "decision run id returned");

  const detail = await getHiveDecisionRun({ runId: decision.runId });
  assert.equal(detail.ok, true, "decision run detail loads");
  assert.equal(detail.run.shadow, true, "run is shadow");
  assert.equal(detail.run.status, "completed", "run completed");
  assert.ok(detail.run.reasoningText.length > 40, "explanation persisted");
  assert.ok(detail.run.optionsConsidered.length >= 1, "options considered persisted");
  assert.ok(detail.run.inputReportIds.length >= 6, "report ids captured");
  assert.equal(detail.run.result.executed, false, "no mutation executed");
  assert.equal(detail.run.sourcePacket.phase, "shadow", "source packet marks shadow mode");
  assert.equal(detail.run.sourcePacket.guardrails.structuralDedupRequired, true, "dedup guardrail in source");

  const activeCandidate = {
    accountId: "acct_smoke_candidate",
    walletAddress: "rSmokeCandidateWallet",
    verifiedBadges: ["core_contributor"],
    defaultBadge: "core_contributor",
    allowedWorkTypes: ["code_task"],
    rewardCaps: { code_task: 30000 },
    badgeDetails: [{
      badgeId: "core_contributor",
      label: "Core Contributor",
      maxPayoutPft: 30000,
      allowedWorkTypes: ["code_task"],
    }],
  };
  const activeSourcePacket = {
    schema: "pf.hive.decision_agent.source.v1",
    phase: "active",
    sourcePacketDigest: "smoke-active-digest",
    candidates: {
      all: [activeCandidate],
      idleEligibleContributors: [activeCandidate],
    },
    guardrails: {
      structuralDedupRequired: true,
      dedupIndex: [],
    },
  };
  const activeCreateDecision = {
    action: "create_task",
    explanation: "Route a code task to an idle core contributor.",
    optionsConsidered: [],
    informedBy: { taskStateRefs: ["acct_smoke_candidate"] },
    confidence: 0.71,
    payload: {
      project_id: "reward_integrity_sybil_defense",
      project_title: "Reward Integrity & Sybil Defense",
      candidate_account_id: "acct_smoke_candidate",
      candidate_wallet_address: "rSmokeCandidateWallet",
      required_badge_id: "core_contributor",
      operating_badge_id: "core_contributor",
      task_work_type: "code_task",
      badge_work_type: "code_task",
      title: "Smoke active Decision Agent route",
      project_need_summary: "Build a focused smoke artifact.",
      routing_reason: "Idle eligible contributor with Core Contributor badge.",
      dedup_basis: "No matching dedup index rows.",
      reward_min_pft: 100,
      reward_max_pft: 30000,
      badge_reward_cap_pft: 30000,
    },
  };
  const activeGuardrail = applyHiveDecisionGuardrails({
    decision: activeCreateDecision,
    sourcePacket: activeSourcePacket,
  });
  assert.equal(activeGuardrail.ok, true, JSON.stringify(activeGuardrail));
  assert.equal(activeGuardrail.shadowOnly, false, "active guardrail marks active mode");
  const translated = translateHiveDecisionToBoardDecision({
    decision: activeCreateDecision,
    sourcePacket: activeSourcePacket,
  });
  assert.equal(translated.action, "initiate_network_task", "create_task translates to existing action hook");
  assert.equal(translated.payload.network_task.required_badge_id, "core_contributor");
  assert.equal(translated.payload.network_task.reward_max_pft, 30000);

  const duplicateGuardrail = applyHiveDecisionGuardrails({
    decision: activeCreateDecision,
    sourcePacket: {
      ...activeSourcePacket,
      guardrails: {
        ...activeSourcePacket.guardrails,
        dedupIndex: [{
          source: "task_projection",
          taskId: "task_smoke_duplicate",
          accountId: "acct_smoke_candidate",
          walletAddress: "rSmokeCandidateWallet",
          status: "rewarded",
          title: "Smoke active Decision Agent route",
          summaryKey: "smoke active decision agent route build focused smoke artifact",
          active: false,
          terminal: true,
        }],
      },
    },
  });
  assert.equal(duplicateGuardrail.ok, false, "duplicate create_task is blocked");
  assert.ok(duplicateGuardrail.reasons.includes("structural_dedup_match"), "dedup reason recorded");

  const doNothingExecution = await executeHiveDecisionAgentAction({
    decision: {
      action: "do_nothing",
      explanation: "No action needed.",
      confidence: 0.5,
      payload: {},
    },
    sourcePacket: activeSourcePacket,
    guardrailResult: { ok: true, action: "do_nothing" },
    active: true,
  });
  assert.equal(doNothingExecution.executed, true, "active do_nothing executes through action adapter");
  assert.equal(doNothingExecution.translatedAction, "do_nothing");

  const stale = await startHiveDecisionRun({
    trigger: "smoke_stale_reclaim",
    sourcePacket: detail.run.sourcePacket,
    provider: "mock",
    model: "mock",
  });
  await query("UPDATE hive_decision_runs SET started_at = now() - interval '2 hours' WHERE id = $1", [stale.id]);
  const reclaimed = await failStaleHiveDecisionRuns({ staleMinutes: 30, limit: 5 });
  assert.ok(reclaimed.some((item) => item.id === stale.id), "stale running row reclaimed");

  const previousMock = process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousTimeout = process.env.TASKNODE_HIVE_DECISION_AGENT_TIMEOUT_MS;
  try {
    process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK = "false";
    process.env.OPENROUTER_API_KEY = "smoke-test-key";
    process.env.TASKNODE_HIVE_DECISION_AGENT_TIMEOUT_MS = "1000";
    await assert.rejects(
      () => fetchHiveDecisionAgentDecision({
        sourcePacket: detail.run.sourcePacket,
        fetchImpl: () => new Promise(() => {}),
      }),
      /hive_decision_agent_openrouter_timeout/,
      "provider hard timeout rejects stuck fetches"
    );
  } finally {
    process.env.TASKNODE_HIVE_DECISION_AGENT_PROVIDER_MOCK = previousMock;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousTimeout === undefined) delete process.env.TASKNODE_HIVE_DECISION_AGENT_TIMEOUT_MS;
    else process.env.TASKNODE_HIVE_DECISION_AGENT_TIMEOUT_MS = previousTimeout;
  }

  const reportIds = reports.generated.map((item) => item.reportId).filter(Boolean);
  await query("DELETE FROM hive_decision_runs WHERE id = ANY($1::text[])", [[decision.runId, stale.id]]);
  await query("DELETE FROM hive_reports WHERE id = ANY($1::text[])", [reportIds]);
  console.log(`hive-decision-agent-smoke ok: ${decision.runId}`);
} finally {
  await closePool().catch(() => null);
}
