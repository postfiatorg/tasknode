import { Check, ChevronRight, Settings as SettingsIcon, User as UserIcon, X } from "lucide-react";
import { profileAvatarText } from "../chat/AppChatDialogs.jsx";
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
  return (
    <>
      {accounts.length > 0 && (
        <div className="profile-account-list" aria-label="Accounts on this browser">
          {accounts.map((account) => {
            const selected = account.accountId === selectedAccountId;
            const accountLabel = account.displayName || account.hiveHandle || account.maskedEmail || "Member";
            const accountDetail = account.hiveHandle
              ? `@${account.hiveHandle}`
              : account.maskedEmail
                || (account.walletAddress ? `${account.walletAddress.slice(0, 8)}…${account.walletAddress.slice(-6)}` : "Authenticated account");
            return (
              <div className={selected ? "profile-account-row selected" : "profile-account-row"} key={account.accountId}>
                <button disabled={selected || Boolean(pending)} onClick={() => onSwitch?.(account.accountId)} type="button">
                  <span className="profile-account-avatar">{profileAvatarText({ displayName: accountLabel })}</span>
                  <span><strong>{accountLabel}</strong><small>{accountDetail}</small></span>
                  {selected ? <Check size={14} strokeWidth={2} /> : pending === account.accountId ? <small>Switching</small> : null}
                </button>
                {managing && !selected && (
                  <button aria-label={`Remove ${accountLabel} from this browser`} className="profile-account-remove" disabled={Boolean(pending)} onClick={() => onRemove?.(account.accountId)} type="button">
                    <X size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ToolMenuRow icon={UserIcon} label={pending === "add" ? "Starting account login" : "Add account"} onClick={onAdd} trailing={<ChevronRight size={14} />} />
      {accounts.length > 1 && (
        <ToolMenuRow icon={SettingsIcon} label={managing ? "Done managing accounts" : "Manage accounts"} onClick={() => onManagingChange?.(!managing)} />
      )}
    </>
  );
}
