#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUMMARY_SCHEMA = "pf.orc.evidence_packet_summary.v1";

function usage() {
  return `Usage:
  node scripts/orc-evidence-packet-generator.mjs generate --task-id <task_id> --title <title> --pr-url <github_pr_url> --commit <sha> --out <dir> [--artifact <path>] [--commands <commands.json>] [--json-excerpts <excerpts.json>] [--repo-root <path>]

Generates a Task Node evidence markdown packet and compact JSON summary from public repository links plus local verification artifacts.

Inputs:
  --pr-url          Public GitHub PR URL.
  --commit         Commit SHA or ref. The script resolves changed files with git show when possible.
  --artifact       Repeatable local artifact path to include and validate.
  --commands       JSON array or {commands:[...]} with command/result/status entries.
  --json-excerpts  JSON array or {excerpts:[...]} with reviewer-critical excerpt objects.

Outputs:
  evidence_packet.md
  submission_summary.json`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [], artifact: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    if (key === "artifact") {
      options.artifact.push(next);
    } else {
      options[key] = next;
    }
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJsonIfProvided(filePath) {
  if (!filePath) return [];
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  if (Array.isArray(raw)) return raw;
  return asArray(raw.commands || raw.excerpts || raw.items);
}

function parseGithubPrUrl(prUrl) {
  const text = safeText(prUrl, 400);
  const match = text.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!match) {
    return {
      ok: false,
      owner: "",
      repo: "",
      prNumber: "",
      normalizedUrl: text,
      error: "PR URL must be a public https://github.com/<owner>/<repo>/pull/<number> URL",
    };
  }
  return {
    ok: true,
    owner: match[1],
    repo: match[2],
    prNumber: match[3],
    normalizedUrl: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    error: "",
  };
}

function commitUrlFrom({ pr, commit }) {
  if (!pr.ok || !commit) return "";
  return `https://github.com/${pr.owner}/${pr.repo}/commit/${commit}`;
}

async function changedFilesForCommit({ repoRoot, commit }) {
  const ref = safeText(commit, 120);
  if (!ref) return { files: [], error: "commit ref missing" };
  try {
    const { stdout: resolvedStdout } = await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const resolvedRef = resolvedStdout.trim();
    const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", "--no-renames", resolvedRef], {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return { files, error: "" };
  } catch (error) {
    return { files: [], error: safeText(error.message, 400) };
  }
}

function artifactRows(artifactPaths, repoRoot) {
  return artifactPaths.map((artifactPath) => {
    const normalized = safeText(artifactPath, 500);
    const absolute = path.isAbsolute(normalized) ? normalized : path.join(repoRoot, normalized);
    return {
      path: normalized,
      exists: existsSync(absolute),
    };
  });
}

function normalizeCommands(rows) {
  return rows.map((row, index) => ({
    label: safeText(row.label || `command_${index + 1}`, 120),
    command: safeText(row.command, 1000),
    status: safeText(row.status || row.result || "unknown", 120),
    output: safeText(row.output || row.stdout || row.summary, 2000),
  }));
}

function normalizeExcerpts(rows) {
  return rows.map((row, index) => ({
    label: safeText(row.label || `excerpt_${index + 1}`, 160),
    file: safeText(row.file, 500),
    path: safeText(row.path || row.jsonPath, 300),
    excerpt: row.excerpt === undefined ? row.value : row.excerpt,
  }));
}

function checklist({ pr, commitUrl, changedFiles, artifacts, commands, excerpts }) {
  return [
    {
      item: "Public PR URL is present and GitHub-shaped",
      ok: Boolean(pr.ok),
      detail: pr.normalizedUrl,
    },
    {
      item: "Public commit URL is present",
      ok: Boolean(commitUrl),
      detail: commitUrl,
    },
    {
      item: "Changed file paths are included",
      ok: changedFiles.length > 0,
      detail: `${changedFiles.length} files`,
    },
    {
      item: "Local artifacts exist",
      ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.exists),
      detail: `${artifacts.filter((artifact) => artifact.exists).length}/${artifacts.length} found`,
    },
    {
      item: "Command results are included",
      ok: commands.length > 0,
      detail: `${commands.length} command entries`,
    },
    {
      item: "Critical JSON excerpts are included",
      ok: excerpts.length > 0,
      detail: `${excerpts.length} excerpts`,
    },
  ];
}

