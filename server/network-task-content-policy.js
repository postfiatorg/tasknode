// Operator content policy for network tasks (2026-09-26).
//
// Two task shapes are banned outright, whatever board, agent or prompt asks
// for them, because they pay for commentary instead of work and attract
// low-effort sybil farming:
//
//  1. Critiques of published writing: critiques, fact-checks, claim audits,
//     falsifiability reviews, stress tests, rebuttals or scorecards of essays,
//     posts, articles or threads (including the operator's public writing).
//  2. Audits delivered as documents: audit / review / assessment tasks whose
//     deliverable is a gist, write-up, report, memo or coverage map rather than
//     a code change.
//
// Real engineering stays allowed: pull requests, fixes, tests, reproductions
// that land a patch, backtests with code.
//
// This module is reachable from inference paths, where regular expressions are
// prohibited; matching uses word tokens and plain substring checks.

export const NETWORK_TASK_CONTENT_POLICY_VERSION = "network_task_content_policy_v1";

// Word stems (a token matches when it starts with the stem).
const WRITING_STEMS = ["essay", "article", "primer", "newsletter", "substack", "writing", "oped"];
const WRITING_WORDS = ["posts", "blog", "blogs"];
const WRITING_PHRASES = [
  "goodalexander.github.io", "content/posts", "op-ed", "blog post", " the post ", " a post ", " this post ",
  "x post", "twitter post", "x thread", "twitter thread", "medium article", "medium post", "medium critique", "on medium",
];

const CRITIQUE_STEMS = ["critiqu", "criticis", "criticiz", "factcheck", "falsifiab", "rebut", "refut", "scorecard", "steelman", "contradict", "debunk", "redteam"];
const CRITIQUE_PHRASES = [
  "fact check", "fact-check", "claim by claim", "claim-by-claim", "claim audit", "retrospective claim",
  "stress test", "stress-test", "tear down", "teardown", "red team", "red-team",
];

const AUDIT_STEMS = ["audit", "review", "assess", "evaluat", "inspect", "critiqu", "factcheck"];
const AUDIT_PHRASES = ["fact check", "fact-check", "coverage map", "coverage gap", "coverage plan", "merge readiness", "merge-readiness"];

const DOCUMENT_STEMS = ["gist", "writeup", "report", "memo", "scorecard"];
const DOCUMENT_PHRASES = ["write up", "write-up", "findings doc", "findings note", "coverage map", "coverage plan", "decision gist", "public note"];
// A merge verdict (MERGE / DO-NOT-MERGE, PASS / FAIL on someone else's PR) is
// commentary however much code it discusses: descriptions of the PR under
// review ("fix", "patch") must not unlock it through CODE_PHRASES.
const VERDICT_PHRASES = ["verdict gist", "merge verdict", "merge-verdict", "do-not-merge", "do not merge"];

const CODE_PHRASES = [
  "open a pull request", "open pull request", "open a pr", "open pr", "submit a pull request", "submit a pr",
  "pull request that", "land a fix", "land the fix", "failing test", "regression test", "unit test",
  "pytest", "cargo test", "write a test", "write test", "fix the", "fix a", "patch",
];

function isWordChar(char) {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || char === "_";
}

function normalize(text) {
  const lower = String(text || "").toLowerCase();
  const tokens = [];
  let current = "";
  let spaced = "";
  for (const char of lower) {
    if (isWordChar(char)) {
      current += char;
      spaced += char;
    } else {
      if (current) tokens.push(current);
      current = "";
      spaced += char === "-" || char === "." || char === "/" ? char : " ";
    }
  }
  if (current) tokens.push(current);
  // Hyphen-joined compounds ("fact-check") also appear as one token ("factcheck").
  const joined = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) joined.push(tokens[index] + tokens[index + 1]);
  return { tokens: [...tokens, ...joined], text: ` ${spaced.split(" ").filter(Boolean).join(" ")} ` };
}

function matches({ tokens, text }, { stems = [], words = [], phrases = [] }) {
  if (phrases.some((phrase) => text.includes(phrase))) return true;
  if (words.some((word) => tokens.includes(word))) return true;
  return tokens.some((token) => stems.some((stem) => token.startsWith(stem)));
}

export function networkTaskContentViolation(...texts) {
  const raw = texts
    .flat()
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  if (!raw) return null;
  const normalized = normalize(raw);
  const critique = matches(normalized, { stems: CRITIQUE_STEMS, phrases: CRITIQUE_PHRASES });
  const writing = matches(normalized, { stems: WRITING_STEMS, words: WRITING_WORDS, phrases: WRITING_PHRASES });
  if (critique && writing) {
    return {
      code: "critique_of_published_writing",
      message:
        "Network tasks may not critique, fact-check, audit or stress-test essays, posts or other published writing.",
    };
  }
  const audit = matches(normalized, { stems: AUDIT_STEMS, phrases: AUDIT_PHRASES });
  const document = matches(normalized, { stems: DOCUMENT_STEMS, phrases: DOCUMENT_PHRASES });
  const code = matches(normalized, { phrases: CODE_PHRASES });
  const verdict = matches(normalized, { phrases: VERDICT_PHRASES });
  if ((audit && document && !code) || (verdict && document)) {
    return {
      code: "audit_document_deliverable",
      message:
        "Network tasks may not pay for audits or reviews delivered as a gist, report or write-up; route a code change instead.",
    };
  }
  return null;
}

export function assertNetworkTaskContentAllowed(...texts) {
  const violation = networkTaskContentViolation(...texts);
  if (!violation) return;
  throw Object.assign(
    new Error(`network_task_content_policy_rejected: ${violation.code}: ${violation.message}`),
    { status: 422, code: "network_task_content_policy_rejected", violation, policy: NETWORK_TASK_CONTENT_POLICY_VERSION }
  );
}
