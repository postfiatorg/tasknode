import {
  decryptTaskNodePayload,
  deriveTaskNodePublicKey,
  encryptTaskNodePayloadForTests,
  hydrateTaskNodeFetchedPayload,
  signWalletChallenge,
} from "../src/wallet-core.js";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8080";
let readyChatMode = process.env.SMOKE_CHAT_MODE || "Private Instant";
const smokeConversationId = process.env.SMOKE_CONVERSATION_ID || `smoke-${Date.now()}`;
const smokeTaskRequestId = `req_smoke_task_${Date.now().toString(36)}`;
const smokeTaskBundleId = `bundle_smoke_task_${Date.now().toString(36)}`;
const smokeMnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const smokeContextCid = "bafybeigdyrztm3j5qwerasdfzxcvqwerasdfctx";
const smokeEvidenceCid = "bafybeigdyrztm3j5qwerasdfzxcvqwerasdfevd";
const smokeOtherCid = "bafybeigdyrztm3j5qwerasdfzxcvqwerasdfoth";

const taskNodePublicKey = await deriveTaskNodePublicKey(smokeMnemonic);
const encryptedSmokePayload = await encryptTaskNodePayloadForTests({
  plaintext: JSON.stringify({
    title: "Encrypted Smoke Context",
    body: "SMOKE ENCRYPTED CONTEXT PAYLOAD",
  }),
  recipientPublicKeys: [taskNodePublicKey],
});
const decryptedSmokePayload = await decryptTaskNodePayload({
  blob: encryptedSmokePayload,
  mnemonic: smokeMnemonic,
});
const hydratedSmokePayload = await hydrateTaskNodeFetchedPayload({
  payload: encryptedSmokePayload,
  mnemonic: smokeMnemonic,
});
if (
  !decryptedSmokePayload.includes("SMOKE ENCRYPTED CONTEXT PAYLOAD") ||
  hydratedSmokePayload.decrypted !== true ||
  hydratedSmokePayload.payload?.body !== "SMOKE ENCRYPTED CONTEXT PAYLOAD"
) {
  throw new Error("Task Node encrypted payload crypto smoke failed.");
}

async function rawRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return { response, text };
}

async function check(path, predicate) {
  const { response, text } = await rawRequest(path);
  if (!predicate(response, text)) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  console.log(`${path} ok`);
}

async function checkRequest(path, options, predicate) {
  const { response, text } = await rawRequest(path, options);
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
    typeof body.usage?.availableCreditUsd === "number" &&
    Array.isArray(body.usage?.fundingActions) &&
    Array.isArray(body.context?.sources) &&
    body.context?.history?.canHydrate === false
  );
});

await check("/api/session", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.status === "signed_out" &&
    Array.isArray(body.accountLinks) &&
    body.accountLinks.some((provider) => provider.id === "email" && provider.startPath && provider.verifyPath) &&
    typeof body.devAuth?.enabled === "boolean"
  );
});

const emailLogin = await rawRequest("/api/auth/email/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: `email-smoke-${Date.now()}@tasknode.local` }),
});
const emailLoginBody = JSON.parse(emailLogin.text);

