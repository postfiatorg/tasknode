import { randomUUID } from "node:crypto";

function accountId(value = "") {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

export function getRuntimeEthereumDepositAccount(state, { accountId: rawAccountId = "" } = {}) {
  const normalized = accountId(rawAccountId);
  if (!normalized) return null;
  return state.ethereumDepositAccounts[normalized] ? structuredClone(state.ethereumDepositAccounts[normalized]) : null;
}

export function retireRuntimeEthereumDepositAccount(state, saveState, { accountId: rawAccountId = "", reason = "operator_retired", status = "retired" } = {}) {
  const normalized = accountId(rawAccountId);
  if (!normalized) return { ok: false, status: 401, error: "deposit_login_required" };
  const existing = state.ethereumDepositAccounts[normalized];
  if (!existing?.address) return { ok: false, status: 404, error: "deposit_account_not_found" };
  const retiredAt = new Date().toISOString();
  state.ethereumDepositRetiredAccounts.push({ ...existing, status, retiredAt, retireReason: reason });
  delete state.ethereumDepositAddressIndex[String(existing.address || "").toLowerCase()];
  delete state.ethereumDepositAccounts[normalized];
  saveState();
  return { ok: true, account: structuredClone(existing), retiredAt };
}

export function getOrCreateRuntimeEthereumDepositAccount(state, saveState, options = {}) {
  const normalized = accountId(options.accountId);
  if (!normalized) return { ok: false, status: 401, error: "deposit_login_required" };
  if (typeof options.deriveAddress !== "function") return { ok: false, status: 409, error: "deposit_deriver_unavailable" };
  const startIndex = Math.max(0, Number(options.startIndex) || 0);
  const existing = state.ethereumDepositAccounts[normalized];
  if (existing?.address && Number(existing.derivationIndex) >= startIndex) {
    return { ok: true, account: structuredClone(existing), created: false };
  }
  if (existing?.address) {
    retireRuntimeEthereumDepositAccount(state, saveState, {
      accountId: normalized,
      status: "retired_reserved_index",
      reason: `derivation_index_below_start:${startIndex}`,
    });
  }
  const allocationStart = Math.max(startIndex, Number(state.ethereumDepositCursor || 0));
  for (let offset = 0; offset < 1000; offset += 1) {
    const derivationIndex = allocationStart + offset;
    let derived;
    try { derived = options.deriveAddress(derivationIndex); } catch { return { ok: false, status: 409, error: "deposit_address_derivation_failed" }; }
    const address = String(derived?.address || "").trim();
    const addressKey = address.toLowerCase();
    if (!address || state.ethereumDepositAddressIndex[addressKey]) continue;
    const now = new Date().toISOString();
    const account = {
      id: `ethdep_${randomUUID()}`, accountId: normalized, chainId: options.chainId || 1,
      network: options.network || "Ethereum mainnet", address, addressKey, derivationIndex,
      derivationPath: derived?.derivationPath || "", assets: options.assets || [], status: "active",
      custody: options.custody || "tasknode_deposit_only", withdrawalsEnabled: false,
      sweepStatus: "deferred", observedBalances: {}, creditedBalances: {}, createdAt: now, updatedAt: now,
    };
    state.ethereumDepositAccounts[normalized] = account;
    state.ethereumDepositAddressIndex[addressKey] = normalized;
    state.ethereumDepositCursor = derivationIndex + 1;
    saveState();
    return { ok: true, account: structuredClone(account), created: true };
  }
  return { ok: false, status: 500, error: "deposit_address_allocation_failed" };
}

export function updateRuntimeEthereumDepositSync(state, saveState, options = {}) {
  const normalized = accountId(options.accountId);
  const existing = normalized ? state.ethereumDepositAccounts[normalized] : null;
  if (!existing) return null;
  const now = new Date().toISOString();
  const next = {
    ...existing,
    observedBalances: { ...(existing.observedBalances || {}), ...(options.observedBalances || {}) },
    pendingBalances: { ...(existing.pendingBalances || {}), ...(options.pendingBalances || {}) },
    creditedBalances: { ...(existing.creditedBalances || {}), ...(options.creditedBalances || {}) },
    lastSyncAt: now,
    lastSyncStatus: options.syncStatus || "ready",
    lastSyncError: options.syncError || "",
    lastSyncBlockTag: options.blockTag || existing.lastSyncBlockTag || "",
    lastCreditedLedgerIds: [...new Set([
      ...(existing.lastCreditedLedgerIds || []),
      ...(options.creditedEntries || []).map((entry) => entry.id).filter(Boolean),
    ])].slice(-50),
    updatedAt: now,
  };
  state.ethereumDepositAccounts[normalized] = next;
  saveState();
  return structuredClone(next);
}
