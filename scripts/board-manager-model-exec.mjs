import { closePool } from "../server/db/pool.js";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import {
  buildBoardManagerSourcePacket,
  claimBoardManagerLease,
  completeBoardManagerRun,
  releaseBoardManagerLease,
  startBoardManagerRun,
} from "../server/repositories/board-manager.js";
import {
  boardManagerDecisionInput,
  boardManagerModel,
  boardManagerReasoningEffort,
  fetchBoardManagerDecision,
} from "../server/board-manager-decision-provider.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage: npm run board-manager:model -- [options]",
    "",
    "Options:",
    "  --trigger <name>       Run trigger label. Default: manual_model_exec",
    "  --scope <scope>        Manager scope. Default: global_hive",
    "  --model <model>        OpenAI model. Default: gpt-5.5-pro",
    "  --reasoning <effort>   OpenAI reasoning effort. Default: high",
    "  --packet-only          Build and print the source packet without calling OpenAI.",
    "  --prompt-only          Build and print the prompt packet without calling OpenAI.",
    "  --execute              Execute supported action hooks after the model chooses an action.",
    "  --no-record           Do not write board_manager_runs.",
    "  --no-lease            Do not claim board_manager_leases.",
    "  --json                Print machine-readable JSON.",
  ].join("\n");
}

function packetSectionBytes(packet = {}) {
  return Object.fromEntries(
    Object.entries(packet).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])
  );
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const trigger = argValue("--trigger", "manual_model_exec");
  const scope = argValue("--scope", "global_hive");
  const model = argValue("--model", boardManagerModel());
  const reasoningEffort = argValue("--reasoning", boardManagerReasoningEffort());
  const packetOnly = hasArg("--packet-only");
  const promptOnly = hasArg("--prompt-only");
  const execute = hasArg("--execute");
  const record = !hasArg("--no-record");
  const useLease = !hasArg("--no-lease");
  const json = hasArg("--json");

  const sourcePacket = await buildBoardManagerSourcePacket({ trigger, scope });
  const sourcePacketBytes = Buffer.byteLength(JSON.stringify(sourcePacket));
  const sourcePacketSectionBytes = packetSectionBytes(sourcePacket);
  if (packetOnly) {
    console.log(JSON.stringify({ ok: true, sourcePacketBytes, sourcePacketSectionBytes, packet: sourcePacket }, null, 2));
    await closePool();
    return;
  }
  if (promptOnly) {
    console.log(JSON.stringify(boardManagerDecisionInput({ sourcePacket }), null, 2));
    await closePool();
    return;
  }

  let lease = null;
  let run = null;
  try {
    if (useLease) {
      lease = await claimBoardManagerLease({
        scope,
        ttlSeconds: Number(process.env.TASKNODE_BOARD_MANAGER_LEASE_SECONDS || 900),
        metadata: { trigger, model, reasoningEffort, dry_run: !execute, engine: "openai_responses" },
      });
      if (!lease.ok) {
        throw new Error(`board_manager_lease_unavailable:${JSON.stringify(lease.active || {})}`);
      }
    }

    if (record) {
      const started = await startBoardManagerRun({
        scope,
        managerId: lease?.managerId || "board_manager_unleased",
        trigger,
        sourcePacket,
        dryRun: !execute,
        model,
        reasoningEffort,
        sessionMode: "stateless_openai_responses",
      });
      run = started.run;
    }

    const result = await fetchBoardManagerDecision({ sourcePacket, model, reasoningEffort });
    if (record && run?.id) {
      await completeBoardManagerRun({
        runId: run.id,
        decision: result.decision,
        outputText: result.outputText,
      });
    }
    const actionResult = execute
      ? await executeBoardManagerDecision({
          runId: run?.id || "",
          decision: result.decision,
          sourcePacket,
          dryRun: false,
        })
      : null;

    const output = {
      ok: true,
      dryRun: !execute,
      runId: run?.id || "",
      engine: "openai_responses",
      provider: result.provider,
      model: result.model,
      reasoningEffort,
      responseId: result.responseId,
      sourcePacketDigest: sourcePacket.sourcePacketDigest,
      sourcePacketBytes,
      sourcePacketSectionBytes,
      decision: result.decision,
      usage: result.usage,
      actionResult,
    };
    console.log(json ? JSON.stringify(output, null, 2) : [
      "board manager model exec ok",
      `run: ${output.runId || "not recorded"}`,
      `engine: ${output.engine}`,
      `model: ${output.model}`,
      `source: ${output.sourcePacketDigest}`,
      `action: ${result.decision.action}`,
      `target: ${result.decision.target_type || "-"} ${result.decision.target_id || ""}`.trim(),
      `confidence: ${result.decision.confidence}`,
      `reason: ${result.decision.reason}`,
      actionResult ? `executed: ${actionResult.result?.executed ? "yes" : "no"}` : "",
    ].filter(Boolean).join("\n"));
  } catch (error) {
    if (record && run?.id) {
      await completeBoardManagerRun({
        runId: run.id,
        status: "failed",
        error: error?.message || String(error),
      }).catch(() => null);
    }
    throw error;
  } finally {
    if (useLease && lease?.managerId) {
      await releaseBoardManagerLease({ scope, managerId: lease.managerId }).catch(() => null);
    }
    await closePool();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
