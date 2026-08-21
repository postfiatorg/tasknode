#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const resultSchemaPath = path.join(repoRoot, "schemas", "grashnuk-harvest-codex-result.schema.json");
const defaultModel = process.env.TASKNODE_GRASHNUK_CODEX_MODEL || process.env.TASKNODE_BOARD_MANAGER_CODEX_MODEL || "gpt-5.5";
const defaultReasoning = process.env.TASKNODE_GRASHNUK_CODEX_REASONING || "xhigh";

function usage() {
  return [
    "Usage: npm run grashnuk:harvest-codex -- --task-id <harvest_task_id> [options]",
    "",
    "Options:",
    "  --task-id <id>          Task Accounting harvest row to handle.",
    "  --model <model>         Codex model. Default: TASKNODE_GRASHNUK_CODEX_MODEL or gpt-5.5.",
    "  --reasoning <effort>    model_reasoning_effort. Default: xhigh.",
    "  --packet-only           Print the prompt packet without invoking Codex.",
    "  --execute               Actually run codex exec.",
    "  --no-danger             Use --sandbox workspace-write instead of bypassing approvals/sandbox.",
    "  --json                  Print machine-readable wrapper output.",
  ].join("\n");
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function parseCodexJson(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("grashnuk_codex_invalid_json_result");
  }
}

function buildPrompt({ taskId = "" } = {}) {
  return [
    "You are Grashnuk, the wallet-identified Task Node Orc agent.",
    "",
    "Mission:",
    `Handle exactly one Task Accounting harvester row: ${taskId}.`,
    "Do the work in this separate Codex process, not by relying on the outer operator.",
    "",
    "Hard rules:",
    "- Never print, cat, echo, summarize, or expose seeds, mnemonics, session tokens, cookies, private keys, or raw auth headers.",
    "- Do not approve your own reward, decide reward policy, claw back rewards, ban users, or perform enforcement.",
    "- A documentation packet is not a fix. If the harvest describes a real product bug, fix the product behavior or prove it is already fixed/not a bug.",
    "- Only resolve the harvest after the personal follow-up task has independent reward evidence, unless the correct outcome is not_a_bug or duplicate and the proof is concrete.",
    "- If you modify code, keep the change scoped, run focused checks, commit it, push main if appropriate, deploy with npm run fly:deploy:prod if production behavior is required, and verify production /health before claiming fixed.",
    "",
    "Use this local helper for signed Grashnuk actions and harvest API calls:",
    `- node scripts/grashnuk-harvest-tools.mjs inspect --task-id ${taskId}`,
    `- node scripts/grashnuk-harvest-tools.mjs checkout --task-id ${taskId}`,
    "- node scripts/grashnuk-harvest-tools.mjs request-task --task-id <harvest_id> --detail-file <request_text_file>",
    "- node scripts/grashnuk-harvest-tools.mjs wait-generated --request-id <request_id>",
    "- node scripts/grashnuk-harvest-tools.mjs run-personal-task --task-id <personal_task_id> --evidence-file <evidence_file>",
    "- node scripts/grashnuk-harvest-tools.mjs wait-reward --task-id <personal_task_id> --verification-response-file <response_file>",
    "- node scripts/grashnuk-harvest-tools.mjs resolve --task-id <harvest_id> --outcome <fixed|already_fixed|not_a_bug|duplicate> --note-file <note_file>",
    "",
    "Suggested loop:",
    "1. Inspect the harvest and checkout state.",
    "2. Check out the row if it is not already checked out by Grashnuk.",
    "3. Decide whether the reported issue is real, already fixed, not a bug, duplicate, or requires a code/product fix.",
    "4. If a fix is needed, implement and verify the actual product fix first.",
    "5. Request one concrete Personal task for Grashnuk that asks for the actual fix/proof, not a QA packet.",
    "6. Accept/submit that Personal task with evidence. Answer reviewer verification requests if they appear.",
    "7. Wait for reward evidence and then resolve the harvest with a concise operator-facing note.",
    "",
    "Resolution note format:",
    "Outcome: fixed / already fixed / not a bug / duplicate.",
    "Problem: one or two plain-English issue summaries.",
    "Action: actual shipped fix, existing shipped fix, not-a-bug proof, or duplicate path.",
    "Proof: generated task id, reward amount, reward tx/CID, and one short reviewer sentence if it matters.",
    "",
    "Final response must be JSON matching schemas/grashnuk-harvest-codex-result.schema.json.",
    "Set secretPrinted to false.",
  ].join("\n");
}

async function runCodex({ prompt, model, reasoning, noDanger = false } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tasknode-grashnuk-codex-"));
  const outputPath = path.join(tempDir, "result.json");
  try {
    const args = [
      "exec",
      "--cd",
      repoRoot,
      "--model",
      model,
      "-c",
      `model_reasoning_effort="${reasoning}"`,
      "--output-schema",
      resultSchemaPath,
      "--output-last-message",
      outputPath,
    ];
    if (noDanger) {
      args.push("--sandbox", "workspace-write");
    } else {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push("-");
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
    const outputText = await readFile(outputPath, "utf8").catch(() => "");
    if (code !== 0) {
      const error = new Error(`grashnuk_codex_exec_failed:${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      error.outputText = outputText;
      throw error;
    }
    return {
      outputText,
      stdout,
      stderr,
      result: parseCodexJson(outputText),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    console.log(usage());
    return;
  }
  const taskId = safeText(argValue("--task-id", ""), 180);
  if (!taskId) throw new Error("task_id_required");
  const model = argValue("--model", defaultModel);
  const reasoning = argValue("--reasoning", defaultReasoning);
  const prompt = buildPrompt({ taskId });
  if (hasArg("--packet-only")) {
    if (hasArg("--json")) {
      console.log(JSON.stringify({ ok: true, taskId, model, reasoning, prompt }, null, 2));
    } else {
      console.log(prompt);
    }
    return;
  }
  if (!hasArg("--execute")) {
    throw new Error("Refusing to run Codex without --execute. Use --packet-only to inspect the prompt.");
  }
  const run = await runCodex({
    prompt,
    model,
    reasoning,
    noDanger: hasArg("--no-danger"),
  });
  const output = {
    ok: true,
    taskId,
    model,
    reasoning,
    result: run.result,
  };
  if (hasArg("--json")) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("grashnuk harvest codex exec ok");
    console.log(`harvest: ${taskId}`);
    console.log(`outcome: ${run.result?.outcome || "unknown"}`);
    if (run.result?.personalTaskId) console.log(`personal task: ${run.result.personalTaskId}`);
    if (run.result?.rewardTxHash) console.log(`reward tx: ${run.result.rewardTxHash}`);
    if (run.result?.summary) console.log(run.result.summary);
  }
}

main().catch(async (error) => {
  const output = {
    ok: false,
    error: error.message || String(error),
    stdoutTail: safeText(error.stdout, 4000),
    stderrTail: safeText(error.stderr, 4000),
    outputText: safeText(error.outputText, 4000),
  };
  if (hasArg("--json")) console.log(JSON.stringify(output, null, 2));
  else {
    console.error(output.error);
    if (output.stderrTail) console.error(output.stderrTail);
    if (output.outputText) {
      const failedPath = path.join(process.cwd(), "grashnuk-codex-failed-result.json");
      await writeFile(failedPath, output.outputText, "utf8").catch(() => null);
      console.error(`last output written to ${failedPath}`);
    }
  }
  process.exitCode = 1;
});
