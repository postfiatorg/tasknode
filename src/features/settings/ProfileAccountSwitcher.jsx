import { Plus, User as UserIcon, X } from "lucide-react";
import { ToolMenuRow } from "../shell/ShellControls";

export function ProfileAccountSwitcher({
  accounts = [],
  managing = false,
  onAdd,
  onManagingChange,
  onRemove,
  onSwitch,
  pending = "",
  selectedAccountId = "",
}) {
  // The menu header already shows the current account; list others only when
  // there are others to switch to.
  const others = accounts.filter((account) => account.accountId !== selectedAccountId);
  return (
    <>
      {others.length > 0 && (
        <div className="profile-account-list" aria-label="Accounts on this browser">
          <div className="profile-account-heading">
            <span>Switch account</span>
            <button onClick={() => onManagingChange?.(!managing)} type="button">{managing ? "Done" : "Manage"}</button>
          </div>
          {others.map((account) => {
            const accountLabel = account.displayName || account.hiveHandle || account.maskedEmail || "Member";
            const accountDetail = account.hiveHandle
              ? `@${account.hiveHandle}`
              : account.maskedEmail
                || (account.walletAddress ? `${account.walletAddress.slice(0, 8)}…${account.walletAddress.slice(-6)}` : "");
            return (
              <div className="profile-account-row" key={account.accountId}>
                <button disabled={Boolean(pending)} onClick={() => onSwitch?.(account.accountId)} type="button">
                  <UserIcon size={16} strokeWidth={1.75} />
                  <span><strong>{accountLabel}</strong>{accountDetail && accountDetail !== accountLabel && <small>{accountDetail}</small>}</span>
                  {pending === account.accountId && <small className="profile-account-pending">Switching…</small>}
                </button>
                {managing && (
                  <button aria-label={`Remove ${accountLabel} from this browser`} className="profile-account-remove" disabled={Boolean(pending)} onClick={() => onRemove?.(account.accountId)} type="button">
                    <X size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ToolMenuRow icon={Plus} label={pending === "add" ? "Starting account login…" : "Add account"} onClick={onAdd} />
    </>
  );
}
