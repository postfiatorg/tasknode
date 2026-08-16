import { randomUUID } from "node:crypto";
import {
  mergeWalletInitiationGrantStatus,
  reserveWalletInitiationGrantRecord,
  updateWalletInitiationGrantRecord,
} from "./wallet-initiation-grants-db.js";
import {
  publicWalletInitiationGrant,
  walletInitiationAmountDrops,
  walletInitiationAmountPft,
  walletInitiationGrantStatusForState,
} from "./wallet-initiation-eligibility.js";

export function createRuntimeWalletGrantStore({ state, saveState, safeId, walletCreatedInAccountForRecord } = {}) {
  function walletInitiationGrantStatus({ accountId = "", walletAddress = "", source = "wallet_create" } = {}) {
    return walletInitiationGrantStatusForState({ accountId, walletAddress, source, state, safeId, walletCreatedInAccountForRecord });
  }

  async function resolveWalletInitiationGrantStatus(params = {}) {
    return mergeWalletInitiationGrantStatus(walletInitiationGrantStatus(params), params);
  }

  async function reserveWalletInitiationGrant({
    accountId = "", walletAddress = "", amountDrops = walletInitiationAmountDrops(),
    amountPft = walletInitiationAmountPft(), source = "wallet_create", trigger = null,
  } = {}) {
    const normalizedAccountId = safeId(accountId, "account");
    const normalizedWalletAddress = String(walletAddress || "").trim();
    const eligibility = await resolveWalletInitiationGrantStatus({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress, source });
    if (!eligibility.eligible) {
      return { ok: false, status: 409, error: eligibility.reason || "wallet_initiation_not_eligible", eligibility };
    }
    const now = new Date().toISOString();
    const identities = Array.isArray(eligibility.identities) ? eligibility.identities : [];
    const normalizedSource = eligibility.source || String(source || "wallet_create").trim().toLowerCase() || "wallet_create";
    const grant = {
      id: `wallet_init_${randomUUID()}`, status: "processing", accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress, amountDrops: String(amountDrops),
      amountPft: Number(Number(amountPft).toFixed(6)), source: normalizedSource,
      provider: eligibility.provider || identities[0]?.provider || "",
      providerUserIdHashes: identities.map((identity) => identity.providerUserIdHash),
      providers: identities.map((identity) => ({ provider: identity.provider, providerUserIdHash: identity.providerUserIdHash, username: identity.username || null })),
      createdAt: now, updatedAt: now,
    };
    if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) grant.trigger = trigger;
    const durable = await reserveWalletInitiationGrantRecord(grant);
    if (!durable.ok) {
      const reason = durable.error || eligibility.reason || "wallet_initiation_not_eligible";
      return {
        ok: false, status: 409, error: reason,
        eligibility: { ...eligibility, eligible: false, reason, grant: durable.grant || eligibility.grant || null },
      };
    }
    state.walletInitiationGrants.push(grant);
    saveState();
    return { ok: true, grant: publicWalletInitiationGrant(grant), internalGrant: structuredClone(grant) };
  }

  async function completeWalletInitiationGrant({ grantId = "", txHash = "", faucetAddress = "" } = {}) {
    const grant = (state.walletInitiationGrants || []).find((item) => item?.id === grantId);
    if (!grant) return { ok: false, status: 404, error: "wallet_initiation_grant_not_found" };
    grant.status = "completed";
    grant.txHash = txHash || grant.txHash || null;
    grant.faucetAddress = faucetAddress || grant.faucetAddress || null;
    grant.error = "";
    grant.updatedAt = new Date().toISOString();
    saveState();
    await updateWalletInitiationGrantRecord({ grantId, status: "completed", txHash: grant.txHash || "", faucetAddress: grant.faucetAddress || "" });
    return { ok: true, grant: publicWalletInitiationGrant(grant) };
  }

  async function failWalletInitiationGrant({ grantId = "", error = "", unknown = false } = {}) {
    const grant = (state.walletInitiationGrants || []).find((item) => item?.id === grantId);
    if (!grant) return { ok: false, status: 404, error: "wallet_initiation_grant_not_found" };
    grant.status = unknown ? "unknown" : "failed";
    grant.error = String(error || "wallet_initiation_failed").slice(0, 240);
    grant.updatedAt = new Date().toISOString();
    saveState();
    await updateWalletInitiationGrantRecord({ grantId, status: grant.status, error: grant.error });
    return { ok: true, grant: publicWalletInitiationGrant(grant) };
  }

  return {
    completeWalletInitiationGrant,
    failWalletInitiationGrant,
    reserveWalletInitiationGrant,
    resolveWalletInitiationGrantStatus,
    walletInitiationGrantStatus,
  };
}
