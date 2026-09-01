import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const migration = await readFile(new URL("../server/db/migrations/110_docs_team_collaboration.sql", import.meta.url), "utf8");
assert.match(migration, /CREATE TABLE IF NOT EXISTS docs_access_grants/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS task_history_grants/);
assert.match(migration, /WHERE status = 'active'/);

const routes = await readFile(new URL("../server/collaboration-routes.js", import.meta.url), "utf8");
assert.match(routes, /requireTaskHistoryGrant\(\{ subjectAccountId, viewerAccountId: accountId \}\)/);
assert.match(routes, /if \(collaborationPath && !accountId\)/);
assert.match(routes, /collaboration_login_required/);
assert.doesNotMatch(routes, /requested_relationship\s*===/);

const repository = await readFile(new URL("../server/repositories/collaboration.js", import.meta.url), "utf8");
assert.match(repository, /\^\[0-9a-f\]\{32\}\$/i);
assert.match(repository, /channelHash: row\.pfdocs_channel_hash/);
assert.match(repository, /identity: await identityDocument\(accountId\)/);
assert.match(repository, /from "\.\/account-profiles\.js"/);
assert.doesNotMatch(repository, /from "\.\.\/runtime-store\.js"/);
assert.match(repository, /shares: document\.owned/);
assert.match(repository, /ORDER BY last_shared_at DESC/);
assert.match(repository, /status IN \('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted'\)/);

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
assert.equal(odvRequest.model, "z-ai/glm-5.2");
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
assert.doesNotMatch(documentOnlyRequest.messages[1].content, /Private prior chat turn/);
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

const appShell = await readFile(new URL("../src/app/App.jsx", import.meta.url), "utf8");
const docsNavIndex = appShell.indexOf('active={view === "docs"}');
const walletNavIndex = appShell.indexOf('active={view === "wallet"}');
assert.ok(docsNavIndex >= 0, "Docs must be a first-class sidebar destination");
assert.ok(walletNavIndex > docsNavIndex, "Docs must appear in the primary sidebar before Wallet");
assert.doesNotMatch(appShell, /ToolMenuRow icon=\{FileText\} label="Docs"/);

const docsView = await readFile(new URL("../src/features/docs-library/DocsLibraryView.jsx", import.meta.url), "utf8");
assert.match(docsView, /collaboration\.pfdocsEditorEnabled/);
assert.match(docsView, /New spreadsheet/);
assert.match(docsView, /createDocument\("sheet"\)/);
assert.match(docsView, /documentType/);
assert.match(docsView, /Encrypted editor temporarily unavailable/);
assert.match(docsView, /\^\[0-9a-f\]\{32\}\$/i);
assert.match(docsView, /if \(!signedIn\)/);
assert.match(docsView, /Sign in to use Docs/);
assert.match(docsView, /docs-editor-workspace/);
assert.match(docsView, /pfdocs\.tasknode\.document-title/);
assert.match(docsView, /tasknode\.pfdocs\.context/);
assert.match(docsView, /pfdocs\.tasknode\.odv-request/);
assert.match(docsView, /pfdocs\.tasknode\.assistant-request/);
assert.match(docsView, /legacyOdv \? "odv" : "assistant"/);
assert.match(docsView, /mention: "@coach"/);
assert.match(docsView, /includeFullContext: editorFullContext === true/);
assert.match(docsView, /Full context/);
assert.match(docsView, /tasknode\.pfdocs\.command/);
assert.match(docsView, /command: "import-content"|sendEditorCommand\("import-content"/);
assert.match(docsView, /pfdocs\.tasknode\.import-result/);
assert.match(docsView, /editorImportRef\.current\?\.click\(\)/);
assert.match(docsView, /\.md, \.txt, \.html/);
assert.doesNotMatch(docsView, /sendEditorCommand\("import"\)/);
assert.match(docsView, /docs-editor-title-block/);
assert.match(docsView, /sendEditorCommand\("chat-toggle"\)/);
assert.match(docsView, /sendEditorCommand\("set-title", \{ title \}\)/);
assert.match(docsView, /z-ai\/glm-5\.2/);
assert.match(docsView, /Select a valid Task Node member from the suggestions/);
assert.match(docsView, /People with access/);
assert.match(docsView, /Link access/);
assert.match(docsView, /Links include the document’s decryption key/);
assert.match(docsView, /copyDocumentShareLink\("view"\)/);
assert.match(docsView, /copyDocumentShareLink\("edit"\)/);
assert.match(docsView, /Copy view link/);
assert.match(docsView, /Copy edit link/);
assert.match(docsView, /navigator\.clipboard\.writeText\(shareUrl\)/);
assert.match(docsView, /Link an active task/);
assert.match(docsView, /Opening encrypted document/);
assert.doesNotMatch(docsView, /window\.prompt\("Task ID to link"/);
assert.doesNotMatch(docsView, /window\.open\(/);

const runtime = await readFile(new URL("../server/server-http-boundary.js", import.meta.url), "utf8");
assert.match(runtime, /pfdocsEditorEnabled: collaborationFlag\("TASKNODE_PFDOCS_EDITOR_ENABLED"\)/);
assert.match(runtime, /docsOdvEnabled: collaborationFlag\("TASKNODE_DOCS_ODV_ENABLED"\)/);
assert.match(runtime, /frame-src 'self'.*pfdocsFrameOrigin/);

const appStyles = await readFile(new URL("../src/styles-shell.css", import.meta.url), "utf8");
assert.match(appStyles, /\.app-shell\.view-docs \.topbar\s*\{\s*display:\s*none/);

console.log("collaboration contract smoke passed");
