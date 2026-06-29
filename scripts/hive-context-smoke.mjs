import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DEEPSEEK_API_KEY = "hive-context-smoke-deepseek-key";

const {
  buildHiveSecretarySourcePacket,
  enqueueHiveSecretaryJob,
  formatHiveSecretaryReport,
  getHiveContextDocument,
  getHiveSecretaryState,
  listHiveProjectComments,
  markHiveContextEntriesWalletValidated,
  normalizeHiveProjectCommentMetadata,
  saveHiveContextEntry,
} = await import("../server/repositories/hive-context.js");
const { hiveProjectsDocumentForTests } = await import("../server/repositories/hive-projects.js");
const { handleHiveRoute } = await import("../server/hive-routes.js");
const { getChatMessages } = await import("../server/repositories/chat-billing.js");
const {
  formatHiveReportsContextForImmediateResponse,
  formatHiveMindContextForImmediateResponse,
  formatLiveBoardFactsForImmediateResponse,
} = await import("../server/hive-immediate-response.js");

await saveHiveContextEntry({
  accountId: "account_zephyr",
  displayName: "Zephyr",
  body: "Need stronger validator onboarding context for Network Validation tasks.",
  sourceConversationId: "conversation_1",
  sourceConversationTitle: "validator planning",
  walletAddress: "rZephyrWallet",
  walletValidated: true,
});

await saveHiveContextEntry({
  accountId: "account_alex",
  displayName: "Alex",
  body: "Protocol Marketing needs a concise weekly narrative packet.",
  sourceConversationId: "conversation_2",
  sourceConversationTitle: "marketing planning",
  walletAddress: "rAlexWallet",
  walletValidated: true,
  attachments: [
    {
      name: "launch-surfaces.txt",
      mimeType: "text/plain",
      kind: "text",
      source: "paste",
      size: 126,
      textContent: "Telegram, task generation, context editing, and Hive board are the first launch surfaces.",
      textExcerpt: "Telegram, task generation, context editing, and Hive board are the first launch surfaces.",
    },
  ],
});

await saveHiveContextEntry({
  accountId: "account_alex",
  displayName: "Alex",
  body: "Alpha Generation should track wallet clustering questions.",
  sourceConversationId: "conversation_3",
  sourceConversationTitle: "alpha planning",
  walletAddress: "rAlexWallet",
  walletValidated: true,
});

await saveHiveContextEntry({
  accountId: "account_unvalidated",
  displayName: "Unvalidated",
  body: "This entry should join the Secretary source only after wallet validation.",
});

const backfill = await markHiveContextEntriesWalletValidated({
  accountId: "account_unvalidated",
  walletAddress: "rValidatedLater",
});
assert.equal(backfill.updated, 1);

const document = await getHiveContextDocument();
assert.equal(document.entryCount, 4);
assert.equal(document.userCount, 3);
assert.deepEqual(document.groups.map((group) => group.displayName), ["Alex", "Unvalidated", "Zephyr"]);
assert.equal(document.groups[0].entries.length, 2);
assert.match(document.groups[0].entries[0].body, /Alpha Generation|Protocol Marketing/);
assert.equal(document.groups[0].entries[0].sourceConversationTitle, "alpha planning");
const attachmentEntry = document.groups[0].entries.find((entry) => entry.attachments?.length > 0);
assert.equal(attachmentEntry.attachments[0].name, "launch-surfaces.txt");
assert.equal(attachmentEntry.attachments[0].textContent, undefined);

const sourcePacket = await buildHiveSecretarySourcePacket();
assert.equal(sourcePacket.counts.entryCount, 4);
assert.equal(sourcePacket.counts.userCount, 3);
assert.match(sourcePacket.sourceText, /Validated wallet inputs: 4/);
assert.match(sourcePacket.sourceText, /Protocol Marketing needs/);
assert.match(sourcePacket.sourceText, /launch-surfaces\.txt/);
assert.match(sourcePacket.sourceText, /Telegram, task generation, context editing, and Hive board/);
assert.match(
  sourcePacket.sourceJson.groups[0].entries.find((entry) => entry.attachments?.length > 0).attachments[0].text_content,
  /first launch surfaces/
);

