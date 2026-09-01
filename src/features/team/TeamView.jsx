import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight, Eye, EyeOff, RefreshCw, ShieldCheck, UserPlus2, Users } from "lucide-react";
import { requestJson } from "../../api";
import { newUuid, signedCollaborationProof } from "../collaboration/collaboration-client";
import { TeamTaskDetailPopout } from "./TeamTaskDetailPopout";
import {
  shouldRefreshTeamContext,
  teamContextStatusLabel,
  TEAM_CONTEXT_REFRESH_DELAY_MS,
} from "./team-context-refresh";
import "./team.css";

const ROLE_COPY = {
  collaborator: { label: "Collaborator", detail: "You can both see each other's task history." },
  manager: { label: "Manager", detail: "They can see your tasks; you cannot see theirs." },
  direct_report: { label: "Direct Report", detail: "You can see their tasks; they cannot see yours." },
};

function requestedGrants(relationship, inviterAccountId, inviteeAccountId) {
  if (relationship === "collaborator") return [
    { subjectAccountId: inviterAccountId, viewerAccountId: inviteeAccountId },
    { subjectAccountId: inviteeAccountId, viewerAccountId: inviterAccountId },
  ];
  if (relationship === "manager") return [{ subjectAccountId: inviterAccountId, viewerAccountId: inviteeAccountId }];
  return [{ subjectAccountId: inviteeAccountId, viewerAccountId: inviterAccountId }];
}

function resultError(result, fallback) { return result?.body?.error || fallback; }

function teamContextPreview(value = "", maxLength = 360) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  const wordBoundary = text.lastIndexOf(" ", maxLength);
  const end = wordBoundary > Math.floor(maxLength * 0.72) ? wordBoundary : maxLength;
  return `${text.slice(0, end).trim()}…`;
}

