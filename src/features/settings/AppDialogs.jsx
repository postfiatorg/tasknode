import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Github, Lock, Shield, X } from "lucide-react";
import { requestJson } from "../../api";
import { BillingSettings } from "../billing/BillingSettings";
import { DataSettings } from "../settings/DataSettings.jsx";
import { SettingsLine, SmallPill } from "../settings/SettingsControls.jsx";
import { IdentitySettings } from "../identity/IdentityControls.jsx";
import { loginProviderDisplayState } from "../chat/chat-ui-state.js";
import { isSignedInSession } from "../../session";
import { SETTINGS_PAGES } from "../../app/app-shell-shared.jsx";

export function SettingsModal({ chat, linkedWallet, onAppStateChange, onClose, onWalletUnlock, session, setTheme, theme, walletSecret, walletVault }) {
  const [page, setPage] = useState("general");
  const activePage = SETTINGS_PAGES.find((item) => item.key === page) || SETTINGS_PAGES[0];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section className="settings-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-rail">
          <button className="settings-close" onClick={onClose} type="button" aria-label="Close settings">
            <X size={18} strokeWidth={1.75} />
          </button>
          <nav>
            {SETTINGS_PAGES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={page === item.key ? "active" : ""}
                  key={item.key}
                  onClick={() => setPage(item.key)}
                  type="button"
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </aside>
        <div className="settings-content">
          <header>
            <h2 id="settings-title">{activePage.label}</h2>
          </header>
          <div className="settings-page">
            {page === "general" && <GeneralSettings setTheme={setTheme} theme={theme} />}
            {page === "security" && (
              <SecuritySettings
                linkedWallet={linkedWallet}
                onAppStateChange={onAppStateChange}
                onWalletUnlock={onWalletUnlock}
                session={session}
                walletSecret={walletSecret}
                walletVault={walletVault}
              />
            )}
            {page === "data" && <DataSettings chat={chat} onAccountDeleted={onClose} onAppStateChange={onAppStateChange} session={session} />}
            {page === "billing" && <BillingSettings onAppStateChange={onAppStateChange} />}
          </div>
        </div>
      </section>
    </div>
  );
}

export function GeneralSettings({ setTheme, theme }) {
  return (
    <>
      <MfaCallout />
      <SettingsLine label="Appearance" right={<CycleButton onClick={() => setTheme(nextTheme(theme))} value={themeLabel(theme)} />} />
      <SettingsLine label="Contrast" right={<StaticButton value="System" />} />
      <SettingsLine label="Accent color" right={<StaticButton value="Black" />} />
      <SettingsLine label="Language" right={<StaticButton value="Auto-detect" />} />
    </>
  );
}