const alexSourcePacket = await buildHiveSecretarySourcePacket({ accountId: "account_alex" });
assert.equal(alexSourcePacket.counts.entryCount, 2);
assert.equal(alexSourcePacket.counts.userCount, 1);
assert.match(alexSourcePacket.sourceText, /Protocol Marketing needs/);
assert.doesNotMatch(alexSourcePacket.sourceText, /Need stronger validator onboarding/);

const queued = await enqueueHiveSecretaryJob({
  reason: "hive_context_smoke",
  sourceEntryId: document.groups[0].entries[0].id,
  sourcePacket,
});
assert.equal(queued.queued, true);

const secretaryState = await getHiveSecretaryState();
assert.equal(secretaryState.job.status, "pending");
assert.equal(secretaryState.sourcePacket.counts.entryCount, 4);

const reportText = formatHiveSecretaryReport({
  title: "Hive Secretary Report",
  summary: "Inputs point to validator onboarding, weekly protocol marketing, and alpha tracking needs.",
  projectSignals: [
    {
      projectType: "protocol_marketing",
      signal: "A weekly narrative packet is needed.",
      reason: "A validated input explicitly requested it.",
    },
  ],
  networkImplications: ["Hive Context can now produce a compact report over validated inputs."],
});
assert.match(reportText, /Hive Secretary Report/);
assert.match(reportText, /Project signals/);

const hiddenEmptyProjects = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "empty_active_project",
      title: "Empty Active Project",
      type: "network",
      status: "active",
      priority: 1,
    },
  ],
});
assert.equal(hiddenEmptyProjects.projectIds.includes("empty_active_project"), false);

const boardManagerEmptyProjects = hiveProjectsDocumentForTests({
  includeEmptyActive: true,
  projectRows: [
    {
      id: "empty_active_project",
      title: "Empty Active Project",
      type: "network",
      status: "active",
      priority: 1,
    },
  ],
});
assert.equal(boardManagerEmptyProjects.projectIds.includes("empty_active_project"), true);

assert.deepEqual(
  normalizeHiveProjectCommentMetadata({
    projectId: "routing_project",
    projectName: "Routing Eligibility and Badge Projection",
  }),
  {
    projectId: "routing_project",
    projectName: "Routing Eligibility and Badge Projection",
  }
);

await saveHiveContextEntry({
  accountId: "account_board_comment",
  displayName: "@boardop",
  body: "Routing board comment: the eligibility source still needs a clear owner.",
  walletAddress: "rBoardCommentWallet",
  walletValidated: true,
  metadata: {
    kind: "hive_project_comment",
    source: "project_board",
    projectComment: {
      projectId: "routing_project",
      projectName: "Routing Eligibility and Badge Projection",
    },
  },
});
const projectComments = await listHiveProjectComments({
  projectIds: ["routing_project", "unrelated_project"],
  limitPerProject: 3,
});
assert.equal(projectComments.routing_project.length, 1);
assert.equal(projectComments.routing_project[0].handle, "@boardop");
assert.match(projectComments.routing_project[0].body, /eligibility source/);
assert.deepEqual(projectComments.unrelated_project, []);
const projectCommentDocument = hiveProjectsDocumentForTests({
  includeEmptyActive: true,
  projectRows: [
    {
      id: "routing_project",
      title: "Routing Eligibility and Badge Projection",
      type: "protocol_development",
      status: "active",
      priority: 1,
    },
  ],
  projectCommentsByProject: projectComments,
});
assert.equal(projectCommentDocument.projects.routing_project.comments.length, 1);
assert.equal(projectCommentDocument.projects.routing_project.comments[0].handle, "@boardop");