export function TeamView({ accountId, onWalletUnlock, walletSecret }) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [relationship, setRelationship] = useState("collaborator");
  const [busy, setBusy] = useState("");
  const [taskState, setTaskState] = useState({});
  const [selectedTask, setSelectedTask] = useState(null);
  const [contextState, setContextState] = useState({ loading: true, data: null, error: "" });
  const [expandedContextMembers, setExpandedContextMembers] = useState({});

  const load = useCallback(async () => {
    const [result, contextResult] = await Promise.all([
      requestJson("/api/team"),
      requestJson("/api/team/context"),
    ]);
    if (!result.ok) setState({ loading: false, data: null, error: resultError(result, "Could not load team.") });
    else setState({ loading: false, data: result.body, error: "" });
    if (!contextResult.ok) setContextState({ loading: false, data: null, error: resultError(contextResult, "Could not load Team Context.") });
    else setContextState({ loading: false, data: contextResult.body, error: "" });
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!shouldRefreshTeamContext(contextState.data?.status)) return undefined;
    let cancelled = false;
    let timeout;
    const poll = async () => {
      const result = await requestJson("/api/team/context");
      if (cancelled) return;
      if (result.ok) {
        setContextState({ loading: false, data: result.body, error: "" });
        if (!shouldRefreshTeamContext(result.body?.status)) return;
      } else {
        setContextState((current) => ({
          ...current,
          error: resultError(result, "Could not refresh Team Context."),
        }));
      }
      timeout = setTimeout(poll, TEAM_CONTEXT_REFRESH_DELAY_MS);
    };
    timeout = setTimeout(poll, TEAM_CONTEXT_REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [contextState.data?.status]);

  async function sendInvite() {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    setBusy("invite");
    try {
      const resolved = await requestJson(`/api/collaboration/resolve?q=${encodeURIComponent(target)}`);
      if (!resolved.ok) throw new Error(resultError(resolved, "Task Node member not found."));
      const inviteeAccountId = resolved.body.identity.accountId;
      const inviteId = newUuid();
      const payload = {
        inviteId,
        inviterAccountId: accountId,
        inviteeAccountId,
        relationship,
        requestedGrants: requestedGrants(relationship, accountId, inviteeAccountId),
      };
      const proof = await signedCollaborationProof({ action: "team_invite", resourceId: inviteId, payload, walletSecret });
      const result = await requestJson("/api/team/invites", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteId, inviteeAccountId, relationship, proof }),
      });
      if (!result.ok) throw new Error(resultError(result, "Could not send invite."));
      setInviteOpen(false); setTarget(""); await load();
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setBusy(""); }
  }

  async function actOnInvite(invite, action) {
    if (action === "accept" && !walletSecret?.mnemonic) return onWalletUnlock?.();
    setBusy(invite.inviteId);
    try {
      let proof;
      if (action === "accept") {
        const grants = requestedGrants(invite.relationship, invite.otherAccountId, accountId);
        const payload = { inviteId: invite.inviteId, relationship: invite.relationship, requestedGrants: grants, acceptingAccountId: accountId };
        proof = await signedCollaborationProof({ action: "team_invite_accept", resourceId: invite.inviteId, payload, walletSecret });
      }
      const result = await requestJson(`/api/team/invites/${invite.inviteId}/action`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, proof }),
      });
      if (!result.ok) throw new Error(resultError(result, "Could not update invite."));
      await load();
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setBusy(""); }
  }

  async function stopSharing(member) {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    if (!member.outgoingGrantId) return;
    setBusy(member.outgoingGrantId);
    try {
      const payload = { grantId: member.outgoingGrantId };
      const proof = await signedCollaborationProof({ action: "team_grant_revoke", resourceId: member.outgoingGrantId, payload, walletSecret });
      const result = await requestJson(`/api/team/grants/${member.outgoingGrantId}/revoke`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof }),
      });
      if (!result.ok) throw new Error(resultError(result, "Could not revoke task access."));
      await load();
    } catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setBusy(""); }
  }

  async function toggleTasks(member) {
    if (taskState[member.accountId]?.open) {
      setTaskState((current) => ({ ...current, [member.accountId]: { ...current[member.accountId], open: false } }));
      return;
    }
    setTaskState((current) => ({ ...current, [member.accountId]: { open: true, loading: true } }));
    const result = await requestJson(`/api/team/${encodeURIComponent(member.accountId)}/tasks`);
    setTaskState((current) => ({ ...current, [member.accountId]: {
      open: true, loading: false,
      tasks: result.ok ? result.body.tasks : null,
      error: result.ok ? "" : resultError(result, "Could not load tasks."),
    } }));
  }

  function toggleContextMember(accountId) {
    setExpandedContextMembers((current) => ({
      ...current,
      [accountId]: current[accountId] !== true,
    }));
  }

  async function toggleContextInclusion() {
    const includeInPersonalContext = contextState.data?.includeInPersonalContext !== true;
    setBusy("team-context-preference");
    const result = await requestJson("/api/team/context/preference", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeInPersonalContext }),
    });
    if (!result.ok) {
      setContextState((current) => ({ ...current, error: resultError(result, "Could not update Team Context.") }));
    } else {
      setContextState((current) => ({
        ...current,
        data: { ...(current.data || {}), includeInPersonalContext },
        error: "",
      }));
      await load();
    }
    setBusy("");
  }

  const grouped = useMemo(() => {
    const members = state.data?.members || [];
    return {
      collaborator: members.filter((member) => member.relationship === "collaborator"),
      manager: members.filter((member) => member.relationship === "manager"),
      direct_report: members.filter((member) => member.relationship === "direct_report"),
    };
  }, [state.data]);

  if (state.loading && !state.data) return <div className="collab-route-state">Loading Team…</div>;
  return <div className="collab-page team-page">
    <header className="collab-page-header"><div><span>Directional, wallet-authorized access</span><h1>Team</h1><p>Coordinate with people you trust without making task history public.</p></div><button className="collab-primary" onClick={() => setInviteOpen(true)} type="button"><UserPlus2 size={16} />Invite teammate</button></header>
    <div className="team-stats"><div><strong>{state.data?.counts?.collaborators || 0}</strong><span>Collaborators</span></div><div><strong>{state.data?.counts?.managers || 0}</strong><span>Managers</span></div><div><strong>{state.data?.counts?.directReports || 0}</strong><span>Direct reports</span></div><button onClick={load} type="button"><RefreshCw size={15} />Refresh</button></div>
    <section className="team-context-report" aria-labelledby="team-context-title">
      <header className="team-context-heading">
        <div className="team-context-intro">
          <span>Generated from rewarded work</span>
          <h2 id="team-context-title">Team Context</h2>
          <p>A concise briefing on what changed, why it matters, and who moved it forward.</p>
        </div>
        <div className="team-context-controls">
          {contextState.data && <div className="team-context-meta" aria-live="polite">
            <span className={`team-context-status status-${contextState.data.status}`}><i aria-hidden="true" />{teamContextStatusLabel(contextState.data)}</span>
            {contextState.data.generatedAt && <time dateTime={contextState.data.generatedAt}>Updated {new Date(contextState.data.generatedAt).toLocaleString()}</time>}
          </div>}
          <button
            aria-pressed={contextState.data?.includeInPersonalContext === true}
            className={contextState.data?.includeInPersonalContext === true ? "team-context-toggle active" : "team-context-toggle"}
            disabled={busy === "team-context-preference"}
            onClick={toggleContextInclusion}
            type="button"
          ><span className="team-context-check"><Check size={14} /></span><span><strong>Use in personal context</strong><small>Available to your chats and agents</small></span></button>
        </div>
      </header>
      {contextState.error && <p className="collab-error">{contextState.error}</p>}
      {contextState.loading ? <p className="team-context-state">Loading Team Context…</p> :
        contextState.data?.members?.length ? <>
          {contextState.data.showingPreviousReport && <div className="team-context-freshness" role="status">
            <RefreshCw aria-hidden="true" size={14} />
            <span>Refreshing now. Showing the last completed report{contextState.data.generatedAt ? <> from <time dateTime={contextState.data.generatedAt}>{new Date(contextState.data.generatedAt).toLocaleString()}</time></> : ""}.</span>
          </div>}
          {contextState.data.overview && <div className="team-context-overview"><span>Current workstreams</span><p>{contextState.data.overview}</p></div>}
          <div className="team-context-members" role="list">{contextState.data.members.map((member, index) => {
            const expanded = expandedContextMembers[member.accountId] === true;
            const recentWork = String(member.recentWork || "");
            const canExpand = recentWork.length > 420;
            const updateId = `team-context-update-${index + 1}`;
            return <article className={expanded ? "team-context-member is-expanded" : "team-context-member"} key={member.accountId} role="listitem">
              <header className="team-context-member-head">
                <div className="team-context-member-avatar" aria-hidden="true">{(member.hiveHandle || member.displayName || "?").slice(0, 1).toUpperCase()}</div>
                <div className="team-context-member-identity"><strong>{member.displayName}</strong><small>{member.hiveHandle ? `@${member.hiveHandle}` : "Task Node member"}</small></div>
                <dl className="team-context-member-metrics">
                  <div><dd>{member.tasksPastDay == null ? "—" : member.tasksPastDay}</dd><dt>24 hours</dt></div>
                  <div><dd>{member.tasksPastWeek == null ? "—" : member.tasksPastWeek}</dd><dt>7 days</dt></div>
                </dl>
              </header>
              <div className="team-context-member-update">
                <span>Recent rewarded work</span>
                <p id={updateId}>{expanded || !canExpand ? recentWork : teamContextPreview(recentWork)}</p>
                {canExpand && <button
                  aria-controls={updateId}
                  aria-expanded={expanded}
                  data-team-context-expand
                  onClick={() => toggleContextMember(member.accountId)}
                  type="button"
                >{expanded ? "Show less" : "Read full update"}<ChevronDown aria-hidden="true" size={15} /></button>}
              </div>
            </article>;
          })}</div>
        </> : <p className="team-context-state">Add a teammate to create Team Context.</p>}
    </section>
    {state.error && <p className="collab-error">{state.error}</p>}
    {(state.data?.invites || []).length > 0 && <section className="team-invites"><h2>Pending invites</h2>{state.data.invites.map((invite) => <article key={invite.inviteId}><span><Users size={18} /><span><strong>{invite.identity.displayName}</strong><small>{invite.direction === "incoming" ? "invited you as" : "invited as"} {ROLE_COPY[invite.relationship].label}</small></span></span><span>{invite.direction === "incoming" ? <><button onClick={() => actOnInvite(invite, "decline")} type="button">Decline</button><button className="collab-primary" disabled={busy === invite.inviteId} onClick={() => actOnInvite(invite, "accept")} type="button">Accept</button></> : <button onClick={() => actOnInvite(invite, "cancel")} type="button">Cancel</button>}</span></article>)}</section>}
    {Object.entries(grouped).map(([role, members]) => members.length > 0 && <section className="team-group" key={role}><h2>{role === "manager" ? "Your manager" : role === "direct_report" ? "Direct reports" : "Collaborators"}<small>{ROLE_COPY[role].detail}</small></h2><div className="team-card-list">{members.map((member) => {
      const tasks = taskState[member.accountId];
      const allTasks = tasks?.tasks ? ["outstanding", "verification", "refused", "rewarded"].flatMap((key) => tasks.tasks[key] || []) : [];
      return <article className="team-card" key={member.accountId}><div className="team-card-head"><div className="team-avatar">{member.identity.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{member.identity.displayName}</strong><small>{member.identity.hiveHandle ? `@${member.identity.hiveHandle}` : "Task Node member"}</small></div><span className={`team-role role-${role}`}>{ROLE_COPY[role].label}</span></div><div className="team-lanes"><span className={member.seesTheirs ? "on" : "off"}>{member.seesTheirs ? <Eye size={14} /> : <EyeOff size={14} />}You see their tasks</span><ArrowRight size={14} /><span className={member.theySeeYours ? "on" : "off"}>{member.theySeeYours ? <Eye size={14} /> : <EyeOff size={14} />}They see yours</span></div>{member.summary && <div className="team-summary"><span><strong>{member.summary.taskCount}</strong> tasks</span><span><strong>{member.summary.rewardPft.toLocaleString()}</strong> PFT rewarded</span></div>}<footer>{member.seesTheirs && <button onClick={() => toggleTasks(member)} type="button">{tasks?.open ? "Hide tasks" : "View tasks"}</button>}{member.theySeeYours && <button disabled={busy === member.outgoingGrantId} onClick={() => stopSharing(member)} type="button">Stop sharing mine</button>}</footer>{tasks?.open && <div className="team-task-drawer">{tasks.loading ? "Loading tasks…" : tasks.error || (allTasks.length ? <><header><strong>Task history</strong><small>Select a task to open its details</small></header><div className="team-task-list">{allTasks.map((task) => <button aria-haspopup="dialog" className="team-task-row" key={task.taskId || task.fullId || task.id} onClick={() => setSelectedTask({ member, task })} type="button"><span><strong>{task.title || "Untitled task"}</strong><small>{task.status || task.statusLabel || task.statusKey}</small></span><span>{Number(task.pft || 0).toLocaleString()} <small>PFT</small><ChevronRight size={15} /></span></button>)}</div></> : "No tasks yet.")}</div>}</article>;
    })}</div></section>)}
    {!state.data?.members?.length && !state.data?.invites?.length && <div className="collab-empty"><ShieldCheck size={25} /><p>No teammates yet. Invite someone by exact Task Node handle or linked wallet.</p></div>}
    {inviteOpen && <div className="collab-dialog-backdrop" onMouseDown={() => setInviteOpen(false)}><section className="collab-dialog" onMouseDown={(event) => event.stopPropagation()}><h2>Invite teammate</h2><p>The selected role is a precise task-history grant, not a public social label.</p><label>Task Node handle or wallet<input autoFocus onChange={(event) => setTarget(event.target.value)} placeholder="@teammate" value={target} /></label><label>Relationship<select onChange={(event) => setRelationship(event.target.value)} value={relationship}>{Object.entries(ROLE_COPY).map(([key, copy]) => <option key={key} value={key}>{copy.label}</option>)}</select></label><p className="team-role-detail">{ROLE_COPY[relationship].detail}</p><div><button onClick={() => setInviteOpen(false)} type="button">Cancel</button><button className="collab-primary" disabled={!target.trim() || busy === "invite"} onClick={sendInvite} type="button">{busy === "invite" ? "Signing…" : "Send invite"}</button></div></section></div>}
    {selectedTask && <TeamTaskDetailPopout member={selectedTask.member} onClose={() => setSelectedTask(null)} task={selectedTask.task} />}
  </div>;
}
