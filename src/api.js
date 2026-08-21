export async function requestJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  return { event, data: data.join("\n") };
}

async function readSseStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n|\r\n\r\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed.data) continue;
      await onEvent({
        event: parsed.event,
        body: parsed.data === "[DONE]" ? null : JSON.parse(parsed.data),
      });
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer);
    if (parsed.data) {
      await onEvent({
        event: parsed.event,
        body: parsed.data === "[DONE]" ? null : JSON.parse(parsed.data),
      });
    }
  }
}

function retryableStreamError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.retryableStream = true;
  return error;
}

async function requestEventStreamOnce(path, options, onEvent) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options });
  } catch (error) {
    throw retryableStreamError(error?.message || "Chat connection failed.", error);
  }
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body, streamed: false };
  }

  let finalBody = null;
  try {
    await readSseStream(response.body, async ({ event, body }) => {
      if (event === "done" || event === "error") finalBody = body;
      await onEvent({ event, body });
    });
  } catch (error) {
    throw retryableStreamError(error?.message || "Chat stream was interrupted.", error);
  }

  if (!finalBody) {
    throw retryableStreamError("Chat stream ended before the response completed.");
  }

  return {
    ok: Boolean(finalBody?.ok),
    status: response.status,
    body: finalBody,
    streamed: true,
  };
}

function waitForStreamRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function requestEventStream(
  path,
  options = {},
  onEvent = () => {},
  {
    retryDelaysMs = [750, 2_000, 5_000],
    onRetry = () => {},
    wait = waitForStreamRetry,
  } = {}
) {
  const delays = (Array.isArray(retryDelaysMs) ? retryDelaysMs : [])
    .map((delay) => Math.max(0, Number(delay) || 0));
  let retryCount = 0;

  while (true) {
    try {
      return await requestEventStreamOnce(path, options, onEvent);
    } catch (error) {
      if (!error?.retryableStream || options?.signal?.aborted || retryCount >= delays.length) throw error;
      retryCount += 1;
      await onRetry({ error, retryCount, maxRetries: delays.length });
      await wait(delays[retryCount - 1]);
    }
  }
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

export function fetchAppState({ taskProjectionRefresh = false } = {}) {
  const query = taskProjectionRefresh ? "?taskProjectionRefresh=1" : "";
  return fetchJson(`/api/app-state${query}`);
}