if (emailLogin.response.status === 200) {
  if (
    emailLoginBody.ok !== true ||
    emailLoginBody.action !== "email_login_start" ||
    !emailLoginBody.challengeId ||
    !emailLoginBody.maskedEmail ||
    !emailLoginBody.expiresAt
  ) {
    throw new Error("/api/auth/email/start did not return a challenge contract");
  }
  console.log("/api/auth/email/start ok");

  await checkRequest(
    "/api/auth/email/verify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: emailLoginBody.challengeId,
        code: "00000000",
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return response.status === 400 && body.error === "email_code_invalid";
    }
  );

  if (emailLoginBody.delivery?.devCode) {
    let emailCookie = "";
    await checkRequest(
      "/api/auth/email/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: emailLoginBody.challengeId,
          code: emailLoginBody.delivery.devCode,
        }),
      },
      (response, text) => {
        const body = JSON.parse(text);
        emailCookie = response.headers.get("set-cookie")?.split(";")[0] || "";
        return (
          response.ok &&
          Boolean(emailCookie) &&
          body.session?.status === "signed_in" &&
          body.session?.primaryProvider === "email" &&
          body.session?.assurance === "low"
        );
      }
    );

    await checkRequest(
      "/api/auth/email/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: emailLoginBody.challengeId,
          code: emailLoginBody.delivery.devCode,
        }),
      },
      (response, text) => {
        const body = JSON.parse(text);
        return response.status === 400 && body.error === "email_code_invalid";
      }
    );

    await checkRequest(
      "/api/session",
      { headers: { cookie: emailCookie } },
      (response, text) => {
        const body = JSON.parse(text);
        return response.ok && body.status === "signed_in" && body.primaryProvider === "email";
      }
    );

    await checkRequest(
      "/api/auth/logout",
      { method: "POST", headers: { cookie: emailCookie } },
      (response, text) => {
        const body = JSON.parse(text);
        return response.ok && body.ok === true;
      }
    );
  }
} else if (emailLogin.response.status === 503 && emailLoginBody.error === "email_login_not_configured") {
  console.log("/api/auth/email/start ok");
} else {
  throw new Error(`/api/auth/email/start failed: HTTP ${emailLogin.response.status}`);
}

const devAuth = await rawRequest("/api/auth/dev/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "dev-smoke@tasknode.local" }),
});
const devAuthBody = JSON.parse(devAuth.text);
let signedInConversationId = "";

