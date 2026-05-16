import {
  actualChatCost,
  anyChatProviderEnabled,
  chatExecutionStatus,
  chatModeConfig,
  chatModePrices,
  executeChat,
  normalizedChatMode,
} from "./chat-router.js";
import { appendUsageCredit, usageSummary } from "./runtime-store.js";

function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function actionResponse({ status, error, action, message, actionRequired }) {
  return {
    status,
    body: {
      ok: false,
      error,
      action,
      message,
      actionRequired,
    },
  };
}

function provider({ id, label, kind, requiredEnv, note }) {
  const configured = hasAll(requiredEnv);
  const startPath = `/api/auth/start/${id}`;
  const callbackPath = `/api/auth/callback/${id}`;

  return {
    id,
    label,
    kind,
    configured,
    enabled: false,
    status: configured ? "configured" : "missing_config",
    startPath,
    callbackPath,
    actionRequired: configured
      ? "Implement callback handling, account merge rules, and launch review before enabling this provider"
      : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function walletAction({ id, label, path, requiredEnv = [], note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: false,
    status: configured ? "disabled" : "missing_config",
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
}

function contextAction({ id, label, path, requiredEnv = [], note, actionRequired }) {
  const configured = hasAll(requiredEnv);

  return {
    id,
    label,
    path,
    method: "POST",
    configured,
    enabled: false,
    status: configured ? "disabled" : "missing_config",
    actionRequired: configured ? actionRequired : `Configure ${requiredEnv.join(", ")}`,
    note,
  };
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

function chatPayload(payload) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const mode = typeof payload?.mode === "string" ? payload.mode : "Private Instant";
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim().slice(0, 80)
      : "dev";
  const dryRun = payload?.dryRun === true;
  return { message, mode: normalizedChatMode(mode), conversationId, dryRun };
}

export function chatEstimate(payload) {
  const { message, mode } = chatPayload(payload);
  const inputTokens = Math.max(1, Math.ceil(message.length / 4));
  const estimatedOutputTokens = mode.includes("Thinking") ? 1800 : 700;
  const estimatedUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens: estimatedOutputTokens,
  });
  const execution = chatExecutionStatus(mode);

  return {
    ok: true,
    mode,
    provider: execution.provider,
    model: execution.model,
    providerConfigured: execution.configured,
    providerStatus: execution.status,
    executionReady: execution.enabled,
    inputTokens,
    estimatedOutputTokens,
    estimatedUsd: Number(Math.max(0.0001, estimatedUsd).toFixed(6)),
    currency: "USD",
    billingModel: "usage_based",
    requiresConfirmation: estimatedUsd >= 0.05,
    policy: "This is an estimate only. Final billing is based on provider usage returned after execution.",
  };
}

export async function chatSend(payload, method) {
  if (method !== "POST") {
    return actionResponse({
      status: 405,
      error: "chat_send_method_not_allowed",
      action: "chat_send",
      message: "Chat send requires POST.",
      actionRequired: "Send chat payloads with POST.",
    });
  }

  const { message, mode, conversationId, dryRun } = chatPayload(payload);
  const estimate = chatEstimate(payload);

  if (!message) {
    return actionResponse({
      status: 400,
      error: "chat_message_required",
      action: "chat_send",
      message: "Chat send requires a non-empty message.",
      actionRequired: "Send a message before requesting chat execution.",
    });
  }

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        action: "chat_send",
        message: estimate.executionReady
          ? "Chat execution is configured. Dry run skipped the provider call."
          : "Chat execution is not configured for this mode. Dry run skipped the provider call.",
        estimate,
      },
    };
  }

  if (!estimate.executionReady) {
    const configured = estimate.providerConfigured;
    return {
      status: configured ? 503 : 409,
      body: {
        ok: false,
        error: configured ? "chat_provider_disabled" : "chat_provider_not_configured",
        action: "chat_send",
        message: `${mode} is not enabled for chat execution in this environment.`,
        actionRequired: configured
          ? `Enable and verify the ${estimate.provider} route for this mode or choose a ready mode.`
          : `Configure the ${estimate.provider} provider for this mode or choose a ready mode.`,
        estimate,
      },
    };
  }

  try {
    const result = await executeChat({ mode, message, conversationId });
    return {
      status: 200,
      body: {
        ok: true,
        action: "chat_send",
        message: "Chat response generated.",
        conversationId,
        mode,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        user: result.user,
        assistant: result.assistant,
        estimate,
        usage: {
          billingModel: "usage_based",
          currency: "USD",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          costUsd: result.usage.costUsd,
        },
        ledgerEntry: result.ledgerEntry,
      },
    };
  } catch (error) {
    const status = error?.status || 502;
    return {
      status,
      body: {
        ok: false,
        error: error?.message || "chat_provider_error",
        action: "chat_send",
        message:
          status === 504
            ? "The chat provider timed out before returning a response."
            : "The chat provider could not complete this response.",
        actionRequired:
          "Retry with a shorter prompt, choose another configured mode, or check provider health.",
        estimate,
      },
    };
  }
}

