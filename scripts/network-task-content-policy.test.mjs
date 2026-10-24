import assert from "node:assert/strict";
import { test } from "node:test";
import { networkTaskContentViolation } from "../server/network-task-content-policy.js";

const banned = [
  ["critique_of_published_writing", "Publish a public critique gist of the essay The Story of Taran by goodalexander"],
  ["critique_of_published_writing", "Fact-Check the Memory Hole Essay in a Public Gist"],
  ["critique_of_published_writing", "Publish a Medium Critique of The Nigeria Template"],
  ["critique_of_published_writing", "Publish a Retrospective Claim Audit of '14 Reasons I'm Bullish Crypto' essay"],
  ["audit_document_deliverable", "Audit Vote-Counting Logic in internal_validation.rs and Publish Gist"],
  ["audit_document_deliverable", "Audit Issue 36 Operator Onboarding Gaps and Publish Coverage Gist"],
  ["audit_document_deliverable", "Assess PR #94 Merge Readiness and Publish Decision Gist"],
  // Network tasks generated after the 2026-09-26 policy that it failed to stop.
  ["audit_document_deliverable", "Verify PR #131 Zlib Pin Fix and Publish Verdict Gist"],
  ["audit_document_deliverable", "Publish Merge-Verdict Gist For CorbanuTerminal PR #130"],
  ["audit_document_deliverable", "Publish Fresh Merge-Verdict Gist for PR #103 insta Bump"],
  ["audit_document_deliverable", "Review PR #124 Cache Marker Fix and Publish Verdict Gist"],
  ["audit_document_deliverable", ["Verify PR #131 fix", "PR #131 ('fix(bazel): refresh rules_rs pin') updates the patch. Publish a public gist with a one-word verdict, MERGE or DO-NOT-MERGE."]],
];

const allowed = [
  "Open PR Bumping rustls to 0.23.45 in CorbanuTerminal",
  "Fix TAR Size Parsing for Non-Regular Archive Entries",
  "Write Pytest Rejecting Non-Integer max_size in UNL Selector",
  "Replicate the momentum backtest with code in a notebook against Sharadar data",
  "Review the failing test, fix the parser and open a pull request",
];

test("banned network task shapes are rejected with the right code", () => {
  for (const [code, text] of banned) {
    assert.equal(networkTaskContentViolation(text)?.code, code, text);
  }
});

test("engineering and reproducible data work is allowed", () => {
  for (const text of allowed) assert.equal(networkTaskContentViolation(text), null, text);
});

test("pull request URLs are extracted and de-duplicated from evidence", async () => {
  const { extractPullRequestRefs } = await import("../server/merged-pr-requirement.js");
  const refs = extractPullRequestRefs(
    { text: "PR https://github.com/postfiatorg/tasknode/pull/279 again https://github.com/postfiatorg/tasknode/pull/279" },
    "gist https://gist.github.com/x/abc and https://github.com/postfiatorg/postfiatl1v2/pull/12/files"
  );
  assert.deepEqual(refs.map((ref) => ref.key), ["postfiatorg/tasknode#279", "postfiatorg/postfiatl1v2#12"]);
});

test("ordinary engineering wording is not mistaken for critique", async () => {
  const { networkTaskContentViolation: check } = await import("../server/network-task-content-policy.js");
  for (const text of [
    "Fix critical consensus bug in the Post Fiat node and open a pull request",
    "Refactor the thread pool used by the Post Fiat RPC server",
    "Add medium-severity lint rules to CorbanuTerminal",
  ]) assert.equal(check(text), null, text);
});
