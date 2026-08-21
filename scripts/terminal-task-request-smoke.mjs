import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const storeDir = mkdtempSync(path.join(tmpdir(), "tasknode-terminal-request-smoke-"));
process.env.TASKNODE_STORE_PATH = path.join(storeDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";

try {
  const { linkWalletToAccount } = await import("../server/runtime-store.js");
  const { terminalTaskRequestAction } = await import("../server/task-request.js");

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const accountId = `acct_terminal_request_smoke_${suffix}`;
  const walletAddress = `rTerminalRequestSmoke${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 18)}`;
  const linked = linkWalletToAccount({
    accountId,
    address: walletAddress,
    publicKey: "",
    signature: `terminal_request_smoke_${suffix}`,
    proofPurpose: "wallet_link",
  });
  assert.equal(linked.ok, true);

  const basePayload = {
    phase: "submit",
    source: "pfterminal",
    sourceConversationTitle: "PFTerminal",
    requestedTaskKind: "personal",
  };
  const first = await terminalTaskRequestAction({
    ...basePayload,
    requestId: `req_terminal_request_a_${suffix}`,
    bundleId: `bundle_terminal_request_a_${suffix}`,
    userDetailText: "Create a concise terminal request smoke task.",
  }, "POST", { accountId });
  const second = await terminalTaskRequestAction({
    ...basePayload,
    requestId: `req_terminal_request_b_${suffix}`,
    bundleId: `bundle_terminal_request_b_${suffix}`,
    userDetailText: "Create a different terminal request smoke task.",
  }, "POST", { accountId });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(second.body.ok, true);
  assert.match(first.body.bundleDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(second.body.bundleDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first.body.bundleDigest, second.body.bundleDigest);
  assert.equal(first.body.visibleRequest.skipped, true);
  assert.equal(first.body.generationScheduled.scheduled, false);

  console.log("terminal task request smoke ok");
} finally {
  rmSync(storeDir, { recursive: true, force: true });
}
