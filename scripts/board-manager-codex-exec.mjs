import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompt } from "../server/prompt-registry.js";
import { closePool } from "../server/db/pool.js";
import { executeBoardManagerDecision } from "../server/board-manager-actions.js";
import {
  buildBoardManagerSourcePacket,
  claimBoardManagerLease,
  completeBoardManagerRun,
  formatBoardManagerCodexPrompt,
  getBoardManagerSession,
  normalizeBoardManagerDecision,
  releaseBoardManagerLease,
  startBoardManagerRun,
  updateBoardManagerRunSession,
  upsertBoardManagerSession,
} from "../server/repositories/board-manager.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(repoRoot, "schemas", "board-manager-action.schema.json");
const codexSessionsRoot = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");

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
    "  --execute              Execute supported action hooks after Codex chooses an action.",
    "  --fresh-session        Start a new persistent Codex session for this scope.",
    "  --resume-session <id>  Resume a specific Codex session id instead of the stored scope session.",
    "  --no-record           Do not write board_manager_runs.",
    "  --no-lease            Do not claim board_manager_leases.",
    "  --json                Print machine-readable JSON.",
  ].join("\n");
}

async function walkFiles(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

async function readCodexSessionMeta(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    const firstLine = text.split("\n").find(Boolean);
    const item = JSON.parse(firstLine || "{}");
    const payload = item?.payload || {};
    if (item?.type !== "session_meta" || !payload.id) return null;
    return {
      id: payload.id,
      cwd: payload.cwd || "",
      path: filePath,
      timestamp: payload.timestamp || item.timestamp || "",
    };
  } catch {
    return null;
  }
}

async function findCodexSession({ sessionId = "", sinceMs = 0 } = {}) {
  const files = await walkFiles(codexSessionsRoot);
  const candidates = [];
  for (const filePath of files) {
    const info = await stat(filePath).catch(() => null);
    if (!info || (sinceMs && info.mtimeMs < sinceMs - 5000)) continue;
    const meta = await readCodexSessionMeta(filePath);
    if (!meta) continue;
    if (sessionId && meta.id !== sessionId) continue;
    if (!sessionId && meta.cwd && path.resolve(meta.cwd) !== repoRoot) continue;
    candidates.push({ ...meta, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function runCodexExec({ prompt, model, reasoningEffort, resumeSessionId = "" }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tasknode-board-manager-"));
  const outputPath = path.join(tempDir, "decision.json");
  const startedAtMs = Date.now();
  try {
    const args = resumeSessionId
      ? [
          "exec",
          "--cd",
          repoRoot,
          "--sandbox",
          "read-only",
          "resume",
          "--model",
          model,
          "-c",
          `model_reasoning_effort="${reasoningEffort}"`,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          resumeSessionId,
          "-",
        ]
      : [
          "exec",
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
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    if (code !== 0) {
      const error = new Error(`codex_exec_failed:${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }
    const outputText = await readFile(outputPath, "utf8");
    const session = resumeSessionId
      ? await findCodexSession({ sessionId: resumeSessionId })
      : await findCodexSession({ sinceMs: startedAtMs });
    return {
      outputText,
      stdout,
      stderr,
      decision: normalizeBoardManagerDecision(parseJson(outputText)),
      session,
      sessionMode: resumeSessionId ? "resumed" : "created",
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function isContextWindowError(error) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n").toLowerCase();
  return text.includes("context window") || text.includes("ran out of room");
}

async function runCodexExecWithSessionFallback({ prompt, model, reasoningEffort, resumeSessionId = "", allowFreshFallback = true }) {
  try {
    return await runCodexExec({ prompt, model, reasoningEffort, resumeSessionId });
  } catch (error) {
    if (!resumeSessionId || !allowFreshFallback || !isContextWindowError(error)) throw error;
    const result = await runCodexExec({ prompt, model, reasoningEffort, resumeSessionId: "" });
    return {
      ...result,
      sessionMode: "rotated_after_context_overflow",
      previousSessionId: resumeSessionId,
    };
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
  const execute = hasArg("--execute");
  const freshSession = hasArg("--fresh-session");
  const explicitResumeSessionId = argValue("--resume-session", "");
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
  let storedSession = null;
  let resumeSessionId = "";
  let sessionMode = "created";
  try {
    if (useLease) {
      lease = await claimBoardManagerLease({
        scope,
        ttlSeconds: Number(process.env.TASKNODE_BOARD_MANAGER_LEASE_SECONDS || 900),
        metadata: { trigger, model, reasoningEffort, dry_run: !execute },
      });
      if (!lease.ok) {
        throw new Error(`board_manager_lease_unavailable:${JSON.stringify(lease.active || {})}`);
      }
    }

    storedSession = !freshSession && !explicitResumeSessionId
      ? await getBoardManagerSession({ scope })
      : null;
    resumeSessionId = explicitResumeSessionId || storedSession?.sessionId || "";
    sessionMode = resumeSessionId ? "resumed" : "created";

    if (record) {
      const started = await startBoardManagerRun({
        scope,
        managerId: lease?.managerId || "board_manager_unleased",
        trigger,
        sourcePacket,
        dryRun: !execute,
        model,
        reasoningEffort,
        codexSessionId: resumeSessionId,
        codexSessionPath: storedSession?.sessionPath || "",
        sessionMode,
      });
      run = started.run;
    }

    const result = await runCodexExecWithSessionFallback({
      prompt,
      model,
      reasoningEffort,
      resumeSessionId,
      allowFreshFallback: !explicitResumeSessionId,
    });
    const activeSession = result.session || storedSession || null;
    if (activeSession?.id) {
      await upsertBoardManagerSession({
        scope,
        sessionId: activeSession.id,
        sessionPath: activeSession.path || activeSession.sessionPath || "",
        model,
        reasoningEffort,
        lastRunId: run?.id || "",
        metadata: {
          trigger,
          session_mode: result.sessionMode || sessionMode,
          previous_session_id: result.previousSessionId || "",
          source_packet_digest: sourcePacket.sourcePacketDigest,
        },
      }).catch(() => null);
      if (record && run?.id) {
        await updateBoardManagerRunSession({
          runId: run.id,
          codexSessionId: activeSession.id,
          codexSessionPath: activeSession.path || activeSession.sessionPath || "",
          sessionMode: result.sessionMode || sessionMode,
        }).catch(() => null);
      }
    }
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
      codexSessionId: activeSession?.id || resumeSessionId || "",
      sessionMode: activeSession?.id ? result.sessionMode || sessionMode : "untracked",
      sourcePacketDigest: sourcePacket.sourcePacketDigest,
      decision: result.decision,
      actionResult,
    };
    console.log(json ? JSON.stringify(output, null, 2) : [
      "board manager codex exec ok",
      `run: ${output.runId || "not recorded"}`,
      `session: ${output.codexSessionId || "not tracked"} (${output.sessionMode})`,
      `source: ${output.sourcePacketDigest}`,
      `action: ${result.decision.action}`,
      `target: ${result.decision.target_type || "-"} ${result.decision.target_id || ""}`.trim(),
      `confidence: ${result.decision.confidence}`,
      `reason: ${result.decision.reason}`,
      actionResult ? `executed: ${actionResult.result?.executed ? "yes" : "no"}` : "",
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
