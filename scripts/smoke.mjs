const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080";

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

await checkRequest(
  "/api/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Try disabled chat execution", mode: "Private Instant" }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      response.status === 503 &&
      body.error === "chat_execution_disabled" &&
      body.estimate?.billingModel === "usage_based"
    );
  }
);

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
    body.billing?.chatExecutionReady === false
  );
});

await check("/", (response, text) => {
  return response.ok && text.includes("Task Node");
});
