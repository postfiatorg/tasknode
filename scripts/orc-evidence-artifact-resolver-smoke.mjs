#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = await mkdtemp(path.join(os.tmpdir(), "orc-evidence-artifact-resolver-"));
const scriptPath = path.join(repoRoot, "scripts/orc-evidence-artifact-resolver.mjs");
const { stdout: rootCommitStdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
  cwd: repoRoot,
});
const rootCommit = rootCommitStdout.trim();

const { stdout: helpOutput } = await execFileAsync(process.execPath, [scriptPath, "--help"]);
assert.match(helpOutput, /artifact resolution packet/);
assert.match(helpOutput, /--artifact/);

const { stdout } = await execFileAsync(process.execPath, [
  scriptPath,
  "resolve",
  "--pr-url",
  "https://github.com/postfiatorg/tasknode/pull/1",
  "--commit",
  rootCommit,
  "--artifact",
  "package.json",
  "--artifact",
  "README.md",
  "--artifact",
  "scripts/orc-evidence-artifact-resolver.mjs",
  "--out",
  outDir,
  "--repo-root",
  repoRoot,
  "--generated-at",
  "2026-06-20T10:30:00.000Z",
]);

await assert.rejects(
  execFileAsync(process.execPath, [
    scriptPath,
    "resolve",
    "--pr-url",
    "https://github.com/postfiatorg/tasknode/pull/1",
    "--commit",
    rootCommit,
    "--artifact",
    "../package.json",
    "--out",
    outDir,
    "--repo-root",
    repoRoot,
  ]),
  (error) => /Artifact path must be a relative path inside the repository/.test(error.stderr)
);

const output = JSON.parse(stdout);
assert.equal(output.ok, true);
assert.equal(output.artifactCount, 3);
assert.equal(output.checklistPassed, output.checklistTotal);

const packet = JSON.parse(await readFile(path.join(outDir, "artifact_resolution_packet.json"), "utf8"));
assert.equal(packet.ok, true);
assert.equal(packet.publicLinks.prUrl, "https://github.com/postfiatorg/tasknode/pull/1");
assert.equal(packet.publicLinks.commitUrl, `https://github.com/postfiatorg/tasknode/commit/${rootCommit}`);
assert.equal(packet.artifacts.length, 3);
assert.ok(packet.artifacts.every((artifact) => artifact.localExists));
assert.ok(packet.artifacts.every((artifact) => artifact.committedExists));
assert.ok(packet.artifacts.every((artifact) => artifact.changedInCommit));
assert.ok(packet.artifacts.every((artifact) => artifact.blobUrl.includes(`/blob/${rootCommit}/`)));
assert.ok(packet.artifacts.every((artifact) => artifact.rawUrl.includes(`/${rootCommit}/`)));

const packageArtifact = packet.artifacts.find((artifact) => artifact.path === "package.json");
assert.equal(packageArtifact.excerpt.type, "json");
assert.ok(packageArtifact.excerpt.excerpt.topLevelKeys.includes("name"));

const readmeArtifact = packet.artifacts.find((artifact) => artifact.path === "README.md");
assert.equal(readmeArtifact.excerpt.type, "text");
assert.match(readmeArtifact.excerpt.text, /Task Node/);

const markdown = await readFile(path.join(outDir, "artifact_resolution_packet.md"), "utf8");
assert.match(markdown, /Artifact Checks/);
assert.match(markdown, /Blob URL:/);
assert.match(markdown, /Changed in commit: true/);
assert.match(markdown, /Reviewer Checklist/);

console.log("orc-evidence-artifact-resolver-smoke ok");
