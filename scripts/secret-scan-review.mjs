#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findingsPath = process.argv[2];
const scopeArgument = process.argv.find((argument) => argument.startsWith("--scope="));
const scope = scopeArgument?.slice("--scope=".length) || "git";
if (!findingsPath || !["git", "filesystem"].includes(scope)) {
  throw new Error("usage: node scripts/secret-scan-review.mjs <trufflehog-jsonl> [--scope=git|filesystem]");
}

const manifest = JSON.parse(readFileSync(path.join(repoRoot, "provenance/secret-scan-reviews.json"), "utf8"));
if (manifest.schemaVersion !== 2
  || !Array.isArray(manifest.reviewedFindings)
  || !Array.isArray(manifest.reviewedFilesystemFindings)) {
  throw new Error("secret_scan_review_manifest_invalid");
}
const expiresAt = Date.parse(`${manifest.reviewExpiresAt}T23:59:59.999Z`);
if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) throw new Error("secret_scan_reviews_expired");

const source = readFileSync(path.resolve(findingsPath), "utf8").trim();
const findings = source ? source.split(/\r?\n/).map((line, index) => {
  try { return JSON.parse(line); }
  catch { throw new Error(`secret_scan_invalid_json_line:${index + 1}`); }
}) : [];

function fingerprint(finding) {
  const git = finding?.SourceMetadata?.Data?.Git || {};
  const filesystemFile = String(finding?.SourceMetadata?.Data?.Filesystem?.file || "")
    .replace(/^\/repo\//, "");
  if (scope === "filesystem") {
    return createHash("sha256")
      .update(JSON.stringify([finding.DetectorName, finding.Raw, filesystemFile]))
      .digest("hex");
  }
  return createHash("sha256")
    .update(JSON.stringify([finding.DetectorName, finding.Raw, git.file, git.commit]))
    .digest("hex");
}

const reviewedFindings = scope === "filesystem"
  ? manifest.reviewedFilesystemFindings
  : manifest.reviewedFindings;
const reviewed = new Map(reviewedFindings.map((finding) => [finding.fingerprint, finding]));
if (reviewed.size !== reviewedFindings.length) throw new Error("secret_scan_duplicate_review_fingerprint");
const seen = new Set();
const errors = [];
for (const finding of findings) {
  const digest = fingerprint(finding);
  const git = finding?.SourceMetadata?.Data?.Git || {};
  const filesystemFile = String(finding?.SourceMetadata?.Data?.Filesystem?.file || "")
    .replace(/^\/repo\//, "");
  const file = scope === "filesystem" ? filesystemFile : git.file;
  const review = reviewed.get(digest);
  if (finding.Verified) errors.push(`verified secret: ${finding.DetectorName} ${file || "unknown"}`);
  else if (!review) errors.push(`unreviewed finding: ${finding.DetectorName} ${file || "unknown"} ${digest}`);
  else if (review.detector !== finding.DetectorName
    || review.file !== file
    || (scope === "git" && review.commit !== git.commit)) {
    errors.push(`review metadata mismatch: ${digest}`);
  }
  seen.add(digest);
}
for (const review of reviewedFindings) {
  if (!seen.has(review.fingerprint)) errors.push(`stale reviewed finding: ${review.fingerprint}`);
}
if (errors.length) throw new Error(`secret_scan_review_failed:\n${errors.join("\n")}`);
console.log(`secret scan review ok (${scope}): ${findings.length} synthetic/non-secret findings, 0 unreviewed findings`);
