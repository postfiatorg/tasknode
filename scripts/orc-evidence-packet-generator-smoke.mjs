#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-evidence-packet-generator-"));
const { stdout: rootCommitStdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
  cwd: repoRoot,
});
const rootCommit = rootCommitStdout.trim();
const commandsPath = path.join(outDir, "fixture_commands.json");
const excerptsPath = path.join(outDir, "fixture_json_excerpts.json");
await writeFile(
  commandsPath,
  JSON.stringify([{ label: "repository check", command: "npm run check", status: "passed", output: "all gates passed" }])
);
await writeFile(
  excerptsPath,
  JSON.stringify([{ label: "package identity", file: "package.json", path: "$.name", excerpt: "tasknode" }])
);

const { stdout } = await execFileAsync(process.execPath, [
  path.join(repoRoot, "scripts/orc-evidence-packet-generator.mjs"),
  "generate",
  "--task-id",
  "task_public_fixture",
  "--title",
  "Verify Public Task Node Evidence Packet",
  "--pr-url",
  "https://github.com/postfiatorg/tasknode/pull/1",
  "--commit",
  rootCommit,
  "--artifact",
  "package.json",
  "--artifact",
  "README.md",
  "--commands",
  commandsPath,
  "--json-excerpts",
  excerptsPath,
  "--out",
  outDir,
  "--repo-root",
  repoRoot,
]);

const commandOutput = JSON.parse(stdout);
assert.equal(commandOutput.ok, true);
assert.equal(commandOutput.checklistPassed, commandOutput.checklistTotal);
assert.ok(commandOutput.changedFileCount >= 2);
assert.equal(commandOutput.artifactCount, 2);
assert.equal(commandOutput.commandCount, 1);
assert.equal(commandOutput.excerptCount, 1);

const markdown = await readFile(path.join(outDir, "evidence_packet.md"), "utf8");
assert.match(markdown, /https:\/\/github\.com\/postfiatorg\/tasknode\/pull\/1/);
assert.match(markdown, new RegExp(`https://github\\.com/postfiatorg/tasknode/commit/${rootCommit}`));
assert.match(markdown, /npm run check/);
assert.match(markdown, /package identity/);
assert.match(markdown, /Reviewer Checklist/);

const summary = JSON.parse(await readFile(path.join(outDir, "submission_summary.json"), "utf8"));
assert.equal(summary.ok, true);
assert.equal(summary.publicLinks.prUrl, "https://github.com/postfiatorg/tasknode/pull/1");
assert.ok(summary.reviewerChecklist.every((item) => item.ok));

console.log("orc-evidence-packet-generator-smoke ok");