if (devAuth.response.status === 200) {
  const cookie = devAuth.response.headers.get("set-cookie")?.split(";")[0] || "";
  if (!cookie || devAuthBody.session?.status !== "signed_in") {
    throw new Error("/api/auth/dev/start did not issue a signed-in session");
  }
  console.log("/api/auth/dev/start ok");

  await checkRequest(
    "/api/session",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.status === "signed_in" && body.primaryProvider === "dev";
    }
  );

  await checkRequest(
    "/api/app-state",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      signedInConversationId = body.chat?.conversationId || "";
      return (
        response.ok &&
        body.session?.status === "signed_in" &&
        signedInConversationId.startsWith("account_") &&
        body.usage?.chatStreamPath === "/api/chat/stream" &&
        body.context?.document?.canEdit === true &&
        body.context?.savePath === "/api/context/edit/save"
      );
    }
  );

  await checkRequest(
    "/api/auth/start/github",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      if (response.ok) {
        return (
          body.ok === true &&
          body.provider === "github" &&
          body.mode === "account_link" &&
          body.action === "github_account_link_start" &&
          body.redirectUrl?.startsWith("https://github.com/login/oauth/authorize") &&
          Boolean(response.headers.get("set-cookie"))
        );
      }
      return response.status === 409 && body.error === "auth_provider_not_configured";
    }
  );

  let walletChallenge = null;
  await checkRequest(
    "/api/wallet/link/start",
    { method: "POST", headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      walletChallenge = body.challenge || null;
      return (
        response.ok &&
        body.ok === true &&
        body.action === "wallet_link_start" &&
        body.verifyPath === "/api/wallet/link/verify" &&
        walletChallenge?.message?.includes("Post Fiat Task Node wallet proof")
      );
    }
  );

  const walletProof = signWalletChallenge(smokeMnemonic, walletChallenge.message);
  await checkRequest(
    "/api/wallet/link/verify",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        challengeId: walletChallenge.id,
        address: walletProof.address,
        publicKey: walletProof.publicKey,
        signature: walletProof.signature,
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.ok === true &&
        body.wallet?.status === "linked" &&
        body.wallet?.address === walletProof.address &&
        !text.includes(smokeMnemonic)
      );
    }
  );

  await checkRequest(
    "/api/app-state",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.wallet?.pftWallet?.status === "linked" &&
        body.wallet?.pftWallet?.address === walletProof.address &&
        body.session?.walletLink?.status === "linked"
      );
    }
  );

  await checkRequest(
    "/api/chat/history",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.conversationId === signedInConversationId && Array.isArray(body.messages);
    }
  );

  await checkRequest(
    "/api/chat/conversations",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && Array.isArray(body.conversations);
    }
  );

  await checkRequest(
    "/api/chat/send",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message: "Dry run account scoped chat",
        mode: "Private Instant",
        dryRun: true,
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.dryRun === true && body.conversationId === signedInConversationId;
    }
  );

  await checkRequest(
    "/api/chat/stream",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        message: "Dry run account scoped streaming chat",
        mode: "Private Instant",
        dryRun: true,
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.dryRun === true && body.conversationId === signedInConversationId;
    }
  );

  await checkRequest(
    "/api/tasks/request-intent",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        requestId: smokeTaskRequestId,
        bundleId: smokeTaskBundleId,
        conversationId: signedInConversationId,
        userDetailText: "Use this smoke detail to create a tagged task request intent.",
        sourceConversationTitle: "Smoke chat",
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.ok === true &&
        body.action === "task_request_intent" &&
        body.request?.requestId === smokeTaskRequestId &&
        body.request?.bundleId === smokeTaskBundleId &&
        body.request?.status === "intent_recorded" &&
        body.user?.metadata?.kind === "task_request_intent" &&
        body.assistant?.metadata?.kind === "task_request_intent"
      );
    }
  );

  await checkRequest(
    "/api/context/edit/save",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Smoke Context",
        body: "# Smoke Context\n\nThis context belongs to the signed-in smoke account.",
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.ok === true &&
        body.action === "save_edit" &&
        body.document?.title === "Smoke Context" &&
        body.document?.revision >= 1 &&
        body.document?.canEdit === true
      );
    }
  );

  await checkRequest(
    "/api/app-state",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.context?.document?.title === "Smoke Context" &&
        body.context?.document?.body?.includes("signed-in smoke account") &&
        body.context?.document?.canEdit === true
      );
    }
  );

  await checkRequest(
    "/api/context/history/indexed",
    {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        snapshot: {
          walletAddress: walletProof.address,
          contextRevisions: [
            {
              id: "ctx-smoke-1",
              cid: `ipfs://${smokeContextCid}`,
              tx_hash: "SMOKE_CONTEXT_TX",
              created_at: "2026-05-16T00:00:00.000Z",
              word_count: 120,
            },
          ],
          tasks: [
            {
              id: "task-smoke-1",
              title: "Smoke private task title",
              status: "rewarded",
              verification_type: "text",
            },
          ],
          taskEvents: [
            {
              id: "event-smoke-1",
              task_id: "task-smoke-1",
              event_type: "submission_recorded",
              event_payload: JSON.stringify({
                artifact_cid: `ipfs://${smokeEvidenceCid}`,
                encrypted_cid: `ipfs://${smokeEvidenceCid}`,
                response_text: "SMOKE PRIVATE PAYLOAD MUST NOT LEAK",
              }),
              created_at: "2026-05-16T00:01:00.000Z",
            },
          ],
        },
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.ok === true &&
        body.action === "hydrate_indexed_history" &&
        body.history?.contextUpdateCount === 1 &&
        body.history?.taskEventCount === 1 &&
        body.history?.latestContextPointer?.cid === smokeContextCid &&
        text.includes(smokeEvidenceCid) &&
        !text.includes("SMOKE PRIVATE PAYLOAD MUST NOT LEAK")
      );
    }
  );

  await checkRequest(
    "/api/context/history",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.canHydrate === true &&
        body.pointerCount === 2 &&
        body.hydration?.requiresWalletUnlock === true
      );
    }
  );

  await checkRequest(
    `/api/context/history/ipfs/${smokeOtherCid}`,
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return response.status === 404 && body.error === "context_cid_not_imported";
    }
  );

  await checkRequest(
    "/api/usage/ledger",
    { headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return (
        response.ok &&
        body.accountId === devAuthBody.session.accountId &&
        body.conversationId === signedInConversationId &&
        Array.isArray(body.entries)
      );
    }
  );

  await checkRequest(
    "/api/auth/logout",
    { method: "POST", headers: { cookie } },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.ok === true;
    }
  );
} else if (devAuth.response.status === 503 && devAuthBody.error === "dev_auth_disabled") {
  console.log("/api/auth/dev/start ok");
} else {
  throw new Error(`/api/auth/dev/start failed: HTTP ${devAuth.response.status}`);
}

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

