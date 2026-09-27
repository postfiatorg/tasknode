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
    onMessage("");
    try {
      const result = await requestJson(path, { method: "POST" });
      if (!result.ok || result.body?.ok === false) throw new Error(result.body?.message || "Log out failed. Please try again.");
      clearSessionHint();
      window.location.reload();
    } catch (error) {
      onTransitionChange(false);
      onMessage(error?.message || "Log out failed. Check your connection and try again.");
    }
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
      } catch (error) {
        onMessage(error?.message || "Another account cannot be added right now.");
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
      let reloading = false;
      try {
        const result = await requestJson("/api/auth/accounts/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetAccountId }),
        });
        if (result.ok && result.body?.ok !== false) {
          reloading = true;
          clearSessionHint();
          window.location.reload();
          return;
        }
        onMessage(result.body?.message || "That account could not be selected.");
      } catch (error) {
        onMessage(error?.message || "Check your connection and try switching again.");
      } finally {
        if (!reloading) {
          onPendingChange("");
          onTransitionChange(false);
        }
      }
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
