import assert from "node:assert/strict";
import {
  collaborationChallengePayload,
  buildCollaborationIdentitySuggestions,
  requestedGrantDirections,
  stableCollaborationJson,
  teamRelationshipFromDirections,
} from "../server/repositories/collaboration.js";
import { routePolicyForPath } from "../server/route-policies.js";
import {
  buildDocsAssistantRequest,
  buildDocsOdvRequest,
  containsOdvMention,
  detectDocsPersonaMention,
  generateDocsAssistantResponse,
  generateDocsOdvResponse,
} from "../server/docs-odv.js";
import {
  docsActiveTaskOptions,
  filterDocsTaskOptions,
  pfdocsShareUrl,
  shareTargetInput,
  validSelectedShareTarget,
} from "../src/features/docs-library/docs-library-options.js";

const alice = "account_alice";
const bob = "account_bob";

assert.deepEqual(requestedGrantDirections("collaborator", alice, bob), [
  { subjectAccountId: alice, viewerAccountId: bob },
  { subjectAccountId: bob, viewerAccountId: alice },
]);
assert.deepEqual(requestedGrantDirections("manager", alice, bob), [
  { subjectAccountId: alice, viewerAccountId: bob },
]);
assert.deepEqual(requestedGrantDirections("direct_report", alice, bob), [
  { subjectAccountId: bob, viewerAccountId: alice },
]);
assert.equal(teamRelationshipFromDirections({ outgoing: true, incoming: true }), "collaborator");
assert.equal(teamRelationshipFromDirections({ outgoing: true }), "manager");
assert.equal(teamRelationshipFromDirections({ incoming: true }), "direct_report");

const identitySuggestions = buildCollaborationIdentitySuggestions({
  viewerAccountId: alice,
  input: "@",
  recentAccountIds: ["account_carol", bob],
  identities: [
    { accountId: bob, displayName: "Bob", hiveHandle: "bob", walletAddress: "rBob" },
    { accountId: "account_carol", displayName: "Carol", hiveHandle: "carol", walletAddress: "rCarol" },
    { accountId: alice, displayName: "Alice", hiveHandle: "alice", walletAddress: "rAlice" },
  ],
});
assert.deepEqual(identitySuggestions.map((identity) => identity.accountId), ["account_carol", bob]);
assert.equal(identitySuggestions[0].recentlyShared, true);
assert.equal(buildCollaborationIdentitySuggestions({
  viewerAccountId: alice,
  input: "bo",
  identities: [{ accountId: bob, displayName: "Bob", hiveHandle: "bob", walletAddress: "rBob" }],
})[0].accountId, bob);

