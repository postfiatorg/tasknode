import { createPrivateProfileNftSummary } from "./profile-nft-privacy-gateway.js";
import { classifyProfileNftGenerationFailure } from "./profile-nft-failures.js";
import { enqueueProfileNftRenderJob } from "./repositories/profile-nft-render-jobs.js";
import {
  createGeneratingProfileNft,
  failStaleGeneratingProfileNfts,
  markProfileNftFailed,
} from "./repositories/profile-nfts.js";

const defaultProfileNftSize = "1024x1024";
const defaultProfileNftQuality = "high";
const defaultProfileNftOutputFormat = "png";

function safeText(value = "", max = 5000) {
  return String(value || "").trim().slice(0, max);
}

export { classifyProfileNftGenerationFailure } from "./profile-nft-failures.js";

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

function parsedProfilePacket(value = "") {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : { user_provided_context: safeText(value, 20000) };
  } catch {
    return { user_provided_context: safeText(value, 20000) };
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

  const contextDocument = profileNftGenerationContextDocument({ payload, state });
  const nftUserData =
    safeText(payload?.nftUserData, 20000) ||
    buildProfileNftUserData({ session, state, payload });
  const rendered = await createPrivateProfileNftSummary({
    sourcePacket: { profile: parsedProfilePacket(nftUserData), memory_and_context: contextDocument },
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
    await enqueueProfileNftRenderJob({ profileNftId: recoveryNft.id, sanitizedPrompt: rendered.prompt, model, size, quality, outputFormat });

    return {
      status: 202,
      body: {
        ok: true,
        action: "profile_nft_render_queued",
        nft: recoveryNft,
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
    const message = error?.message || "Profile NFT generation failed.";
    const failedNft = recoveryNft?.id
      ? await markProfileNftFailed({
          accountId: session.accountId,
          nftId: recoveryNft.id,
          error: message,
        }).catch(() => null)
      : null;
    return {
      status: error?.status || 502,
      body: {
        ok: false,
        error: "profile_nft_generation_failed",
        message,
        failure: classifyProfileNftGenerationFailure({ ...error, message }),
        nft: failedNft || recoveryNft || undefined,
      },
    };
  }
}
