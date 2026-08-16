import { getAccountIdentityProfile } from "./repositories/account-profiles.js";
import { getTaskAccountingCheckoutAccess } from "./repositories/task-accounting-harvester.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

async function linkedWalletForSession({ getLinkedWallet, session } = {}) {
  if (!session?.accountId || typeof getLinkedWallet !== "function") return null;
  try {
    return await getLinkedWallet({ accountId: session.accountId });
  } catch {
    return null;
  }
}

function normalizedList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean);
}

export function wantsRawAuditPacket(url = null) {
  const value = String(url?.searchParams?.get("includeRaw") || url?.searchParams?.get("includeSourcePacket") || "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export async function hiveBrainOperatorAccess(session = null) {
  if (!session?.accountId) {
    return { ok: false, status: 401, error: "hive_brain_login_required", message: "Sign in before opening Hive Brain." };
  }
  const profile = await getAccountIdentityProfile({ accountId: session.accountId }) || {};
  const allowedAccounts = new Set(normalizedList(process.env.TASKNODE_HIVE_BRAIN_OPERATOR_ACCOUNT_IDS || ""));
  if (allowedAccounts.has(String(session.accountId || "").trim().toLowerCase())) {
    return { ok: true, profile };
  }
  const allowedHandles = new Set(normalizedList(process.env.TASKNODE_HIVE_BRAIN_OPERATOR_HANDLES || ""));
  const candidateHandles = [
    profile.hiveHandle,
    profile.handle,
    profile.publicDisplayName,
    profile.displayName,
    session.hiveHandle,
    session.displayName,
  ]
    .map((value) => String(value || "").trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean);
  if (candidateHandles.some((handle) => allowedHandles.has(handle))) {
    return { ok: true, profile };
  }
  return {
    ok: false,
    status: 403,
    error: "hive_brain_operator_required",
    message: "Hive Brain is restricted to operator accounts.",
  };
}

export async function hiveReportRerunAccess(session = null) {
  if (!session?.accountId) {
    return { ok: false, status: 401, error: "hive_report_rerun_login_required", message: "Sign in before rerunning Hive reports." };
  }
  const profile = await getAccountIdentityProfile({ accountId: session.accountId }) || {};
  const allowedAccounts = new Set(normalizedList(process.env.TASKNODE_HIVE_REPORT_RERUN_ACCOUNT_IDS || ""));
  const allowedHandles = new Set(normalizedList(process.env.TASKNODE_HIVE_REPORT_RERUN_HANDLES || ""));
  const accountId = String(session.accountId || "").trim().toLowerCase();
  const handleCandidates = [
    profile.hiveHandle,
    profile.handle,
    profile.publicDisplayName,
    profile.displayName,
    session.hiveHandle,
    session.displayName,
  ].map((value) => String(value || "").trim().replace(/^@+/, "").toLowerCase()).filter(Boolean);
  if (allowedAccounts.has(accountId) || handleCandidates.some((handle) => allowedHandles.has(handle))) {
    return { ok: true, profile };
  }
  return {
    ok: false,
    status: 403,
    error: "hive_report_rerun_operator_required",
    message: "Only configured operator accounts can rerun Hive reports from the UI.",
  };
}

export function canResolveTaskAccountingHarvest({ session = null, profile = {}, linkedWallet = null } = {}) {
  const allowedAccounts = new Set(normalizedList(process.env.TASKNODE_TASK_ACCOUNTING_HARVEST_RESOLVER_ACCOUNT_IDS || ""));
  const allowedHandles = new Set(normalizedList(process.env.TASKNODE_TASK_ACCOUNTING_HARVEST_RESOLVER_HANDLES || ""));
  const allowedWallets = new Set(normalizedList(process.env.TASKNODE_TASK_ACCOUNTING_HARVEST_RESOLVER_WALLETS || ""));
  const accountId = String(session?.accountId || "").trim();
  const handleCandidates = [
    profile.hiveHandle,
    profile.handle,
    profile.publicDisplayName,
    profile.displayName,
    session?.hiveHandle,
    session?.displayName,
  ].map((value) => String(value || "").trim().replace(/^@+/, "").toLowerCase()).filter(Boolean);
  const wallet = String(linkedWallet?.address || linkedWallet?.walletAddress || "").trim();
  return (
    allowedAccounts.has(accountId.toLowerCase()) ||
    handleCandidates.some((handle) => allowedHandles.has(handle)) ||
    (wallet && allowedWallets.has(wallet.toLowerCase()))
  );
}

export async function taskAccountingCheckoutPermissions({ getLinkedWallet, session = null } = {}) {
  const linkedWallet = await linkedWalletForSession({ getLinkedWallet, session });
  const walletAddress = safeText(linkedWallet?.address || linkedWallet?.walletAddress || "", 120);
  const access = await getTaskAccountingCheckoutAccess({
    accountId: session?.accountId || "",
    walletAddress,
  }).catch(() => false);
  const canCheckout = typeof access === "object" ? Boolean(access.canCheckout) : Boolean(access);
  const hasCoreContributorBadge = typeof access === "object" ? Boolean(access.hasCoreContributorBadge) : Boolean(access);
  const hasActiveOrcAgent = typeof access === "object" ? Boolean(access.hasActiveOrcAgent) : false;
  const reason = !canCheckout
    ? "core_contributor_or_active_orc_required"
    : !walletAddress
      ? "linked_wallet_required"
      : "";
  return {
    canCheckout: Boolean(canCheckout && walletAddress),
    hasCoreContributorBadge,
    hasActiveOrcAgent,
    walletAddress,
    accountId: safeText(session?.accountId || "", 180),
    reason,
  };
}
