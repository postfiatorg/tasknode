import { useEffect, useState } from "react";
import { requestJson } from "../../api";
import { ProviderIcon } from "../identity/ProviderIcon.jsx";

export function ProfileIdentityCard({ onProfileIdentityChange, session }) {
  const identity = session?.identityProfile || {};
  const aliases = identity.aliases || [];
  const [handle, setHandle] = useState(identity.hiveHandle || identity.suggestions?.[0] || "");
  const [displayName, setDisplayName] = useState(identity.publicDisplayName || "");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState("");

  useEffect(() => {
    setHandle(identity.hiveHandle || identity.suggestions?.[0] || "");
    setDisplayName(identity.publicDisplayName || "");
    setMessage("");
  }, [identity.accountId, identity.hiveHandle, identity.publicDisplayName, identity.suggestions]);

  if (!session?.accountId) return null;

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
      setMessage("Hive identity saved.");
      await onProfileIdentityChange?.();
    } catch (error) {
      setMessage(error?.message || "Hive identity could not be saved.");
    } finally {
      setPending("");
    }
  }

  async function saveAlias(alias, patch) {
    const nextVisibility = patch.visibility || alias.visibility || "private";
    setPending(alias.provider);
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
      await onProfileIdentityChange?.();
    } catch (error) {
      setMessage(error?.message || "Alias visibility could not be saved.");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h2>Identity</h2>
          <p>Your handle is how Hive, Messages and the Directory address you.</p>
        </div>
      </div>
      <div className="pf-identity-form">
        <ProfileIdentityInput label="Handle" onChange={setHandle} placeholder="public-handle" value={handle} />
        <ProfileIdentityInput label="Display name" onChange={setDisplayName} placeholder={handle ? `@${handle.replace(/^@+/, "")}` : "Optional"} value={displayName} />
        <button className="pf-button is-primary" disabled={pending === "handle"} onClick={saveHandle} style={{ minHeight: 34 }} type="button">
          {pending === "handle" ? "Saving…" : "Save"}
        </button>
      </div>
      {identity.suggestions?.length > 0 && !identity.hiveHandle && (
        <div className="pf-studio-actions">
          {identity.suggestions.map((suggestion) => (
            <button className="pf-text-button" key={suggestion} onClick={() => setHandle(suggestion)} type="button">@{suggestion}</button>
          ))}
        </div>
      )}
      {aliases.length > 0 && (
        <div>
          {aliases.map((alias) => (
            <ProfileIdentityAliasRow alias={alias} key={alias.provider} pending={pending === alias.provider} saveAlias={saveAlias} />
          ))}
        </div>
      )}
      {message && <p className="pf-note">{message}</p>}
    </section>
  );
}

function ProfileIdentityInput({ label, onChange, placeholder, value }) {
  return (
    <label className="pf-field">
      <span>{label}</span>
      <input
        autoCapitalize="none"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        value={value}
      />
    </label>
  );
}

function ProfileIdentityAliasRow({ alias, pending, saveAlias }) {
  const publicAlias = alias.visibility === "public";
  const handleToggleDisabled = pending || !publicAlias || !alias.canDiscloseHandle;
  return (
    <div className="pf-alias">
      <ProviderIcon id={String(alias.provider || "").toLowerCase() === "twitter" ? "x" : String(alias.provider || "").toLowerCase()} />
      <div>
        <strong>{alias.label}</strong>
        <small>{alias.username ? `@${alias.username}` : "Verified account"}</small>
      </div>
      <label className={`pf-check${pending ? " is-disabled" : ""}`}>
        <input
          checked={publicAlias}
          disabled={pending}
          onChange={() => saveAlias(alias, {
            visibility: publicAlias ? "private" : "public",
            discloseHandle: !publicAlias && alias.canDiscloseHandle,
            discloseVerifiedBadge: !publicAlias,
          })}
          type="checkbox"
        />
        Show on public profile
      </label>
      <label className={`pf-check${handleToggleDisabled ? " is-disabled" : ""}`}>
        <input
          checked={publicAlias && Boolean(alias.discloseHandle)}
          disabled={handleToggleDisabled}
          onChange={() => saveAlias(alias, { discloseHandle: !alias.discloseHandle })}
          type="checkbox"
        />
        Show handle
      </label>
    </div>
  );
}
