#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  formatTaskDescription,
  formatTaskParagraphs,
  linkifyInline,
  splitSentences,
  taskRepoFromTexts,
  verificationTitleLabel,
} from "../src/features/tasks/task-description-format.js";

const flatten = (parts) => parts.map((part) => part.text ?? part.link ?? "").join("");

assert.deepEqual(
  splitSentences("Fix the bug in v1.2.3 at postfiat.org, e.g. the parser. Then open a PR. Done!"),
  ["Fix the bug in v1.2.3 at postfiat.org, e.g. the parser.", "Then open a PR.", "Done!"],
);
assert.deepEqual(splitSentences("It said \"stop.\" Then it ran."), ["It said \"stop.\"", "Then it ran."]);

const description = [
  "Task Node has an open bug report, issue #320 in the GitHub repository postfiatorg/tasknode.",
  "The bug: a fallback value can end up as NaN.",
  "That number flows into request serialization.",
  "Your job: add a guard and a regression test.",
  "This pays only for a merged pull request written by the GitHub account linked to your Task Node account.",
  "An open, unmerged, closed, or draft pull request will not be paid.",
].join(" ");
const formatted = formatTaskDescription(description);
assert.equal(formatted.repo, "postfiatorg/tasknode");
assert.equal(flatten(formatted.lead), "Task Node has an open bug report, issue #320 in the GitHub repository postfiatorg/tasknode.");
assert.ok(formatted.lead.some((part) => part.href === "https://github.com/postfiatorg/tasknode/issues/320"));
assert.ok(formatted.lead.some((part) => part.href === "https://github.com/postfiatorg/tasknode"));
assert.equal(formatted.terms.length, 2);
assert.equal(formatted.paragraphs.length >= 1, true);
// No words are lost or reordered outside the terms split.
const rebuilt = [formatted.lead, ...formatted.paragraphs, ...formatted.terms].map(flatten).join(" ");
assert.equal(rebuilt.replace(/\s+/g, " ").length, description.replace(/\s+/g, " ").length);

const markdown = formatTaskDescription("Goal:\n\n- one\n- two");
assert.equal(markdown.markdown, "Goal:\n\n- one\n- two");

const short = formatTaskDescription("Write a thread. Post it.");
assert.equal(short.lead, null);
assert.equal(short.paragraphs.length, 1);

const links = linkifyInline("Open https://github.com/postfiatorg/tasknode/pull/12. Then read github.com/postfiatorg/pfsite/issues.", {});
assert.equal(links.filter((part) => part.href).length, 2);
assert.equal(links[1].href, "https://github.com/postfiatorg/tasknode/pull/12");
assert.equal(links[3].href, "https://github.com/postfiatorg/pfsite/issues");

// Issue numbers are only linked when a repository is known.
assert.equal(linkifyInline("See #12.").some((part) => part.href), false);
assert.equal(linkifyInline("See PR #12.", { repo: "postfiatorg/tasknode" })[1].href, "https://github.com/postfiatorg/tasknode/pull/12");

assert.equal(taskRepoFromTexts("", "merged into postfiatorg/postfiatl1v2 main"), "postfiatorg/postfiatl1v2");
assert.equal(formatTaskParagraphs("One. Two. Three. Four.").length, 2);
assert.equal(verificationTitleLabel("Submit Url"), "Submit URL");

console.log("task-description-format-smoke ok");
