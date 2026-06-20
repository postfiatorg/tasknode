#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKET_SCHEMA = "pf.orc.evidence_artifact_resolution_packet.v1";

function usage() {
  return `Usage:
  node scripts/orc-evidence-artifact-resolver.mjs resolve --pr-url <github_pr_url> --commit <sha> --artifact <path> --out <dir> [--repo-root <path>] [--excerpt-bytes 1200]

Builds a reviewer-facing artifact resolution packet from a public GitHub PR, commit, and expected artifact paths.

Outputs:
  artifact_resolution_packet.json
  artifact_resolution_packet.md

The resolver is offline and read-only. It does not submit live API changes, sign transactions, send messages, move funds, or execute enforcement.`;
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
    if (key === "artifact") options.artifact.push(next);
    else options[key] = next;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true || (Array.isArray(value) && value.length === 0)) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

async function git(args, cwd, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: options.maxBuffer || 5 * 1024 * 1024,
  });
  return stdout;
}

async function resolveCommit(repoRoot, commit) {
  const ref = safeText(commit, 160);
  const resolved = await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoRoot);
  return resolved.trim();
}

async function changedFilesForCommit(repoRoot, commit) {
  const stdout = await git(["show", "--name-only", "--format=", "--no-renames", commit], repoRoot);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function commitObjectExists(repoRoot, commit, artifactPath) {
  try {
    await git(["cat-file", "-e", `${commit}:${artifactPath}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function readCommitFile(repoRoot, commit, artifactPath) {
  return git(["show", `${commit}:${artifactPath}`], repoRoot, { maxBuffer: 10 * 1024 * 1024 });
}

async function readArtifactContent({ repoRoot, commit, artifactPath, localExists, committedExists }) {
  const absolute = path.join(repoRoot, artifactPath);
  if (localExists) return readFile(absolute, "utf8");
  if (committedExists) return readCommitFile(repoRoot, commit, artifactPath);
  return "";
}

function jsonExcerpt(parsed) {
  if (Array.isArray(parsed)) {
    return {
      type: "json_array",
      length: parsed.length,
      firstItem: parsed[0] ?? null,
    };
  }
  if (!parsed || typeof parsed !== "object") return parsed;
  const excerpt = {
    type: "json_object",
    topLevelKeys: Object.keys(parsed).slice(0, 24),
  };
  for (const key of ["schema", "ok", "summary", "run", "taskId", "title", "files", "safety"]) {
    if (parsed[key] !== undefined) excerpt[key] = parsed[key];
  }
  if (Array.isArray(parsed.records)) {
    excerpt.recordsCount = parsed.records.length;
    excerpt.firstRecord = parsed.records[0] ?? null;
  }
  if (Array.isArray(parsed.updates)) {
    excerpt.updatesCount = parsed.updates.length;
    excerpt.firstUpdate = parsed.updates[0] ?? null;
  }
  return excerpt;
}

function compactExcerpt(content, artifactPath, excerptBytes) {
  if (!content) {
    return {
      available: false,
      type: "missing",
      text: "",
    };
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (artifactPath.endsWith(".json")) {
    try {
      return {
        available: true,
        type: "json",
        byteLength,
        excerpt: jsonExcerpt(JSON.parse(content)),
      };
    } catch {
      return {
        available: true,
        type: "text",
        byteLength,
        text: content.slice(0, excerptBytes),
      };
    }
  }
  return {
    available: true,
    type: "text",
    byteLength,
    text: content.slice(0, excerptBytes),
  };
}

function sha256(content) {
  if (!content) return "";
  return createHash("sha256").update(content).digest("hex");
}

function githubUrls(pr, commit, artifactPath) {
  const encoded = artifactPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return {
    blobUrl: `https://github.com/${pr.owner}/${pr.repo}/blob/${commit}/${encoded}`,
    rawUrl: `https://raw.githubusercontent.com/${pr.owner}/${pr.repo}/${commit}/${encoded}`,
  };
}

function normalizeArtifactPath(artifactPath) {
  const normalized = safeText(artifactPath, 1000).replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Artifact path must be a relative path inside the repository");
  }
  return normalized;
}

async function artifactRow({ repoRoot, pr, commit, changedFiles, artifactPath, excerptBytes }) {
  const normalized = normalizeArtifactPath(artifactPath);
  const absolute = path.join(repoRoot, normalized);
  const localExists = existsSync(absolute);
  const committedExists = await commitObjectExists(repoRoot, commit, normalized);
  const content = await readArtifactContent({
    repoRoot,
    commit,
    artifactPath: normalized,
    localExists,
    committedExists,
  });
  return {
    path: normalized,
    localExists,
    committedExists,
    changedInCommit: changedFiles.includes(normalized),
    contentSha256: sha256(content),
    ...githubUrls(pr, commit, normalized),
    excerpt: compactExcerpt(content, normalized, excerptBytes),
  };
}

function reviewerChecklist({ pr, commitUrl, changedFiles, artifacts }) {
  return [
    {
      item: "Public PR URL is GitHub-shaped",
      ok: pr.ok,
      detail: pr.normalizedUrl,
    },
    {
      item: "Commit URL is direct and inspectable",
      ok: Boolean(commitUrl),
      detail: commitUrl,
    },
    {
      item: "Commit changed-file list resolved",
      ok: changedFiles.length > 0,
      detail: `${changedFiles.length} changed files`,
    },
    {
      item: "Every expected artifact exists locally",
      ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.localExists),
      detail: `${artifacts.filter((artifact) => artifact.localExists).length}/${artifacts.length}`,
    },
    {
      item: "Every expected artifact exists in the commit object",
      ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.committedExists),
      detail: `${artifacts.filter((artifact) => artifact.committedExists).length}/${artifacts.length}`,
    },
    {
      item: "Every expected artifact was changed by the commit",
      ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.changedInCommit),
      detail: `${artifacts.filter((artifact) => artifact.changedInCommit).length}/${artifacts.length}`,
    },
    {
      item: "Every expected artifact has a compact excerpt",
      ok: artifacts.length > 0 && artifacts.every((artifact) => artifact.excerpt.available),
      detail: `${artifacts.filter((artifact) => artifact.excerpt.available).length}/${artifacts.length}`,
    },
  ];
}