await check("/api/chat/modes", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  const readyMode = body.modes?.find((mode) => mode.enabled);
  if (readyMode && !process.env.SMOKE_CHAT_MODE) readyChatMode = readyMode.label;
  return (
    Array.isArray(body.modes) &&
    body.modes.some((mode) => mode.label === "Private Instant") &&
    body.modes.some((mode) => mode.label === "Frontier Instant")
  );
});

await check("/api/chat/history", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return Array.isArray(body.messages);
});

await check("/api/chat/conversations", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return Array.isArray(body.conversations);
});

await check("/api/usage/ledger", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    body.billingModel === "usage_based" &&
    body.currency === "USD" &&
    body.accountId === null &&
    typeof body.currentSpendUsd === "number" &&
    typeof body.currentCreditUsd === "number" &&
    typeof body.availableCreditUsd === "number" &&
    typeof body.ledgerEntryCount === "number" &&
    typeof body.durable === "boolean" &&
    Array.isArray(body.entries)
  );
});

await check("/api/usage/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  return (
    Array.isArray(body.actions) &&
    body.actions.some((action) => action.id === "top_up_start") &&
    body.actions.some((action) => action.id === "admin_credit")
  );
});

await checkRequest("/api/usage/top-up/start", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "usage_top_up_login_required";
});

await checkRequest(
  "/api/usage/credit/admin",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountUsd: 1, note: "smoke unauthorized probe" }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      [401, 409].includes(response.status) &&
      ["usage_credit_unauthorized", "usage_credit_not_configured"].includes(body.error)
    );
  }
);

await checkRequest(
  "/api/chat/send",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Dry run chat execution",
      mode: readyChatMode,
      dryRun: true,
    }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      response.status === 401 &&
      body.error === "chat_login_required" &&
      body.estimate?.billingModel === "usage_based"
    );
  }
);

await checkRequest(
  "/api/chat/stream",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "Dry run streaming chat execution",
      mode: readyChatMode,
      dryRun: true,
    }),
  },
  (response, text) => {
    const body = JSON.parse(text);
    return (
      response.status === 401 &&
      body.error === "chat_login_required" &&
      body.estimate?.billingModel === "usage_based"
    );
  }
);

if (process.env.SMOKE_CHAT_EXECUTION === "1") {
  await checkRequest(
    "/api/chat/send",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Reply with one short sentence confirming Task Node chat is online.",
        mode: readyChatMode,
        conversationId: smokeConversationId,
      }),
    },
    (response, text) => {
      const body = JSON.parse(text);
      return response.ok && body.ok === true && body.assistant?.body && body.usage?.billingModel === "usage_based";
    }
  );

  await check("/api/chat/conversations", (response, text) => {
    if (!response.ok) return false;
    const body = JSON.parse(text);
    return body.conversations?.some((conversation) => (
      conversation.conversationId === smokeConversationId &&
      conversation.title &&
      conversation.messageCount >= 2
    ));
  });
}

await check("/api/wallet/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  const createAction = body.actions?.find((action) => action.id === "create_start");
  const linkAction = body.actions?.find((action) => action.id === "link_start");
  const unlockAction = body.actions?.find((action) => action.id === "unlock_start");
  const delinkAction = body.actions?.find((action) => action.id === "delink");
  const relinkAction = body.actions?.find((action) => action.id === "relink_start");
  return (
    Array.isArray(body.actions) &&
    createAction?.enabled === true &&
    linkAction?.enabled === true &&
    unlockAction?.enabled === false &&
    delinkAction?.enabled === true &&
    relinkAction?.enabled === true
  );
});

