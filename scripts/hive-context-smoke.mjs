import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  buildHiveSecretarySourcePacket,
  enqueueHiveSecretaryJob,
  formatHiveSecretaryReport,
  getHiveContextDocument,
  getHiveSecretaryState,
  markHiveContextEntriesWalletValidated,
  saveHiveContextEntry,
} = await import("../server/repositories/hive-context.js");

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

const sourcePacket = await buildHiveSecretarySourcePacket();
assert.equal(sourcePacket.counts.entryCount, 4);
assert.equal(sourcePacket.counts.userCount, 3);
assert.match(sourcePacket.sourceText, /Validated wallet inputs: 4/);
assert.match(sourcePacket.sourceText, /Protocol Marketing needs/);

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

console.log("hive context smoke ok");