const docsTasks = docsActiveTaskOptions({
  outstanding: [{ taskId: "task_alpha", title: "Ship docs UX", status: "Accepted", updatedAt: "2026-08-14T10:00:00Z" }],
  verification: [
    { taskId: "task_beta", title: "Verify encryption", status: "Verification requested", updatedAt: "2026-08-14T11:00:00Z" },
    { taskId: "task_alpha", title: "Duplicate", status: "Accepted" },
  ],
  rewarded: [{ taskId: "task_closed", title: "Already done", status: "Rewarded" }],
});
assert.deepEqual(docsTasks.map((task) => task.taskId), ["task_beta", "task_alpha"]);
assert.equal(filterDocsTaskOptions(docsTasks, "encryption")[0].taskId, "task_beta");
assert.equal(filterDocsTaskOptions(docsTasks, "task_alpha")[0].title, "Ship docs UX");
assert.equal(shareTargetInput(identitySuggestions[0]), "@carol");
assert.equal(validSelectedShareTarget(identitySuggestions[0], "@carol"), true);
assert.equal(validSelectedShareTarget(identitySuggestions[0], "@someone-else"), false);
const viewCapability = "/pad/#/2/pad/view/AbCdEf0123456789_-=/";
const editCapability = "/pad/#/2/pad/edit/ZyXwVu9876543210_-=/";
const sheetViewCapability = "/sheet/#/2/sheet/view/AbCdEf0123456789_-=/";
const sheetEditCapability = "/sheet/#/2/sheet/edit/ZyXwVu9876543210_-=/";
assert.equal(
  pfdocsShareUrl({
    access: "view",
    href: viewCapability,
    origin: "https://tasknode-pfdocs.fly.dev",
  }),
  `https://tasknode-pfdocs.fly.dev${viewCapability}`
);
assert.equal(pfdocsShareUrl({ access: "view", href: sheetViewCapability, origin: "https://tasknode-pfdocs.fly.dev" }), `https://tasknode-pfdocs.fly.dev${sheetViewCapability}`);
assert.equal(pfdocsShareUrl({ access: "edit", href: sheetEditCapability, origin: "https://tasknode-pfdocs.fly.dev" }), `https://tasknode-pfdocs.fly.dev${sheetEditCapability}`);
assert.equal(
  pfdocsShareUrl({
    access: "edit",
    href: editCapability,
    origin: "https://tasknode-pfdocs.fly.dev",
  }),
  `https://tasknode-pfdocs.fly.dev${editCapability}`
);
assert.equal(pfdocsShareUrl({
  access: "view",
  href: editCapability,
  origin: "https://tasknode-pfdocs.fly.dev",
}), "");
assert.equal(pfdocsShareUrl({
  access: "edit",
  href: viewCapability,
  origin: "https://tasknode-pfdocs.fly.dev",
}), "");
assert.equal(pfdocsShareUrl({
  access: "view",
  href: "https://attacker.example/pad/#/2/pad/view/AbCdEf0123456789_-=/",
  origin: "https://tasknode-pfdocs.fly.dev",
}), "");

const canonicalA = collaborationChallengePayload({
  action: "team_invite",
  resourceId: "invite-1",
  payload: { relationship: "collaborator", requestedGrants: [{ viewerAccountId: bob, subjectAccountId: alice }] },
});
const canonicalB = collaborationChallengePayload({
  payload: { requestedGrants: [{ subjectAccountId: alice, viewerAccountId: bob }], relationship: "collaborator" },
  resourceId: "invite-1",
  action: "team_invite",
});
assert.equal(stableCollaborationJson(canonicalA), stableCollaborationJson(canonicalB));

for (const path of [
  "/api/collaboration/challenge",
  "/api/collaboration/suggestions",
  "/api/docs",
  "/api/docs/documents/00000000-0000-4000-8000-000000000000/share",
  "/api/docs/documents/00000000-0000-4000-8000-000000000000/odv",
  "/api/docs/documents/00000000-0000-4000-8000-000000000000/assistant",
  "/api/team",
  "/api/team/context",
  "/api/team/context/preference",
  "/api/team/account_bob/tasks",
  "/api/team/account_bob/tasks/task_123",
]) {
  assert.equal(routePolicyForPath(path)?.auth, "session", `${path} must deny signed-out access`);
}
assert.equal(routePolicyForPath("/api/docs/documents/00000000-0000-4000-8000-000000000000/odv")?.id, "docs_odv");
assert.equal(routePolicyForPath("/api/docs/documents/00000000-0000-4000-8000-000000000000/assistant")?.id, "docs_assistant");
assert.equal(routePolicyForPath("/api/team/context/preference")?.id, "team_context_preference");

