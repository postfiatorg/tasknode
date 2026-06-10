import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknode-task-request-context-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_ENABLED = "false";

try {
  const { saveContextDocument } = await import("../server/runtime-store.js");
  const { buildRequestBundle } = await import("../server/task-request.js");
  const { TASKGEN_CONTEXT_MAX_CHARS } = await import("../shared/context-budget.js");

  const accountId = "acct_context_budget_smoke";
  const longBody = [
    "<h1>Current Direction</h1>",
    `<p>${"launch product context ".repeat(4000)}</p>`,
    "<h2>Second Section</h2>",
    `<p>${"keep the concrete operating notes available ".repeat(1800)}</p>`,
  ].join("");

  const saved = saveContextDocument({
    accountId,
    title: "Long Context",
    body: longBody,
  });
  assert.equal(saved.ok, true);

  const bundle = await buildRequestBundle({
    accountId,
    walletAddress: "rContextBudgetWallet111111111111111111",
    request: {
      requestId: "req_context_budget_smoke",
      bundleId: "bundle_context_budget_smoke",
      requestText: "Request a task",
      userDetailText: "Use my current direction.",
      requestedTaskKind: "personal",
      subjectEncryptionPubkey: "ed".padEnd(66, "1"),
      source: "task_interface",
      sourceConversationTitle: "Tasks",
      conversationId: "",
      attachments: [],
    },
    authorityWallet: "rTaskAuthority1111111111111111111111",
  });

  const contextDoc = bundle.context.primary_context_doc;
  assert.equal(contextDoc.summary.length, TASKGEN_CONTEXT_MAX_CHARS);
  assert.equal(contextDoc.summary.includes("<p>"), false);
  assert.equal(contextDoc.summary.includes("<h1>"), false);
  assert.ok(contextDoc.summary.startsWith("Current Direction"));
  assert.ok(contextDoc.word_count > 5000);
  assert.equal(Object.hasOwn(contextDoc, "usage_percent"), false);
  assert.equal(Object.hasOwn(contextDoc, "included_char_count"), false);
  assert.equal(Object.hasOwn(contextDoc, "omitted_char_count"), false);
  assert.equal(Object.hasOwn(contextDoc, "max_chars"), false);

  console.log("task-request-context-budget-smoke: ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
