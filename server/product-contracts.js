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
    billing: {
      model: "usage_based",
      ledgerReady: false,
      blockers: [
        "Ledger tables are not implemented",
        "Top-up rail decision is not made",
        "Per-query cost estimate contract is not implemented",
      ],
    },
    llm: {
      openaiConfigured: hasAll(["OPENAI_API_KEY"]),
      openrouterConfigured: hasAll(["OPENROUTER_API_KEY"]),
      aiGatewayConfigured: hasAll(["VERCEL_AI_GATEWAY_API_KEY"]),
    },
  };
}
