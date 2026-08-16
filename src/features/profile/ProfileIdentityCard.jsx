import { useEffect, useState } from "react";
import { requestJson } from "../../api";

const C = {
  paper3: "#FFFCF5",
  ink: "#1F1B16",
  ink3: "#6B6052",
  ink4: "#9B9081",
  ruleSoft: "#EFE7D6",
};

function SectionHead({ eyebrow, sub }) {
  return (
    <div style={{
      alignItems: "baseline",
      borderBottom: `1px solid ${C.ruleSoft}`,
      display: "flex",
      justifyContent: "space-between",
      marginBottom: 28,
      paddingBottom: 14,
    }}>
      <div>
        <div className="tn-eyebrow">{eyebrow}</div>
        {sub && <div style={{ color: C.ink3, fontSize: 13, marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

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
    <section style={{ paddingTop: 44 }}>
      <SectionHead eyebrow="Hive identity" sub={identity.hiveHandle ? `@${identity.hiveHandle}` : "Choose a public handle"} />
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto" }}>
          <ProfileIdentityInput label="Handle" onChange={setHandle} placeholder="public-handle" value={handle} />
          <ProfileIdentityInput label="Display name" onChange={setDisplayName} placeholder={handle ? `@${handle.replace(/^@+/, "")}` : "Optional"} value={displayName} />
          <button className="tn-btn tn-btn-primary" disabled={pending === "handle"} onClick={saveHandle} style={{ alignSelf: "end", justifyContent: "center", minHeight: 40, padding: "0 16px" }} type="button">
            {pending === "handle" ? "Saving" : "Save"}
          </button>
        </div>
        {identity.suggestions?.length > 0 && !identity.hiveHandle && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {identity.suggestions.map((suggestion) => (
              <button className="tn-btn" key={suggestion} onClick={() => setHandle(suggestion)} type="button">@{suggestion}</button>
            ))}
          </div>
        )}
        {aliases.length > 0 && (
          <div style={{ borderTop: `1px solid ${C.ruleSoft}`, display: "grid", marginTop: 8 }}>
            {aliases.map((alias) => (
              <ProfileIdentityAliasRow alias={alias} key={alias.provider} pending={pending === alias.provider} saveAlias={saveAlias} />
            ))}
          </div>
        )}
        {message && <div style={{ color: C.ink3, fontSize: 13 }}>{message}</div>}
      </div>
    </section>
  );
}

function ProfileIdentityInput({ label, onChange, placeholder, value }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span className="tn-eyebrow">{label}</span>
      <input
        autoCapitalize="none"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          background: C.paper3,
          border: `1px solid ${C.ruleSoft}`,
          borderRadius: 10,
          color: C.ink,
          font: "inherit",
          minHeight: 40,
          padding: "0 12px",
        }}
        value={value}
      />
    </label>
  );
}

function ProfileIdentityAliasRow({ alias, pending, saveAlias }) {
  const publicAlias = alias.visibility === "public";
  return (
    <div style={{ alignItems: "center", borderBottom: `1px solid ${C.ruleSoft}`, display: "grid", gap: 12, gridTemplateColumns: "1fr auto auto", minHeight: 54 }}>
      <div>
        <div style={{ color: C.ink, fontSize: 13.5, fontWeight: 600 }}>{alias.label}</div>
        <div style={{ color: C.ink4, fontSize: 12 }}>{alias.username ? `@${alias.username}` : "Verified account"}</div>
      </div>
      <button
        className="tn-btn"
        disabled={pending}
        onClick={() => saveAlias(alias, {
          visibility: publicAlias ? "private" : "public",
          discloseHandle: !publicAlias && alias.canDiscloseHandle,
          discloseVerifiedBadge: !publicAlias,
        })}
        type="button"
      >
        {publicAlias ? "Public" : "Private"}
      </button>
      <button
        className="tn-btn"
        disabled={pending || !publicAlias || !alias.canDiscloseHandle}
        onClick={() => saveAlias(alias, { discloseHandle: !alias.discloseHandle })}
        type="button"
      >
        {alias.discloseHandle ? "Handle shown" : "Handle hidden"}
      </button>
    </div>
  );
}

