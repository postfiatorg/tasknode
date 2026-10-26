import { useCallback, useEffect, useState } from "react";
import { requestJson } from "../../api";
import { ProfileIdentityCard } from "./ProfileIdentityCard.jsx";
import { TodaysBriefing, latestAvatarNft } from "./ProfileBriefing.jsx";
import { ConnectionsCard } from "./ProfileConnections.jsx";
import { ProfileHero } from "./ProfileHero.jsx";
import { NFTGallery, PFTTimeseries, ProfileStudio } from "./ProfileStudioPanels.jsx";
import { providerConnectionState } from "./provider-connection-state.js";
import {
  C,
  fmtN,
  identityApprovalBadges,
} from "./profile-view-shared.jsx";

export function NetworkBadgesPanel({ session = null } = {}) {
  const [xRefreshState, setXRefreshState] = useState({ pending: false, message: "" });
  const [githubRefreshState, setGithubRefreshState] = useState({ pending: false, message: "" });
  const [qaProviderRefreshState, setQaProviderRefreshState] = useState({
    discord: { pending: false, message: "" },
    telegram: { pending: false, message: "" },
  });
  const [badgeRefreshState, setBadgeRefreshState] = useState({ pending: false, message: "" });
  const [networkBadgeState, setNetworkBadgeState] = useState({ pending: false, message: "", state: null });
  const [badgeActionState, setBadgeActionState] = useState({});
  const sessionExpertAccess = session?.identityProfile?.expertAccess || {};
  const [expertAccessOverride, setExpertAccessOverride] = useState(null);
  const [expertTopicInput, setExpertTopicInput] = useState(sessionExpertAccess.topic || "");
  const [expertEvalState, setExpertEvalState] = useState({ pending: false, message: "" });
  const expertAccess = expertAccessOverride || sessionExpertAccess;
  const projectLeaderAccess = session?.identityProfile?.projectLeaderAccess || {};
  const currentBadgeState = networkBadgeState.state?.accountId === session?.accountId ? networkBadgeState.state : null;
  const currentIdentity = currentBadgeState?.identityProfile || session?.identityProfile;
  const aliases = Array.isArray(currentIdentity?.aliases) ? currentIdentity.aliases : [];
  const linkedProviders = currentBadgeState?.identityProfile ? [] : Array.isArray(session?.linkedProviders) ? session.linkedProviders : [];
  const durableBadges = Array.isArray(currentBadgeState?.badges) ? currentBadgeState.badges : [];
  const durableBadgeFor = (badgeId = "") => durableBadges.find((badge) => badge.badgeId === badgeId && badge.status === "verified" && !badge.revokedAt && (!badge.expiresAt || Date.parse(badge.expiresAt) > Date.now()));
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
  const connectionForProvider = (provider = "") => providerConnectionState({
    aliases,
    linkedProviders,
    provider,
  });
  const linked = (provider = "") => connectionForProvider(provider).linked;
  const verifiedLinked = (provider = "") => connectionForProvider(provider).verified;
  useEffect(() => {
    setExpertAccessOverride(null);
    setExpertTopicInput(sessionExpertAccess.topic || "");
  }, [sessionExpertAccess.topic, sessionExpertAccess.reviewedAt]);
  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    async function loadNetworkBadgeState() {
      const currentSequence = ++sequence;
      if (!session?.accountId) {
        setNetworkBadgeState({ pending: false, message: "", state: null });
        return;
      }
      setNetworkBadgeState((current) => ({ ...current, pending: true, message: "" }));
      try {
        const result = await requestJson("/api/profile/network-badges");
        if (cancelled || currentSequence !== sequence) return;
        setNetworkBadgeState({
          pending: false,
          message: result.ok ? "" : result.body?.message || result.body?.error || `Badge state returned HTTP ${result.status}.`,
          state: result.body?.state || null,
        });
      } catch (error) {
        if (!cancelled && currentSequence === sequence) {
          setNetworkBadgeState({ pending: false, message: error?.message || "Network badge state could not load.", state: null });
        }
      }
    }
    loadNetworkBadgeState();
    window.addEventListener("focus", loadNetworkBadgeState);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", loadNetworkBadgeState);
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
        return `${fmtN(expertAccess.score || 0)} / 100 expertise score (${fmtN(requirement.expertScore)}+ required)`;
      }
      return "Expertise review of your last 20 Personal tasks";
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
    if (durableBadgeFor(badge.id)) return { label: "Ready", color: C.success, tone: "ready" };
    if (networkBadgeState.pending && !currentBadgeState) return { label: "Checking", color: C.ink3, tone: "proof" };
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
  const xAlias = aliasForProvider("x");
  const githubAlias = aliasForProvider("github");
  const telegramConnection = connectionForProvider("telegram").connection;
  const discordConnection = connectionForProvider("discord").connection;
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

  async function refreshQaProviderProof(provider = "") {
    const label = providerLabel(provider);
    setQaProviderRefreshState((current) => ({
      ...current,
      [provider]: { pending: true, message: "" },
    }));
    try {
      const result = await requestJson(`/api/auth/start/${provider}?redirect=${encodeURIComponent("/#profile")}`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setQaProviderRefreshState((current) => ({
        ...current,
        [provider]: {
          pending: false,
          message: result.body?.message || result.body?.actionRequired || `${label} returned HTTP ${result.status}.`,
        },
      }));
    } catch (error) {
      setQaProviderRefreshState((current) => ({
        ...current,
        [provider]: { pending: false, message: error?.message || `${label} link could not start.` },
      }));
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

  const verifiedCount = durableBadges.filter((badge) => badge.status === "verified").length;
  const badgeActions = (badge, active) => {
    if (badge.id === "kol" && !active) {
      return (
        <button className="pf-button" disabled={xRefreshState.pending} onClick={refreshXProof} type="button">
          {xRefreshState.pending ? "Opening X…" : xAlias ? "Refresh X" : "Connect X"}
        </button>
      );
    }
    if (badge.id === "core_contributor" && !active) {
      return (
        <button className="pf-button" disabled={githubRefreshState.pending} onClick={refreshGithubProof} type="button">
          {githubRefreshState.pending ? "Opening GitHub…" : githubAlias ? "Refresh GitHub" : "Connect GitHub"}
        </button>
      );
    }
    if (badge.id === "qa_worker" && !active) {
      return [
        { provider: "telegram", connection: telegramConnection },
        { provider: "discord", connection: discordConnection },
      ].filter(({ connection }) => !connection).map(({ provider }) => {
        const refreshState = qaProviderRefreshState[provider] || {};
        return (
          <button className="pf-button" disabled={refreshState.pending} key={provider} onClick={() => refreshQaProviderProof(provider)} type="button">
            {refreshState.pending ? `Opening ${providerLabel(provider)}…` : `Connect ${providerLabel(provider)}`}
          </button>
        );
      });
    }
    return null;
  };
  const badgeMessages = (badge) => [
    badge.id === "kol" ? xRefreshState.message : "",
    badge.id === "core_contributor" ? githubRefreshState.message : "",
    badge.id === "qa_worker" ? qaProviderRefreshState.telegram?.message : "",
    badge.id === "qa_worker" ? qaProviderRefreshState.discord?.message : "",
    badgeActionState[badge.id]?.message || "",
  ].filter(Boolean);

  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h2>Badges</h2>
          <p>
            {networkBadgeState.pending && !currentBadgeState
              ? "Loading badges."
              : verifiedCount
                ? `${fmtN(verifiedCount)} active. Badges route higher-value network tasks to you.`
                : "Badges route higher-value network tasks to you."}
          </p>
        </div>
        <div className="pf-section-actions">
          <button className="pf-text-button" disabled={badgeRefreshState.pending} onClick={refreshNetworkBadgeState} type="button">
            {badgeRefreshState.pending ? "Syncing…" : "Sync badges"}
          </button>
        </div>
      </div>
      {(networkBadgeState.message || badgeRefreshState.message) && (
        <p className={`pf-note${badgeRefreshState.message.startsWith("Synced") ? " is-success" : " is-error"}`}>
          {badgeRefreshState.message || networkBadgeState.message}
        </p>
      )}
      <div className="pf-badges">
        {identityApprovalBadges.map((badge) => {
          const Icon = badge.icon;
          const durableBadge = durableBadgeFor(badge.id);
          const active = Boolean(durableBadge);
          const pendingStatus = active ? null : statusFor(badge);
          const status = active
            ? { label: durableBadge.selectedDefault ? "Active · default" : "Active", tone: "ready" }
            : pendingStatus.tone === "ready"
              ? { ...pendingStatus, label: "Ready · sync to activate", tone: "proof" }
              : pendingStatus;
          const done = completedCount(badge.requirements);
          const actionState = badgeActionState[badge.id] || {};
          const messages = badgeMessages(badge);
          const actions = badgeActions(badge, active);
          return (
            <div className="pf-badge" key={badge.id}>
              <span className="pf-badge-icon"><Icon size={16} strokeWidth={1.8} /></span>
              <div>
                <div className="pf-badge-title">
                  <strong>{badge.label}</strong>
                  <span className={`pf-badge-status${status.tone === "ready" ? " is-active" : status.tone === "missing" ? " is-needs" : ""}`}>
                    {status.label}
                  </span>
                </div>
                <div className="pf-badge-detail">{badge.lane} · {/^\d/.test(badge.maxPayout) ? `up to ${badge.maxPayout}` : `${badge.maxPayout.toLowerCase()} payout`}</div>
              </div>
              <div className="pf-badge-actions">
                {active && !durableBadge.selectedDefault && (
                  <button className="pf-button" disabled={actionState.pending} onClick={() => selectDefaultBadge(badge)} type="button">
                    {actionState.pending ? "Saving…" : "Make default"}
                  </button>
                )}
                {actions}
              </div>
              {(!active || messages.length > 0) && (
                <div className="pf-badge-body">
                  {!active && (
                    <ul className="pf-requirements" aria-label={`${badge.label} requirements, ${done} of ${badge.requirements.length} met`}>
                      {badge.requirements.map((requirement) => (
                        <li className={requirementFulfilled(requirement) ? "is-done" : ""} key={requirement.id}>
                          {requirementText(requirement)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {badge.id === "expert" && !active && (
                    <div className="pf-badge-input">
                      <input
                        aria-label="Expert topic"
                        onChange={(event) => setExpertTopicInput(event.target.value)}
                        placeholder="What are you an expert in?"
                        type="text"
                        value={expertTopicInput}
                      />
                      <button className="pf-button" disabled={!expertCanEvaluate} onClick={evaluateExpertProof} type="button">
                        {expertEvalState.pending ? "Evaluating…" : expertAccess.reviewedAt ? "Re-run review" : "Evaluate"}
                      </button>
                    </div>
                  )}
                  {badge.id === "expert" && !active && expertAccess.summary && <p className="pf-note">{expertAccess.summary}</p>}
                  {badge.id === "expert" && expertEvalState.message && (
                    <p className={`pf-note${expertAccess.eligible ? " is-success" : " is-error"}`}>{expertEvalState.message}</p>
                  )}
                  {messages.map((message) => (
                    <p className={`pf-note${/updated|verified/i.test(message) ? " is-success" : " is-error"}`} key={message}>{message}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
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
  const [selectingNftId, setSelectingNftId] = useState("");
  const [nftSelectionError, setNftSelectionError] = useState("");
  const [airdropState, setAirdropState] = useState({ loading: Boolean(accountId), error: "", latest: null, alignment: null });
  const [rewardRange, setRewardRange] = useState("28d");
  const [rewardHistoryState, setRewardHistoryState] = useState({ loading: Boolean(accountId), error: "", history: null });
  const handleNftsChange = useCallback((nextNfts = []) => {
    setProfileNfts(nextNfts);
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
      setAirdropState({ loading: false, error: "", latest: null, alignment: null });
      return () => {
        cancelled = true;
      };
    }
    setAirdropState((current) => ({ ...current, loading: true, error: "" }));
    requestJson("/api/profile/daily-airdrop").then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAirdropState({ loading: false, error: "", latest: result.body?.latest || null, alignment: result.body?.alignment || null });
        return;
      }
      setAirdropState({
        loading: false,
        error: result.body?.message || result.body?.error || "Daily airdrop score could not be loaded.",
        latest: null,
        alignment: null,
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
      <ProfileHero
        alignment={airdropState.alignment}
        avatarNft={latestAvatarNft(profileNfts)}
        rewardHistory={rewardHistoryState.history}
        rewardRange={rewardRange}
        session={session}
      />
      <TodaysBriefing
        airdrop={airdropState.latest}
        error={airdropState.error}
        loading={airdropState.loading}
        pftlExplorerUrl={pftlExplorerUrl}
      />
      <PFTTimeseries
        error={rewardHistoryState.error}
        history={rewardHistoryState.history}
        loading={rewardHistoryState.loading}
        onRangeChange={setRewardRange}
        range={rewardRange}
      />
      <NetworkBadgesPanel session={session} />
      <ProfileStudio
        accountId={accountId}
        linkedWalletAddress={linkedWalletAddress}
        nfts={profileNfts}
        onNftsChange={handleNftsChange}
        onProfileAvatarChange={onProfileAvatarChange}
        onViewGallery={scrollToNftGallery}
        onWalletUnlock={onWalletUnlock}
        walletSecret={walletSecret}
        walletVault={walletVault}
      />
      {nftSelectionError && <p className="pf-note is-error">{nftSelectionError}</p>}
      <NFTGallery
        minted={profileNfts}
        onSetProfilePicture={setProfilePicture}
        selectingNftId={selectingNftId}
      />
      <ProfileIdentityCard
        onProfileIdentityChange={onProfileIdentityChange}
        session={session}
      />
      <ConnectionsCard accountId={accountId} pftlExplorerUrl={pftlExplorerUrl} profilePublic={profilePublic} />
    </div>
  );
}
