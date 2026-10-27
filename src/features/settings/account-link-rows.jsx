import { ProviderIcon } from "../identity/ProviderIcon.jsx";

// Account-link helpers the always-loaded shell needs. Kept apart from
// AppDialogs.jsx so the login and settings dialogs can load on demand.
export function TelegramProfileMenuRow({ linkedProvider, onClick, pending, provider, signedIn }) {
  const linked = Boolean(linkedProvider);
  const detail = linked
    ? linkedAccountStatus(linkedProvider)
    : provider?.enabled
      ? "Link Telegram to use Task Node from chat."
      : provider?.configured
        ? "Telegram linking is temporarily disabled."
        : "Telegram linking needs setup.";
  const status = linked
    ? "Linked"
    : pending
      ? "Checking"
      : provider?.enabled
        ? "Connect"
        : "Setup";

  return (
    <button
      className="telegram-menu-row"
      disabled={!signedIn || pending}
      onClick={onClick}
      type="button"
    >
      <span className="telegram-menu-icon">
        <ProviderIcon id="telegram" />
      </span>
      <span className="telegram-menu-copy">
        <strong>Telegram Chat</strong>
        <small>{detail}</small>
      </span>
      <span className={linked ? "telegram-menu-status linked" : "telegram-menu-status"}>
        {status}
      </span>
    </button>
  );
}

export function linkedAccountStatus(provider) {
  if (provider.username) return `@${provider.username}`;
  if (provider.maskedEmail) return provider.maskedEmail;
  if (provider.email) return provider.email;
  return "Linked";
}

export function accountLinkProvider(session, providerId) {
  const id = String(providerId || "").trim();
  return (
    (session?.accountLinks || []).find((provider) => provider?.id === id) || {
      id,
      label: "Telegram",
      startPath: `/api/auth/start/${id}`,
      configured: false,
      enabled: false,
    }
  );
}

export function linkedProviderById(session, providerId) {
  const id = String(providerId || "").trim();
  return (session?.linkedProviders || []).find((provider) => provider?.id === id) || null;
}
