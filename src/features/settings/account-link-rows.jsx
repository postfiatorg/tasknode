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
    <button className="tool-menu-row telegram-menu-row" disabled={!signedIn || pending} onClick={onClick} title={detail} type="button">
      <ProviderIcon id="telegram" size={16} />
      <span>Telegram</span>
      <small className={linked ? "menu-row-state is-ok" : "menu-row-state"}>{status}</small>
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