export function SecuritySettings({ linkedWallet, onAppStateChange, onWalletUnlock, session, walletSecret, walletVault }) {
  const signedIn = isSignedInSession(session);
  const linkedProviders = session?.linkedProviders || [];
  const providers = (session?.accountLinks || []).filter((provider) =>
    ["github", "telegram", "discord", "x"].includes(provider.id)
  );
  const linkedProviderCount = linkedProviders.filter((item) =>
    providers.some((provider) => provider.id === item?.id)
  ).length;
  const [message, setMessage] = useState("");
  const [pendingProvider, setPendingProvider] = useState("");
  const [confirmingUnlink, setConfirmingUnlink] = useState("");

  async function unlinkProvider(provider) {
    setPendingProvider(provider.id);
    setMessage("");
    try {
      const result = await requestJson("/api/account/unlink-provider", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, confirm: true }),
      });
      if (result.ok) {
        setMessage(result.body?.message || `${provider.label} unlinked.`);
        await onAppStateChange?.();
      } else {
        setMessage(
          result.body?.message || result.body?.error || `${provider.label} could not be unlinked.`
        );
      }
    } catch (error) {
      setMessage(error?.message || `${provider.label} could not be unlinked.`);
    } finally {
      setPendingProvider("");
      setConfirmingUnlink("");
    }
  }

  async function startProviderLink(provider) {
    if (!signedIn) {
      setMessage("Sign in before linking accounts.");
      return;
    }

    setPendingProvider(provider.id);
    setMessage("");

    try {
      const result = await requestJson(`${provider.startPath}?redirect=/`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${provider.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${provider.label} is unavailable.`);
    } finally {
      setPendingProvider("");
    }
  }

  return (
    <>
      <MfaCallout />
      <IdentitySettings onAppStateChange={onAppStateChange} session={session} />
      <PasswordSecurity
        linkedWallet={linkedWallet}
        onSessionChange={onAppStateChange}
        onWalletUnlock={onWalletUnlock}
        session={session}
        signedIn={signedIn}
        walletSecret={walletSecret}
        walletVault={walletVault}
      />
      {providers.length > 0 && (
        <section className="connected-accounts">
          <div className="connected-heading">
            <strong>Connected accounts</strong>
            <span>{linkedProviderCount} linked</span>
          </div>
          {providers.map((provider) => (
            <ConnectedAccountRow
              key={provider.id}
              confirmingUnlink={confirmingUnlink === provider.id}
              linkedProviders={linkedProviders}
              onLink={startProviderLink}
              onUnlink={unlinkProvider}
              onUnlinkConfirmChange={(open) => setConfirmingUnlink(open ? provider.id : "")}
              pending={pendingProvider === provider.id}
              provider={provider}
              signedIn={signedIn}
            />
          ))}
          {message && <div className="inline-message">{message}</div>}
        </section>
      )}
      <SettingsLine desc="Write down or store your recovery phrase securely." label="Backup recovery phrase" right={<SmallPill>Reveal</SmallPill>} />
      <SettingsLine desc="Sign in with an existing recovery phrase." label="Restore wallet" right={<SmallPill>Restore</SmallPill>} />
      <SettingsLine desc="2 devices currently signed in." label="Active sessions" right={<SmallPill>Manage</SmallPill>} />
      <SettingsLine desc="Send a security or product report." label="Report issue" right={<SmallPill>Report</SmallPill>} />
    </>
  );
}

function PasswordSecurity({ linkedWallet, onSessionChange, onWalletUnlock, session, signedIn, walletSecret, walletVault }) {
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  const loadStatus = useCallback(async () => {
    if (!signedIn) return;
    const result = await requestJson("/api/account/password");
    if (result.ok) setStatus(result.body?.password || null);
  }, [signedIn]);

  useEffect(() => {
    loadStatus().catch(() => setMessage("Password settings are unavailable."));
  }, [loadStatus]);

  function resetForm(nextMode = "") {
    setMode(nextMode);
    setCurrentPassword("");
    setPassword("");
    setConfirmPassword("");
    setMessage("");
  }

  const walletReady = Boolean(
    walletVault?.unlocked
    && walletSecret?.mnemonic
    && walletSecret?.accountId === session?.accountId
    && walletSecret?.address === linkedWallet?.address
  );

  function beginEnable() {
    if (!linkedWallet?.address) {
      setMessage("Link a wallet to this account before enabling password login.");
      onWalletUnlock?.();
      return;
    }
    if (!walletReady) {
      setMessage("Unlock the linked wallet before enabling password login.");
      onWalletUnlock?.();
      return;
    }
    resetForm("enable");
  }

  async function submitCredential() {
    if (mode !== "disable" && password !== confirmPassword) {
      setMessage("The new passwords do not match.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      let result;
      if (mode === "enable") {
        if (!walletReady) {
          setMessage("Unlock the linked wallet before enabling password login.");
          onWalletUnlock?.();
          return;
        }
        const start = await requestJson("/api/account/password/enable/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!start.ok || !start.body?.challenge?.message) {
          setMessage(start.body?.message || "Wallet verification could not start.");
          return;
        }
        const walletCore = await import("../../wallet-core");
        const proof = walletCore.signWalletChallenge(walletSecret.mnemonic, start.body.challenge.message);
        if (proof.address !== linkedWallet.address) {
          setMessage("The unlocked wallet does not match the wallet linked to this account.");
          return;
        }
        result = await requestJson("/api/account/password/enable/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            challengeId: start.body.challenge.id,
            address: proof.address,
            publicKey: proof.publicKey,
            signature: proof.signature,
            password,
          }),
        });
      } else {
        const path = mode === "change"
          ? "/api/account/password/change"
          : "/api/account/password/disable";
        const body = mode === "change"
          ? { currentPassword, newPassword: password }
          : { currentPassword };
        result = await requestJson(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      setMessage(result.body?.message || (result.ok ? "Password settings updated." : "Password settings could not be updated."));
      if (!result.ok) return;
      resetForm("");
      await loadStatus();
      await onSessionChange?.();
    } catch (error) {
      setMessage(error?.message || "Password settings could not be updated.");
    } finally {
      setPending(false);
    }
  }

  const enabled = status?.enabled === true;
  return (
    <section className="connected-accounts password-security">
      <div className="connected-heading">
        <strong>Account password</strong>
        <span>{enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <p className="password-security-copy">
        {!status?.walletLinked
          ? "Link and unlock a wallet before enabling password login."
          : enabled
            ? `Password login is enabled${status?.maskedEmail ? ` with recovery at ${status.maskedEmail}` : ""}.`
            : walletReady
              ? "The linked wallet is unlocked and ready to authorize a password."
              : "Unlock the linked wallet to authorize a password."}
      </p>
      {!mode && (
        <div className="password-security-actions">
          {enabled ? (
            <>
              <SmallPill onClick={() => resetForm("change")}>Change</SmallPill>
              <SmallPill danger onClick={() => resetForm("disable")}>Disable</SmallPill>
            </>
          ) : (
            <SmallPill disabled={!status || pending} onClick={beginEnable}>
              {!status?.walletLinked ? "Open wallet" : walletReady ? "Enable" : "Unlock wallet"}
            </SmallPill>
          )}
        </div>
      )}
      {mode && (
        <div className="password-security-form">
          {(mode === "change" || mode === "disable") && (
            <input autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" type="password" value={currentPassword} />
          )}
          {mode !== "disable" && (
            <>
              <input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} placeholder="New password (12+ characters)" type="password" value={password} />
              <input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" type="password" value={confirmPassword} />
            </>
          )}
          <div className="password-security-actions">
            <SmallPill disabled={pending} onClick={() => resetForm("")}>Cancel</SmallPill>
            <SmallPill danger={mode === "disable"} disabled={pending} onClick={submitCredential}>
              {pending ? "Saving" : mode === "disable" ? "Disable" : "Save password"}
            </SmallPill>
          </div>
        </div>
      )}
      {message && <div className="inline-message">{message}</div>}
    </section>
  );
}

export function ConnectedAccountRow({
  confirmingUnlink = false,
  linkedProviders,
  onLink,
  onUnlink,
  onUnlinkConfirmChange,
  pending,
  provider,
  signedIn,
}) {
  const linkedProvider = linkedProviders.find((item) => item?.id === provider.id);
  const linked = Boolean(linkedProvider);
  const status = linked
    ? linkedAccountStatus(linkedProvider)
    : provider.enabled
      ? "Available"
      : provider.configured
        ? "Disabled"
        : "Needs config";

  return (
    <div className="connected-account-row">
      <span className="connected-provider-icon">
        <ProviderIcon id={provider.id} />
      </span>
      <div>
        <strong>{provider.label}</strong>
        <small>{confirmingUnlink ? `Unlink ${provider.label}? You can relink it later.` : status}</small>
      </div>
      {linked ? (
        confirmingUnlink ? (
          <span className="connected-unlink-confirm">
            <button disabled={pending} onClick={() => onUnlinkConfirmChange?.(false)} type="button">
              Keep
            </button>
            <button disabled={pending} onClick={() => onUnlink?.(provider)} type="button">
              {pending ? "Unlinking" : "Unlink"}
            </button>
          </span>
        ) : (
          <button disabled={!signedIn || pending} onClick={() => onUnlinkConfirmChange?.(true)} type="button">
            Disconnect
          </button>
        )
      ) : (
        <button
          disabled={!signedIn || !provider.enabled || pending}
          onClick={() => onLink(provider)}
          type="button"
        >
          {pending ? "Checking" : "Connect"}
        </button>
      )}
    </div>
  );
}

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

export function MfaCallout() {
  return (
    <section className="mfa-callout">
      <span>
        <Shield size={16} strokeWidth={1.75} />
        <i><Lock size={8} strokeWidth={2.5} /></i>
      </span>
      <strong>Secure your account</strong>
      <p>Add multi-factor authentication (MFA), like a hardware key or authenticator app, to help protect your account when signing in.</p>
      <button type="button">Set up MFA</button>
    </section>
  );
}

export function StaticButton({ value }) {
  return (
    <button className="static-button" type="button">
      {value}
      <ChevronRight size={13} strokeWidth={1.75} />
    </button>
  );
}

export function CycleButton({ onClick, value }) {
  return (
    <button className="static-button" onClick={onClick} type="button">
      {value}
      <ChevronRight size={13} strokeWidth={1.75} />
    </button>
  );
}

export function nextTheme(theme) {
  if (theme === "auto") return "light";
  if (theme === "light") return "dark";
  return "auto";
}

export function themeLabel(theme) {
  if (theme === "auto") return "System";
  return theme[0].toUpperCase() + theme.slice(1);
}

export function LoginDialog({ authLoading = false, session, onClose, onSessionChange, reloadOnSuccess = false }) {
  const providers = (session?.accountLinks || []).filter((provider) =>
    ["telegram", "discord", "x", "github"].includes(provider.id) && provider.enabled
  );
  const providerDisplayState = loginProviderDisplayState({ authLoading, providers });
  const emailProvider = (session?.accountLinks || []).find((provider) => provider.id === "email");
  const devAuth = session?.devAuth;
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailStep, setEmailStep] = useState("email");
  const [challenge, setChallenge] = useState(null);
  const [message, setMessage] = useState("");
  const [pendingProvider, setPendingProvider] = useState("");
  const [loginMethod, setLoginMethod] = useState("code");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStep, setPasswordStep] = useState("login");

  async function completeAuthentication() {
    if (reloadOnSuccess) {
      window.location.reload();
      return;
    }
    await onSessionChange?.();
    onClose();
  }

  async function startProvider(provider) {
    setPendingProvider(provider.id);
    setMessage("");

    try {
      const result = await requestJson(provider.startPath);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${provider.label} login returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${provider.label} login is unavailable.`);
    } finally {
      setPendingProvider("");
    }
  }

  async function continueEmail() {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setMessage("Enter an email address.");
      return;
    }

    setPendingProvider("email");
    setMessage("");

    if (emailProvider?.enabled) {
      try {
        const result = await requestJson(emailProvider.startPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: trimmedEmail }),
        });

        if (result.ok) {
          setChallenge(result.body);
          setEmailStep("code");
          setCode("");
          setMessage(result.body?.message || "Enter the sign-in code.");
        } else {
          setMessage(
            result.body?.message ||
              result.body?.actionRequired ||
              `Email login returned HTTP ${result.status}.`
          );
        }
      } catch (error) {
        setMessage(error?.message || "Email login is unavailable.");
      } finally {
        setPendingProvider("");
      }
      return;
    }

    if (!devAuth?.enabled) {
      setMessage(
        emailProvider?.actionRequired ||
          "Email login needs a transactional email provider and code callback."
      );
      setPendingProvider("");
      return;
    }

    try {
      const result = await requestJson(devAuth.startPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail }),
      });

      if (result.ok) {
        await completeAuthentication();
      } else {
        setMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Email login returned HTTP ${result.status}.`
        );
      }
    } catch (error) {
      setMessage(error?.message || "Email login is unavailable.");
    } finally {
      setPendingProvider("");
    }
  }

  async function verifyEmailCode() {
    const trimmedCode = code.trim().replace(/\s+/g, "");
    if (!trimmedCode) {
      setMessage("Enter the sign-in code.");
      return;
    }

    if (!challenge?.challengeId || !emailProvider?.verifyPath) {
      setMessage("Request a new sign-in code.");
      return;
    }

    setPendingProvider("email");
    setMessage("");

    try {
      const result = await requestJson(emailProvider.verifyPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code: trimmedCode,
        }),
      });

      if (result.ok) {
        await completeAuthentication();
      } else {
        setMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Email verification returned HTTP ${result.status}.`
        );
      }
    } catch (error) {
      setMessage(error?.message || "Email verification is unavailable.");
    } finally {
      setPendingProvider("");
    }
  }

  function editEmail() {
    setEmailStep("email");
    setCode("");
    setChallenge(null);
    setMessage("");
  }

  async function submitPasswordLogin() {
    if (!email.trim() || !password) {
      setMessage("Enter your verified email or Hive handle and account password.");
      return;
    }
    setPendingProvider("password");
    setMessage("");
    try {
      const result = await requestJson("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: email.trim(), password }),
      });
      if (result.ok) return completeAuthentication();
      setMessage(result.body?.message || "Email, handle, or account password is incorrect.");
    } finally {
      setPendingProvider("");
    }
  }

  async function startPasswordReset() {
    if (!email.trim() || !email.includes("@")) {
      setMessage("Enter the verified email address for this account to reset its password.");
      return;
    }
    setPendingProvider("password");
    setMessage("");
    try {
      const result = await requestJson("/api/auth/password/reset/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!result.ok) return setMessage(result.body?.message || "A reset code could not be sent.");
      setChallenge(result.body);
      setPasswordStep("reset");
      setCode("");
      setPassword("");
      setConfirmPassword("");
      setMessage(result.body?.message || "Enter the reset code and a new password.");
    } finally {
      setPendingProvider("");
    }
  }

  async function verifyPasswordReset() {
    if (!code.trim() || password.length < 12 || password !== confirmPassword) {
      setMessage(password !== confirmPassword ? "The new passwords do not match." : "Enter the code and a password of at least 12 characters.");
      return;
    }
    setPendingProvider("password");
    setMessage("");
    try {
      const result = await requestJson("/api/auth/password/reset/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge?.challengeId, code: code.trim(), password }),
      });
      if (result.ok) return completeAuthentication();
      setMessage(result.body?.message || "That reset request is invalid or expired.");
    } finally {
      setPendingProvider("");
    }
  }

  const devCode = challenge?.delivery?.devCode || "";

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close">
          <X size={18} strokeWidth={2} />
        </button>
        <h2 id="login-title">Log in or sign up</h2>
        <p>You'll get smarter responses and can upload files, images, and more.</p>
        {providerDisplayState === "loading" ? (
          <div className="login-loading-options" aria-live="polite">Checking login options</div>
        ) : (
          <>
            {providers.map((provider) => (
              <button
                key={provider.id}
                className="provider-row"
                type="button"
                onClick={() => startProvider(provider)}
              >
                <ProviderIcon id={provider.id} />
                <span>Continue with {provider.label}</span>
                {pendingProvider === provider.id && <small>Checking</small>}
              </button>
            ))}
            {message && <div className="dialog-message">{message}</div>}
            <div className="divider">OR</div>
            <div className="login-method-switch">
              <button className={loginMethod === "code" ? "active" : ""} onClick={() => { setLoginMethod("code"); setMessage(""); }} type="button">Email code</button>
              <button className={loginMethod === "password" ? "active" : ""} onClick={() => { setLoginMethod("password"); setMessage(""); }} type="button">Password</button>
            </div>
            {loginMethod === "code" && (emailStep === "email" ? (
              <>
                <input
                  type="email"
                  placeholder="Email address"
                  aria-label="Email address"
                  onChange={(event) => setEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") continueEmail();
                  }}
                  value={email}
                />
                <button
                  className="continue-button"
                  type="button"
                  onClick={continueEmail}
                >
                  {pendingProvider === "email" ? "Checking" : "Continue"}
                </button>
              </>
            ) : (
              <div className="email-code-step">
                <div className="email-code-target">
                  <span>{challenge?.maskedEmail || email}</span>
                  <button type="button" onClick={editEmail}>Edit</button>
                </div>
                {devCode && (
                  <div className="dev-code-note">
                    Development code: <strong>{devCode}</strong>
                  </div>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Code"
                  aria-label="Sign-in code"
                  autoComplete="one-time-code"
                  onChange={(event) => setCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") verifyEmailCode();
                  }}
                  value={code}
                />
                <button
                  className="continue-button"
                  type="button"
                  onClick={verifyEmailCode}
                >
                  {pendingProvider === "email" ? "Checking" : "Continue"}
                </button>
              </div>
            ))}
            {loginMethod === "password" && passwordStep === "login" && (
              <div className="email-code-step">
                <div className="password-login-note">Use a verified email or Hive handle. Enable password login first under Settings → Security after signing in with a connected provider.</div>
                <input type="text" autoComplete="username" placeholder="Verified email or Hive handle" aria-label="Verified email or Hive handle" onChange={(event) => setEmail(event.target.value)} value={email} />
                <input type="password" autoComplete="current-password" placeholder="Account password" aria-label="Account password" onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitPasswordLogin(); }} value={password} />
                <button className="continue-button" disabled={pendingProvider === "password"} onClick={submitPasswordLogin} type="button">{pendingProvider === "password" ? "Checking" : "Continue"}</button>
                <button className="login-text-button" onClick={startPasswordReset} type="button">Forgot password?</button>
              </div>
            )}
            {loginMethod === "password" && passwordStep === "reset" && (
              <div className="email-code-step">
                <div className="email-code-target"><span>{challenge?.maskedEmail || email}</span><button onClick={() => setPasswordStep("login")} type="button">Cancel</button></div>
                {challenge?.delivery?.devCode && <div className="dev-code-note">Development code: <strong>{challenge.delivery.devCode}</strong></div>}
                <input autoComplete="one-time-code" inputMode="numeric" onChange={(event) => setCode(event.target.value)} placeholder="Reset code" value={code} />
                <input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} placeholder="New password (12+ characters)" type="password" value={password} />
                <input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" type="password" value={confirmPassword} />
                <button className="continue-button" disabled={pendingProvider === "password"} onClick={verifyPasswordReset} type="button">{pendingProvider === "password" ? "Saving" : "Reset password"}</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function ProviderIcon({ id }) {
  if (id === "github") return <Github size={20} strokeWidth={1.9} />;
  if (id === "telegram") return <span className="provider-icon telegram">T</span>;
  if (id === "discord") return <span className="provider-icon discord">D</span>;
  return <span className="provider-icon x-provider">X</span>;
}
