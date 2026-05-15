export async function requestJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

export async function fetchJson(path) {
  const { ok, status, body } = await requestJson(path);
  if (!ok) {
    throw new Error(`${path} failed with HTTP ${status}`);
  }
  return body;
}

export function fetchRuntimeConfig() {
  return fetchJson("/runtime-config.json");
}

export function fetchAppState() {
  return fetchJson("/api/app-state");
}
