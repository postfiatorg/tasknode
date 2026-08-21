import { useEffect, useState } from "react";
import { Github, X } from "lucide-react";
import { requestJson } from "../../api";
import "./identity.css";

function ProviderIcon({ id }) {
  if (id === "github") return <Github size={20} strokeWidth={1.9} />;
  if (id === "telegram") return <span className="provider-icon telegram">T</span>;
  if (id === "discord") return <span className="provider-icon discord">D</span>;
  return <span className="provider-icon x-provider">X</span>;
}

function ToggleSwitch({ checked, disabled = false, initial, onChange }) {
  const controlled = checked !== undefined;
  const [on, setOn] = useState(Boolean(initial));
  const value = controlled ? Boolean(checked) : on;
  function toggle() {
    if (disabled) return;
    const nextValue = !value;
    if (!controlled) setOn(nextValue);
    onChange?.(nextValue);
  }
  return (
    <button
      aria-pressed={value}
      className={value ? "toggle-switch on" : "toggle-switch"}
      disabled={disabled}
      onClick={toggle}
      type="button"
    >
      <span />
    </button>
  );
}

export function IdentitySettings({ onAppStateChange, session }) {
  const identity = session?.identityProfile || {};
  const [handle, setHandle] = useState(identity.hiveHandle || identity.suggestions?.[0] || "");
  const [displayName, setDisplayName] = useState(identity.publicDisplayName || "");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState("");
  const aliases = identity.aliases || [];

  useEffect(() => {
    setHandle(identity.hiveHandle || identity.suggestions?.[0] || "");
    setDisplayName(identity.publicDisplayName || "");
    setMessage("");
  }, [identity.accountId, identity.hiveHandle, identity.publicDisplayName, identity.suggestions]);

  async function saveHandle() {
    const nextHandle = handle.trim().replace(/^@+/, "");
    if (!nextHandle) {
      setMessage("Choose a Hive handle.");
      return;
    }
    setPending("handle");
    setMessage("");
    try {
      const result = await requestJson("/api/profile/handle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: nextHandle, displayName }),
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Hive handle could not be saved.");
      }
      setMessage("Hive handle saved.");
      await onAppStateChange?.();
    } catch (error) {
      setMessage(error?.message || "Hive handle could not be saved.");
    } finally {
      setPending("");
    }
  }

  async function updateAlias(alias, patch) {
    const nextVisibility = patch.visibility || alias.visibility || "private";
    setPending(`alias-${alias.provider}`);
    setMessage("");
    try {
      const result = await requestJson("/api/profile/identity/alias", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: alias.provider,
          visibility: nextVisibility,
          discloseHandle: nextVisibility === "public" && (patch.discloseHandle ?? alias.discloseHandle) === true,
          discloseVerifiedBadge:
            nextVisibility === "public" &&
            (patch.discloseVerifiedBadge ?? alias.discloseVerifiedBadge) === true,
        }),
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Alias visibility could not be saved.");
      }
      setMessage("Alias visibility saved.");
      await onAppStateChange?.();
    } catch (error) {
      setMessage(error?.message || "Alias visibility could not be saved.");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="identity-settings">
      <div className="connected-heading">
        <strong>Hive identity</strong>
        <span>{identity.hiveHandle ? `@${identity.hiveHandle}` : "handle required"}</span>
      </div>
      <div className="identity-handle-form">
        <label>
          <span>Hive handle</span>
          <input autoCapitalize="none" autoComplete="off" onChange={(event) => setHandle(event.target.value)} placeholder="public-handle" spellCheck={false} value={handle} />
        </label>
        <label>
          <span>Display name</span>
          <input autoComplete="off" onChange={(event) => setDisplayName(event.target.value)} placeholder={handle ? `@${handle.replace(/^@+/, "")}` : "Optional"} value={displayName} />
        </label>
        <button disabled={pending === "handle"} onClick={saveHandle} type="button">
          {pending === "handle" ? "Saving" : "Save"}
        </button>
      </div>
      {identity.suggestions?.length > 0 && !identity.hiveHandle && (
        <div className="identity-suggestions">
          {identity.suggestions.map((suggestion) => (
            <button key={suggestion} onClick={() => setHandle(suggestion)} type="button">@{suggestion}</button>
          ))}
        </div>
      )}
      {aliases.length > 0 && (
        <div className="identity-aliases">
          {aliases.map((alias) => (
            <IdentityAliasRow alias={alias} key={alias.provider} onChange={updateAlias} pending={pending === `alias-${alias.provider}`} />
          ))}
        </div>
      )}
      {message && <div className="inline-message">{message}</div>}
    </section>
  );
}

