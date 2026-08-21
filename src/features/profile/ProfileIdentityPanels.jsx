import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { requestJson } from "../../api";
import { ProfileIdentityCard } from "./ProfileIdentityCard.jsx";
import { TodaysBriefing, latestAvatarNft } from "./ProfileBriefing.jsx";
import { ConnectionsCard } from "./ProfileConnections.jsx";
import { NFTGallery, PFTTimeseries, ProfileStudio } from "./ProfileStudioPanels.jsx";
import {
  C,
  SectionHead,
  fmtN,
  identityApprovalBadges,
} from "./profile-view-shared.jsx";

export function NetworkBadgesPanel({ session = null } = {}) {
  const [xRefreshState, setXRefreshState] = useState({ pending: false, message: "" });
  const [githubRefreshState, setGithubRefreshState] = useState({ pending: false, message: "" });
  const [discordRefreshState, setDiscordRefreshState] = useState({ pending: false, message: "" });
  const [badgeRefreshState, setBadgeRefreshState] = useState({ pending: false, message: "" });
  const [networkBadgeState, setNetworkBadgeState] = useState({ pending: false, message: "", state: null });
  const [badgeActionState, setBadgeActionState] = useState({});
  const sessionExpertAccess = session?.identityProfile?.expertAccess || {};
  const [expertAccessOverride, setExpertAccessOverride] = useState(null);
  const [expertTopicInput, setExpertTopicInput] = useState(sessionExpertAccess.topic || "");
  const [expertEvalState, setExpertEvalState] = useState({ pending: false, message: "" });
  const expertAccess = expertAccessOverride || sessionExpertAccess;
  const projectLeaderAccess = session?.identityProfile?.projectLeaderAccess || {};
  const aliases = Array.isArray(session?.identityProfile?.aliases) ? session.identityProfile.aliases : [];
  const durableBadges = Array.isArray(networkBadgeState.state?.badges) ? networkBadgeState.state.badges : [];
  const durableBadgeFor = (badgeId = "") => durableBadges.find((badge) => badge.badgeId === badgeId && badge.status === "verified");
  const providerAliases = {
    x: ["x", "twitter"],
    github: ["github"],
    discord: ["discord"],
    telegram: ["telegram"],
  };
  const providerLabel = (provider = "") => ({ x: "X", github: "GitHub", discord: "Discord", telegram: "Telegram" }[provider] || provider || "identity");
  const aliasForProvider = (provider = "") => {
    const accepted = providerAliases[provider] || [provider];
    return aliases.find((alias) => accepted.includes(String(alias.provider || "").toLowerCase()));
  };
  const linked = (provider = "") => Boolean(aliasForProvider(provider));
  const verifiedLinked = (provider = "") => Boolean(aliasForProvider(provider)?.verified);
  useEffect(() => {
    setExpertAccessOverride(null);
    setExpertTopicInput(sessionExpertAccess.topic || "");
  }, [sessionExpertAccess.topic, sessionExpertAccess.reviewedAt]);
  useEffect(() => {
    let cancelled = false;
    async function loadNetworkBadgeState() {
      if (!session?.accountId) {
        setNetworkBadgeState({ pending: false, message: "", state: null });
        return;
      }
      setNetworkBadgeState((current) => ({ ...current, pending: true, message: "" }));
      try {
        const result = await requestJson("/api/profile/network-badges");
        if (cancelled) return;
        setNetworkBadgeState({
          pending: false,
          message: result.ok ? "" : result.body?.message || result.body?.error || `Badge state returned HTTP ${result.status}.`,
          state: result.body?.state || null,
        });
      } catch (error) {
        if (!cancelled) {
          setNetworkBadgeState({ pending: false, message: error?.message || "Network badge state could not load.", state: null });
        }
      }
    }
    loadNetworkBadgeState();
    return () => {
      cancelled = true;
    };
  }, [session?.accountId]);
  const coreContributorAccessFor = (provider = "") => {
    const access = aliasForProvider(provider)?.metrics?.coreContributorAccess;
    return access && typeof access === "object" && !Array.isArray(access) ? access : {};
  };
  const metricValue = (requirement = {}) => {
    const alias = aliasForProvider(requirement.metricProvider || requirement.provider || "");
    return Number(alias?.metrics?.[requirement.metric]);
  };
  const requirementFulfilled = (requirement = {}) => {
    if (requirement.always) return true;
    if (requirement.projectLeader) {
      return projectLeaderAccess.eligible === true;
    }
    if (requirement.qaTopUp === "usdc") {
      return session?.identityProfile?.qaWorkerAccess?.usdcTopUp === true;
    }
    if (requirement.personalTaskCount) {
      return Number(expertAccess.personalTaskCount || 0) >= Number(requirement.personalTaskCount || 0);
    }
    if (requirement.expertTopic) {
      return Boolean(String(expertTopicInput || expertAccess.topic || "").trim());
    }
    if (requirement.expertScore) {
      return expertAccess.eligible === true &&
        expertAccess.reviewCurrent === true &&
        Number(expertAccess.score || 0) >= Number(requirement.expertScore || 0);
    }
    if (requirement.coreContributor === "sanctioned") {
      const access = coreContributorAccessFor(requirement.provider);
      return access.sanctioned === true;
    }
    if (requirement.coreContributorScope) {
      const access = coreContributorAccessFor(requirement.provider);
      return access.scopeRecorded === true;
    }
    if (requirement.metric) {
      const value = metricValue(requirement);
      return Number.isFinite(value) && value >= Number(requirement.min || 0);
    }
    return Boolean(requirement.provider && linked(requirement.provider));
  };
  const requirementText = (requirement = {}) => {
    if (requirement.metric === "followersCount") {
      const value = metricValue(requirement);
      if (Number.isFinite(value)) {
        return `${fmtN(value)} X followers (${fmtN(requirement.min || 0)}+ required)`;
      }
      return "X follower count needs refresh";
    }
    if (requirement.qaTopUp === "usdc") {
      const access = session?.identityProfile?.qaWorkerAccess || {};
      return access.usdcTopUp ? "USDC chat wallet top-up recorded" : "USDC chat wallet top-up required";
    }
    if (requirement.personalTaskCount) {
      return `${fmtN(expertAccess.personalTaskCount || 0)} / ${fmtN(requirement.personalTaskCount)} completed Personal tasks`;
    }
    if (requirement.expertTopic) {
      const topic = String(expertTopicInput || expertAccess.topic || "").trim();
      return topic ? `Expert topic: ${topic}` : "Enter the topic you want Expert rewards in";
    }
    if (requirement.expertScore) {
      if (expertAccess.reviewedAt) {
        return `${fmtN(expertAccess.score || 0)} / 100 GLM 5.2 expertise score (${fmtN(requirement.expertScore)}+ required)`;
      }
      return "Run GLM 5.2 review over last 20 Personal tasks";
    }
    if (requirement.projectLeader) {
      if (projectLeaderAccess.eligible) {
        return `@${projectLeaderAccess.matchedHandle || projectLeaderAccess.handle} has discretionary Project Leader approval`;
      }
      return "Discretionary approval by Post Fiat";
    }
    if (requirement.coreContributor === "sanctioned") {
      const access = coreContributorAccessFor(requirement.provider);
      if (access.sanctioned) {
        return `${access.username || "GitHub handle"} is sanctioned for Core Contributor work`;
      }
      return access.checkedAt ? "GitHub handle is not on the sanctioned Core Contributor list" : requirement.label;
    }
    if (requirement.coreContributorScope) {
      const access = coreContributorAccessFor(requirement.provider);
      return access.scopeRecorded ? "Core Contributor scope recorded from GitHub handle" : requirement.label;
    }
    return requirement.label;
  };
  const completedCount = (requirements = []) => requirements.filter(requirementFulfilled).length;
  const statusFor = (badge) => {
    const providerRequirements = badge.requirements.filter((requirement) => requirement.provider && !requirement.metric);
    const missingProvider = providerRequirements.find((requirement) => !linked(requirement.provider));
    if (missingProvider) {
      return { label: `Needs ${providerLabel(missingProvider.provider)}`, color: C.warning, tone: "missing" };
    }
    const unverifiedProvider = providerRequirements.find((requirement) => !verifiedLinked(requirement.provider));
    if (unverifiedProvider) {
      return { label: `Verify ${providerLabel(unverifiedProvider.provider)}`, color: C.ink3, tone: "proof" };
    }
    const missingMetric = badge.requirements.find((requirement) => requirement.metric && !requirementFulfilled(requirement));
    if (missingMetric?.metric === "followersCount") {
      const value = metricValue(missingMetric);
      return {
        label: Number.isFinite(value) ? "Below threshold" : "Refresh X proof",
        color: Number.isFinite(value) ? C.warning : C.ink3,
        tone: "proof",
      };
    }
    const missingCoreProof = badge.requirements.find((requirement) => (
      (requirement.coreContributor || requirement.coreContributorScope) && !requirementFulfilled(requirement)
    ));
    if (badge.id === "core_contributor" && missingCoreProof) {
      const access = coreContributorAccessFor("github");
      return {
        label: access.checkedAt ? "Not sanctioned" : "Refresh GitHub proof",
        color: access.checkedAt ? C.warning : C.ink3,
        tone: "proof",
      };
    }
    const missingQaTopUp = badge.requirements.find((requirement) => (
      requirement.qaTopUp && !requirementFulfilled(requirement)
    ));
    if (badge.id === "qa_worker" && missingQaTopUp) {
      return { label: "Needs USDC", color: C.warning, tone: "proof" };
    }
    if (badge.id === "expert") {
      if (Number(expertAccess.personalTaskCount || 0) < Number(expertAccess.requiredPersonalTaskCount || 20)) {
        return { label: "Needs tasks", color: C.warning, tone: "missing" };
      }
      if (!String(expertTopicInput || expertAccess.topic || "").trim()) {
        return { label: "Enter topic", color: C.warning, tone: "missing" };
      }
      if (expertEvalState.pending) {
        return { label: "Evaluating", color: C.ink3, tone: "proof" };
      }
      if (expertAccess.eligible === true) {
        return { label: "Ready", color: C.success, tone: "ready" };
      }
      if (expertAccess.status === "stale_review") {
        return { label: "Re-run review", color: C.warning, tone: "proof" };
      }
      if (expertAccess.reviewedAt) {
        return { label: "Score low", color: C.warning, tone: "proof" };
      }
      return { label: "Run review", color: C.ink3, tone: "proof" };
    }
    if (badge.id === "project_leader") {
      return projectLeaderAccess.eligible === true
        ? { label: "Ready", color: C.success, tone: "ready" }
        : { label: "Discretionary", color: C.ink3, tone: "proof" };
    }
    if (completedCount(badge.requirements) >= badge.requirements.length) {
      return { label: "Ready", color: C.success, tone: "ready" };
    }
    return { label: "Needs proof", color: C.ink3, tone: "proof" };
  };
  const topAliases = aliases.filter((alias) => ["x", "twitter", "github", "discord", "telegram"].includes(String(alias.provider || "").toLowerCase()));
  const xAlias = aliasForProvider("x");
  const xFollowerCount = Number(xAlias?.metrics?.followersCount);
  const xFollowerMetricsPresent = Number.isFinite(xFollowerCount);
  const githubAlias = aliasForProvider("github");
  const githubAccess = coreContributorAccessFor("github");
  const githubAccessPresent = Boolean(githubAccess.checkedAt) || Number(githubAccess.accessCount || 0) > 0;
  const discordAlias = aliasForProvider("discord");
  const expertCanEvaluate = Number(expertAccess.personalTaskCount || 0) >= Number(expertAccess.requiredPersonalTaskCount || 20) &&
    String(expertTopicInput || "").trim().length >= 3 &&
    !expertEvalState.pending;

  async function refreshXProof() {
    setXRefreshState({ pending: true, message: "" });
    try {
      const result = await requestJson(`/api/auth/start/x?redirect=${encodeURIComponent("/#profile")}`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setXRefreshState({
        pending: false,
        message: result.body?.message || result.body?.actionRequired || `X returned HTTP ${result.status}.`,
      });
    } catch (error) {
      setXRefreshState({ pending: false, message: error?.message || "X refresh could not start." });
    }
  }

  async function refreshGithubProof() {
    setGithubRefreshState({ pending: true, message: "" });
    try {
      const result = await requestJson(`/api/auth/start/github?redirect=${encodeURIComponent("/#profile")}&proof=core_contributor`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setGithubRefreshState({
        pending: false,
        message: result.body?.message || result.body?.actionRequired || `GitHub returned HTTP ${result.status}.`,
      });
    } catch (error) {
      setGithubRefreshState({ pending: false, message: error?.message || "GitHub proof refresh could not start." });
    }
  }

  async function refreshDiscordProof() {
    setDiscordRefreshState({ pending: true, message: "" });
    try {
      const result = await requestJson(`/api/auth/start/discord?redirect=${encodeURIComponent("/#profile")}`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setDiscordRefreshState({
        pending: false,
        message: result.body?.message || result.body?.actionRequired || `Discord returned HTTP ${result.status}.`,
      });
    } catch (error) {
      setDiscordRefreshState({ pending: false, message: error?.message || "Discord link could not start." });
    }
  }

  async function evaluateExpertProof() {
    const topic = String(expertTopicInput || "").trim();
    setExpertEvalState({ pending: true, message: "" });
    try {
      const result = await requestJson("/api/profile/expert/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (result.body?.expertAccess) setExpertAccessOverride(result.body.expertAccess);
      setExpertEvalState({
        pending: false,
        message: result.ok
          ? result.body?.expertAccess?.eligible
            ? "Expert badge verified."
            : "Expert review completed below threshold."
          : result.body?.message || result.body?.error || `Expert review returned HTTP ${result.status}.`,
      });
    } catch (error) {
      setExpertEvalState({ pending: false, message: error?.message || "Expert review could not start." });
    }
  }

  async function refreshNetworkBadgeState() {
    setBadgeRefreshState({ pending: true, message: "" });
    try {
      const result = await requestJson("/api/profile/network-badges/refresh", { method: "POST" });
      const badgeCount = Array.isArray(result.body?.materialized?.badgeIds) ? result.body.materialized.badgeIds.length : 0;
      if (result.body?.state) {
        setNetworkBadgeState({ pending: false, message: "", state: result.body.state });
      }
      setBadgeRefreshState({
        pending: false,
        message: result.ok
          ? `Synced ${fmtN(badgeCount)} verified badge${badgeCount === 1 ? "" : "s"} into routing state.`
          : result.body?.message || result.body?.error || `Badge sync returned HTTP ${result.status}.`,
      });
    } catch (error) {
      setBadgeRefreshState({ pending: false, message: error?.message || "Network badge sync failed." });
    }
  }

  async function selectDefaultBadge(badge = {}) {
    setBadgeActionState((current) => ({ ...current, [badge.id]: { pending: true, message: "" } }));
    try {
      const result = await requestJson("/api/profile/network-badges/default", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ badgeId: badge.id }),
      });
      if (result.body?.state) {
        setNetworkBadgeState({ pending: false, message: "", state: result.body.state });
      }
      setBadgeActionState((current) => ({
        ...current,
        [badge.id]: {
          pending: false,
          message: result.ok ? "Default routing badge updated." : result.body?.message || result.body?.error || `Default update returned HTTP ${result.status}.`,
        },
      }));
    } catch (error) {
      setBadgeActionState((current) => ({
        ...current,
        [badge.id]: { pending: false, message: error?.message || "Default badge update failed." },
      }));
    }
  }

  return (
    <section style={{ paddingTop: 44 }}>
      <SectionHead
        eyebrow="Network badges"
        sub="Pilot badges for Network Task routing: KOL amplification, Core Contributor repo work, Expert bundles, Project Leader project authority, and QA Worker product reports."
      />

      <div style={{ display: "grid", gap: 18 }}>
        <div style={{
          background: C.paper2,
          border: `1px solid ${C.ruleSoft}`,
          borderRadius: 8,
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          padding: 18,
        }}>
          <div>
            <div style={{ color: C.ink, fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
              Badge state
            </div>
            <div style={{ color: C.ink3, fontSize: 13.5, maxWidth: 540 }}>
              Link the matching account and sync. KOL uses X follower metrics; Core Contributor uses sanctioned GitHub handles; Project Leader is set manually by the core team; QA Worker requires Telegram, Discord, and one USDC chat wallet top-up.
            </div>
            <div style={{ color: C.ink4, fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
              {networkBadgeState.pending
                ? "Loading durable routing state."
                : networkBadgeState.state?.database?.enabled === false
                  ? "Durable badge database is not enabled in this environment."
                  : `${fmtN(durableBadges.filter((badge) => badge.status === "verified").length)} verified routing badge${durableBadges.filter((badge) => badge.status === "verified").length === 1 ? "" : "s"} recorded.`}
            </div>
            {networkBadgeState.message && (
              <div style={{ color: C.rust, fontSize: 12, lineHeight: 1.45, marginTop: 6 }}>
                {networkBadgeState.message}
              </div>
            )}
            <div style={{ display: "grid", gap: 7, marginTop: 12, maxWidth: 280 }}>
              <button
                className="tn-btn"
                disabled={badgeRefreshState.pending}
                onClick={refreshNetworkBadgeState}
                style={{ justifyContent: "center", minHeight: 34 }}
                type="button"
              >
                {badgeRefreshState.pending ? "Syncing..." : "Sync routing badges"}
              </button>
              {badgeRefreshState.message && (
                <div style={{
                  color: badgeRefreshState.message.startsWith("Synced") ? C.success : C.rust,
                  fontSize: 12,
                  lineHeight: 1.45,
                }}>
                  {badgeRefreshState.message}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {topAliases.length ? topAliases.map((alias) => (
              <IdentityProviderRow alias={alias} key={alias.provider} />
            )) : (
              <div style={{ color: C.ink4, fontSize: 13 }}>
                No X, GitHub, Telegram, or Discord identity is linked yet.
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}>
          {identityApprovalBadges.map((badge) => {
            const Icon = badge.icon;
            const status = statusFor(badge);
            const done = completedCount(badge.requirements);
            const total = badge.requirements.length || 1;
            const durableBadge = durableBadgeFor(badge.id);
            const actionState = badgeActionState[badge.id] || {};
            return (
              <div
                key={badge.id}
                style={{
                  background: C.paper3,
                  border: `1px solid ${status.tone === "ready" ? "rgba(92,140,79,.45)" : C.ruleSoft}`,
                  borderRadius: 8,
                  display: "grid",
                  gap: 14,
                  padding: 16,
                }}
              >
                <div style={{ alignItems: "start", display: "flex", gap: 12, justifyContent: "space-between" }}>
                  <div style={{ alignItems: "center", display: "flex", gap: 10, minWidth: 0 }}>
                    <span style={{
                      alignItems: "center",
                      background: C.paper2,
                      border: `1px solid ${C.ruleSoft}`,
                      borderRadius: 8,
                      color: C.ink2,
                      display: "inline-flex",
                      flex: "0 0 auto",
                      height: 34,
                      justifyContent: "center",
                      width: 34,
                    }}>
                      <Icon size={17} strokeWidth={1.9} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: C.ink, fontSize: 14.5, fontWeight: 700 }}>{badge.label}</div>
                      <div style={{ color: C.ink4, fontSize: 12 }}>{badge.lane}</div>
                    </div>
                  </div>
                  <span style={{
                    border: `1px solid ${C.ruleSoft}`,
                    borderRadius: 999,
                    color: status.color,
                    flex: "0 0 auto",
                    fontSize: 11.5,
                    fontWeight: 700,
                    padding: "3px 7px",
                  }}>
                    {status.label}
                  </span>
                </div>

                <div>
                  <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                    <span className="tn-eyebrow">Requirements</span>
                    <span style={{ color: C.ink4, fontSize: 12 }}>{done}/{total}</span>
                  </div>
                  <div className="tn-progressLine">
                    <span style={{ width: `${Math.max(8, Math.round((done / total) * 100))}%` }} />
                  </div>
                </div>

                <div style={{ display: "grid", gap: 7 }}>
                  {badge.requirements.map((requirement) => {
                    const fulfilled = requirementFulfilled(requirement);
                    const RequirementIcon = fulfilled ? CheckCircle2 : CircleDashed;
                    return (
                      <div
                        key={requirement.id}
                        style={{ alignItems: "center", color: fulfilled ? C.ink2 : C.ink4, display: "flex", fontSize: 12.5, gap: 8 }}
                      >
                        <RequirementIcon color={fulfilled ? C.success : C.ink5} size={14} strokeWidth={2} />
                        <span>{requirementText(requirement)}</span>
                      </div>
                    );
                  })}
                </div>

                <div style={{ borderTop: `1px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 12.5, paddingTop: 10 }}>
                  Max payout: <span style={{ color: C.ink2, fontWeight: 700 }}>{badge.maxPayout}</span>
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {durableBadge ? (
                    <>
                      <div style={{ color: durableBadge.selectedDefault ? C.success : C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                        {durableBadge.selectedDefault ? "Default routing badge" : "Verified in durable routing state"}
                      </div>
                      {!durableBadge.selectedDefault && (
                        <button
                          className="tn-btn"
                          disabled={actionState.pending}
                          onClick={() => selectDefaultBadge(badge)}
                          style={{ justifyContent: "center", minHeight: 34, width: "100%" }}
                          type="button"
                        >
                          {actionState.pending ? "Saving..." : "Use by default"}
                        </button>
                      )}
                    </>
                  ) : (
                    <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                      {badge.id === "project_leader"
                        ? "Project Leader is granted manually by the core team."
                        : "Complete the requirements above, then sync the badge state."}
                    </div>
                  )}
                  {actionState.message && (
                    <div style={{
                      color: /updated|created|cancelled/i.test(actionState.message) ? C.success : C.rust,
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}>
                      {actionState.message}
                    </div>
                  )}
                </div>

                {badge.id === "kol" && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      className="tn-btn"
                      disabled={xRefreshState.pending}
                      onClick={refreshXProof}
                      style={{ justifyContent: "center", minHeight: 34, width: "100%" }}
                      type="button"
                    >
                      {xRefreshState.pending ? "Opening X..." : xFollowerMetricsPresent ? "Re-link X" : xAlias ? "Refresh X proof" : "Connect X"}
                    </button>
                    {!xFollowerMetricsPresent && xAlias && (
                      <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                        Reconnect X once to import follower count.
                      </div>
                    )}
                    {xRefreshState.message && (
                      <div style={{ color: C.rust, fontSize: 12, lineHeight: 1.45 }}>
                        {xRefreshState.message}
                      </div>
                    )}
                  </div>
                )}

                {badge.id === "core_contributor" && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      className="tn-btn"
                      disabled={githubRefreshState.pending}
                      onClick={refreshGithubProof}
                      style={{ justifyContent: "center", minHeight: 34, width: "100%" }}
                      type="button"
                    >
                      {githubRefreshState.pending ? "Opening GitHub..." : githubAccessPresent ? "Re-link GitHub" : githubAlias ? "Refresh GitHub proof" : "Connect GitHub"}
                    </button>
                    {!githubAccessPresent && githubAlias && (
                      <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                        Reconnect GitHub once to verify your handle against the sanctioned Core Contributor list.
                      </div>
                    )}
                    {githubAccess.checkedAt && !githubAccess.sanctioned && (
                      <div style={{ color: C.warning, fontSize: 12, lineHeight: 1.45 }}>
                        This GitHub handle is not currently sanctioned for Core Contributor work.
                      </div>
                    )}
                    {githubRefreshState.message && (
                      <div style={{ color: C.rust, fontSize: 12, lineHeight: 1.45 }}>
                        {githubRefreshState.message}
                      </div>
                    )}
                  </div>
                )}

                {badge.id === "expert" && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <input
                      aria-label="Expert topic"
                      onChange={(event) => setExpertTopicInput(event.target.value)}
                      placeholder="What are you an expert in?"
                      style={{
                        background: C.paper2,
                        border: `1px solid ${C.ruleSoft}`,
                        borderRadius: 8,
                        color: C.ink,
                        font: "inherit",
                        minHeight: 36,
                        outline: "none",
                        padding: "8px 10px",
                        width: "100%",
                      }}
                      type="text"
                      value={expertTopicInput}
                    />
                    <button
                      className="tn-btn"
                      disabled={!expertCanEvaluate}
                      onClick={evaluateExpertProof}
                      style={{ justifyContent: "center", minHeight: 34, width: "100%" }}
                      type="button"
                    >
                      {expertEvalState.pending ? "Evaluating..." : expertAccess.reviewedAt ? "Re-run Expert review" : "Evaluate Expert"}
                    </button>
                    {Number(expertAccess.personalTaskCount || 0) < Number(expertAccess.requiredPersonalTaskCount || 20) && (
                      <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                        Complete {fmtN(Number(expertAccess.requiredPersonalTaskCount || 20) - Number(expertAccess.personalTaskCount || 0))} more Personal tasks before evaluation.
                      </div>
                    )}
                    {expertAccess.summary && (
                      <div style={{ color: C.ink3, fontSize: 12, lineHeight: 1.45 }}>
                        {expertAccess.summary}
                      </div>
                    )}
                    {Array.isArray(expertAccess.disqualifyingConcerns) && expertAccess.disqualifyingConcerns.length > 0 && (
                      <div style={{ color: C.warning, fontSize: 12, lineHeight: 1.45 }}>
                        {expertAccess.disqualifyingConcerns[0]}
                      </div>
                    )}
                    {expertEvalState.message && (
                      <div style={{ color: expertAccess.eligible ? C.success : C.rust, fontSize: 12, lineHeight: 1.45 }}>
                        {expertEvalState.message}
                      </div>
                    )}
                  </div>
                )}

                {badge.id === "qa_worker" && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <button
                      className="tn-btn"
                      disabled={discordRefreshState.pending}
                      onClick={refreshDiscordProof}
                      style={{ justifyContent: "center", minHeight: 34, width: "100%" }}
                      type="button"
                    >
                      {discordRefreshState.pending ? "Opening Discord..." : discordAlias ? "Re-link Discord" : "Connect Discord"}
                    </button>
                    {!discordAlias && (
                      <div style={{ color: C.ink4, fontSize: 12, lineHeight: 1.45 }}>
                        Link Discord to qualify for QA Worker routing.
                      </div>
                    )}
                    {discordRefreshState.message && (
                      <div style={{ color: C.rust, fontSize: 12, lineHeight: 1.45 }}>
                        {discordRefreshState.message}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function IdentityProviderRow({ alias = {} }) {
  const label = alias.label || alias.provider || "Provider";
  return (
    <div style={{
      alignItems: "center",
      borderBottom: `1px solid ${C.ruleSoft}`,
      display: "grid",
      gap: 10,
      gridTemplateColumns: "1fr auto",
      minHeight: 38,
      paddingBottom: 8,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: C.ink, fontSize: 13.5, fontWeight: 700 }}>{label}</div>
        <div style={{ color: C.ink4, fontSize: 12 }}>
          {alias.username ? `@${alias.username}` : alias.displayName || "Linked account"}
        </div>
      </div>
      <span style={{ alignItems: "center", color: alias.verified ? C.success : C.ink4, display: "inline-flex", fontSize: 12, fontWeight: 700, gap: 5 }}>
        {alias.verified ? <CheckCircle2 size={14} strokeWidth={2} /> : <CircleDashed size={14} strokeWidth={2} />}
        {alias.verified ? "Verified" : "Linked"}
      </span>
    </div>
  );
}

export function PrivateProfile({
  accountId = "",
  linkedWalletAddress = "",
  onProfileIdentityChange,
  onProfileAvatarChange,
  onWalletUnlock,
  pftlExplorerUrl = "",
  profilePublic = true,
  session = null,
  walletSecret = null,
  walletVault = {},
} = {}) {
  const [profileNfts, setProfileNfts] = useState([]);
  const [profileNftTotal, setProfileNftTotal] = useState(null);
  const [selectingNftId, setSelectingNftId] = useState("");
  const [nftSelectionError, setNftSelectionError] = useState("");
  const [airdropState, setAirdropState] = useState({ loading: Boolean(accountId), error: "", latest: null });
  const [rewardRange, setRewardRange] = useState("28d");
  const [rewardHistoryState, setRewardHistoryState] = useState({ loading: Boolean(accountId), error: "", history: null });
  const handleNftsChange = useCallback((nextNfts = [], total = null) => {
    setProfileNfts(nextNfts);
    if (Number.isFinite(Number(total))) setProfileNftTotal(Number(total));
    else setProfileNftTotal(nextNfts.length);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(nextNfts));
  }, [onProfileAvatarChange]);
  const scrollToNftGallery = useCallback(() => {
    document.getElementById("profile-nft-gallery")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const setProfilePicture = useCallback(async (nft = {}) => {
    if (!nft?.id || selectingNftId) return;
    setSelectingNftId(nft.id);
    setNftSelectionError("");
    const previousNfts = profileNfts;
    const optimistic = profileNfts.map((record) => ({
      ...record,
      selected: record.id === nft.id,
    }));
    setProfileNfts(optimistic);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(optimistic));
    const result = await requestJson("/api/profile/nft/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nftId: nft.id }),
    });
    setSelectingNftId("");
    if (!result.ok || !result.body?.nft) {
      setProfileNfts(previousNfts);
      if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(previousNfts));
      setNftSelectionError(result.body?.message || result.body?.error || "Profile picture could not be updated.");
      return;
    }
    const selectedNft = result.body.nft;
    const confirmed = profileNfts.map((record) => ({
      ...record,
      ...(record.id === selectedNft.id ? selectedNft : {}),
      selected: record.id === selectedNft.id,
    }));
    setProfileNfts(confirmed);
    if (typeof onProfileAvatarChange === "function") onProfileAvatarChange(latestAvatarNft(confirmed));
  }, [onProfileAvatarChange, profileNfts, selectingNftId]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setAirdropState({ loading: false, error: "", latest: null });
      return () => {
        cancelled = true;
      };
    }
    setAirdropState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/daily-airdrop").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAirdropState({ loading: false, error: "", latest: result.body?.latest || null });
        return;
      }
      setAirdropState({
        loading: false,
        error: result.body?.message || result.body?.error || "Daily airdrop score could not be loaded.",
        latest: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setRewardHistoryState({ loading: false, error: "", history: null });
      return () => {
        cancelled = true;
      };
    }
    setRewardHistoryState((current) => ({ ...current, loading: true, error: "" }));
    requestJson(`/api/profile/reward-history?range=${encodeURIComponent(rewardRange)}`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setRewardHistoryState({ loading: false, error: "", history: result.body?.history || null });
        return;
      }
      setRewardHistoryState({
        loading: false,
        error: result.body?.message || result.body?.error || "Task reward history could not be loaded.",
        history: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, rewardRange]);

  return (
    <div>
      <TodaysBriefing
        airdrop={airdropState.latest}
        error={airdropState.error}
        loading={airdropState.loading}
        rewardHistory={rewardHistoryState.history}
      />
      <ProfileIdentityCard
        onProfileIdentityChange={onProfileIdentityChange}
        session={session}
      />
      <NetworkBadgesPanel session={session} />
      <ProfileStudio
        accountId={accountId}
        linkedWalletAddress={linkedWalletAddress}
        onNftsChange={handleNftsChange}
        onProfileAvatarChange={onProfileAvatarChange}
        onViewGallery={scrollToNftGallery}
        onWalletUnlock={onWalletUnlock}
        walletSecret={walletSecret}
        walletVault={walletVault}
      />
      <PFTTimeseries
        error={rewardHistoryState.error}
        history={rewardHistoryState.history}
        loading={rewardHistoryState.loading}
        onRangeChange={setRewardRange}
        range={rewardRange}
      />
      {nftSelectionError && (
        <div style={{ color: C.rust, fontSize: 13.5, marginTop: 28 }}>
          {nftSelectionError}
        </div>
      )}
      <NFTGallery
        allowMockFallback={false}
        minted={profileNfts}
        onSetProfilePicture={setProfilePicture}
        selectingNftId={selectingNftId}
        total={profileNftTotal}
      />
      <ConnectionsCard accountId={accountId} pftlExplorerUrl={pftlExplorerUrl} profilePublic={profilePublic} />
    </div>
  );
}
