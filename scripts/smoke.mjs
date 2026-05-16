const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080";
let readyChatMode = process.env.SMOKE_CHAT_MODE || "Private Instant";
const smokeConversationId = process.env.SMOKE_CONVERSATION_ID || `smoke-${Date.now()}`;

async function check(path, predicate) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!predicate(response, text)) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  console.log(`${path} ok`);
}

async function checkRequest(path, options, predicate) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  if (!predicate(response, text)) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  console.log(`${path} ok`);
}

await check("/health", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return body.ok === true && body.service === "tasknodeofficial";
});

await check("/runtime-config.js", (response, text) => {
  return response.ok && text.includes("window.__TASKNODE_CONFIG__");
});

await check("/runtime-config.json", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return body.appName === "tasknodeofficial";
});

await check("/api/app-state", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.session?.status === "signed_out" &&
    body.tasks?.personalRequestEnabled === true &&
    body.tasks?.networkRequestEnabled === false &&
    body.wallet?.pftWallet?.status === "not_linked" &&
    body.usage?.billingModel === "usage_based" &&
    typeof body.usage?.availableCreditUsd === "number" &&
    Array.isArray(body.usage?.fundingActions) &&
    Array.isArray(body.context?.sources)
  );
});

await check("/api/tasks", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return body.personalRequestEnabled === true && body.networkRequestEnabled === false;
});

await checkRequest(
  "/api/chat/estimate",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Estimate this execution", mode: "Private Instant" }),
  },
  (response, text) => {
    if (!response.ok) return false;
    const body = JSON.parse(text);
    return body.billingModel === "usage_based" && body.estimatedUsd > 0;
  }
);

await check("/api/chat/modes", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  const readyMode = body.modes?.find((mode) => mode.enabled);
  if (readyMode && !process.env.SMOKE_CHAT_MODE) readyChatMode = readyMode.label;
  return (
    Array.isArray(body.modes) &&
    body.modes.some((mode) => mode.label === "Private Instant") &&
    body.modes.some((mode) => mode.label === "Frontier Instant")
  );
});

await check("/api/chat/history", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return Array.isArray(body.messages);
});

await check("/api/usage/ledger", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.billingModel === "usage_based" &&
    body.currency === "USD" &&
    typeof body.currentSpendUsd === "number" &&
    typeof body.currentCreditUsd === "number" &&
    typeof body.availableCreditUsd === "number" &&
    typeof body.ledgerEntryCount === "number" &&
    typeof body.durable === "boolean" &&
    Array.isArray(body.entries)
  );
});

await check("/api/usage/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.actions) &&
    body.actions.some((action) => action.id === "top_up_start") &&
    body.actions.some((action) => action.id === "admin_credit")
  );
});

await checkRequest("/api/usage/top-up/start", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 503 && body.error === "usage_action_disabled";
});

await checkRequest(
  "/api/usage/credit/admin",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd: 1, note: "smoke unauthorized probe" }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      [401, 409].includes(response.status) &&
      ["usage_credit_unauthorized", "usage_credit_not_configured"].includes(body.error)
    );
  }
);

await checkRequest(
  "/api/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Dry run chat execution",
      mode: readyChatMode,
      dryRun: true,
    }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      response.ok &&
      body.dryRun === true &&
      body.estimate?.billingModel === "usage_based"
    );
  }
);

if (process.env.SMOKE_CHAT_EXECUTION === "1") {
  await checkRequest(
    "/api/chat/send",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Reply with one short sentence confirming Task Node chat is online.",
        mode: readyChatMode,
        conversationId: smokeConversationId,
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.ok === true && body.assistant?.body && body.usage?.billingModel === "usage_based";
    }
  );
}

await check("/api/wallet/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.actions) &&
    body.actions.some((action) => action.id === "link_start") &&
    body.actions.some((action) => action.id === "delink") &&
    body.actions.every((action) => action.enabled === false)
  );
});

await checkRequest("/api/wallet/link/start", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return (
    [409, 503].includes(response.status) &&
    ["wallet_action_not_configured", "wallet_action_disabled"].includes(body.error)
  );
});

await checkRequest("/api/wallet/delink", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 503 && body.error === "wallet_action_disabled";
});

await check("/api/context/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.actions) &&
    body.actions.some((action) => action.id === "import_shared_url") &&
    body.actions.some((action) => action.id === "ink_manifest") &&
    body.actions.every((action) => action.enabled === false)
  );
});

await checkRequest("/api/context/import/start", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return (
    [409, 503].includes(response.status) &&
    ["context_action_not_configured", "context_action_disabled"].includes(body.error)
  );
});

await checkRequest("/api/context/edit/save", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 503 && body.error === "context_action_disabled";
});

await checkRequest("/api/context/manifest/ink", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return (
    [409, 503].includes(response.status) &&
    ["context_action_not_configured", "context_action_disabled"].includes(body.error)
  );
});

await check("/api/auth/providers", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.providers) &&
    body.providers.some((provider) => provider.id === "telegram") &&
    body.providers.every((provider) => provider.startPath && provider.callbackPath) &&
    body.providers.every((provider) => provider.enabled === false)
  );
});

await check("/api/auth/start/telegram", (response, text) => {
  const body = JSON.parse(text);
  return (
    [409, 503].includes(response.status) &&
    ["auth_provider_not_configured", "auth_provider_disabled"].includes(body.error)
  );
});

await check("/api/auth/callback/telegram", (response, text) => {
  const body = JSON.parse(text);
  return response.status === 501 && body.error === "auth_callback_not_implemented";
});

await check("/api/readiness", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.auth?.launchReady === false &&
    body.wallet?.seedStorageReady === false &&
    body.context?.importReady === false &&
    body.context?.manifestInkReady === false &&
    body.billing?.model === "usage_based" &&
    body.billing?.chatEstimateReady === true &&
    typeof body.billing?.adminCreditReady === "boolean" &&
    typeof body.billing?.chatExecutionReady === "boolean"
  );
});

await check("/", (response, text) => {
  return response.ok && text.includes("Task Node");
});
