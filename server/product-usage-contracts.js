import { timingSafeEqual } from "node:crypto";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import {
  appendUsageCredit,
  usageSummary,
} from "./repositories/chat-billing.js";
import { refreshIdentityApprovalsAfterSignal } from "./repositories/identity-approvals.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import {
  ethereumDepositConfigStatus,
  getOrCreateVerifiedEthereumTopUpAccount,
  syncEthereumTopUpAccount,
} from "./ethereum-deposits.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function safeEventText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function safeEqualText(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function safeClientObject(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 24)) {
    const key = safeEventText(rawKey, 80).replace(/[^A-Za-z0-9_.:-]/g, "_");
    if (!key) continue;
    if (rawValue === null || rawValue === undefined) {
      result[key] = "";
    } else if (typeof rawValue === "boolean") {
      result[key] = rawValue;
    } else if (typeof rawValue === "number") {
      result[key] = Number.isFinite(rawValue) ? rawValue : 0;
    } else if (typeof rawValue === "string") {
      result[key] = safeEventText(rawValue, 240);
    } else if (Array.isArray(rawValue)) {
      result[key] = rawValue.slice(0, 12).map((item) => (
        typeof item === "number" && Number.isFinite(item)
          ? item
          : typeof item === "boolean"
            ? item
            : safeEventText(item, 120)
      ));
    } else if (depth < 1) {
      result[key] = safeClientObject(rawValue, depth + 1);
    }
  }
  return result;
}

const clientObservabilityEventTypes = new Set([
  "user.ui.blocker_shown",
  "user.ui.sync_warning_shown",
  "user.ui.action_disabled",
  "user.ui.action_recovered",
  "user.wallet.selected",
]);

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: { ok: false, error, action, message, actionRequired },
  };
}

async function recordUsageObservabilityEvent({
  eventType = "",
  accountId = "",
  action = "",
  resultStatus = "",
  reasonCode = "",
  depositAccount = null,
  creditedEntries = [],
  metadata = {},
  metrics = {},
  sourceRoute = "",
} = {}) {
  if (!accountId || !eventType) return;
  const entries = Array.isArray(creditedEntries) ? creditedEntries : [];
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    sourceSurface: "billing",
    sourceRoute: sourceRoute || `server/product-usage-contracts.js::${action || "usage"}`,
    resultStatus,
    reasonCode,
    metrics: {
      creditedEntryCount: entries.length,
      creditedAmountUsd: entries.reduce((sum, entry) => sum + Number(entry?.amountUsd || 0), 0),
      ...metrics,
    },
    metadata: {
      action: safeEventText(action, 120),
      depositAccountId: safeEventText(depositAccount?.id, 180),
      depositAddress: safeEventText(depositAccount?.address, 120),
      creditedLedgerEntryIds: entries.map((entry) => safeEventText(entry?.id, 180)).filter(Boolean),
      ...metadata,
    },
  }).catch(() => {});
}

