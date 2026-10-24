// Both collaboration assistant routes read at most this many UTF-8 JSON bytes.
export const DOCS_ASSISTANT_HTTP_MAX_BYTES = 128_000;
export const DOCS_ASSISTANT_HTTP_SIZE_ERROR = "This assistant request is too large to send. Try a shorter question or document conversation.";

function scalarPrefix(text, length) {
  let end = Math.min(text.length, length);
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return text.slice(0, end);
}

// Match existing server field normalization before measuring the HTTP envelope.
function clippedText(value, maximum) {
  return scalarPrefix(String(value || "").split("\u0000").join("").trim(), maximum);
}

export function prepareDocsAssistantHttpRequest(data, includeFullContext) {
  const payload = {
    channelHash: data.channelHash,
    persona: clippedText(data.persona || "odv", 20),
    includeFullContext: includeFullContext === true,
    prompt: clippedText(data.prompt, 4000),
    documentTitle: clippedText(data.documentTitle || "Untitled document", 180),
    documentContent: clippedText(data.documentContent, 80_000),
    recentMessages: (Array.isArray(data.recentMessages) ? data.recentMessages : [])
      .slice(-12)
      .map((message) => ({
        author: clippedText(message?.author || "member", 120),
        text: clippedText(message?.text, 2000),
      }))
      .filter((message) => message.text),
  };
  const encoder = new TextEncoder();
  const serialize = () => {
    const body = JSON.stringify(payload);
    return { body, bytes: encoder.encode(body).byteLength };
  };
  const original = serialize();
  if (original.bytes <= DOCS_ASSISTANT_HTTP_MAX_BYTES) return { ok: true, body: original.body };

  const content = payload.documentContent;
  payload.documentContent = "";
  // Never silently shorten the user's normalized question or active history.
  if (serialize().bytes >= DOCS_ASSISTANT_HTTP_MAX_BYTES) {
    return { ok: false, error: DOCS_ASSISTANT_HTTP_SIZE_ERROR };
  }
  let low = 1, high = content.length, body = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    payload.documentContent = scalarPrefix(content, middle);
    const candidate = serialize();
    if (candidate.bytes <= DOCS_ASSISTANT_HTTP_MAX_BYTES) {
      if (payload.documentContent) body = candidate.body;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return body ? { ok: true, body } : { ok: false, error: DOCS_ASSISTANT_HTTP_SIZE_ERROR };
}
