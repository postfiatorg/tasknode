const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";

function safeText(value = "", max = 10000) {
  return String(value || "").trim().slice(0, max);
}

export async function renderProfileNftImage({ prompt, model = "gpt-image-2", size, quality, outputFormat, env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = safeText(env.PROFILE_NFT_OPENAI_API_KEY, 10000);
  if (!apiKey) throw Object.assign(new Error("profile_nft_openai_not_configured"), { status: 503 });
  const sanitizedPrompt = safeText(prompt, 8000);
  if (!sanitizedPrompt) throw Object.assign(new Error("profile_nft_sanitized_prompt_required"), { status: 400 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(30_000, Number(env.PROFILE_NFT_IMAGE_TIMEOUT_MS || 300_000)));
  try {
    const response = await fetchImpl(`${safeText(env.PROFILE_NFT_OPENAI_BASE_URL || OPENAI_IMAGE_BASE_URL, 500).replace(/\/+$/, "")}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, prompt: sanitizedPrompt, size, quality, output_format: outputFormat, n: 1 }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error?.message || `profile_nft_openai_http_${response.status}`), { status: response.status });
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
