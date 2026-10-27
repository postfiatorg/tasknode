import { useEffect, useState } from "react";
import { requestJson } from "../../api";
import { PublicProfile } from "./PublicProfileView.jsx";
import { PrivateProfile } from "./ProfileIdentityPanels.jsx";
import { C, useStylesheet } from "./profile-view-shared.jsx";
import "./profile.css";

export function ProfileView({
  accountId = "",
  linkedWalletAddress = "",
  onProfileIdentityChange,
  onProfileAvatarChange,
  onWalletUnlock,
  pftlExplorerUrl = "",
  profilePublic = true,
  profileTab = "private",
  session = null,
  setProfilePublic,
  setProfileTab,
  walletSecret = null,
  walletVault = {},
} = {}) {
  useStylesheet();
  const [localView, setLocalView] = useState(profileTab === "public" ? "public" : "private");
  const [visibilityState, setVisibilityState] = useState({
    error: "",
    loading: Boolean(accountId),
    saving: false,
    visibility: profilePublic ? "public" : "private",
  });
  const controlledView = typeof setProfileTab === "function";
  const view = controlledView ? (profileTab === "public" ? "public" : "private") : localView;
  const setView = (nextView) => {
    if (controlledView) {
      setProfileTab(nextView);
      return;
    }
    setLocalView(nextView);
  };
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setVisibilityState({
        error: "",
        loading: false,
        saving: false,
        visibility: profilePublic ? "public" : "private",
      });
      return () => {
        cancelled = true;
      };
    }
    setVisibilityState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/visibility").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const visibility = result.body?.visibility?.visibility === "private" ? "private" : "public";
        setVisibilityState({ error: "", loading: false, saving: false, visibility });
        if (typeof setProfilePublic === "function") setProfilePublic(visibility !== "private");
        return;
      }
      setVisibilityState((current) => ({
        ...current,
        error: result.body?.message || result.body?.error || "Profile visibility could not be loaded.",
        loading: false,
        saving: false,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, profilePublic, setProfilePublic]);
  const effectiveProfilePublic = visibilityState.visibility !== "private";
  const togglePublic = async () => {
    if (!accountId || visibilityState.saving) return;
    const nextVisibility = effectiveProfilePublic ? "private" : "public";
    setVisibilityState((current) => ({
      ...current,
      error: "",
      saving: true,
      visibility: nextVisibility,
    }));
    const result = await requestJson("/api/profile/visibility", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: nextVisibility }),
    });
    if (result.ok && result.body?.ok !== false) {
      const visibility = result.body?.visibility?.visibility === "private" ? "private" : "public";
      setVisibilityState({ error: "", loading: false, saving: false, visibility });
      if (typeof setProfilePublic === "function") setProfilePublic(visibility !== "private");
      return;
    }
    const previousVisibility = nextVisibility === "private" ? "public" : "private";
    setVisibilityState({
      error: result.body?.message || result.body?.error || "Profile visibility could not be saved.",
      loading: false,
      saving: false,
      visibility: previousVisibility,
    });
    if (typeof setProfilePublic === "function") setProfilePublic(previousVisibility !== "private");
  };

  const visibilityBusy = !accountId || visibilityState.saving || visibilityState.loading;
  return (
    <div className="route-scroll">
      <div className="tn-root" style={{ background: "var(--tn-bg)", minHeight: "100vh" }}>
      <div className="pf-page">
        <div className="pf-topbar">
          <div className="pf-tabs" role="tablist" aria-label="Profile view">
            <button aria-selected={view === "private"} onClick={() => setView("private")} role="tab" type="button">Your profile</button>
            <button aria-selected={view === "public"} onClick={() => setView("public")} role="tab" type="button">Public view</button>
          </div>
          <button
            className={`pf-visibility${effectiveProfilePublic ? " is-public" : ""}`}
            disabled={visibilityBusy}
            onClick={togglePublic}
            title={effectiveProfilePublic ? "Make your profile private" : "Make your profile public"}
            type="button"
          >
            <i aria-hidden="true" />
            {visibilityState.saving ? "Saving…" : effectiveProfilePublic ? "Profile is public" : "Profile is hidden"}
          </button>
        </div>
        {visibilityState.error && <p className="pf-note is-error">{visibilityState.error}</p>}

        <div className="tn-fadeIn" key={view}>
          {view === "private" ? (
            <PrivateProfile
              accountId={accountId}
              linkedWalletAddress={linkedWalletAddress}
              onProfileIdentityChange={onProfileIdentityChange}
              onProfileAvatarChange={onProfileAvatarChange}
              onWalletUnlock={onWalletUnlock}
              pftlExplorerUrl={pftlExplorerUrl}
              profilePublic={effectiveProfilePublic}
              session={session}
              walletSecret={walletSecret}
              walletVault={walletVault}
            />
          ) : (
            <PublicProfile accountId={accountId} profilePublic={effectiveProfilePublic} />
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

export function MemberProfileView({ accountId = "", onBack } = {}) {
  useStylesheet();
  return (
    <div className="route-scroll">
      <div className="tn-root" style={{ minHeight: "100vh" }}>
        <div style={{ maxWidth: 980, margin: "0 auto", padding: "34px 36px 140px" }}>
          <button
            className="tn-btn"
            onClick={onBack}
            style={{ marginBottom: 18, padding: 0 }}
            type="button"
          >
            Directory
          </button>
          {accountId ? (
            <PublicProfile accountId={accountId} profilePublic profileSource="member" />
          ) : (
            <div style={{ borderTop: `1px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 13.5, paddingTop: 18 }}>
              Choose a member from the Directory.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProfileView;
