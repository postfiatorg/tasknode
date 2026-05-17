#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const maxLines = Number(process.env.TASKNODE_MAX_FILE_LINES || 5000);
const ignoredPathPrefixes = [
  "dist/",
  "node_modules/",
];
const ignoredFiles = new Set([
  "package-lock.json",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !ignoredFiles.has(file))
    .filter((file) => !ignoredPathPrefixes.some((prefix) => file.startsWith(prefix)));
}

function lineCount(file) {
  const text = readFileSync(file, "utf8");
  if (!text) return 0;
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

const violations = trackedFiles()
  .map((file) => ({ file, lines: lineCount(file) }))
  .filter((entry) => entry.lines > maxLines)
  .sort((left, right) => right.lines - left.lines);

if (violations.length > 0) {
  console.error(`Files over ${maxLines} lines are not allowed:`);
  for (const entry of violations) {
    console.error(`  ${entry.lines.toString().padStart(5)} ${entry.file}`);
  }
  process.exit(1);
}

console.log(`file size check ok: no repository file over ${maxLines} lines`);
