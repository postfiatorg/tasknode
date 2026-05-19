#!/usr/bin/env node
import assert from "node:assert/strict";
import { chatEstimate } from "../server/chat-estimate.js";
import { contextDocumentPacket } from "../server/context-line-map.js";
import {
  applyContextEditProposalToDocument,
  parseContextEditOutput,
} from "../server/context-edit-proposals.js";

const document = {
  title: "Task Node Context",
  revision: 7,
  body: [
    "# Values",
    "Build one useful product.",
    "",
    "# Tactics",
    "Ship one clean loop people rely on.",
  ].join("\n"),
};
const packet = contextDocumentPacket(document);
const output = JSON.stringify({
  response: "This makes the tactical line more operational without changing the goal.",
  state: "proposal",
  proposal: {
    operation: "replace_block",
    anchor_type: "line_range",
    line_start: 5,
    line_end: 5,
    target_heading: "",
    target_before: "Ship one clean loop people rely on.",
    target_after: "Ship one clean loop that thirty serious people would miss if it disappeared.",
    rationale: "It replaces a broad aspiration with a sharper adoption threshold.",
    risk: "low",
  },
});
const parsed = parseContextEditOutput(output);
const patched = applyContextEditProposalToDocument({
  document,
  proposal: {
    ...parsed.proposal,
    baseContextRevision: packet.revision,
    baseBodySha256: packet.bodySha256,
  },
});

assert.equal(parsed.state, "proposal");
assert.match(patched.body, /thirty serious people/);

assert.throws(
  () => applyContextEditProposalToDocument({
    document: { ...document, revision: 8 },
    proposal: {
      ...parsed.proposal,
      baseContextRevision: packet.revision,
      baseBodySha256: packet.bodySha256,
    },
  }),
  /context_edit_stale/
);

const estimate = chatEstimate({
  mode: "context_edit",
  contextMode: "context_edit",
  message: "tighten tactics",
}, {
  contextDocument: document,
});
assert.equal(estimate.mode, "Frontier Thinking");
assert.equal(estimate.contextMode, "context_edit");
assert.equal(estimate.estimatedWebSearchCalls, 0);
assert.ok(estimate.contextEditLineNumberCharacters > 0);

console.log("context edit smoke ok");