let capturedProjectCommentResponse = null;
await handleHiveRoute({
  getLinkedWallet: () => ({ status: "linked", address: "rProjectCommentWallet" }),
  json: (_res, status, body) => {
    capturedProjectCommentResponse = { status, body };
  },
  readJson: async () => ({
    body: "Project board route comment.",
    conversationId: "conversation_should_not_receive_project_comment",
    projectComment: {
      projectId: "routing_project",
      projectName: "Routing Eligibility and Badge Projection",
    },
  }),
  req: { method: "POST" },
  res: {},
  session: { accountId: "account_project_comment", displayName: "@routecomment", primaryProvider: "smoke" },
  url: new URL("https://tasknode.local/api/hive/context"),
});
assert.equal(capturedProjectCommentResponse.status, 200);
assert.equal(capturedProjectCommentResponse.body.entry.metadata.kind, "hive_project_comment");
assert.equal(capturedProjectCommentResponse.body.entry.metadata.source, "project_board");
assert.equal(capturedProjectCommentResponse.body.entry.metadata.projectComment.projectId, "routing_project");
assert.equal(capturedProjectCommentResponse.body.entry.sourceConversationId, "");
assert.equal(capturedProjectCommentResponse.body.user, null);
assert.equal(capturedProjectCommentResponse.body.assistant, null);

const formattedHiveMindContext = formatHiveMindContextForImmediateResponse({
  boardManagerSourcePacket: {
    sourcePacketDigest: "live_source_digest",
    generatedAt: "2026-05-30T02:50:00.000Z",
    boardActionPressure: {
      summary: {
        motionState: "action_required",
        requiresAction: true,
        outstandingNetworkTaskCount: 0,
        pendingNetworkTaskGenerationCount: 0,
        eligibleCandidateCount: 1,
        openFollowupCount: 1,
      },
      signals: [
        {
          projectId: "task_node_core_product_restored",
          requiresAction: true,
          preferredNextAction: "initiate_network_task",
          hasOpenFollowup: false,
          latestClosureAt: "2026-05-30T02:45:27.000Z",
          reasons: ["active project has no live task movement"],
        },
      ],
    },
    openFollowups: [{ accountId: "account_alex", status: "open", lastSentAt: "2026-05-30T02:28:37.000Z" }],
    hiveProjects: { projects: [{ id: "task_node_core_product_restored", title: "Task Node Core Product" }] },
    taskState: {
      recent: [
        {
          taskId: "task_dc07336c457592a783e53b0b7a175df9",
          title: "Ship Four Acceptance Gates Beta Document",
          status: "rewarded",
          rewardActualPft: 18000,
          updatedAt: "2026-05-30T02:45:28.799Z",
        },
      ],
    },
    networkTaskContent: {
      outstanding: [],
      pendingGeneration: [],
      completed: [
        {
          projectId: "task_node_core_product_restored",
          taskId: "task_dc07336c457592a783e53b0b7a175df9",
          title: "Ship Four Acceptance Gates Beta Document",
          state: "rewarded",
          candidateAccountId: "account_alex",
          rewardActualPft: 18000,
          updatedAt: "2026-05-30T02:45:28.799Z",
        },
      ],
      stopped: [],
    },
    networkTaskCandidates: [{ accountId: "account_alex", walletAddress: "rAlexWallet", profileId: "profile_alex" }],
    recentBoardManagerRuns: [{ selectedAction: "do_nothing", microSummaryText: "Waiting for user direction." }],
  },
  secretaryPacket: {
    id: "bmsec_smoke",
    sourceDigest: "secretary_source_digest",
    packetDigest: "secretary_packet_digest",
    packetText: "BOARD MANAGER SECRETARY PACKET\nMotion state: needs_attention\nBoard summary\nTask Node launch loop is active.",
    createdAt: "2026-05-30T00:00:00.000Z",
  },
  secretaryPacketIsCurrentForSource: false,
  requestingAccountId: "account_zephyr",
});
assert.match(formattedHiveMindContext, /HIVE MIND \/ BOARD MANAGER CONTEXT/);
assert.match(formattedHiveMindContext, /Task Node launch loop is active/);
assert.match(formattedHiveMindContext, /LIVE BOARD FACTS - AUTHORITATIVE/);
assert.match(formattedHiveMindContext, /Ship Four Acceptance Gates Beta Document/);
assert.match(formattedHiveMindContext, /status=rewarded/);
assert.match(formattedHiveMindContext, /ownerAccount=account_alex/);
assert.match(formattedHiveMindContext, /requesting_user=no/);
assert.match(formattedHiveMindContext, /No eligible candidate row for the requesting account/);
assert.match(formattedHiveMindContext, /No confirmed tasks for the requesting account/);
assert.match(formattedHiveMindContext, /Compressed Board Manager Secretary Packet - stale/);
assert.match(formattedHiveMindContext, /task_node_core_product_restored/);
assert.ok(
  formattedHiveMindContext.indexOf("LIVE BOARD FACTS - AUTHORITATIVE") <
    formattedHiveMindContext.indexOf("Compressed Board Manager Secretary Packet - stale"),
  "live board facts must precede stale secretary packets"
);

