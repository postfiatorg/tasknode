import { requestJson } from "../../api";
import { clearAuthSessionHint } from "../../app/app-shell-shared.jsx";

function clearSessionHint() {
  clearAuthSessionHint(typeof window === "undefined" ? null : window.sessionStorage);
}

export function createAccountSwitcherActions({
  addingAccount,
  loadRetainedAccounts,
  lockWalletVault,
  onAddLoginClose,
  onAddLoginOpen,
  onMessage,
  onPendingChange,
  onTransitionChange,
  prepareTransition,
  selectedAccountId,
}) {
  async function logOut(path = "/api/auth/logout") {
    onTransitionChange(true);
    lockWalletVault();
    await requestJson(path, { method: "POST" });
    clearSessionHint();
    window.location.reload();
  }

  return {
    logOut: () => logOut(),
    logOutAllAccounts: () => logOut("/api/auth/logout-all"),
    async addAccount() {
      onPendingChange("add");
      onMessage("");
      try {
        const result = await requestJson("/api/auth/accounts/add/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!result.ok) return onMessage(result.body?.message || "Another account cannot be added right now.");
        lockWalletVault();
        onAddLoginOpen();
      } finally {
        onPendingChange("");
      }
    },
    async switchAccount(targetAccountId) {
      if (!targetAccountId || targetAccountId === selectedAccountId) return;
      onPendingChange(targetAccountId);
      onTransitionChange(true);
      onMessage("");
      lockWalletVault();
      prepareTransition();
      const result = await requestJson("/api/auth/accounts/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetAccountId }),
      });
      if (result.ok) {
        clearSessionHint();
        window.location.reload();
        return;
      }
      onPendingChange("");
      onTransitionChange(false);
      onMessage(result.body?.message || "That account could not be selected.");
    },
    async removeRetainedAccount(targetAccountId) {
      onPendingChange(`remove:${targetAccountId}`);
      onMessage("");
      try {
        const result = await requestJson("/api/auth/accounts/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetAccountId }),
        });
        if (!result.ok) return onMessage(result.body?.message || "That account could not be removed from this browser.");
        await loadRetainedAccounts();
      } finally {
        onPendingChange("");
      }
    },
    async closeAccountLogin() {
      if (addingAccount) {
        await requestJson("/api/auth/accounts/add/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }
      onAddLoginClose();
    },
  };
}
