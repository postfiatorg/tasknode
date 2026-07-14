import { closePool } from "../server/db/pool.js";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import {
  buildBoardManagerSourcePacket,
  claimBoardManagerLease,
  completeBoardManagerRun,
  releaseBoardManagerLease,
  startBoardManagerRun,
  updateBoardManagerRunOutput,
} from "../server/repositories/board-manager.js";
import {
  boardManagerDecisionInput,
  boardManagerModel,
  boardManagerProvider,
  boardManagerReasoningEffort,
  fetchBoardManagerDecision,
} from "../server/board-manager-decision-provider.js";
import {
  boardManagerSecretaryEnabled,
  buildBoardManagerSecretaryDecisionPacket,
  ensureBoardManagerSecretaryPacket,
} from "../server/board-manager-secretary-packets.js";
import {
  appendHiveBrainRunOutput,
  completeHiveBrainRunLive,
  startHiveBrainRunLive,
} from "../server/hive-brain-live.js";

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

function oldBoardManagerExecutionEnabled() {
  return process.env.TASKNODE_BOARD_MANAGER_EXECUTION_ENABLED !== "false" &&
    process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE !== "true";
}

function legacyBoardManagerDisabled() {
  return process.env.TASKNODE_LEGACY_BOARD_MANAGER_ENABLED !== "true" && !hasArg("--force-legacy");
}

function legacyBoardManagerDecommissioned() {
  return process.env.TASKNODE_HIVE_DECISION_AGENT_ACTIVE === "true" &&
    process.env.TASKNODE_LEGACY_BOARD_MANAGER_ENABLED !== "true" &&
    !hasArg("--force-legacy");
}

function normalizeProvider(value = "openrouter") {
  const provider = String(value || "").toLowerCase();
  if (provider !== "openrouter") throw new Error(`board_manager_provider_unsupported:${provider || "unknown"}`);
  return provider;
}