function markdown(packet) {
  const lines = [
    `# Artifact Resolution Packet: ${packet.title}`,
    "",
    `Schema: \`${packet.schema}\``,
    `Generated at: ${packet.generatedAt}`,
    "",
    "## Public Links",
    "",
    `- PR: ${packet.publicLinks.prUrl}`,
    `- Commit: ${packet.publicLinks.commitUrl}`,
    "",
    "## Artifact Checks",
    "",
  ];
  for (const artifact of packet.artifacts) {
    lines.push(`### ${artifact.path}`, "");
    lines.push(`- Blob URL: ${artifact.blobUrl}`);
    lines.push(`- Raw URL: ${artifact.rawUrl}`);
    lines.push(`- Local exists: ${artifact.localExists}`);
    lines.push(`- Commit object exists: ${artifact.committedExists}`);
    lines.push(`- Changed in commit: ${artifact.changedInCommit}`);
    lines.push(`- SHA-256: \`${artifact.contentSha256}\``);
    lines.push("", "Excerpt:", "");
    lines.push("```json");
    lines.push(JSON.stringify(artifact.excerpt, null, 2));
    lines.push("```", "");
  }
  lines.push("## Reviewer Checklist", "");
  for (const item of packet.reviewerChecklist) {
    lines.push(`- [${item.ok ? "x" : " "}] ${item.item}: ${item.detail}`);
  }
  lines.push(
    "",
    "## Safety",
    "",
    "This packet is generated offline from git metadata and local/committed artifact content. It does not sign transactions, submit live API changes, send messages, move funds, or execute enforcement."
  );
  return `${lines.join("\n")}\n`;
}

async function resolve(options) {
  const repoRoot = path.resolve(safeText(options["repo-root"] || process.cwd(), 1000));
  const pr = parseGithubPrUrl(requireOption(options, "pr-url"));
  if (!pr.ok) throw new Error(pr.error);
  const commit = await resolveCommit(repoRoot, requireOption(options, "commit"));
  const artifactPaths = requireOption(options, "artifact");
  const outDir = requireOption(options, "out");
  const excerptBytes = Math.max(200, Math.min(10000, safeNumber(options["excerpt-bytes"], 1200)));
  const changedFiles = await changedFilesForCommit(repoRoot, commit);
  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    artifacts.push(await artifactRow({ repoRoot, pr, commit, changedFiles, artifactPath, excerptBytes }));
  }
  const commitUrl = `https://github.com/${pr.owner}/${pr.repo}/commit/${commit}`;
  const packet = {
    ok: true,
    schema: PACKET_SCHEMA,
    title: safeText(options.title || `PR #${pr.prNumber} artifact resolution`, 240),
    generatedAt: safeText(options["generated-at"] || new Date().toISOString(), 80),
    publicLinks: {
      prUrl: pr.normalizedUrl,
      commitUrl,
    },
    repository: {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
      commit,
    },
    changedFiles,
    artifacts,
    reviewerChecklist: reviewerChecklist({ pr, commitUrl, changedFiles, artifacts }),
    safety: {
      offline: true,
      signed: false,
      submittedLive: false,
      movedFunds: false,
      sentMessages: false,
      enforcementAllowed: false,
    },
  };
  packet.ok = packet.reviewerChecklist.every((item) => item.ok);
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "artifact_resolution_packet.json");
  const markdownPath = path.join(outDir, "artifact_resolution_packet.md");
  await writeFile(jsonPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(packet), "utf8");
  return {
    ok: packet.ok,
    schema: PACKET_SCHEMA,
    jsonPath,
    markdownPath,
    checklistPassed: packet.reviewerChecklist.filter((item) => item.ok).length,
    checklistTotal: packet.reviewerChecklist.length,
    artifactCount: packet.artifacts.length,
    changedFileCount: packet.changedFiles.length,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h" || options.help || options.h) {
    console.log(usage());
    return;
  }
  if (command !== "resolve") throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(await resolve(options), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