const formattedLiveFacts = formatLiveBoardFactsForImmediateResponse({
  sourcePacketDigest: "live_source_digest",
  taskState: { recent: [{ title: "Acceptance gate task", status: "rewarded", taskId: "task_live", subjectWallet: "rZephyrWallet" }] },
  openFollowups: [{ id: "followup_other", accountId: "account_other", status: "open" }],
  networkTaskCandidates: [
    { accountId: "account_zephyr", walletAddress: "rZephyrWallet", profileId: "profile_zephyr" },
    { accountId: "account_other", walletAddress: "rOtherWallet", profileId: "profile_other" },
  ],
  networkTaskContent: {
    completed: [{ title: "Acceptance gate task", state: "rewarded", taskId: "task_live", candidateAccountId: "account_other" }],
    outstanding: [{ title: "Fix Hive identity scoping", state: "accepted", taskId: "task_hive_identity", candidateAccountId: "account_zephyr" }],
  },
}, { requestingAccountId: "account_zephyr", requestingWalletAddress: "rZephyrWallet" });
assert.match(formattedLiveFacts, /LIVE BOARD FACTS - AUTHORITATIVE/);
assert.match(formattedLiveFacts, /Acceptance gate task/);
assert.match(formattedLiveFacts, /status=rewarded|state=rewarded/);
assert.match(formattedLiveFacts, /Confirmed tasks for requesting user/);
assert.match(formattedLiveFacts, /Confirmed eligible candidate row for requesting user/);
assert.match(formattedLiveFacts, /profile=profile_zephyr/);
assert.match(formattedLiveFacts, /Fix Hive identity scoping/);
assert.match(formattedLiveFacts, /ownerAccount=account_zephyr/);
assert.match(formattedLiveFacts, /requesting_user=yes/);
assert.match(formattedLiveFacts, /ownerWallet=rZephyrWallet/);
assert.match(formattedLiveFacts, /requesting_wallet=yes/);
assert.match(formattedLiveFacts, /account=account_other/);
assert.match(formattedLiveFacts, /requesting_user=no/);

const formattedReportsContext = formatHiveReportsContextForImmediateResponse({
  generatedAt: "2026-06-29T00:00:00.000Z",
  reports: [
    {
      id: "hiverep_exec",
      type: "executive",
      label: "Executive",
      generatedAt: "2026-06-29T00:00:00.000Z",
      model: "z-ai/glm-5.2",
      bodyMarkdown: "# Executive Report\n\nProject Leaders need clearer owner/blocker context.",
    },
    {
      id: "hiverep_intel",
      type: "hive_intelligence",
      label: "Hive Intelligence",
      generatedAt: "2026-06-29T00:00:00.000Z",
      model: "z-ai/glm-5.2",
      bodyMarkdown: "# Hive Intelligence Report\n\nThe network should focus rewards on work that increases PFT value.",
    },
  ],
  harvestReport: {
    report: {
      id: "harvestreport_1",
      generatedAt: "2026-06-29T00:00:00.000Z",
      resolvedCount: 3,
      unresolvedCount: 2,
      bodyMarkdown: "# Harvest Report\n\nThree resolved harvests produced shipped product fixes.",
    },
  },
  liveTaskPacket: {
    packet: {
      generatedAt: "2026-06-29T00:00:00.000Z",
      contributorCount: 1,
      text: "Contributor 1:\n- Network Task Assigned Proposal: Fix Hive Chat context.",
    },
  },
});
assert.match(formattedReportsContext, /HIVE REPORTS CONTEXT - AUTHORITATIVE STRATEGIC BACKGROUND/);
assert.match(formattedReportsContext, /Executive Report/);
assert.match(formattedReportsContext, /Hive Intelligence Report/);
assert.match(formattedReportsContext, /Harvest Report/);
assert.match(formattedReportsContext, /Live Task Packet/);
assert.match(formattedReportsContext, /Fix Hive Chat context/);