function usageAction({ id, label, path, requiredEnv = [], enabled = false, status, note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: configured && enabled,
    status: status || (configured ? (enabled ? "ready" : "disabled") : "missing_config"),
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}


export function usageActions() {
  const ethDeposits = ethereumDepositConfigStatus();

  return [
    usageAction({
      id: "top_up_start",
      label: "Top up with ETH, USDC, or USDT",
      path: "/api/usage/top-up/start",
      enabled: ethDeposits.enabled,
      status: ethDeposits.status,
      note:
        "Allocates one account-scoped Ethereum mainnet deposit address. This is a custodial top-up rail, not a wallet-connect flow.",
      actionRequired: ethDeposits.actionRequired,
    }),
    usageAction({
      id: "top_up_sync",
      label: "Refresh Ethereum deposits",
      path: "/api/usage/top-up/sync",
      enabled: ethDeposits.enabled && ethDeposits.rpcConfigured,
      status: ethDeposits.enabled && ethDeposits.rpcConfigured ? "ready" : ethDeposits.status,
      note:
        "Reads the account deposit address on Ethereum mainnet, credits configured ETH, USDC, and USDT balance increases, and sends the one-time PFT grant after a qualifying USDC top-up for a newly created linked wallet.",
      actionRequired: ethDeposits.rpcConfigured
        ? ethDeposits.actionRequired
        : "Configure ETH_DEPOSIT_RPC_URL or ETHEREUM_RPC_URL for deposit balance sync.",
    }),
    usageAction({
      id: "admin_credit",
      label: "Admin credit",
      path: "/api/usage/credit/admin",
      requiredEnv: ["TASKNODE_ADMIN_CREDIT_TOKEN"],
      enabled: true,
      note:
        "Operator-only bootstrap path for crediting account balances while real crypto top-up rails are not implemented.",
      actionRequired:
        "Configure TASKNODE_ADMIN_CREDIT_TOKEN and send an authorized server-to-server credit request.",
    }),
  ];
}

export function usageActionByPath(pathname) {
  return usageActions().find((action) => action.path === pathname) || null;
}

export function usageActionStart(pathname, method) {
  const action = usageActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_usage_action",
      action: pathname,
      message: "Unknown usage action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the usage action with the declared method.",
    });
  }

  return actionResponse({
    status: 503,
    error: "usage_action_disabled",
    action: action.id,
    message: `${action.label} is disabled until the funding rail is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export async function usageTopUpStart(payload, method, session = null) {
  const action = usageActionByPath("/api/usage/top-up/start");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_top_up_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Start top-up with POST.",
    });
  }

  const accountId = session?.accountId || "";
  if (!accountId) {
    return actionResponse({
      status: 401,
      error: "usage_top_up_login_required",
      action: action.id,
      message: "Sign in before creating a deposit address.",
      actionRequired: "Use a sign-in identity first. Deposit addresses are bound to app accounts, not PFT wallet links.",
    });
  }

  const result = await getOrCreateVerifiedEthereumTopUpAccount({ accountId });
  if (!result.ok) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.top_up_started",
      accountId,
      action: action.id,
      resultStatus: "failed",
      reasonCode: result.error || "usage_top_up_unavailable",
      sourceRoute: "server/product-usage-contracts.js::usageTopUpStart",
    });
    return actionResponse({
      status: result.status || 409,
      error: result.error || "usage_top_up_unavailable",
      action: action.id,
      message: result.message || "Ethereum deposit addresses are not configured for this environment.",
      actionRequired: result.actionRequired || result.config?.actionRequired || action.actionRequired,
    });
  }

  await recordUsageObservabilityEvent({
    eventType: "user.billing.top_up_started",
    accountId,
    action: action.id,
    resultStatus: result.created ? "created" : "ready",
    depositAccount: result.depositAccount,
    sourceRoute: "server/product-usage-contracts.js::usageTopUpStart",
    metadata: {
      network: result.config.network,
      chainId: result.config.chainId,
      blockTag: result.config.blockTag,
    },
  });

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: result.created ? "Ethereum deposit address created." : "Ethereum deposit address ready.",
      depositAccount: result.depositAccount,
      network: result.config.network,
      chainId: result.config.chainId,
      blockTag: result.config.blockTag,
      syncPath: "/api/usage/top-up/sync",
      instructions: [
        "Send only ETH, USDC, or USDT on Ethereum mainnet to this address.",
        "Deposits credit Task Node chat balance after the configured balance sync.",
        "This is a custodial top-up address controlled by Task Node. Users cannot withdraw from it.",
      ],
    },
  };
}

export async function usageTopUpSync(payload, method, session = null) {
  const action = usageActionByPath("/api/usage/top-up/sync");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_top_up_sync_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Refresh top-ups with POST.",
    });
  }

  const accountId = session?.accountId || "";
  if (!accountId) {
    return actionResponse({
      status: 401,
      error: "usage_top_up_login_required",
      action: action.id,
      message: "Sign in before refreshing deposits.",
      actionRequired: "Use a sign-in identity first. Deposit balances are account-scoped.",
    });
  }

  const result = await syncEthereumTopUpAccount({ accountId });
  if (!result.ok) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.refill_sync_failed",
      accountId,
      action: action.id,
      resultStatus: "failed",
      reasonCode: result.error || "usage_top_up_sync_failed",
      sourceRoute: "server/product-usage-contracts.js::usageTopUpSync",
    });
    return actionResponse({
      status: result.status || 502,
      error: result.error || "usage_top_up_sync_failed",
      action: action.id,
      message: result.message || "Ethereum deposit sync failed.",
      actionRequired:
        result.error === "eth_deposit_not_configured"
          ? "Configure ETH_DEPOSIT_XPUB before syncing deposits."
          : "Check Ethereum RPC health and retry.",
    });
  }

  if ((result.creditedEntries || []).length > 0) {
    await recordUsageObservabilityEvent({
      eventType: "user.billing.deposit_observed",
      accountId,
      action: action.id,
      resultStatus: "credited",
      depositAccount: result.depositAccount,
      creditedEntries: result.creditedEntries,
      sourceRoute: "server/product-usage-contracts.js::usageTopUpSync",
      metadata: {
        pendingSymbols: result.pendingSymbols || [],
        syncErrorsPresent: (result.syncErrors || []).length > 0,
      },
    });
  }
  const hasUsdcTopUpCredit = (result.creditedEntries || [])
    .some((entry) => String(entry?.metadata?.asset || "").toUpperCase() === "USDC");
  const networkBadgeRefresh = hasUsdcTopUpCredit
    ? await refreshIdentityApprovalsAfterSignal({
      accountId,
      signal: "billing_usdc_top_up",
      verifiedByAccountId: accountId,
      metadata: {
        creditedLedgerEntryIds: (result.creditedEntries || []).map((entry) => entry?.id).filter(Boolean),
      },
    })
    : null;

  return {
    status: 200,
    body: networkBadgeRefresh ? { ...result, networkBadgeRefresh } : result,
  };
}

export async function usageAdminCredit(payload, method, authorizationHeader = "") {
  const action = usageActionByPath("/api/usage/credit/admin");

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "usage_credit_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Send admin credits with POST.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "usage_credit_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  const expectedAuthorization = `Bearer ${process.env.TASKNODE_ADMIN_CREDIT_TOKEN || ""}`;
  if (!safeEqualText(authorizationHeader, expectedAuthorization)) {
    return actionResponse({
      status: 401,
      error: "usage_credit_unauthorized",
      action: action.id,
      message: "Admin credit requires an authorized server-to-server request.",
      actionRequired: "Send a valid bearer token from a trusted operator environment.",
    });
  }

  const amountUsd = Number(payload?.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 10000) {
    return actionResponse({
      status: 400,
      error: "usage_credit_invalid_amount",
      action: action.id,
      message: "Admin credit requires a positive amountUsd no larger than 10000.",
      actionRequired: "Send a bounded USD credit amount.",
    });
  }

  const accountId =
    typeof payload?.accountId === "string" && payload.accountId.trim()
      ? payload.accountId.trim().slice(0, 80)
      : "";
  if (!accountId) {
    return actionResponse({
      status: 400,
      error: "usage_credit_account_required",
      action: action.id,
      message: "Admin credit requires an explicit accountId.",
      actionRequired: "Send the exact accountId that should receive credit.",
    });
  }

  const idempotencyKey =
    typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
      ? payload.idempotencyKey.trim().slice(0, 180)
      : "";
  if (idempotencyKey.length < 12) {
    return actionResponse({
      status: 400,
      error: "usage_credit_idempotency_required",
      action: action.id,
      message: "Admin credit requires an idempotencyKey.",
      actionRequired: "Send a stable idempotencyKey for this operator credit event.",
    });
  }

  const note =
    typeof payload?.note === "string" && payload.note.trim()
      ? payload.note.trim().slice(0, 240)
      : "Manual admin credit";
  const actor =
    typeof payload?.actor === "string" && payload.actor.trim()
      ? payload.actor.trim().slice(0, 80)
      : "admin";
  const entry = await appendUsageCredit({
    accountId,
    amountUsd,
    source: "admin_credit",
    note,
    createdBy: actor,
    uniqueKey: `admin_credit:${idempotencyKey}`,
    metadata: {
      idempotencyKey,
      actor,
    },
  });
  const summary = await usageSummary({ accountId });

  return {
    status: 200,
    body: {
      ok: true,
      action: action.id,
      message: "Admin credit recorded.",
      ledgerEntry: entry,
      usage: {
        billingModel: "usage_based",
        currency: "USD",
        currentSpendUsd: summary.currentSpendUsd,
        currentCreditUsd: summary.currentCreditUsd,
        availableCreditUsd: summary.availableCreditUsd,
        ledgerEntryCount: summary.ledgerEntryCount,
      },
    },
  };
}

export async function userObservabilityClientEvent(payload, method, session = null) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "user_observability_event_method_not_allowed",
      action: "user_observability_event",
      message: "User observability events require POST.",
      actionRequired: "Submit client observability events with POST.",
    });
  }

  if (!session?.accountId) {
    return actionResponse({
      status: 401,
      error: "user_observability_login_required",
      action: "user_observability_event",
      message: "Sign in before recording user observability events.",
      actionRequired: "Use an authenticated app session.",
    });
  }

  const eventType = safeEventText(payload?.eventType || payload?.event_type, 160);
  if (!clientObservabilityEventTypes.has(eventType)) {
    return actionResponse({
      status: 400,
      error: "user_observability_event_type_not_allowed",
      action: "user_observability_event",
      message: "That client observability event type is not allowed.",
      actionRequired: "Use one of the documented user UI observability event types.",
    });
  }

  const linkedWallet = await getLinkedWallet({ accountId: session.accountId });
  const result = await recordUserObservabilityEvent({
    eventType,
    accountId: session.accountId,
    walletAddress: safeEventText(payload?.walletAddress || payload?.wallet_address || linkedWallet?.address, 120),
    walletScope: safeEventText(payload?.walletScope || payload?.wallet_scope || (linkedWallet?.address ? "active" : ""), 80),
    sessionId: session.id,
    taskId: safeEventText(payload?.taskId || payload?.task_id, 180),
    conversationId: safeEventText(payload?.conversationId || payload?.conversation_id, 180),
    projectId: safeEventText(payload?.projectId || payload?.project_id, 180),
    sourceSurface: safeEventText(payload?.sourceSurface || payload?.source_surface || "client", 120),
    sourceRoute: safeEventText(payload?.sourceRoute || payload?.source_route || "client", 240),
    resultStatus: safeEventText(payload?.resultStatus || payload?.result_status || "observed", 120),
    reasonCode: safeEventText(payload?.reasonCode || payload?.reason_code, 180),
    decision: safeClientObject(payload?.decision || payload?.decision_json),
    metrics: safeClientObject(payload?.metrics || payload?.metrics_json),
    metadata: safeClientObject(payload?.metadata || payload?.metadata_json),
  });

  return {
    status: 202,
    body: {
      ok: true,
      action: "user_observability_event",
      recorded: result?.ok === true,
      skipped: Boolean(result?.skipped),
      eventType,
      eventId: result?.id || "",
      reason: result?.reason || result?.error || "",
    },
  };
}