export function chatModes() {
  return Object.keys(chatModePrices).map((label) => {
    const status = chatExecutionStatus(label);
    return {
      label,
      provider: status.provider,
      model: status.model,
      configured: status.configured,
      enabled: status.enabled,
      status: status.status,
      privacy: status.provider === "openrouter" ? "Private provider route" : "Frontier provider route",
      latency: label.includes("Thinking") ? "Deep" : "Fast",
    };
  });
}

export function authProviders() {
  return [
    provider({
      id: "telegram",
      label: "Telegram",
      kind: "bot_account_link",
      requiredEnv: ["TELEGRAM_AUTH_BOT_TOKEN"],
      note:
        "Preferred mobile account-link path. The bot token is enough for readiness, but the account callback is not wired yet.",
    }),
    provider({
      id: "discord",
      label: "Discord",
      kind: "oauth",
      requiredEnv: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI"],
      note:
        "Required for Discord chat continuity and bot consolidation. OAuth callback wiring is the next implementation step.",
    }),
    provider({
      id: "x",
      label: "X",
      kind: "oauth",
      requiredEnv: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI"],
      note:
        "Useful for pseudonymous identity and public profile continuity. OAuth callback wiring is not active yet.",
    }),
    provider({
      id: "email",
      label: "Email",
      kind: "magic_link",
      requiredEnv: ["EMAIL_FROM", "EMAIL_PROVIDER_API_KEY"],
      note:
        "Email should be account fallback, but no transactional email provider has been selected for Task Node Official yet.",
    }),
  ];
}

export function walletActions() {
  return [
    walletAction({
      id: "link_start",
      label: "Link seed wallet",
      path: "/api/wallet/link/start",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Begins the preferred seed-based PFTL wallet path after local seed storage is implemented.",
      actionRequired:
        "Implement encrypted local seed storage, backup warnings, and one-wallet-per-account checks before enabling wallet link.",
    }),
    walletAction({
      id: "unlock_start",
      label: "Unlock wallet action",
      path: "/api/wallet/unlock/start",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Unlocks only wallet-bound actions such as sending PFT, signing verifications, or inking context manifests.",
      actionRequired:
        "Implement unlock transaction boundaries and signing confirmation screens before enabling wallet unlock.",
    }),
    walletAction({
      id: "delink",
      label: "Delink wallet",
      path: "/api/wallet/delink",
      note:
        "Required for production-safe onboarding tests and account recovery without corrupting identity history.",
      actionRequired:
        "Define balance ownership, audit logging, recovery warnings, and test-only guardrails before enabling delink.",
    }),
    walletAction({
      id: "relink_start",
      label: "Relink wallet",
      path: "/api/wallet/relink/start",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Allows repeated wallet onboarding tests after a safe delink path exists.",
      actionRequired:
        "Implement relink ownership verification and wallet history reconciliation before enabling relink.",
    }),
  ];
}

export function contextActions() {
  return [
    contextAction({
      id: "import_shared_url",
      label: "Import shared URL",
      path: "/api/context/import/start",
      requiredEnv: ["IPFS_API_URL"],
      note:
        "Imports Google Docs, Notion, Gist, or other shared document URLs into a cacheable context record.",
      actionRequired:
        "Implement URL evidence checks, document fetch adapters, cache storage, and user confirmation before enabling context import.",
    }),
    contextAction({
      id: "save_edit",
      label: "Save context edit",
      path: "/api/context/edit/save",
      note:
        "Saves native context edits without inking a PFTL transaction by default.",
      actionRequired:
        "Implement context document schema, edit history, permissions, and conflict handling before enabling context edits.",
    }),
    contextAction({
      id: "ink_manifest",
      label: "Ink PFTL manifest",
      path: "/api/context/manifest/ink",
      requiredEnv: ["PFTL_RPC_URL", "PFTL_RPC_API_KEY"],
      note:
        "Explicitly writes a portable context manifest pointer to PFTL after wallet unlock.",
      actionRequired:
        "Implement manifest schema, wallet unlock confirmation, pointer transaction creation, and index verification before enabling manifest ink.",
    }),
  ];
}

