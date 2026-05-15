export async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

export function fetchRuntimeConfig() {
  return fetchJson("/runtime-config.json");
}

export function fetchAppState() {
  return fetchJson("/api/app-state");
}
