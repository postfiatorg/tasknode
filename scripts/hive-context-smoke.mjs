import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";

const {
  getHiveContextDocument,
  saveHiveContextEntry,
} = await import("../server/repositories/hive-context.js");

await saveHiveContextEntry({
  accountId: "account_zephyr",
  displayName: "Zephyr",
  body: "Need stronger validator onboarding context for Network Validation tasks.",
  sourceConversationId: "conversation_1",
  sourceConversationTitle: "validator planning",
});

await saveHiveContextEntry({
  accountId: "account_alex",
  displayName: "Alex",
  body: "Protocol Marketing needs a concise weekly narrative packet.",
  sourceConversationId: "conversation_2",
  sourceConversationTitle: "marketing planning",
});

await saveHiveContextEntry({
  accountId: "account_alex",
  displayName: "Alex",
  body: "Alpha Generation should track wallet clustering questions.",
  sourceConversationId: "conversation_3",
  sourceConversationTitle: "alpha planning",
});

const document = await getHiveContextDocument();
assert.equal(document.entryCount, 3);
assert.equal(document.userCount, 2);
assert.deepEqual(document.groups.map((group) => group.displayName), ["Alex", "Zephyr"]);
assert.equal(document.groups[0].entries.length, 2);
assert.match(document.groups[0].entries[0].body, /Alpha Generation|Protocol Marketing/);

console.log("hive context smoke ok");