await checkRequest("/api/wallet/link/start", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "wallet_login_required";
});

await checkRequest("/api/wallet/delink", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "wallet_login_required";
});

await check("/api/context/actions", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  const saveAction = body.actions?.find((action) => action.id === "save_edit");
  const rpcHistoryAction = body.actions?.find((action) => action.id === "hydrate_rpc_history");
  const historyAction = body.actions?.find((action) => action.id === "hydrate_indexed_history");
  const cidFetchAction = body.actions?.find((action) => action.id === "fetch_history_cid");
  const importAction = body.actions?.find((action) => action.id === "import_shared_url");
  const inkAction = body.actions?.find((action) => action.id === "ink_manifest");
  return (
    Array.isArray(body.actions) &&
    saveAction?.enabled === true &&
    rpcHistoryAction?.enabled === true &&
    historyAction?.enabled === true &&
    cidFetchAction?.enabled === true &&
    importAction?.enabled === false &&
    inkAction?.enabled === true
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
  return response.status === 401 && body.error === "context_login_required";
});

await checkRequest("/api/context/history/indexed", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "context_login_required";
});

await checkRequest("/api/context/history/rpc/import", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "context_login_required";
});

await checkRequest(`/api/context/history/ipfs/${smokeContextCid}`, { method: "GET" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "context_login_required";
});

await checkRequest("/api/context/manifest/ink", { method: "POST" }, (response, text) => {
  const body = JSON.parse(text);
  return response.status === 401 && body.error === "context_login_required";
});

await check("/api/auth/providers", (response, text) => {
  if (!response.ok) return false;
  const body = JSON.parse(text);
  const nonEmailProviders = body.providers.filter((provider) => provider.id !== "email");
  const disabledProviderIds = new Set(["telegram", "discord", "x"]);
  return (
    Array.isArray(body.providers) &&
    body.providers.some((provider) => provider.id === "telegram") &&
    body.providers.some((provider) => provider.id === "github" && provider.startPath && provider.callbackPath) &&
    body.providers.some((provider) => provider.id === "email" && provider.startPath === "/api/auth/email/start" && provider.verifyPath === "/api/auth/email/verify") &&
    nonEmailProviders.every((provider) => provider.startPath && provider.callbackPath) &&
    nonEmailProviders
      .filter((provider) => disabledProviderIds.has(provider.id))
      .every((provider) => provider.enabled === false)
  );
});

await check("/api/auth/start/telegram", (response, text) => {
  const body = JSON.parse(text);
  return (
    [409, 503].includes(response.status) &&
    ["auth_provider_not_configured", "auth_provider_disabled"].includes(body.error)
  );
});

await check("/api/auth/start/github", (response, text) => {
  const body = JSON.parse(text);
  if (response.ok) {
    return (
      body.ok === true &&
      body.provider === "github" &&
      body.redirectUrl?.startsWith("https://github.com/login/oauth/authorize") &&
      body.redirectUri?.includes("/api/auth/callback/github")
    );
  }
  return (
    response.status === 409 &&
    body.error === "auth_provider_not_configured"
  );
});

await check("/api/auth/callback/github", (response, text) => {
  const body = JSON.parse(text);
  return response.status === 400 && body.error === "oauth_state_invalid";
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
    body.wallet?.seedStorageReady === true &&
    body.wallet?.challengeProofReady === true &&
    body.context?.importReady === false &&
    body.context?.indexedHistoryReady === true &&
    body.context?.encryptedCidHydrationReady === true &&
    typeof body.context?.manifestInkReady === "boolean" &&
    body.billing?.model === "usage_based" &&
    body.billing?.chatEstimateReady === true &&
    typeof body.billing?.adminCreditReady === "boolean" &&
    typeof body.billing?.chatExecutionReady === "boolean"
  );
});

await check("/", (response, text) => {
  return response.ok && text.includes("Task Node");
});