export function usageActions() {
  return [
    usageAction({
      id: "top_up_start",
      label: "Top up with crypto",
      path: "/api/usage/top-up/start",
      enabled: false,
      status: "research",
      note:
        "Placeholder for crypto top-up rails such as USDC or USDT deposit addresses, MetaMask, or Phantom.",
      actionRequired:
        "Choose the safest funding rail and settlement/reconciliation model before enabling user top-ups.",
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

export function contextActionByPath(pathname) {
  return contextActions().find((action) => action.path === pathname) || null;
}

export function contextActionStart(pathname, method) {
  const action = contextActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_context_action",
      action: pathname,
      message: "Unknown context action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "context_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the context action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "context_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "context_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until the context document boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
}

export function walletActionByPath(pathname) {
  return walletActions().find((action) => action.path === pathname) || null;
}

export function walletActionStart(pathname, method) {
  const action = walletActionByPath(pathname);

  if (!action) {
    return actionResponse({
      status: 404,
      error: "unknown_wallet_action",
      action: pathname,
      message: "Unknown wallet action.",
    });
  }

  if (method !== action.method) {
    return actionResponse({
      status: 405,
      error: "wallet_action_method_not_allowed",
      action: action.id,
      message: `${action.label} requires ${action.method}.`,
      actionRequired: "Call the wallet action with the declared method.",
    });
  }

  if (!action.configured) {
    return actionResponse({
      status: 409,
      error: "wallet_action_not_configured",
      action: action.id,
      message: `${action.label} is not configured for this environment.`,
      actionRequired: action.actionRequired,
    });
  }

  return actionResponse({
    status: 503,
    error: "wallet_action_disabled",
    action: action.id,
    message: `${action.label} is configured but disabled until the wallet custody boundary is implemented.`,
    actionRequired: action.actionRequired,
  });
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

export function usageAdminCredit(payload, method, authorizationHeader = "") {
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

  if (authorizationHeader !== `Bearer ${process.env.TASKNODE_ADMIN_CREDIT_TOKEN}`) {
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
      : "dev";
  const note =
    typeof payload?.note === "string" && payload.note.trim()
      ? payload.note.trim().slice(0, 240)
      : "Manual admin credit";
  const entry = appendUsageCredit({
    accountId,
    amountUsd,
    note,
    createdBy: "admin",
  });
  const summary = usageSummary();

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

export function authProviderById(providerId) {
  return authProviders().find((providerItem) => providerItem.id === providerId) || null;
}

export function authStart(providerId) {
  const providerItem = authProviderById(providerId);

  if (!providerItem) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "unknown_auth_provider",
        provider: providerId,
        message: "Unknown auth provider.",
      },
    };
  }

  if (!providerItem.configured) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "auth_provider_not_configured",
        provider: providerItem.id,
        message: `${providerItem.label} is not configured for this environment.`,
        actionRequired: providerItem.actionRequired,
      },
    };
  }

  return {
    status: 503,
    body: {
      ok: false,
      error: "auth_provider_disabled",
      provider: providerItem.id,
      message: `${providerItem.label} auth is configured but disabled until callback handling and account merge rules are implemented.`,
      actionRequired: providerItem.actionRequired,
    },
  };
}

export function authCallback(providerId) {
  const providerItem = authProviderById(providerId);

  if (!providerItem) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "unknown_auth_provider",
        provider: providerId,
        message: "Unknown auth provider.",
      },
    };
  }

  return {
    status: 501,
    body: {
      ok: false,
      error: "auth_callback_not_implemented",
      provider: providerItem.id,
      message: `${providerItem.label} callback handling is not implemented yet.`,
      actionRequired:
        "Implement callback verification, account merge rules, and session issuance before enabling login.",
    },
  };
}

export function readiness() {
  const providers = authProviders();
  const ledger = usageSummary();
  const chatExecutionReady = anyChatProviderEnabled();
  return {
    generatedAt: new Date().toISOString(),
    auth: {
      configuredProviders: providers.filter((item) => item.configured).map((item) => item.id),
      launchReady: false,
      blockers: [
        "Auth start routes are contract-only and disabled",
        "OAuth and bot callback handlers are not implemented",
        "Canonical account merge rules are not implemented",
      ],
    },
    wallet: {
      pftlRpcConfigured: hasAll(["PFTL_RPC_URL"]),
      pftlRpcAuthConfigured: hasAll(["PFTL_RPC_API_KEY"]),
      seedStorageReady: false,
      lifecycleActionsReady: false,
      blockers: [
        "Encrypted local seed storage design is not implemented",
        "Wallet delink and relink runbook is not implemented",
        "Unlock transaction boundary is not implemented",
      ],
    },
    context: {
      importReady: false,
      editReady: false,
      manifestInkReady: false,
      blockers: [
        "Context document schema and permissions are not implemented",
        "Shared URL fetch and cache adapters are not implemented",
        "PFTL manifest pointer creation is not implemented",
      ],
    },
    billing: {
      model: "usage_based",
      ledgerReady: true,
      durableLedgerReady: ledger.durable,
      adminCreditReady: hasAll(["TASKNODE_ADMIN_CREDIT_TOKEN"]),
      chatEstimateReady: true,
      chatExecutionReady,
      blockers: [
        "Durable Postgres ledger tables are not implemented",
        "Top-up rail decision is not made",
        "Provider fallback policy is not implemented",
      ],
    },
    llm: {
      openaiConfigured: hasAll(["OPENAI_API_KEY"]),
      openrouterConfigured: hasAll(["OPENROUTER_API_KEY"]),
      aiGatewayConfigured: hasAll(["VERCEL_AI_GATEWAY_API_KEY"]),
    },
  };
}
