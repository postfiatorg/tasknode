import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-runtime-store-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");

try {
  const {
    appendUsageCredit,
    delinkWalletFromAccount,
    getContextDocument,
    getContextHistory,
    getLinkedWallet,
    linkWalletToAccount,
    saveContextDocument,
    saveIndexedContextHistory,
    usageSummary,
  } = await import("../server/runtime-store.js");
  const { appState } = await import("../server/app-state.js");
  const first = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const replay = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke replay",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const summary = usageSummary({ accountId: "acct_runtime_smoke" });

  if (!first?.id || replay?.id !== first.id || replay?.idempotentReplay !== true) {
    throw new Error("Initial provider credit is not idempotent.");
  }

  if (summary.currentCreditUsd !== 5 || summary.ledgerEntryCount !== 1) {
    throw new Error(`Unexpected credit summary: ${JSON.stringify(summary)}`);
  }

  const savedContext = saveContextDocument({
    accountId: "acct_runtime_smoke",
    title: "Runtime smoke context",
    body: "This account-scoped context remains available without a linked wallet.",
  });

  if (!savedContext.ok) {
    throw new Error(`Native context did not save: ${JSON.stringify(savedContext)}`);
  }

  const imported = saveIndexedContextHistory({
    accountId: "acct_runtime_smoke",
    snapshot: {
      walletAddress: "rSmokeWalletAddress",
      contextRevisions: [
        {
          id: "ctx-1",
          cid: "ipfs://bafyContextSmoke",
          tx_hash: "ABC123",
          created_at: "2026-05-16T00:00:00.000Z",
          word_count: 42,
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Private task title",
          status: "rewarded",
          verification_type: "text",
        },
      ],
      taskEvents: [
        {
          id: "event-1",
          task_id: "task-1",
          event_type: "submission_recorded",
          event_payload: JSON.stringify({
            artifact_cid: "ipfs://bafyEvidenceSmoke",
            response_text: "PRIVATE EVIDENCE TEXT MUST NOT BE STORED",
          }),
          created_at: "2026-05-16T00:01:00.000Z",
        },
      ],
    },
  });
  const unlinkedContext = getContextDocument({ accountId: "acct_runtime_smoke" });
  const unlinkedHistory = getContextHistory({ accountId: "acct_runtime_smoke" });
  const history = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rSmokeWalletAddress",
  });
  const otherWalletHistory = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rDifferentSmokeWallet",
  });
  const serializedHistory = JSON.stringify(history);

  if (!imported.ok || history.contextUpdateCount !== 1 || history.taskEventCount !== 1) {
    throw new Error(`Unexpected context history summary: ${serializedHistory}`);
  }

  if (unlinkedContext.revision !== 1 || unlinkedHistory.contextUpdateCount !== 0 || unlinkedHistory.canHydrate) {
    throw new Error(
      `Unlinked context/history boundary failed: ${JSON.stringify({ unlinkedContext, unlinkedHistory })}`
    );
  }

  if (otherWalletHistory.contextUpdateCount !== 0 || otherWalletHistory.pointerCount !== 0) {
    throw new Error(`Wallet-scoped history leaked to another wallet: ${JSON.stringify(otherWalletHistory)}`);
  }

  const accountSession = { accountId: "acct_runtime_smoke" };
  const linked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge",
    signature: "smoke-signature",
  });
  const linkedState = appState(accountSession);

  if (!linked.ok || linkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Linked wallet history did not appear: ${JSON.stringify(linkedState.context.history)}`);
  }

  const delinked = delinkWalletFromAccount({ accountId: accountSession.accountId });
  const delinkedState = appState(accountSession);

  if (
    !delinked.ok ||
    delinkedState.context.document.revision !== 1 ||
    delinkedState.context.history.pointerCount !== 0 ||
    delinkedState.context.history.canHydrate
  ) {
    throw new Error(`Delinked app state boundary failed: ${JSON.stringify(delinkedState.context)}`);
  }

  const relinked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge-2",
    signature: "smoke-signature-2",
    proofPurpose: "wallet_relink",
  });
  const relinkedState = appState(accountSession);

  if (!relinked.ok || relinkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Relinked wallet history did not reappear: ${JSON.stringify(relinkedState.context.history)}`);
  }

  delinkWalletFromAccount({ accountId: accountSession.accountId });
  const linkedOther = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rDifferentSmokeWallet",
    publicKey: "smoke-public-key-3",
    challengeId: "smoke-challenge-3",
    signature: "smoke-signature-3",
    proofPurpose: "wallet_relink",
  });
  const otherLinkedState = appState(accountSession);

  if (!linkedOther.ok || otherLinkedState.context.history.pointerCount !== 0) {
    throw new Error(`Different linked wallet saw old history: ${JSON.stringify(otherLinkedState.context.history)}`);
  }

  const reclaimAddress = "rReclaimSmokeWallet";
  const firstOwner = linkWalletToAccount({
    accountId: "acct_reclaim_owner_a",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-a",
    signature: "smoke-reclaim-signature-a",
  });
  const reclaimed = linkWalletToAccount({
    accountId: "acct_reclaim_owner_b",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-b",
    signature: "smoke-reclaim-signature-b",
    proofPurpose: "wallet_relink",
  });
  const firstOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_a" });
  const secondOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_b" });

  if (
    !firstOwner.ok ||
    !reclaimed.ok ||
    reclaimed.reclaimedWalletCount !== 1 ||
    firstOwnerWallet.status !== "not_linked" ||
    secondOwnerWallet.status !== "linked" ||
    secondOwnerWallet.address !== reclaimAddress
  ) {
    throw new Error(
      `Wallet reclaim boundary failed: ${JSON.stringify({ firstOwner, reclaimed, firstOwnerWallet, secondOwnerWallet })}`
    );
  }

  if (!history.latestContextPointer?.cid || history.latestContextPointer.cid !== "bafyContextSmoke") {
    throw new Error("Latest context pointer was not normalized.");
  }

  if (!serializedHistory.includes("bafyEvidenceSmoke")) {
    throw new Error("Indexed task event CID was not retained.");
  }

  if (serializedHistory.includes("PRIVATE EVIDENCE TEXT MUST NOT BE STORED")) {
    throw new Error("Indexed history import leaked raw event payload text.");
  }

  console.log("runtime store smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
