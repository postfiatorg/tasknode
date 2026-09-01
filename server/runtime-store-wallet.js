import { randomUUID } from "node:crypto";

function walletChallengeMessage({ accountId, challengeId, purpose, issuedAt, expiresAt }) {
  return [
    "Post Fiat Task Node wallet proof",
    `Purpose: ${purpose}`,
    `Account: ${accountId}`,
    `Challenge: ${challengeId}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

function walletLoginChallengeMessage({ address, challengeId, issuedAt, expiresAt }) {
  return [
    "Post Fiat Task Node wallet login",
    "Purpose: wallet_login",
    `Address: ${address}`,
    `Challenge: ${challengeId}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

export function createRuntimeWalletStore({
  state,
  saveState,
  safeId,
  stableId,
  normalizeAccountProfileVisibility,
  accountPayload,
  mergeLinkedProvider,
  linkedWalletProvider,
  displayNameFromWalletAddress,
  syncAccountSessions,
  walletLoginChallengeMaxActive,
} = {}) {
  function pruneExpiredWalletChallenges({ save = true } = {}) {
    const now = Date.now();
    let changed = false;
    const activeLoginChallenges = [];
    for (const [challengeId, challenge] of Object.entries(state.walletChallenges)) {
      if (challenge?.purpose !== "wallet_login") continue;
      const expiresAt = Date.parse(challenge.expiresAt || "");
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        delete state.walletChallenges[challengeId];
        changed = true;
        continue;
      }
      activeLoginChallenges.push([challengeId, challenge]);
    }
    if (activeLoginChallenges.length > walletLoginChallengeMaxActive) {
      activeLoginChallenges
        .sort((left, right) => {
          const leftIssued = Date.parse(left[1]?.issuedAt || "") || 0;
          const rightIssued = Date.parse(right[1]?.issuedAt || "") || 0;
          return leftIssued !== rightIssued ? leftIssued - rightIssued : String(left[0]).localeCompare(String(right[0]));
        })
        .slice(0, activeLoginChallenges.length - walletLoginChallengeMaxActive)
        .forEach(([challengeId]) => {
          delete state.walletChallenges[challengeId];
          changed = true;
        });
    }
    if (changed && save) saveState();
    return {
      changed,
      activeLoginCount: Object.values(state.walletChallenges).filter((challenge) => challenge?.purpose === "wallet_login").length,
      maxActive: walletLoginChallengeMaxActive,
    };
  }

  function createWalletChallenge({ accountId = "", purpose = "wallet_link" } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
    const normalizedAccountId = safeId(accountId, "account");
    const challengeId = randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const challenge = {
      id: challengeId,
      accountId: normalizedAccountId,
      purpose,
      issuedAt,
      expiresAt,
      message: walletChallengeMessage({ accountId: normalizedAccountId, challengeId, purpose, issuedAt, expiresAt }),
    };
    state.walletChallenges[challengeId] = challenge;
    saveState();
    return { ok: true, challenge };
  }

  function createWalletLoginChallenge({ address = "", publicKey = "", expiresInSeconds = 5 * 60, expiresAt = "" } = {}) {
    pruneExpiredWalletChallenges({ save: false });
    const normalizedAddress = String(address || "").trim();
    if (!normalizedAddress) return { ok: false, status: 400, error: "wallet_address_required" };
    const challengeId = randomUUID();
    const issuedAt = new Date().toISOString();
    const ttlMs = Math.min(Math.max(Number(expiresInSeconds) || 5 * 60, 1), 10 * 60) * 1000;
    const resolvedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : new Date(Date.now() + ttlMs).toISOString();
    const challenge = {
      id: challengeId,
      accountId: "",
      address: normalizedAddress,
      publicKey: String(publicKey || "").trim(),
      purpose: "wallet_login",
      issuedAt,
      expiresAt: resolvedExpiresAt,
      message: walletLoginChallengeMessage({ address: normalizedAddress, challengeId, issuedAt, expiresAt: resolvedExpiresAt }),
    };
    state.walletChallenges[challengeId] = challenge;
    pruneExpiredWalletChallenges({ save: false });
    saveState();
    return { ok: true, challenge };
  }

  function consumeWalletChallenge({ accountId = "", challengeId = "", purpose = "wallet_link" } = {}) {
    const normalizedAccountId = safeId(accountId, "account");
    const id = String(challengeId || "");
    const challenge = state.walletChallenges[id];
    if (!challenge) return { ok: false, status: 400, error: "wallet_challenge_invalid" };
    const allowedPurposes = Array.isArray(purpose) ? purpose : [purpose];
    if (challenge.accountId !== normalizedAccountId || !allowedPurposes.includes(challenge.purpose)) {
      return { ok: false, status: 400, error: "wallet_challenge_mismatch" };
    }
    if ((Date.parse(challenge.expiresAt || "") || 0) <= Date.now()) {
      return { ok: false, status: 400, error: "wallet_challenge_expired" };
    }
    delete state.walletChallenges[id];
    saveState();
    return { ok: true, challenge };
  }

  function consumeWalletLoginChallenge({ challengeId = "", address = "" } = {}) {
    const pruned = pruneExpiredWalletChallenges({ save: false });
    const normalizedAddress = String(address || "").trim();
    const id = String(challengeId || "");
    const challenge = state.walletChallenges[id];
    if (!challenge) {
      if (pruned.changed) saveState();
      return { ok: false, status: 400, error: "invalid_or_expired_challenge" };
    }
    const valid = challenge.purpose === "wallet_login"
      && challenge.address === normalizedAddress
      && (Date.parse(challenge.expiresAt || "") || 0) > Date.now();
    delete state.walletChallenges[id];
    saveState();
    return valid ? { ok: true, challenge } : { ok: false, status: 400, error: "invalid_or_expired_challenge" };
  }

  function activeWalletAccountsForAddress(address = "", exceptAccountId = "") {
    const normalizedAddress = String(address || "").trim();
    const normalizedExceptAccountId = exceptAccountId ? safeId(exceptAccountId, "account") : "";
    if (!normalizedAddress) return [];
    return Object.entries(state.accountWallets || {}).filter(([accountId, wallet]) => (
      wallet?.status === "linked"
      && (!normalizedExceptAccountId || accountId !== normalizedExceptAccountId)
      && String(wallet.address || "").trim() === normalizedAddress
    ));
  }

  function findAccountByLinkedWallet({ address = "" } = {}) {
    const normalizedAddress = String(address || "").trim();
    if (!normalizedAddress) return null;
    const [accountId, wallet] = activeWalletAccountsForAddress(normalizedAddress)[0] || [];
    if (!accountId || !wallet || !state.accounts[accountId]) return null;
    return { accountId, account: accountPayload(state.accounts[accountId]), wallet };
  }

  function accountWalletCloudFacts({ accountId = "" } = {}) {
    const normalizedAccountId = accountId ? safeId(accountId, "account") : "";
    return {
      accountId: normalizedAccountId,
      activeWallet: normalizedAccountId ? state.accountWallets[normalizedAccountId] || null : null,
      activeWallets: state.accountWallets || {},
      authEvents: (state.authEvents || []).filter((event) => event?.accountId === normalizedAccountId && String(event.eventType || "").startsWith("wallet_")),
    };
  }

  function mirrorLinkedWalletToDatabase({ accountId, walletAddress, linkedAt = null, reclaimedAccountIds = [] }) {
    (async () => {
      const { databaseEnabled, query } = await import("./db/pool.js");
      if (!databaseEnabled()) return;
      await query(
        `INSERT INTO account_linked_wallets (account_id, wallet_address, status, linked_at, updated_at)
         VALUES ($1, $2, 'linked', $3, now())
         ON CONFLICT (account_id) DO UPDATE SET
           wallet_address = EXCLUDED.wallet_address,
           status = 'linked',
           linked_at = EXCLUDED.linked_at,
           updated_at = now()`,
        [accountId, walletAddress, linkedAt]
      );
      for (const reclaimed of reclaimedAccountIds) await query(`DELETE FROM account_linked_wallets WHERE account_id = $1`, [reclaimed]);
    })().catch(() => null);
  }

  function mirrorDelinkedWalletToDatabase(accountId) {
    (async () => {
      const { databaseEnabled, query } = await import("./db/pool.js");
      if (!databaseEnabled()) return;
      await query(`DELETE FROM account_linked_wallets WHERE account_id = $1`, [accountId]);
    })().catch(() => null);
  }

  function walletCreatedInAccountForRecord(accountId = "", wallet = null) {
    if (!wallet?.address) return false;
    if (wallet.walletCreatedInAccount === true || wallet.proof?.purpose === "wallet_create") return true;
    const normalizedAccountId = safeId(accountId, "account");
    for (const event of [...(state.authEvents || [])].reverse()) {
      if (event?.accountId !== normalizedAccountId) continue;
      if (!["wallet_linked", "wallet_relinked"].includes(String(event.eventType || ""))) continue;
      if (String(event.metadata?.walletAddress || "") !== String(wallet.address || "")) continue;
      if (event.metadata?.proofPurpose === "wallet_create") return true;
    }
    return false;
  }

  function linkWalletToAccount({
    accountId = "", address = "", publicKey = "", tasknodeEncryptionPubkey = "",
    challengeId = "", signature = "", proofPurpose = "wallet_link", databaseMirror = true,
  } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
    const normalizedAccountId = safeId(accountId, "account");
    const normalizedAddress = String(address || "").trim();
    if (!normalizedAddress) return { ok: false, status: 400, error: "wallet_address_required" };
    const conflictingOwners = activeWalletAccountsForAddress(normalizedAddress, normalizedAccountId);
    if (conflictingOwners.length > 0) {
      return { ok: false, status: 409, error: "wallet_owned_by_other_account" };
    }
    const now = new Date().toISOString();
    const previousWallet = state.accountWallets[normalizedAccountId] || null;
    const walletCreatedInAccount = walletCreatedInAccountForRecord(normalizedAccountId, {
      ...(previousWallet || {}), address: normalizedAddress, proof: { purpose: proofPurpose },
    }) || proofPurpose === "wallet_create";
    const wallet = {
      accountId: normalizedAccountId, status: "linked", address: normalizedAddress,
      publicKey: String(publicKey || "").trim(),
      tasknodeEncryptionPubkey: String(tasknodeEncryptionPubkey || previousWallet?.tasknodeEncryptionPubkey || "").trim(),
      custody: "local_seed_required", linkedAt: previousWallet?.linkedAt || now,
      relinkedAt: previousWallet ? now : undefined, updatedAt: now, walletCreatedInAccount,
      proof: { challengeId, purpose: proofPurpose, signatureHash: stableId(signature, "sig") },
    };
    state.accountWallets[normalizedAccountId] = wallet;
    state.authEvents.push({
      id: randomUUID(), accountId: normalizedAccountId, eventType: previousWallet ? "wallet_relinked" : "wallet_linked",
      provider: "wallet", email: null, decision: "accepted",
      metadata: {
        walletAddress: wallet.address, previousWalletAddress: previousWallet?.address || null,
        tasknodeEncryptionPubkey: wallet.tasknodeEncryptionPubkey || null, proofPurpose, challengeId,
        signatureHash: wallet.proof.signatureHash, reclaimedWalletCount: 0,
      },
      createdAt: now,
    });
    if (state.authEvents.length > 1000) state.authEvents = state.authEvents.slice(-1000);
    saveState();
    if (databaseMirror) mirrorLinkedWalletToDatabase({
      accountId: normalizedAccountId, walletAddress: wallet.address, linkedAt: wallet.linkedAt,
      reclaimedAccountIds: [],
    });
    return { ok: true, wallet, reclaimedWalletCount: 0 };
  }

  function resolveOrCreateWalletLoginAccount({ address = "", publicKey = "", challengeId = "", signature = "" } = {}) {
    const normalizedAddress = String(address || "").trim();
    if (!normalizedAddress) return { ok: false, status: 400, error: "wallet_address_required" };
    const now = new Date().toISOString();
    const existing = findAccountByLinkedWallet({ address: normalizedAddress });
    if (existing?.accountId && state.accounts[existing.accountId]) {
      const account = state.accounts[existing.accountId];
      normalizeAccountProfileVisibility(account);
      mergeLinkedProvider(account, linkedWalletProvider({ address: normalizedAddress, publicKey }));
      account.assurance = "high";
      account.updatedAt = now;
      account.lastProviderLoginAt = now;
      state.accounts[existing.accountId] = account;
      saveState();
      syncAccountSessions(account);
      return { ok: true, account: accountPayload(account), wallet: existing.wallet, created: false, linked: false, reclaimedWalletCount: 0 };
    }
    const accountId = stableId(normalizedAddress, "acct_wallet");
    let account = state.accounts[accountId];
    if (!account) {
      account = {
        id: accountId, status: "active", displayName: displayNameFromWalletAddress(normalizedAddress),
        primaryProvider: "wallet", assurance: "high", profileVisibility: "public", linkedProviders: [],
        createdAt: now, updatedAt: now,
      };
    }
    normalizeAccountProfileVisibility(account);
    mergeLinkedProvider(account, linkedWalletProvider({ address: normalizedAddress, publicKey }));
    account.status = account.status || "active";
    account.displayName = account.displayName || displayNameFromWalletAddress(normalizedAddress);
    account.primaryProvider = account.primaryProvider || "wallet";
    account.assurance = "high";
    account.updatedAt = now;
    account.lastProviderLoginAt = now;
    state.accounts[accountId] = account;
    const linked = linkWalletToAccount({ accountId, address: normalizedAddress, publicKey, challengeId, signature, proofPurpose: "wallet_login" });
    if (!linked.ok) return linked;
    const resolvedAccount = state.accounts[accountId] || account;
    syncAccountSessions(resolvedAccount);
    return { ok: true, account: accountPayload(resolvedAccount), wallet: linked.wallet, created: !existing, linked: true, reclaimedWalletCount: Number(linked.reclaimedWalletCount || 0) };
  }

  function delinkWalletFromAccount({ accountId = "", reason = "user_requested", actorSessionId = "", databaseMirror = true } = {}) {
    if (!accountId) return { ok: false, status: 401, error: "wallet_login_required" };
    const normalizedAccountId = safeId(accountId, "account");
    const wallet = state.accountWallets[normalizedAccountId];
    if (!wallet || wallet.status !== "linked" || !wallet.address) return { ok: false, status: 409, error: "wallet_not_linked" };
    const now = new Date().toISOString();
    const previousWallet = { ...wallet, status: "delinked", delinkedAt: now, updatedAt: now };
    delete state.accountWallets[normalizedAccountId];
    state.authEvents.push({
      id: randomUUID(), accountId: normalizedAccountId, eventType: "wallet_delinked", provider: "wallet",
      email: null, decision: "accepted",
      metadata: {
        walletAddress: wallet.address, publicKey: wallet.publicKey || null,
        tasknodeEncryptionPubkey: wallet.tasknodeEncryptionPubkey || null,
        custody: wallet.custody || "local_seed_required", linkedAt: wallet.linkedAt || null,
        reason: String(reason || "user_requested").slice(0, 120), actorSessionId: actorSessionId || null,
      },
      createdAt: now,
    });
    if (state.authEvents.length > 1000) state.authEvents = state.authEvents.slice(-1000);
    saveState();
    if (databaseMirror) mirrorDelinkedWalletToDatabase(normalizedAccountId);
    return { ok: true, wallet: previousWallet };
  }

  function getLinkedWallet({ accountId = "" } = {}) {
    const unlinked = { status: "not_linked", address: null, publicKey: null, tasknodeEncryptionPubkey: "", custody: "local_seed_required" };
    if (!accountId) return unlinked;
    const normalizedAccountId = safeId(accountId, "account");
    const wallet = state.accountWallets[normalizedAccountId];
    if (!wallet) return unlinked;
    return {
      status: wallet.status || "linked", address: wallet.address, publicKey: wallet.publicKey,
      tasknodeEncryptionPubkey: wallet.tasknodeEncryptionPubkey || "", proofPurpose: wallet.proof?.purpose || null,
      walletCreatedInAccount: walletCreatedInAccountForRecord(normalizedAccountId, wallet),
      custody: wallet.custody || "local_seed_required", linkedAt: wallet.linkedAt, updatedAt: wallet.updatedAt,
    };
  }

  return {
    accountWalletCloudFacts,
    consumeWalletChallenge,
    consumeWalletLoginChallenge,
    createWalletChallenge,
    createWalletLoginChallenge,
    delinkWalletFromAccount,
    findAccountByLinkedWallet,
    getLinkedWallet,
    linkWalletToAccount,
    pruneExpiredWalletChallenges,
    resolveOrCreateWalletLoginAccount,
    walletCreatedInAccountForRecord,
  };
}
