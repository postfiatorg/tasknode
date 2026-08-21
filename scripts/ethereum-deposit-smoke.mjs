export async function runEthereumDepositSmoke({
  appendChatTurn,
  appendUsageCredit,
  depositReceiveNode,
  getEthereumDepositAccount,
  getOrCreateEmailAccount,
  linkWalletToAccount,
  updateEthereumDepositSync,
  usageActions,
  usageTopUpStart,
  usageTopUpSync,
}) {
  const topUpAction = usageActions().find((action) => action.id === "top_up_start");
  if (topUpAction?.enabled !== true) {
    throw new Error(`Ethereum top-up action should be enabled with an xpub: ${JSON.stringify(topUpAction)}`);
  }

  const noLoginTopUp = await usageTopUpStart({}, "POST", null);
  if (noLoginTopUp.status !== 401 || noLoginTopUp.body?.error !== "usage_top_up_login_required") {
    throw new Error(`Ethereum top-up should require account login: ${JSON.stringify(noLoginTopUp)}`);
  }

  const receiveNode = depositReceiveNode.neuter();
  const usdcBalancesByAddress = new Map();
  const originalFetch = global.fetch;
  let failUsdcProbe = false;
  global.fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body || "{}");
    if (payload.method === "eth_getBalance") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x0" }), { status: 200 });
    }
    if (payload.method === "eth_call") {
      const target = String(payload.params?.[0]?.to || "").toLowerCase();
      const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      if (target === usdc && failUsdcProbe) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { message: "usdc unavailable" } }), { status: 200 });
      }
      const calledAddress = `0x${String(payload.params?.[0]?.data || "").slice(-40)}`.toLowerCase();
      const raw = usdcBalancesByAddress.get(calledAddress) || 0n;
      const result = target === usdc ? `0x${raw.toString(16)}` : "0x0";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200 });
    }
    return originalFetch(url, options);
  };

  try {
    const prefundedDepositAddress = receiveNode.deriveChild(1).address;
    usdcBalancesByAddress.set(prefundedDepositAddress.toLowerCase(), 12_340_000n);
    const prefundedTopUp = await usageTopUpStart({}, "POST", { accountId: "acct_eth_prefunded_smoke" });
    if (
      prefundedTopUp.status !== 200 ||
      prefundedTopUp.body?.depositAccount?.address === prefundedDepositAddress
    ) {
      throw new Error(`Ethereum top-up should skip prefunded derived addresses: ${JSON.stringify(prefundedTopUp)}`);
    }

    const topUp = await usageTopUpStart({}, "POST", { accountId: "acct_eth_smoke" });
    const expectedDepositAddress = receiveNode.deriveChild(3).address;
    const topUpSymbols = (topUp.body?.depositAccount?.assets || []).map((asset) => asset.symbol);
    if (
      topUp.status !== 200 ||
      topUp.body?.depositAccount?.address !== expectedDepositAddress ||
      topUp.body?.depositAccount?.withdrawalsEnabled !== false ||
      ["ETH", "USDC", "USDT"].every((symbol) => topUpSymbols.includes(symbol)) !== true
    ) {
      throw new Error(`Ethereum top-up address allocation failed: ${JSON.stringify(topUp)}`);
    }

    const replayTopUp = await usageTopUpStart({}, "POST", { accountId: "acct_eth_smoke" });
    const storedDeposit = getEthereumDepositAccount({ accountId: "acct_eth_smoke" });
    if (
      replayTopUp.body?.depositAccount?.address !== topUp.body.depositAccount.address ||
      storedDeposit?.address !== topUp.body.depositAccount.address
    ) {
      throw new Error("Ethereum top-up address was not stable for the account.");
    }

    usdcBalancesByAddress.set(expectedDepositAddress.toLowerCase(), 12_340_000n);
    const firstSyncedTopUp = await usageTopUpSync({}, "POST", { accountId: "acct_eth_smoke" });
    usdcBalancesByAddress.set(expectedDepositAddress.toLowerCase(), 18_340_000n);
    const syncedTopUp = await usageTopUpSync({}, "POST", { accountId: "acct_eth_smoke" });
    if (
      firstSyncedTopUp.status !== 200 ||
      firstSyncedTopUp.body?.creditedEntries?.[0]?.amountUsd !== 12.34 ||
      firstSyncedTopUp.body?.usage?.availableCreditUsd !== 12.34
    ) {
      throw new Error(`Ethereum top-up first post-assignment increase should credit: ${JSON.stringify(firstSyncedTopUp)}`);
    }
    if (
      syncedTopUp.status !== 200 ||
      syncedTopUp.body?.creditedEntries?.[0]?.amountUsd !== 6 ||
      syncedTopUp.body?.usage?.availableCreditUsd !== 18.34
    ) {
      throw new Error(`Ethereum top-up sync did not credit USDC delta: ${JSON.stringify(syncedTopUp)}`);
    }

    const emailGrantAccount = getOrCreateEmailAccount({
      email: "eth-smoke-usdc-grant@example.com",
      canonicalEmail: "eth-smoke-usdc-grant@example.com",
      maskedEmail: "e***@example.com",
    });
    linkWalletToAccount({
      accountId: emailGrantAccount.id,
      address: "rEthSmokeUsdcTopUpGrant11111111111",
      publicKey: "eth-smoke-usdc-topup-grant-pubkey",
      challengeId: "eth-smoke-usdc-topup-grant-challenge",
      signature: "eth-smoke-usdc-topup-grant-signature",
      proofPurpose: "wallet_create",
    });
    const emailGrantTopUp = await usageTopUpStart({}, "POST", { accountId: emailGrantAccount.id });
    const emailGrantAddress = emailGrantTopUp.body?.depositAccount?.address;
    usdcBalancesByAddress.set(String(emailGrantAddress || "").toLowerCase(), 10_000_000n);
    const emailGrantPartialSync = await usageTopUpSync({}, "POST", { accountId: emailGrantAccount.id });
    usdcBalancesByAddress.set(String(emailGrantAddress || "").toLowerCase(), 12_340_000n);
    const emailGrantSync = await usageTopUpSync({}, "POST", { accountId: emailGrantAccount.id });
    if (
      emailGrantPartialSync.status !== 200 ||
      emailGrantPartialSync.body?.creditedEntries?.[0]?.amountUsd !== 10 ||
      emailGrantPartialSync.body?.pftGrant !== null ||
      !String(emailGrantPartialSync.body?.message || "").includes("Current credited USDC: $10.00.")
    ) {
      throw new Error(`Email USDC top-up should wait until credited USDC crosses the grant threshold: ${JSON.stringify(emailGrantPartialSync)}`);
    }
    if (
      emailGrantSync.status !== 200 ||
      emailGrantSync.body?.creditedEntries?.[0]?.amountUsd !== 2.34 ||
      emailGrantSync.body?.pftGrant?.status !== "local_vault_required" ||
      emailGrantSync.body?.pftGrant?.reason !== "local_vault_required"
    ) {
      throw new Error(`Email USDC top-up sync should wait for local vault confirmation before the PFT grant: ${JSON.stringify(emailGrantSync)}`);
    }

    const preWalletGrantAccount = getOrCreateEmailAccount({
      email: "eth-smoke-usdc-grant-pre-wallet@example.com",
      canonicalEmail: "eth-smoke-usdc-grant-pre-wallet@example.com",
      maskedEmail: "e***@example.com",
    });
    const preWalletGrantTopUp = await usageTopUpStart({}, "POST", { accountId: preWalletGrantAccount.id });
    const preWalletGrantAddress = preWalletGrantTopUp.body?.depositAccount?.address;
    usdcBalancesByAddress.set(String(preWalletGrantAddress || "").toLowerCase(), 13_940_000n);
    const preWalletGrantSync = await usageTopUpSync({}, "POST", { accountId: preWalletGrantAccount.id });
    if (
      preWalletGrantSync.status !== 200 ||
      preWalletGrantSync.body?.usage?.availableCreditUsd !== 13.94 ||
      preWalletGrantSync.body?.pftGrant !== null
    ) {
      throw new Error(`USDC top-up before wallet creation should credit without sending the PFT grant: ${JSON.stringify(preWalletGrantSync)}`);
    }
    linkWalletToAccount({
      accountId: preWalletGrantAccount.id,
      address: "rEthSmokeUsdcTopUpPreWallet111111111",
      publicKey: "eth-smoke-usdc-pre-wallet-pubkey",
      challengeId: "eth-smoke-usdc-pre-wallet-challenge",
      signature: "eth-smoke-usdc-pre-wallet-signature",
      proofPurpose: "wallet_create",
    });
    const preWalletGrantClaim = await (await import("../server/ethereum-deposits.js")).maybeClaimUsdcTopUpInitiationGift({ accountId: preWalletGrantAccount.id });
    if (
      preWalletGrantClaim?.status !== "not_configured" ||
      preWalletGrantClaim?.reason !== "faucet_not_configured"
    ) {
      throw new Error(`USDC top-up grant should be claimable after wallet creation once credited USDC exceeds the threshold: ${JSON.stringify(preWalletGrantClaim)}`);
    }

    appendChatTurn({
      accountId: "acct_eth_smoke",
      conversationId: "acct_eth_smoke_default",
      mode: "Frontier Instant",
      provider: "openai",
      model: "chat-latest",
      responseId: "runtime-smoke-eth-topup-spend",
      userMessage: "Spend deposited credit",
      assistantMessage: "ok",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 18.34 },
    });
    const spentAddressReplay = await usageTopUpStart({}, "POST", { accountId: "acct_eth_smoke" });
    if (spentAddressReplay.body?.depositAccount?.address !== expectedDepositAddress) {
      throw new Error(`Ethereum top-up should not retire address after deposited credit was spent: ${JSON.stringify(spentAddressReplay)}`);
    }

    const unrelatedCreditTopUp = await usageTopUpStart({}, "POST", { accountId: "acct_eth_unrelated_credit_smoke" });
    const unrelatedCreditAddress = unrelatedCreditTopUp.body?.depositAccount?.address;
    updateEthereumDepositSync({
      accountId: "acct_eth_unrelated_credit_smoke",
      observedBalances: { USDC: { raw: "5000000", amount: "5.0", decimals: 6, syncedAt: new Date().toISOString(), blockTag: "latest" } },
      creditedBalances: { USDC: { raw: "5000000", amount: "5.0", decimals: 6, syncedAt: new Date().toISOString(), blockTag: "latest" } },
      syncStatus: "ready",
      blockTag: "latest",
      creditedEntries: [],
    });
    appendUsageCredit({
      accountId: "acct_eth_unrelated_credit_smoke",
      amountUsd: 5,
      source: "admin_credit",
      uniqueKey: "admin_credit:acct_eth_unrelated_credit_smoke",
    });
    const unrelatedCreditReplay = await usageTopUpStart({}, "POST", { accountId: "acct_eth_unrelated_credit_smoke" });
    if (unrelatedCreditReplay.body?.depositAccount?.address === unrelatedCreditAddress) {
      throw new Error(`Unrelated billing credit must not keep a baseline-only prefunded address: ${JSON.stringify(unrelatedCreditReplay)}`);
    }

    failUsdcProbe = true;
    const failedProbeTopUp = await usageTopUpStart({}, "POST", { accountId: "acct_eth_probe_fail_smoke" });
    if (
      failedProbeTopUp.status !== 503 ||
      failedProbeTopUp.body?.error !== "deposit_balance_probe_failed" ||
      !String(failedProbeTopUp.body?.message || "").includes("Could not verify deposit address balances")
    ) {
      throw new Error(`Ethereum top-up start should fail closed on partial balance probe failure: ${JSON.stringify(failedProbeTopUp)}`);
    }
  } finally {
    global.fetch = originalFetch;
  }
}
