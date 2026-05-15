function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
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