function IdentityAliasRow({ alias, onChange, pending }) {
  const publicAlias = alias.visibility === "public";
  return (
    <div className="identity-alias-row">
      <span className="connected-provider-icon"><ProviderIcon id={alias.provider} /></span>
      <div>
        <strong>{alias.label}</strong>
        <small>{alias.username ? `@${alias.username}` : "Verified account"}</small>
      </div>
      <label className="identity-toggle">
        <span>Public</span>
        <ToggleSwitch
          checked={publicAlias}
          disabled={pending}
          onChange={(checked) => onChange(alias, {
            visibility: checked ? "public" : "private",
            discloseHandle: checked && alias.canDiscloseHandle,
            discloseVerifiedBadge: checked,
          })}
        />
      </label>
      <label className="identity-toggle">
        <span>Handle</span>
        <ToggleSwitch
          checked={publicAlias && alias.discloseHandle}
          disabled={pending || !publicAlias || !alias.canDiscloseHandle}
          onChange={(checked) => onChange(alias, { discloseHandle: checked })}
        />
      </label>
    </div>
  );
}

export function IdentityHandleDialog({ onClose, onSaved, session }) {
  const identity = session?.identityProfile || {};
  const aliases = (identity.aliases || []).filter((alias) => alias?.provider && alias.canDiscloseHandle);
  const firstAlias = aliases[0] || null;
  const [handle, setHandle] = useState(identity.hiveHandle || identity.suggestions?.[0] || "");
  const [displayName, setDisplayName] = useState(identity.publicDisplayName || "");
  const [providerId, setProviderId] = useState(firstAlias?.provider || "");
  const [showProvider, setShowProvider] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setHandle(identity.hiveHandle || identity.suggestions?.[0] || "");
    setDisplayName(identity.publicDisplayName || "");
    setProviderId(firstAlias?.provider || "");
    setShowProvider(false);
    setMessage("");
  }, [firstAlias?.provider, identity.accountId, identity.hiveHandle, identity.publicDisplayName, identity.suggestions]);

  async function saveIdentity() {
    const nextHandle = handle.trim().replace(/^@+/, "");
    if (!nextHandle) {
      setMessage("Choose a Hive handle.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const handleResult = await requestJson("/api/profile/handle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: nextHandle, displayName }),
      });
      if (!handleResult.ok || !handleResult.body?.ok) {
        throw new Error(handleResult.body?.message || handleResult.body?.error || "Hive handle could not be saved.");
      }
      if (showProvider && providerId) {
        const aliasResult = await requestJson("/api/profile/identity/alias", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: providerId, visibility: "public", discloseHandle: true, discloseVerifiedBadge: true }),
        });
        if (!aliasResult.ok || !aliasResult.body?.ok) {
          throw new Error(aliasResult.body?.message || aliasResult.body?.error || "Provider alias could not be saved.");
        }
      }
      await onSaved?.();
      onClose?.();
    } catch (error) {
      setMessage(error?.message || "Hive identity could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="login-dialog identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close"><X size={18} strokeWidth={2} /></button>
        <h2 id="identity-title">Choose Hive handle</h2>
        <p>Your provider account stays private unless you show it.</p>
        <label className="identity-dialog-field">
          <span>Hive handle</span>
          <input autoCapitalize="none" autoComplete="off" onChange={(event) => setHandle(event.target.value)} placeholder="public-handle" spellCheck={false} value={handle} />
        </label>
        <label className="identity-dialog-field">
          <span>Display name</span>
          <input autoComplete="off" onChange={(event) => setDisplayName(event.target.value)} placeholder={handle ? `@${handle.replace(/^@+/, "")}` : "Optional"} value={displayName} />
        </label>
        {identity.suggestions?.length > 0 && (
          <div className="identity-suggestions">
            {identity.suggestions.map((suggestion) => (
              <button key={suggestion} onClick={() => setHandle(suggestion)} type="button">@{suggestion}</button>
            ))}
          </div>
        )}
        {aliases.length > 0 && (
          <div className="identity-dialog-alias">
            <label className="identity-toggle">
              <span>Show verified provider</span>
              <ToggleSwitch checked={showProvider} onChange={setShowProvider} />
            </label>
            {showProvider && (
              <select onChange={(event) => setProviderId(event.target.value)} value={providerId}>
                {aliases.map((alias) => (
                  <option key={alias.provider} value={alias.provider}>{alias.label} @{alias.username}</option>
                ))}
              </select>
            )}
          </div>
        )}
        {message && <div className="dialog-message">{message}</div>}
        <button className="continue-button" disabled={pending} onClick={saveIdentity} type="button">
          {pending ? "Saving" : "Save handle"}
        </button>
      </section>
    </div>
  );
}