function markdownPacket(summary) {
  const lines = [
    `# Evidence Packet: ${summary.title}`,
    "",
    `Task: \`${summary.taskId}\``,
    "",
    "## Public Links",
    "",
    `- PR: ${summary.publicLinks.prUrl}`,
    `- Commit: ${summary.publicLinks.commitUrl}`,
    "",
    "## Changed Files",
    "",
  ];
  for (const file of summary.changedFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("", "## Artifacts", "");
  for (const artifact of summary.artifacts) {
    lines.push(`- \`${artifact.path}\` - ${artifact.exists ? "found" : "missing"}`);
  }
  lines.push("", "## Command Results", "");
  for (const command of summary.commands) {
    lines.push(`- ${command.label}: \`${command.command}\` -> ${command.status}`);
    if (command.output) lines.push(`  - ${command.output}`);
  }
  lines.push("", "## Critical JSON Excerpts", "");
  for (const excerpt of summary.jsonExcerpts) {
    lines.push(`### ${excerpt.label}`, "");
    if (excerpt.file) lines.push(`File: \`${excerpt.file}\``);
    if (excerpt.path) lines.push(`Path: \`${excerpt.path}\``);
    lines.push("", "```json", JSON.stringify(excerpt.excerpt, null, 2), "```", "");
  }
  lines.push("## Reviewer Checklist", "");
  for (const item of summary.reviewerChecklist) {
    lines.push(`- [${item.ok ? "x" : " "}] ${item.item}: ${item.detail}`);
  }
  lines.push(
    "",
    "## Safety",
    "",
    "This evidence packet is generated from local artifacts and public repository links. It does not send live messages, sign transactions, move funds, or mutate production state."
  );
  return `${lines.join("\n")}\n`;
}

async function generate(options) {
  const repoRoot = path.resolve(safeText(options["repo-root"] || process.cwd(), 1000));
  const taskId = requireOption(options, "task-id");
  const title = requireOption(options, "title");
  const prUrl = requireOption(options, "pr-url");
  const commit = requireOption(options, "commit");
  const outDir = requireOption(options, "out");
  const pr = parseGithubPrUrl(prUrl);
  const commitUrl = commitUrlFrom({ pr, commit });
  const changedFilesResult = await changedFilesForCommit({ repoRoot, commit });
  const artifacts = artifactRows(asArray(options.artifact), repoRoot);
  const commands = normalizeCommands(await readJsonIfProvided(options.commands));
  const jsonExcerpts = normalizeExcerpts(await readJsonIfProvided(options["json-excerpts"]));
  const reviewerChecklist = checklist({
    pr,
    commitUrl,
    changedFiles: changedFilesResult.files,
    artifacts,
    commands,
    excerpts: jsonExcerpts,
  });
  const summary = {
    ok: reviewerChecklist.every((item) => item.ok),
    schema: SUMMARY_SCHEMA,
    taskId,
    title,
    publicLinks: {
      prUrl: pr.normalizedUrl,
      commitUrl,
    },
    commit,
    changedFiles: changedFilesResult.files,
    changedFilesError: changedFilesResult.error,
    artifacts,
    commands,
    jsonExcerpts,
    reviewerChecklist,
  };

  await mkdir(outDir, { recursive: true });
  const markdownPath = path.join(outDir, "evidence_packet.md");
  const summaryPath = path.join(outDir, "submission_summary.json");
  await writeFile(markdownPath, markdownPacket(summary), "utf8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    ok: summary.ok,
    schema: SUMMARY_SCHEMA,
    markdownPath,
    summaryPath,
    checklistPassed: summary.reviewerChecklist.filter((item) => item.ok).length,
    checklistTotal: summary.reviewerChecklist.length,
    changedFileCount: summary.changedFiles.length,
    artifactCount: summary.artifacts.length,
    commandCount: summary.commands.length,
    excerptCount: summary.jsonExcerpts.length,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (command !== "generate") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await generate(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
