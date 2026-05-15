function hasAll(keys) {
  return keys.every((key) => Boolean(process.env[key]));
}

function provider({ id, label, kind, requiredEnv, note }) {
  const configured = hasAll(requiredEnv);
  return {
    id,
    label,
    kind,
    configured,
    enabled: false,
    status: configured ? "configured" : "missing_config",
    actionRequired: configured
      ? "Implement auth start and callback handling"
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

export function readiness() {
  const providers = authProviders();
  return {
    generatedAt: new Date().toISOString(),
    auth: {
      configuredProviders: providers.filter((item) => item.configured).map((item) => item.id),
      launchReady: false,
      blockers: [
        "Auth start routes are not implemented",
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
