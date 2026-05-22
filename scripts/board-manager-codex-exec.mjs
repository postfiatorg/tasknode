import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt } from "../server/prompt-registry.js";
import { closePool } from "../server/db/pool.js";
import {
  buildBoardManagerSourcePacket,
  claimBoardManagerLease,
  completeBoardManagerRun,
  formatBoardManagerCodexPrompt,
  normalizeBoardManagerDecision,
  releaseBoardManagerLease,
  startBoardManagerRun,
} from "../server/repositories/board-manager.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "schemas", "board-manager-action.schema.json");

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function parseJson(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("board_manager_empty_codex_output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("board_manager_invalid_codex_json");
  }
}

function usage() {
  return [
    "Usage: npm run board-manager:codex -- [options]",
    "",
    "Options:",
    "  --trigger <name>       Run trigger label. Default: manual_codex_exec",
    "  --scope <scope>        Manager scope. Default: global_hive",
    "  --model <model>        Codex model. Default: gpt-5.5",
    "  --reasoning <effort>   Codex reasoning effort. Default: xhigh",
    "  --packet-only          Build and print the source packet without calling Codex.",
    "  --no-record           Do not write board_manager_runs.",
    "  --no-lease            Do not claim board_manager_leases.",
    "  --json                Print machine-readable JSON.",
  ].join("\n");
}

async function runCodexExec({ prompt, model, reasoningEffort }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tasknode-board-manager-"));
  const outputPath = path.join(tempDir, "decision.json");
  try {
    const args = [
      "exec",
      "--ephemeral",
      "--cd",
      repoRoot,
      "--sandbox",
      "read-only",
      "--model",
      model,
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ];
    const child = spawn("codex", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(prompt);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise((resolve) => {
      child.on("close", resolve);
    });
    if (code !== 0) {
      const error = new Error(`codex_exec_failed:${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }
    const outputText = await readFile(outputPath, "utf8");
    return { outputText, stdout, stderr, decision: normalizeBoardManagerDecision(parseJson(outputText)) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }

  const trigger = argValue("--trigger", "manual_codex_exec");
  const scope = argValue("--scope", "global_hive");
  const model = argValue("--model", process.env.TASKNODE_BOARD_MANAGER_CODEX_MODEL || "gpt-5.5");
  const reasoningEffort = argValue("--reasoning", process.env.TASKNODE_BOARD_MANAGER_CODEX_REASONING || "xhigh");
  const packetOnly = hasArg("--packet-only");
  const record = !hasArg("--no-record");
  const useLease = !hasArg("--no-lease");
  const json = hasArg("--json");

  const sourcePacket = await buildBoardManagerSourcePacket({ trigger, scope });
  if (packetOnly) {
    console.log(JSON.stringify({ ok: true, packet: sourcePacket }, null, 2));
    await closePool();
    return;
  }

  const prompt = formatBoardManagerCodexPrompt({
    prompt: loadPrompt("hive/board_manager_v1.md"),
    sourcePacket,
  });

  let lease = null;
  let run = null;
  try {
    if (useLease) {
      lease = await claimBoardManagerLease({
        scope,
        ttlSeconds: Number(process.env.TASKNODE_BOARD_MANAGER_LEASE_SECONDS || 900),
        metadata: { trigger, model, reasoningEffort, dry_run: true },
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
        dryRun: true,
        model,
        reasoningEffort,
      });
      run = started.run;
    }

    const result = await runCodexExec({ prompt, model, reasoningEffort });
    if (record && run?.id) {
      await completeBoardManagerRun({
        runId: run.id,
        decision: result.decision,
        outputText: result.outputText,
      });
    }

    const output = {
      ok: true,
      dryRun: true,
      runId: run?.id || "",
      sourcePacketDigest: sourcePacket.sourcePacketDigest,
      decision: result.decision,
    };
    console.log(json ? JSON.stringify(output, null, 2) : [
      "board manager codex exec ok",
      `run: ${output.runId || "not recorded"}`,
      `source: ${output.sourcePacketDigest}`,
      `action: ${result.decision.action}`,
      `target: ${result.decision.target_type || "-"} ${result.decision.target_id || ""}`.trim(),
      `confidence: ${result.decision.confidence}`,
      `reason: ${result.decision.reason}`,
    ].join("\n"));
  } catch (error) {
    if (record && run?.id) {
      await completeBoardManagerRun({
        runId: run.id,
        status: "failed",
        error: error?.message || String(error),
        outputText: [error?.stdout || "", error?.stderr || ""].filter(Boolean).join("\n").slice(0, 120000),
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
