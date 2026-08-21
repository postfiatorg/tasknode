import { useEffect, useState } from "react";
import { requestJson } from "../../api";
import { PublicProfile } from "./PublicProfileView.jsx";
import { PrivateProfile } from "./ProfileIdentityPanels.jsx";
import { C, SANS, useStylesheet } from "./profile-view-shared.jsx";

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

  return (
    <div className="route-scroll">
      <div className="tn-root" style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "40px 36px 140px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <button
              className={`tn-tab ${view === "private" ? "tn-tab-active" : ""}`}
              onClick={() => setView("private")}
            >Private</button>
            <button
              className={`tn-tab ${view === "public" ? "tn-tab-active" : ""}`}
              onClick={() => setView("public")}
            >Public</button>
          </div>

          <button
            onClick={togglePublic}
            disabled={!accountId || visibilityState.saving || visibilityState.loading}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: effectiveProfilePublic ? C.success : C.ink4,
              cursor: !accountId || visibilityState.saving || visibilityState.loading ? "default" : "pointer",
              display: "inline-flex",
              fontFamily: SANS,
              fontSize: 13,
              fontWeight: 500,
              gap: 7,
              padding: 0,
            }}
            type="button"
          >
            <span
              className="tn-pulseGreen"
              style={{ background: effectiveProfilePublic ? C.success : C.ink5 }}
            />
            {visibilityState.saving ? "Saving..." : effectiveProfilePublic ? "Profile public" : "Profile hidden"}
          </button>
        </div>
        {visibilityState.error && (
          <div style={{ color: C.rust, fontSize: 12.5, marginBottom: 12, textAlign: "right" }}>
            {visibilityState.error}
          </div>
        )}

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