function usage() {
  return [
    "Usage: npm run board-manager:model -- [options]",
    "",
    "Options:",
    "  --trigger <name>       Run trigger label. Default: manual_model_exec",
    "  --scope <scope>        Manager scope. Default: global_hive",
    "  --provider <provider>  Decision provider: openrouter. Default: openrouter",
    "  --model <model>        Provider model. Default: z-ai/glm-5.2",
    "  --reasoning <effort>   Provider reasoning effort. Default: high",
    "  --packet-only          Build and print the source packet without calling the model provider.",
    "  --prompt-only          Build and print the prompt packet without calling the model provider.",
    "  --no-secretary         Skip DeepSeek secretary packet compression and send the full source packet.",
    "  --execute              Execute supported action hooks after the model chooses an action.",
    "  --force-legacy         Allow the retired Board Manager LLM loop while Hive Decision Agent is active.",
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

async function buildDecisionSourcePacket({ rawSourcePacket, scope, noSecretary = false } = {}) {
  if (noSecretary || !boardManagerSecretaryEnabled()) {
    return {
      sourcePacket: rawSourcePacket,
      secretary: null,
      sourceMode: "full_source_packet",
    };
  }
  const secretary = await ensureBoardManagerSecretaryPacket({
    sourcePacket: rawSourcePacket,
    scope,
    packetType: "board_triage",
  });
  if (!secretary.ok || !secretary.packet) {
    throw new Error(`board_manager_secretary_packet_unavailable:${secretary.reason || "unknown"}`);
  }
  return {
    sourcePacket: buildBoardManagerSecretaryDecisionPacket({
      sourcePacket: rawSourcePacket,
      secretaryPacket: secretary.packet,
      reused: secretary.reused,
    }),
    secretary,
    sourceMode: "deepseek_secretary_packet",
  };
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const trigger = argValue("--trigger", "manual_model_exec");
  const scope = argValue("--scope", "global_hive");
  const provider = normalizeProvider(argValue("--provider", process.env.TASKNODE_BOARD_MANAGER_PROVIDER || boardManagerProvider()));
  const model = argValue("--model", boardManagerModel(provider));
  const reasoningEffort = argValue("--reasoning", boardManagerReasoningEffort());
  const packetOnly = hasArg("--packet-only");
  const promptOnly = hasArg("--prompt-only");
  const noSecretary = hasArg("--no-secretary");
  const execute = hasArg("--execute") && oldBoardManagerExecutionEnabled();
  const record = !hasArg("--no-record");
  const useLease = !hasArg("--no-lease");
  const json = hasArg("--json");

  if (legacyBoardManagerDecommissioned() && !packetOnly && !promptOnly) {
    const output = {
      ok: true,
      skipped: true,
      decommissioned: true,
      reason: "hive_decision_agent_active",
      replacement: "hive_decision_agent",
      execute: false,
      decision: {
        action: "do_nothing",
        reason: "Retired Board Manager LLM loop skipped because Hive Decision Agent is active.",
      },
    };
    console.log(json ? JSON.stringify(output, null, 2) : output.reason);
    await closePool();
    return;
  }
  if (legacyBoardManagerDisabled() && !packetOnly && !promptOnly) {
    const output = {
      ok: true,
      skipped: true,
      disabled: true,
      reason: "legacy_board_manager_disabled",
      replacement: "hive_board_secretary",
      execute: false,
      decision: {
        action: "do_nothing",
        reason: "Retired Board Manager LLM loop skipped because GLM Board Secretary memos replaced board action jobs.",
      },
    };
    console.log(json ? JSON.stringify(output, null, 2) : output.reason);
    await closePool();
    return;
  }

  const rawSourcePacket = await buildBoardManagerSourcePacket({ trigger, scope });
  const rawSourcePacketBytes = Buffer.byteLength(JSON.stringify(rawSourcePacket));
  const rawSourcePacketSectionBytes = packetSectionBytes(rawSourcePacket);
  if (packetOnly) {
    console.log(JSON.stringify({
      ok: true,
      sourceMode: "full_source_packet",
      sourcePacketBytes: rawSourcePacketBytes,
      sourcePacketSectionBytes: rawSourcePacketSectionBytes,
      packet: rawSourcePacket,
    }, null, 2));
    await closePool();
    return;
  }
  if (promptOnly) {
    console.log(JSON.stringify(boardManagerDecisionInput({ sourcePacket: rawSourcePacket }), null, 2));
    await closePool();
    return;
  }

  const decisionSource = await buildDecisionSourcePacket({ rawSourcePacket, scope, noSecretary });
  const sourcePacket = decisionSource.sourcePacket;
  const sourcePacketBytes = Buffer.byteLength(JSON.stringify(sourcePacket));
  const sourcePacketSectionBytes = packetSectionBytes(sourcePacket);

  let lease = null;
  let run = null;
  let liveOutputText = "";
  let lastLiveOutputFlushMs = 0;
  async function flushLiveOutput({ force = false } = {}) {
    if (!run?.id || !liveOutputText) return;
    const now = Date.now();
    if (!force && now - lastLiveOutputFlushMs < 750) return;
    lastLiveOutputFlushMs = now;
    await updateBoardManagerRunOutput({
      runId: run.id,
      outputText: liveOutputText,
    }).catch(() => null);
  }
  try {
    if (useLease) {
      lease = await claimBoardManagerLease({
        scope,
        ttlSeconds: Number(process.env.TASKNODE_BOARD_MANAGER_LEASE_SECONDS || 900),
        metadata: {
          trigger,
          provider,
          model,
          reasoningEffort,
          dry_run: !execute,
          engine: "openrouter_chat_completions",
          source_mode: decisionSource.sourceMode,
          raw_source_packet_digest: rawSourcePacket.sourcePacketDigest,
          secretary_packet_id: decisionSource.secretary?.packet?.id || "",
        },
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
        provider,
        sessionMode: decisionSource.sourceMode === "deepseek_secretary_packet"
          ? "secretary_openrouter"
          : "stateless_openrouter_chat",
      });
      run = started.run;
      startHiveBrainRunLive({
        runId: run?.id || "",
        metadata: {
          scope,
          trigger,
          provider,
          model,
          reasoningEffort,
          sourceMode: decisionSource.sourceMode,
          sourcePacketDigest: sourcePacket.sourcePacketDigest,
        },
      });
    }

    const result = await fetchBoardManagerDecision({
      sourcePacket,
      provider,
      model,
      reasoningEffort,
      onOutputDelta: run?.id
        ? async (delta) => {
            liveOutputText = `${liveOutputText}${delta || ""}`;
            appendHiveBrainRunOutput({ runId: run.id, delta });
            await flushLiveOutput();
          }
        : null,
    });
    if (run?.id) {
      liveOutputText = result.outputText || liveOutputText;
      await flushLiveOutput({ force: true });
    }
    if (record && run?.id) {
      await completeBoardManagerRun({
        runId: run.id,
        decision: result.decision,
        outputText: result.outputText,
        usage: result.usage,
      });
      completeHiveBrainRunLive({
        runId: run.id,
        status: "completed",
        outputText: result.outputText,
        usage: result.usage,
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
      engine: "openrouter_chat_completions",
      provider: result.provider,
      model: result.model,
      reasoningEffort,
      responseId: result.responseId,
      sourceMode: decisionSource.sourceMode,
      sourcePacketDigest: sourcePacket.sourcePacketDigest,
      rawSourcePacketDigest: rawSourcePacket.sourcePacketDigest,
      rawSourcePacketBytes,
      sourcePacketBytes,
      sourcePacketSectionBytes,
      secretaryPacket: decisionSource.secretary
        ? {
            id: decisionSource.secretary.packet?.id || "",
            reused: Boolean(decisionSource.secretary.reused),
            packetDigest: decisionSource.secretary.packet?.packetDigest || "",
            sourceDigest: decisionSource.secretary.packet?.sourceDigest || "",
            provider: decisionSource.secretary.packet?.provider || "",
            model: decisionSource.secretary.packet?.model || "",
            usage: decisionSource.secretary.packet?.usage || {},
          }
        : null,
      decision: result.decision,
      usage: result.usage,
      actionResult,
    };
    console.log(json ? JSON.stringify(output, null, 2) : [
      "board manager model exec ok",
      `run: ${output.runId || "not recorded"}`,
      `engine: ${output.engine}`,
      `source mode: ${output.sourceMode}`,
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
      await flushLiveOutput({ force: true });
      await completeBoardManagerRun({
        runId: run.id,
        status: "failed",
        error: error?.message || String(error),
      }).catch(() => null);
      completeHiveBrainRunLive({
        runId: run.id,
        status: "failed",
        error: error?.message || String(error),
      });
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
