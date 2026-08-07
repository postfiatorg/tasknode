import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureRepo(cwd) {
  git(cwd, ["config", "user.email", "board-manager-smoke@example.invalid"]);
  git(cwd, ["config", "user.name", "Board Manager Smoke"]);
}

const root = mkdtempSync(path.join(tmpdir(), "board-manager-repo-integrity-"));
process.env.BM_REPO_ROOT = root;
const {
  gitCheckoutState,
  repoSourceLeads,
  validateGitFileReference,
} = await import("./bm/lib.mjs");

const remote = path.join(root, "remote.git");
const source = path.join(root, "source");
const checkout = path.join(root, "checkout");
const publisher = path.join(root, "publisher");

try {
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["init", source], { stdio: "pipe" });
  configureRepo(source);
  writeFileSync(path.join(source, "existing.txt"), "line one\nline two\n", "utf8");
  git(source, ["add", "existing.txt"]);
  git(source, ["commit", "-m", "initial"]);
  git(source, ["branch", "-M", "main"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);
  const firstCommit = git(source, ["rev-parse", "HEAD"]);

  writeFileSync(path.join(source, "future.txt"), "future path\n", "utf8");
  git(source, ["add", "future.txt"]);
  git(source, ["commit", "-m", "add future path"]);
  git(source, ["push"]);
  const secondCommit = git(source, ["rev-parse", "HEAD"]);

  execFileSync("git", ["clone", "--branch", "main", remote, checkout], { stdio: "pipe" });
  configureRepo(checkout);

  const validAtFirst = validateGitFileReference({
    checkout,
    commit: firstCommit,
    file: "existing.txt",
    line: 2,
    expectedText: "line two",
  });
  writeFileSync(
    path.join(checkout, "existing.txt"),
    "line one\nTODO dirty working-tree replacement\n",
    "utf8"
  );
  const mismatchedAtFirst = validateGitFileReference({
    checkout,
    commit: firstCommit,
    file: "existing.txt",
    line: 2,
    expectedText: "TODO dirty working-tree replacement",
  });
  const missingAtFirst = validateGitFileReference({
    checkout,
    commit: firstCommit,
    file: "future.txt",
    line: 1,
  });
  const validAtSecond = validateGitFileReference({
    checkout,
    commit: secondCommit,
    file: "future.txt",
    line: 1,
  });
  const invalidLine = validateGitFileReference({
    checkout,
    commit: secondCommit,
    file: "future.txt",
    line: 99,
  });
  assert.equal(validAtFirst.verified, true);
  assert.equal(mismatchedAtFirst.verified, false);
  assert.match(mismatchedAtFirst.warning, /content differs at commit/);
  assert.equal(missingAtFirst.verified, false);
  assert.match(missingAtFirst.warning, /was not found at commit/);
  assert.equal(validAtSecond.verified, true);
  assert.equal(invalidLine.verified, false);
  assert.match(invalidLine.warning, /line 99 was not found at commit/);

  const dirtyWorkingTreeLead = repoSourceLeads(["checkout"], { fetchOrigin: false })[0];
  assert.equal(dirtyWorkingTreeLead.todo_count, 0);
  assert.equal(dirtyWorkingTreeLead.verified_references.length, 0);
  assert.match(dirtyWorkingTreeLead.unverified_references[0].warning, /content differs at commit/);

  const synced = gitCheckoutState(checkout);
  assert.equal(synced.relation, "synced");
  assert.equal(synced.current_commit_verified, true);
  assert.equal(synced.current_commit, secondCommit);

  writeFileSync(path.join(checkout, "ahead.txt"), "ahead\n", "utf8");
  git(checkout, ["add", "ahead.txt"]);
  git(checkout, ["commit", "-m", "local ahead"]);
  const ahead = gitCheckoutState(checkout);
  assert.equal(ahead.relation, "ahead");
  assert.equal(ahead.current_commit_verified, true);
  assert.ok(ahead.current_commit);

  git(checkout, ["reset", "--hard", "origin/main"]);
  execFileSync("git", ["clone", "--branch", "main", remote, publisher], { stdio: "pipe" });
  configureRepo(publisher);
  writeFileSync(path.join(publisher, "remote.txt"), "remote\n", "utf8");
  git(publisher, ["add", "remote.txt"]);
  git(publisher, ["commit", "-m", "remote advance"]);
  git(publisher, ["push"]);
  git(checkout, ["fetch", "origin"]);
  const behind = gitCheckoutState(checkout);
  assert.equal(behind.relation, "behind");
  assert.equal(behind.current_commit_verified, false);
  assert.equal(behind.current_commit, "");
  assert.match(behind.warning, /must not be presented/);

  writeFileSync(path.join(checkout, "diverged.txt"), "diverged\n", "utf8");
  git(checkout, ["add", "diverged.txt"]);
  git(checkout, ["commit", "-m", "local divergence"]);
  const diverged = gitCheckoutState(checkout);
  assert.equal(diverged.relation, "diverged");
  assert.equal(diverged.current_commit_verified, false);
  assert.equal(diverged.current_commit, "");

  git(checkout, ["checkout", "-b", "no-upstream"]);
  const missingUpstream = gitCheckoutState(checkout);
  assert.equal(missingUpstream.relation, "missing_upstream");
  assert.equal(missingUpstream.current_commit_verified, false);
  assert.equal(missingUpstream.current_commit, "");

  git(checkout, ["remote", "set-url", "origin", path.join(root, "missing-remote.git")]);
  const cachedLead = repoSourceLeads(["checkout"], { fetchOrigin: false })[0];
  assert.equal(cachedLead.fetch_verified, null);
  assert.equal(cachedLead.checkout_relation, "missing_upstream");
  const fetchBackedLead = repoSourceLeads(["checkout"], { fetchOrigin: true })[0];
  assert.equal(fetchBackedLead.fetch_verified, false);
  assert.equal(fetchBackedLead.checkout_relation, "unverified");

  console.log(JSON.stringify({
    references: {
      before: missingAtFirst,
      after: validAtSecond,
      validAtFirst,
      mismatchedAtFirst,
      dirtyWorkingTreeLead,
      invalidLine,
    },
    checkoutStates: {
      synced,
      ahead,
      behind,
      diverged,
      missingUpstream,
    },
    fetchModes: {
      cachedLead,
      fetchBackedLead,
    },
  }, null, 2));
  console.log("board-manager-repo-integrity-smoke ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
