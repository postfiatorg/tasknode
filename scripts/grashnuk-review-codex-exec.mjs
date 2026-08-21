#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const resultSchemaPath = path.join(repoRoot, "schemas", "grashnuk-review-codex-result.schema.json");
const defaultModel = process.env.TASKNODE_GRASHNUK_REVIEW_CODEX_MODEL
  || process.env.TASKNODE_GRASHNUK_CODEX_MODEL
  || process.env.TASKNODE_BOARD_MANAGER_CODEX_MODEL
  || "gpt-5.5";
const defaultReasoning = process.env.TASKNODE_GRASHNUK_REVIEW_CODEX_REASONING || "xhigh";

function usage() {
  return [
    "Usage: npm run grashnuk:review-codex -- [--commit <sha> | --base <sha> --head <sha>] [options]",
    "",
    "Options:",
    "  --commit <sha>         Review one Grashnuk submission commit.",
    "  --base <sha>           Review a range from base..head.",
    "  --head <sha>           Review a range from base..head. Default: HEAD.",
    "  --label <text>         Human-readable target label for output.",
    "  --model <model>        Codex model. Default: TASKNODE_GRASHNUK_REVIEW_CODEX_MODEL or gpt-5.5.",
    "  --reasoning <effort>   model_reasoning_effort. Default: xhigh.",
    "  --packet-only          Print the prompt packet without invoking Codex.",
    "  --execute              Actually run codex exec.",
    "  --no-danger            Use --sandbox workspace-write instead of bypassing approvals/sandbox.",
    "  --json                 Print machine-readable wrapper output.",
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
    throw new Error("grashnuk_review_codex_invalid_json_result");
  }
}

function targetFromArgs() {
  const commit = safeText(argValue("--commit", ""), 120);
  const base = safeText(argValue("--base", ""), 120);
  const head = safeText(argValue("--head", "HEAD"), 120);
  if (commit && base) throw new Error("Use either --commit or --base/--head, not both.");
  if (commit) {
    return {
      label: safeText(argValue("--label", `commit ${commit}`), 240),
      diffSpec: `${commit}^!`,
      commit,
      base: "",
      head: commit,
    };
  }
  if (base) {
    return {
      label: safeText(argValue("--label", `${base}..${head}`), 240),
      diffSpec: `${base}..${head}`,
      commit: "",
      base,
      head,
    };
  }
  throw new Error("review_target_required");
}

function buildPrompt({ target } = {}) {
  return [
    "You are an independent code-review and fix agent for Task Node Grashnuk submissions.",
    "",
    "Mission:",
    `Review the Grashnuk submission target: ${target.label}.`,
    `Diff spec: ${target.diffSpec}.`,
    "This is a separate Codex process whose job is quality control after a Grashnuk work session.",
    "",
    "Hard rules:",
    "- Do not use Grashnuk wallet keys, task sessions, harvest resolve APIs, or reward/task lifecycle tooling.",
    "- Never print, cat, echo, summarize, or expose seeds, mnemonics, session tokens, cookies, private keys, or raw auth headers.",
    "- Review like a senior code reviewer: prioritize correctness, regressions, data loss, security, confusing UX states, and missing focused tests.",
    "- If the submission is sound, leave the tree clean and report clean.",
    "- If you find a real defect, fix it in this process with a separate follow-up commit. Keep fixes scoped to the reviewed change.",
    "- Do not rewrite or amend the original Grashnuk commit. Preserve user and unrelated work.",
    "- If a fix changes production behavior, push main, run npm run fly:deploy:prod, and verify production /health before reporting fixed.",
    "- If a fix does not affect production behavior, commit and push if appropriate, but do not deploy unnecessarily.",
    "- Documentation upkeep is part of the review. When the reviewed commit or your fix changes product behavior, operator workflow, prompts, task lifecycle, PFTL/replay behavior, wallet/auth behavior, Hive/Board behavior, or any public Help-facing contract, update the relevant `docs/wiki/` page and `src/features/docs/docs-content.js` registry if a page must be exposed in Help.",
    "- If the only concrete issue is stale or missing documentation for changed behavior or workflow, fix the docs in a separate follow-up commit and set reviewOutcome to fixed.",
    "- If no documentation update is relevant, say why in proof. Do not add placeholder TODOs or generic reviewer checklists.",
    "- Do not perform broad refactors, style churn, or documentation-only criticism unrelated to changed behavior or operator workflow.",
    "",
    "Suggested review loop:",
    `1. Inspect git show --stat --oneline ${target.diffSpec} and git show --find-renames ${target.diffSpec}.`,
    "2. Inspect the changed code paths and nearest tests/smokes.",
    "3. Run the focused checks that match the changed boundary, plus lint/build only when relevant.",
    "4. Patch any concrete defect you find and add or update a focused regression check.",
    "5. After code review, do a documentation-impact pass: identify the relevant wiki/help page, update it when behavior or workflow changed, and include the doc path in proof; if no doc update is needed, include the reason.",
    "6. Commit fixes and relevant docs as a new commit with a clear message. Push/deploy only when the fix requires it.",
    "7. Return JSON matching schemas/grashnuk-review-codex-result.schema.json.",
    "",
    "Final JSON guidance:",
    "- reviewOutcome is clean when no fixes were needed.",
    "- reviewOutcome is fixed when you committed fixes.",
    "- reviewOutcome is blocked only when the review could not complete.",
    "- findings should be concise reviewer findings, not a prose essay.",
    "- proof should list commands run and key results.",
    "- Set secretPrinted to false.",
  ].join("\n");
}

async function runCodex({ prompt, model, reasoning, noDanger = false } = {}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tasknode-grashnuk-review-codex-"));
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
      const error = new Error(`grashnuk_review_codex_exec_failed:${code}`);
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
  const target = targetFromArgs();
  const model = argValue("--model", defaultModel);
  const reasoning = argValue("--reasoning", defaultReasoning);
  const prompt = buildPrompt({ target });
  if (hasArg("--packet-only")) {
    if (hasArg("--json")) {
      console.log(JSON.stringify({ ok: true, target, model, reasoning, prompt }, null, 2));
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
    target,
    model,
    reasoning,
    result: run.result,
  };
  if (hasArg("--json")) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("grashnuk review codex exec ok");
    console.log(`target: ${target.label}`);
    console.log(`outcome: ${run.result?.reviewOutcome || "unknown"}`);
    if (run.result?.fixCommit) console.log(`fix commit: ${run.result.fixCommit}`);
    if (run.result?.findings?.length) console.log(`findings: ${run.result.findings.join("; ")}`);
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
      const failedPath = path.join(process.cwd(), "grashnuk-review-codex-failed-result.json");
      await writeFile(failedPath, output.outputText, "utf8").catch(() => null);
      console.error(`last output written to ${failedPath}`);
    }
  }
  process.exitCode = 1;
});
