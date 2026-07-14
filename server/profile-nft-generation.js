import { renderProfileNftPrompt } from "./profile-nft-prompts.js";
import { pinIpfsFile } from "./context-ipfs.js";
import {
  createGeneratingProfileNft,
  failStaleGeneratingProfileNfts,
  markProfileNftFailed,
  markProfileNftGenerated,
} from "./repositories/profile-nfts.js";

const defaultOpenAiBaseUrl = "https://api.openai.com/v1";
const defaultProfileNftSize = "1024x1024";
const defaultProfileNftQuality = "high";
const defaultProfileNftOutputFormat = "png";
const defaultProfileNftTimeoutMs = 300_000;

function safeText(value = "", max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function sanitizedFailureMessage(value = "") {
  return safeText(value, 500)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

export function classifyProfileNftGenerationFailure(error = {}) {
  const status = Number(error?.status || error?.httpStatus || 0);
  const rawCode = safeText(error?.code || error?.error || "", 160).toLowerCase();
  const message = sanitizedFailureMessage(error?.message || error || "Profile NFT generation failed.");
  const text = `${rawCode} ${message}`.toLowerCase();
  const permanent = rawCode === "openai_not_configured" || rawCode === "pinata_not_configured" ||
    status === 401 || status === 403 ||
    (status >= 400 && status < 500 && status !== 408 && status !== 429) ||
    /unauthori[sz]ed|forbidden|invalid.*(api|key|model|request)|model.*(not.*found|invalid)|not_configured|invalid_request|ipfs_file_empty|too_large/.test(text);
  const transient = status === 408 || status === 429 || status >= 500 || error?.name === "AbortError" ||
    /timeout|timed out|network|fetch failed|econn|enotfound|temporar/.test(text);
  const code = rawCode || (permanent ? "profile_nft_provider_permanent" : transient ? "profile_nft_provider_transient" : "profile_nft_generation_failed");
  return { code, message, retryable: !permanent };
}

function compactTasks(tasks = {}) {
  const groups = ["outstanding", "verification", "refused", "rewarded"];
  return groups.map((group) => {
    const items = Array.isArray(tasks[group]) ? tasks[group] : [];
    return {
      group,
      count: items.length,
      examples: items.slice(0, 4).map((task) => ({
        title: task.title || task.name || "",
        status: task.status || task.state || "",
        rewardPft: task.rewardPft || task.reward || task.rewardOffer || "",
        kind: task.kind || task.taskKind || "",
      })),
    };
  });
}

function linkedWalletAddressFromState(state = {}) {
  return safeText(state?.wallet?.pftWallet?.address || state?.session?.walletLink?.address || "", 120);
}

function titleFromSession() {
  return "Task Node Profile NFT";
}

function imageMimeType(outputFormat = "png") {
  const normalized = safeText(outputFormat, 20).toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  return "image/png";
}

function gatewayUrlForCid(cid = "") {
  return cid ? `https://dweb.link/ipfs/${encodeURIComponent(cid)}` : "";
}

export function buildProfileNftUserData({ session = null, state = null, payload = {} } = {}) {
  const linkedWallet = state?.wallet?.pftWallet || state?.session?.walletLink || {};
  const taskSummary = compactTasks(state?.tasks || {});
  return JSON.stringify(
    {
      account: {
        displayName: session?.displayName || state?.session?.displayName || "Task Node member",
        primaryProvider: session?.primaryProvider || state?.session?.primaryProvider || "",
        accountId: session?.accountId || "",
      },
      wallet: {
        status: linkedWallet.status || "",
        address: linkedWallet.address || "",
      },
      requestedStyle: safeText(payload?.style || payload?.note || "", 1200),
      taskSummary,
    },
    null,
    2
  );
}

export function profileNftGenerationContextDocument({ payload = {}, state = null } = {}) {
  return (
    safeText(payload?.contextDocument, 20000) ||
    safeText(state?.context?.document?.html, 20000) ||
    safeText(state?.context?.document?.text, 20000) ||
    safeText(state?.context?.document?.body, 20000) ||
    "No current context document was available."
  );
}

function profileNftTimeoutMs(env = process.env) {
  return Math.max(30_000, Number(env.PROFILE_NFT_IMAGE_TIMEOUT_MS || defaultProfileNftTimeoutMs));
}

async function openAiImageGeneration({ apiKey, baseUrl, body, env = process.env }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profileNftTimeoutMs(env));

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(responseBody?.error?.message || `openai_image_generation_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
}

export async function profileNftGenerateStart({
  method,
  payload = {},
  session = null,
  state = null,
  env = process.env,
} = {}) {
  if (method !== "POST") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "profile_nft_method_not_allowed",
        message: "Profile NFT generation requires POST.",
      },
    };
  }

  if (!session?.accountId) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "profile_nft_login_required",
        message: "Sign in before generating a profile NFT.",
      },
    };
  }

  await failStaleGeneratingProfileNfts({ accountId: session.accountId }).catch((error) => {
    console.warn(`profile nft stale generation sweep failed: ${error?.message || error}`);
  });

  const apiKey = safeText(env.OPENAI_API_KEY, 10000);
  if (!apiKey) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "openai_not_configured",
        message: "OpenAI is not configured for profile NFT generation.",
      },
    };
  }

  const contextDocument = profileNftGenerationContextDocument({ payload, state });
  const nftUserData =
    safeText(payload?.nftUserData, 20000) ||
    buildProfileNftUserData({ session, state, payload });
  const rendered = renderProfileNftPrompt({
    nftUserData,
    contextDocument,
    env,
  });

  if (
    rendered.source === "placeholder" &&
    env.NODE_ENV === "production" &&
    env.PROFILE_NFT_ALLOW_PLACEHOLDER !== "true"
  ) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "profile_nft_private_prompt_required",
        message: "Profile NFT generation is missing the private production prompt.",
      },
    };
  }

  if (rendered.unresolvedPlaceholders.length > 0) {
    return {
      status: 500,
      body: {
        ok: false,
        error: "profile_nft_prompt_unresolved_placeholders",
        unresolvedPlaceholders: rendered.unresolvedPlaceholders,
      },
    };
  }

  const model = rendered.metadata.model || "gpt-image-2";
  const size = safeText(payload?.size, 32) || env.PROFILE_NFT_IMAGE_SIZE || defaultProfileNftSize;
  const quality = safeText(payload?.quality, 32) || env.PROFILE_NFT_IMAGE_QUALITY || defaultProfileNftQuality;
  const outputFormat =
    safeText(payload?.outputFormat, 32) ||
    env.PROFILE_NFT_IMAGE_OUTPUT_FORMAT ||
    defaultProfileNftOutputFormat;
  const title = titleFromSession(session, state);
  const description = "Generated Task Node profile NFT image. Prompt text remains private.";
  let recoveryNft = null;

  try {
    recoveryNft = await createGeneratingProfileNft({
      accountId: session.accountId,
      walletAddress: linkedWalletAddressFromState(state),
      title,
      description,
      promptSource: rendered.source,
      promptDigest: rendered.promptDigest,
      templateDigest: rendered.templateDigest,
      model,
      size,
      quality,
      outputFormat,
    });
    const result = await openAiImageGeneration({
      apiKey,
      baseUrl: env.OPENAI_BASE_URL || defaultOpenAiBaseUrl,
      body: {
        model,
        prompt: rendered.prompt,
        size,
        quality,
        output_format: outputFormat,
        n: 1,
      },
      env,
    });
    const imageBase64 = result?.data?.[0]?.b64_json || "";
    if (!imageBase64) {
      const failedNft = await markProfileNftFailed({
        accountId: session.accountId,
        nftId: recoveryNft.id,
        error: "OpenAI returned no profile NFT image data.",
      });
      return {
        status: 502,
        body: {
          ok: false,
          error: "profile_nft_image_missing",
          message: "OpenAI returned no profile NFT image data.",
          nft: failedNft || recoveryNft,
        },
      };
    }
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const mimeType = imageMimeType(outputFormat);
    const extension = mimeType.split("/")[1] || "png";
    const imagePin = await pinIpfsFile({
      bytes: imageBuffer,
      name: `profile_nft_${session.accountId}_${Date.now()}.${extension}`,
      mimeType,
      keyvalues: {
        type: "profile_nft_image",
        accountId: session.accountId,
        promptDigest: rendered.promptDigest,
      },
      env,
    });
    const nft = await markProfileNftGenerated({
      accountId: session.accountId,
      nftId: recoveryNft.id,
      imageCid: imagePin.cid,
      imageGatewayUrl: gatewayUrlForCid(imagePin.cid),
      imageMimeType: mimeType,
      imageSizeBytes: imagePin.sizeBytes,
      imageSha256: imagePin.sha256,
      promptSource: rendered.source,
      promptDigest: rendered.promptDigest,
      templateDigest: rendered.templateDigest,
      model,
      size,
      quality,
      outputFormat,
    });

    return {
      status: 200,
      body: {
        ok: true,
        action: "profile_nft_generate",
        nft,
        imageDataUrl: `data:image/${outputFormat};base64,${imageBase64}`,
        model,
        size,
        quality,
        outputFormat,
        promptSource: rendered.source,
        promptDigest: rendered.promptDigest,
        templateDigest: rendered.templateDigest,
      },
    };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "OpenAI image generation timed out before returning an image."
      : error?.message || "Profile NFT generation failed.";
    const failedNft = recoveryNft?.id
      ? await markProfileNftFailed({
          accountId: session.accountId,
          nftId: recoveryNft.id,
          error: message,
        }).catch(() => null)
      : null;
    return {
      status: error?.status || (error?.name === "AbortError" ? 504 : 502),
      body: {
        ok: false,
        error: error?.name === "AbortError" ? "profile_nft_generation_timeout" : "profile_nft_generation_failed",
        message,
        failure: classifyProfileNftGenerationFailure({ ...error, message }),
        nft: failedNft || recoveryNft || undefined,
      },
    };
  }
}