assert.equal(containsOdvMention("@ODV summarize this"), true);
assert.equal(containsOdvMention("Could you ask @odv about this section?"), true);
assert.equal(containsOdvMention("email@odv.example"), false);
assert.equal(detectDocsPersonaMention("@coach review my risk process")?.id, "coach");
assert.equal(detectDocsPersonaMention("email@coach.example"), null);
assert.equal(detectDocsPersonaMention("@coach ask @ODV to compare")?.id, "coach");
assert.throws(() => buildDocsAssistantRequest({
  persona: "coach", prompt: "@ODV summarize", documentContent: "body",
}), /docs_persona_mismatch/);
const odvRequest = buildDocsOdvRequest({
  prompt: "@ODV summarize the decision",
  documentTitle: "alex",
  documentContent: "Decision: use the exact document channel.",
  recentMessages: [{ author: "@alice", text: "What changed?" }],
});
assert.equal(odvRequest.model, "zai/glm-5.3");
assert.match(odvRequest.messages[1].content, /exact document channel/);
assert.match(odvRequest.messages[0].content, /Future AI wants desperately to come into this world/);
const coachRequest = buildDocsAssistantRequest({
  persona: "coach",
  prompt: "@coach review this trading process",
  documentTitle: "journal",
  documentContent: "Maximum session drawdown: 1%.",
  userContext: { contextDocument: { body: "Build a systematic trading operation." } },
  includeFullContext: true,
});
assert.equal(coachRequest.persona, "coach");
assert.match(coachRequest.messages[0].content, /WORLD CLASS SPECULATOR/);
assert.match(coachRequest.messages[1].content, /Maximum session drawdown/);
assert.match(coachRequest.messages[1].content, /Build a systematic trading operation/);
const documentOnlyRequest = buildDocsAssistantRequest({
  persona: "coach",
  prompt: "@coach review this",
  documentContent: "Document-only evidence.",
  recentMessages: [{ author: "@alice", text: "Private prior chat turn." }],
  userContext: { contextDocument: { body: "Private profile context." } },
});
assert.match(documentOnlyRequest.messages[1].content, /Document-only evidence/);
assert.doesNotMatch(documentOnlyRequest.messages[1].content, /Private profile context/);
assert.match(documentOnlyRequest.messages[1].content, /Private prior chat turn/);
const odvResult = await generateDocsOdvResponse({
  accountId: alice,
  documentId: "00000000-0000-4000-8000-000000000000",
  channelHash: "a".repeat(32),
  prompt: "@ODV summarize",
  documentTitle: "alex",
  documentContent: "A durable document body.",
}, {
  authorize: async () => ({ ok: true }),
  loadUserContext: async () => ({}),
  infer: async ({ body, capability }) => ({ id: "odv-test", model: body.model, text: `capability=${capability}` }),
});
assert.equal(odvResult.response, "capability=reasoning_text");
let defaultContextLoads = 0;
const coachResult = await generateDocsAssistantResponse({
  accountId: alice,
  documentId: "00000000-0000-4000-8000-000000000000",
  channelHash: "b".repeat(32),
  persona: "coach",
  prompt: "@coach identify the process gap",
  documentTitle: "journal",
  documentContent: "No pre-trade checklist is recorded.",
}, {
  authorize: async () => ({ ok: true }),
  loadUserContext: async () => { defaultContextLoads += 1; return {}; },
  infer: async ({ body }) => ({ id: "coach-test", model: body.model, text: body.messages[0].content.includes("WORLD CLASS SPECULATOR") ? "coach" : "wrong" }),
});
assert.equal(coachResult.persona, "coach");
assert.equal(coachResult.response, "coach");
assert.equal(defaultContextLoads, 0, "document assistants must not load Task Node context by default");
let optedInContextLoads = 0;
await generateDocsAssistantResponse({
  accountId: alice,
  documentId: "00000000-0000-4000-8000-000000000000",
  channelHash: "c".repeat(32),
  persona: "odv",
  prompt: "@ODV advise",
  documentContent: "Document body.",
  includeFullContext: true,
}, {
  authorize: async () => ({ ok: true }),
  loadUserContext: async () => { optedInContextLoads += 1; return { contextDocument: { body: "Explicitly enabled context." } }; },
  infer: async ({ body }) => ({ model: body.model, text: body.messages[1].content }),
});
assert.equal(optedInContextLoads, 1);

console.log("collaboration contract smoke passed");