const routeAttachmentText = "Hive immediate response should see pasted launch surface context.";
const routeSmokeCorrelationId = randomUUID().replace(/-/g, "").slice(0, 16);
const routeSmokeConversationId = `account_account_hive_smoke_hive_${routeSmokeCorrelationId}`;
const routeSmokeUserMessageId = `msg_hive_context_smoke_${routeSmokeCorrelationId}_user`;
const routeSmokeAssistantMessageId = `msg_hive_context_smoke_${routeSmokeCorrelationId}_assistant`;
const originalFetch = globalThis.fetch;
const originalDeepseekKey = process.env.DEEPSEEK_API_KEY;
process.env.DEEPSEEK_API_KEY = "sk-hive-context-smoke";
let deepSeekRequestSerialized = "";
globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(String(options.body || "{}"));
  deepSeekRequestSerialized = JSON.stringify(request);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      id: "deepseek_hive_immediate_smoke",
      model: "deepseek-v4-pro",
      choices: [
        {
          message: {
            content: "I got the pasted context. The next useful step is to turn it into one concrete launch task.",
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 24,
        total_tokens: 144,
      },
    }),
  };
};

let capturedRouteResponse = null;
await handleHiveRoute({
  getLinkedWallet: () => ({ status: "linked", address: "rHiveSmokeWallet" }),
  json: (_res, status, body) => {
    capturedRouteResponse = { status, body };
  },
  readJson: async () => ({
    body: "Here is pasted Hive context.",
    conversationId: routeSmokeConversationId,
    conversationTitle: "Hive",
    attachments: [
      {
        name: "hive-launch-context.txt",
        mimeType: "text/plain",
        size: routeAttachmentText.length,
        source: "paste",
        dataUrl: `data:text/plain,${encodeURIComponent(routeAttachmentText)}`,
      },
    ],
    userMessageId: routeSmokeUserMessageId,
    assistantMessageId: routeSmokeAssistantMessageId,
  }),
  req: { method: "POST" },
  res: {},
  session: { accountId: "account_hive_smoke", displayName: "Hive Smoke", primaryProvider: "smoke" },
  url: new URL("https://tasknode.local/api/hive/context"),
});
globalThis.fetch = originalFetch;
if (originalDeepseekKey === undefined) {
  delete process.env.DEEPSEEK_API_KEY;
} else {
  process.env.DEEPSEEK_API_KEY = originalDeepseekKey;
}
assert.equal(capturedRouteResponse.status, 200);
assert.match(capturedRouteResponse.body.user.id, /^msg_.+_user$/);
assert.match(capturedRouteResponse.body.assistant.id, /^msg_.+_assistant$/);
assert.equal(capturedRouteResponse.body.assistant.provider, "deepseek");
assert.match(capturedRouteResponse.body.assistant.body, /pasted context/);
assert.equal(capturedRouteResponse.body.immediateResponseWarning, "");
const persistedHiveChatMessages = await getChatMessages({
  accountId: "account_hive_smoke",
  conversationId: routeSmokeConversationId,
});
const persistedHiveUserMessage = persistedHiveChatMessages.find((message) =>
  message.id === capturedRouteResponse.body.user.id
);
const persistedHiveAssistantMessage = persistedHiveChatMessages.find((message) =>
  message.id === capturedRouteResponse.body.assistant.id
);
assert.equal(persistedHiveUserMessage?.body, "Here is pasted Hive context.");
assert.equal(persistedHiveUserMessage?.metadata?.hiveContextEntryId, capturedRouteResponse.body.entry.id);
assert.match(persistedHiveAssistantMessage?.body || "", /pasted context/);
assert.equal(persistedHiveAssistantMessage?.metadata?.kind, "hive_immediate_response");
assert.match(deepSeekRequestSerialized, /Hive immediate response should see pasted launch surface context/);
assert.match(deepSeekRequestSerialized, /REQUESTING USER - AUTHORITATIVE/);
assert.match(deepSeekRequestSerialized, /Account ID: account_hive_smoke/);
assert.match(deepSeekRequestSerialized, /Linked wallet: rHiveSmokeWallet/);
assert.match(deepSeekRequestSerialized, /REQUESTING USER HIVE CONTEXT SOURCE PACKET/);
assert.match(deepSeekRequestSerialized, /This packet is scoped to the requesting account/);
assert.match(deepSeekRequestSerialized, /HIVE MIND \/ BOARD MANAGER CONTEXT/);
assert.match(deepSeekRequestSerialized, /LIVE BOARD FACTS - AUTHORITATIVE/);
assert.match(deepSeekRequestSerialized, /NETWORK TASK ROUTING POLICY - AUTHORITATIVE/);
assert.match(deepSeekRequestSerialized, /Hive Chat cannot create, queue, publish, accept, refuse, or submit personal tasks/);
assert.match(deepSeekRequestSerialized, /Request task button creates user-requested personal task proposals/);
assert.match(deepSeekRequestSerialized, /Do not tell a user that completing personal or engineering tasks is required/);
assert.match(deepSeekRequestSerialized, /generated automatically by the Memory worker/);
assert.match(deepSeekRequestSerialized, /Never tell a user to find, request, or apply for a Network Diagnostic Report/);
assert.match(deepSeekRequestSerialized, /queued automatically after the account's second positively rewarded task/);
assert.match(deepSeekRequestSerialized, /opening Memory generates the same report without any task history/);
assert.match(deepSeekRequestSerialized, /network_task_eligibility/);
assert.match(deepSeekRequestSerialized, /Do not offer to generate a personal task as a fallback/);
assert.match(deepSeekRequestSerialized, /another contributor's outstanding Network Task globally prevents this user/);
assert.match(deepSeekRequestSerialized, /Personal tasks can be useful work, but they are not Network Tasks/);
assert.match(deepSeekRequestSerialized, /Do not offer to create a personal task, task proposal, or concrete card from Hive Chat/);
assert.match(deepSeekRequestSerialized, /Live Board Facts are authoritative/);
assert.match(deepSeekRequestSerialized, /Only describe a task, follow-up, capacity blocker, or reward as the user's own/);
assert.match(deepSeekRequestSerialized, /Hive Reports Context/);
assert.match(deepSeekRequestSerialized, /HIVE REPORTS CONTEXT - AUTHORITATIVE STRATEGIC BACKGROUND/);
assert.match(deepSeekRequestSerialized, /Executive Report/);
assert.match(deepSeekRequestSerialized, /Harvest Report/);
assert.match(deepSeekRequestSerialized, /Live Task Packet/);
assert.match(deepSeekRequestSerialized, /ask at most two targeted clarifying questions/);
assert.match(deepSeekRequestSerialized, /what outcome they want/);
assert.match(deepSeekRequestSerialized, /Requesting account: account_hive_smoke/);
assert.match(deepSeekRequestSerialized, /Requesting wallet: rHiveSmokeWallet/);
assert.doesNotMatch(deepSeekRequestSerialized, /Protocol Marketing needs/);

console.log("hive context smoke ok");
