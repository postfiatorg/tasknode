export function createRuntimeAccountLoginStore({
  state,
  accountPayload,
  normalizeHiveHandle,
}) {
  function findAccountByEmail(canonicalEmail = "") {
    const canonical = String(canonicalEmail || "").trim().toLowerCase();
    const accountId = state.accountEmails[canonical];
    return accountPayload(accountId ? state.accounts[accountId] : null);
  }

  function findAccountByHandle(handle = "") {
    const normalized = normalizeHiveHandle(handle);
    if (!normalized) return null;
    const account = Object.values(state.accounts || {}).find((candidate) => (
      candidate?.status !== "merged"
      && normalizeHiveHandle(candidate?.hiveHandle || "") === normalized
    ));
    return accountPayload(account || null);
  }

  return { findAccountByEmail, findAccountByHandle };
}
