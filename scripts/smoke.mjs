const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080";

async function check(path, predicate) {
  const response = await fetch(`${baseUrl}${path}`);
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

await check("/api/auth/providers", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.providers) &&
    body.providers.some((provider) => provider.id === "telegram") &&
    body.providers.every((provider) => provider.enabled === false)
  );
});

await check("/api/readiness", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.auth?.launchReady === false &&
    body.wallet?.seedStorageReady === false &&
    body.billing?.model === "usage_based"
  );
});

await check("/", (response, text) => {
  return response.ok && text.includes("Task Node");
});
