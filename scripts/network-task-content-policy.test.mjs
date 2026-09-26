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
