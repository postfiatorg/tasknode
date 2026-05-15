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

await check("/", (response, text) => {
  return response.ok && text.includes("Task Node");
});
