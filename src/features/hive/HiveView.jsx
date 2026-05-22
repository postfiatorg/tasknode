import React, { useEffect, useState } from "react";
import { Activity, ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

export function HiveView() {
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectDocument, setProjectDocument] = useState(null);
  const [projectStatus, setProjectStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    setProjectStatus("loading");
    requestJson("/api/hive/projects")
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive projects returned HTTP ${result.status}.`);
        setProjectDocument(result.body?.document || null);
        setProjectStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setProjectDocument(null);
        setProjectStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="route-scroll hive-route">
      {selectedProject ? (
        <ProjectDetail
          onBack={() => setSelectedProject(null)}
          operators={projectDocument?.operators || {}}
          project={projectDocument?.projects?.[selectedProject] || null}
          status={projectStatus}
        />
      ) : (
        <HiveIndex
          onSelectProject={setSelectedProject}
          projectDocument={projectDocument}
          projectStatus={projectStatus}
        />
      )}
    </div>
  );
}

function HiveIndex({ onSelectProject, projectDocument, projectStatus }) {
  const [hiveContext, setHiveContext] = useState(null);
  const [hiveSecretary, setHiveSecretary] = useState(null);
  const [hiveContextOpen, setHiveContextOpen] = useState(false);
  const [hiveContextStatus, setHiveContextStatus] = useState("loading");
  const stats = projectDocument?.stats || {};

  useEffect(() => {
    let cancelled = false;
    setHiveContextStatus("loading");
    requestJson("/api/hive/context?limit=120")
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive Context returned HTTP ${result.status}.`);
        setHiveContext(result.body?.context || null);
        setHiveSecretary(result.body?.secretary || null);
        setHiveContextStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setHiveContext(null);
        setHiveContextStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="hive-shell">
      <header className="hive-header">
        <div>
          <div className="hive-live-kicker">
            <span />
            Live
          </div>
          <h1>Hive</h1>
          <p>Aggregate view of what the network is doing. The hive routes work to nodes; this is its memory in motion.</p>
        </div>
        <div className="hive-stats">
          <Stat label="Operators online" value={projectStatus === "ready" ? stats.operatorsOnline || 0 : "—"} />
          <Stat label="Tasks in flight" value={projectStatus === "ready" ? stats.tasksInFlight || 0 : "—"} />
          <Stat label="PFT routed" value={projectStatus === "ready" ? formatCompactPft(stats.pftRouted) : "—"} accent />
        </div>
      </header>

      <Section title="Active projects" subtitle="What the hive is routing operators to">
        <ProjectGrid
          document={projectDocument}
          onSelectProject={onSelectProject}
          status={projectStatus}
        />
      </Section>

      <Section title="Routing feed" subtitle="Recent state transitions across the network">
        <div className="hive-card hive-feed">
          {(projectDocument?.routingFeed || []).map((entry, index, list) => (
            <FeedRow
              entry={entry}
              key={entry.id || `${entry.wallet}-${entry.task}-${index}`}
              last={index === list.length - 1}
              operators={projectDocument?.operators || {}}
            />
          ))}
          {projectStatus === "loading" && <div className="hive-empty-project">Loading project feed.</div>}
          {projectStatus === "error" && <div className="hive-empty-project">Project feed is unavailable.</div>}
        </div>
      </Section>

      <Section title="Allotted operators" subtitle="Full-time nodes the hive routes to first">
        <div className="hive-card">
          {Object.entries(projectDocument?.operators || {})
            .filter(([, operator]) => operator.allotted)
            .map(([wallet], index, list) => (
              <AllottedOperatorRow
                key={wallet}
                last={index === list.length - 1}
                operator={projectDocument?.operators?.[wallet]}
                wallet={wallet}
              />
            ))}
          {projectStatus === "loading" && <div className="hive-empty-project">Loading operators.</div>}
          {projectStatus === "error" && <div className="hive-empty-project">Operator load is unavailable.</div>}
        </div>
      </Section>

      <Section title="Hive Context" subtitle="User-submitted network context, grouped by contributor">
        <HiveContextPanel
          context={hiveContext}
          expanded={hiveContextOpen}
          onToggle={() => setHiveContextOpen((open) => !open)}
          status={hiveContextStatus}
          secretary={hiveSecretary}
        />
      </Section>
    </div>
  );
}

function ProjectGrid({ document, onSelectProject, status }) {
  const projects = document?.projects || {};
  const projectIds = document?.projectIds || [];
  if (status === "loading") {
    return <div className="hive-card hive-empty-project">Loading active projects.</div>;
  }
  if (status === "error") {
    return <div className="hive-card hive-empty-project">Active projects are unavailable.</div>;
  }
  if (!projectIds.length) {
    return <div className="hive-card hive-empty-project">No active projects are registered.</div>;
  }
  return (
    <div className="hive-project-grid">
      {projectIds.map((id) => (
        <ProjectCard
          key={id}
          operators={document?.operators || {}}
          project={projects[id] || {}}
          onClick={() => onSelectProject(id)}
        />
      ))}
    </div>
  );
}

function ProjectDetail({ onBack, operators, project, status }) {
  if (status === "loading") {
    return <div className="hive-shell"><div className="hive-card hive-empty-project">Loading project.</div></div>;
  }
  if (!project) {
    return <div className="hive-shell"><button className="hive-back" onClick={onBack} type="button"><ArrowLeft size={14} strokeWidth={1.8} />Hive</button><div className="hive-card hive-empty-project">Project is unavailable.</div></div>;
  }

  return (
    <div className="hive-shell">
      <button className="hive-back" onClick={onBack} type="button">
        <ArrowLeft size={14} strokeWidth={1.8} />
        Hive
      </button>

      <header className="hive-header is-detail">
        <div>
          <div className="hive-project-meta">
            <span>{project.type}</span>
            {project.phase && <small>phase {project.phase}</small>}
          </div>
          <h1>{project.name}</h1>
          {project.summary && <p>{project.summary}</p>}
        </div>
        <div className="hive-stats">
          <Stat label="Tasks" value={project.taskCount || project.tasks.length} />
          <Stat label="Contributors" value={project.contributorCount || project.contributors?.length || 0} />
          <Stat label="PFT routed" value={formatPft(project.pft)} accent />
        </div>
      </header>

      <Section title="About" subtitle="What this project is" layerNumber="01">
        <div className="hive-card hive-about">
          <p>{project.about || project.objective || project.summary}</p>
          <div className="hive-about-meta">
            <span>
              <small>Proposed by {project.proposedBy || "hive"}</small>
              <strong>{project.proposed || "Registered project"}</strong>
            </span>
            {project.phase && (
              <span>
                <small>Phase</small>
                <strong>{project.phase}</strong>
              </span>
            )}
            {project.sourceHiveSecretaryReportId && (
              <span>
                <small>Inputs</small>
                <strong>Hive Secretary</strong>
              </span>
            )}
          </div>
        </div>
      </Section>

      <Section title="Contributors" subtitle={`${project.contributors.length} operators have earned PFT on this project`} layerNumber="02">
        {project.contributors.length ? (
          <div className="hive-contributor-grid">
            {project.contributors.map((contributor) => (
              <ContributorCard contributor={contributor} key={contributor.wallet} />
            ))}
          </div>
        ) : (
          <div className="hive-card hive-empty-project">Contributors will populate after tasks are allocated and rewarded.</div>
        )}
      </Section>

      <Section title="Tasks" subtitle={`${project.tasks.length} project task rows`} layerNumber="03">
        <div className="hive-card">
          {project.tasks.length ? (
            project.tasks.map((task, index) => (
              <ProjectTaskRow
                key={task.id || `${task.title}-${task.state}`}
                last={index === project.tasks.length - 1}
                operators={operators}
                task={task}
              />
            ))
          ) : (
            <div className="hive-empty-project">Network tasks will appear after allocation attaches PFTL task IDs to this project.</div>
          )}
        </div>
      </Section>

      <Section title="Activity" subtitle="Recent events scoped to this project" layerNumber="04">
        <div className="hive-card">
          {project.activity.length ? (
            project.activity.map((entry, index) => (
              <ActivityRow
                entry={entry}
                key={entry.id || `${entry.wallet}-${entry.task}`}
                last={index === project.activity.length - 1}
                operators={operators}
              />
            ))
          ) : (
            <div className="hive-empty-project">Project activity will populate as project-linked tasks move.</div>
          )}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value, accent = false }) {
  return (
    <div className="hive-stat">
      <span>{label}</span>
      <strong className={accent ? "is-accent" : ""}>{value}</strong>
    </div>
  );
}

function Section({ title, subtitle, children, layerNumber = "" }) {
  return (
    <section className="hive-section">
      <div className="hive-section-heading">
        {layerNumber && <span className="hive-layer">{layerNumber}</span>}
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function ProjectCard({ operators, project, onClick }) {
  const previewWallets = (project.contributors || []).map((contributor) => contributor.wallet).slice(0, 4);
  const contributorCount = project.contributorCount || project.contributors?.length || 0;
  const taskCount = project.taskCount || project.tasks?.length || 0;

  return (
    <button className="hive-project-card" onClick={onClick} type="button">
      <span className="hive-project-card-title">{project.name}</span>
      <span className="hive-project-type">{project.type}</span>
      <p>{project.summary}</p>
      <span className="hive-card-contributors">
        <span className="hive-badge-stack">
          {previewWallets.map((wallet, index) => (
            <span className="hive-badge-wrap" key={wallet} style={{ marginLeft: index === 0 ? 0 : -8 }}>
              <NftBadge size={22} variant={operatorForWallet(wallet, operators).badge} />
            </span>
          ))}
        </span>
        <span>
          {contributorCount} {contributorCount === 1 ? "contributor" : "contributors"}
        </span>
      </span>
      <span className="hive-project-card-foot">
        <span>
          <strong>{taskCount}</strong> tasks
        </span>
        <span className="hive-pft">{formatPft(project.pft)} PFT</span>
        <ChevronRight size={14} strokeWidth={1.8} />
      </span>
    </button>
  );
}

function FeedRow({ entry, last = false, operators = {} }) {
  const operator = operatorForWallet(entry.wallet, operators);
  return (
    <div className={`hive-feed-row ${last ? "is-last" : ""}`}>
      <NftBadge size={24} variant={operator.badge} />
      <span className="hive-feed-operator">
        <strong>{operator.codename}</strong>
        <small>{entry.wallet}</small>
      </span>
      <span className={`hive-action is-${entry.action}`}>{actionLabel(entry.action)}</span>
      <span className="hive-feed-copy">
        {entry.task}
        <small>· {entry.project}</small>
        {entry.routing && <em>{entry.routing}</em>}
      </span>
      {entry.pft !== null && entry.pft !== undefined && <span className="hive-pft">+{formatPft(entry.pft)} PFT</span>}
      <time>{entry.time}</time>
    </div>
  );
}

function AllottedOperatorRow({ wallet, operator, last = false }) {
  const resolvedOperator = operator || operatorForWallet(wallet);
  const loadPercent = resolvedOperator.cap ? Math.round((resolvedOperator.load / resolvedOperator.cap) * 100) : 0;
  const active = resolvedOperator.status === "active";

  return (
    <div className={`hive-operator-row ${last ? "is-last" : ""}`}>
      <NftBadge size={26} variant={resolvedOperator.badge} />
      <span className="hive-operator-id">
        <strong>{resolvedOperator.codename}</strong>
        <small>{wallet}</small>
      </span>
      <span className={`hive-presence ${active ? "is-active" : "is-quiet"}`} />
      <span className="hive-operator-role">{resolvedOperator.archetype}</span>
      <span className="hive-load">
        <span>
          <i style={{ width: `${loadPercent}%` }} />
        </span>
        <small>
          {resolvedOperator.load}/{resolvedOperator.cap}
        </small>
      </span>
    </div>
  );
}

function ContributorCard({ contributor }) {
  return (
    <div className="hive-contributor-card">
      <NftBadge size={36} variant={contributor.badge} />
      <div className="hive-contributor-main">
        <span>
          <strong>{contributor.codename || "Operator"}</strong>
          {contributor.role === "lead" && <small>lead</small>}
        </span>
        <code>{contributor.wallet}</code>
        <p>{contributor.archetype}</p>
      </div>
      <div className="hive-contributor-metrics">
        <span>
          <strong>{contributor.tasks}</strong> tasks
        </span>
        <span className="hive-pft">{formatPft(contributor.pft)} PFT</span>
        <small>active {contributor.lastActive}</small>
      </div>
    </div>
  );
}

function ProjectTaskRow({ task, last = false, operators = {} }) {
  const state = taskState(task.state);
  const operator = task.assignee ? operatorForWallet(task.assignee, operators) : null;

  return (
    <div className={`hive-task-row ${last ? "is-last" : ""} ${state.dim ? "is-dim" : ""}`}>
      <span className={`hive-task-dot ${state.ring ? "is-ring" : ""} is-${state.tone}`} />
      <span className="hive-task-main">
        <strong>{task.title}</strong>
        <small>
          <span className={`hive-action is-${task.state}`}>{state.label}</span>
          · {task.age}
        </small>
      </span>
      <span className="hive-task-assignee">
        {operator ? (
          <>
            <NftBadge size={20} variant={operator.badge} />
            <span>{operator.codename}</span>
          </>
        ) : (
          <em>unassigned</em>
        )}
      </span>
      <span className="hive-task-pft">
        <strong>{task.pft}</strong>
        <small>PFT</small>
      </span>
    </div>
  );
}

function ActivityRow({ entry, last = false, operators = {} }) {
  const operator = operatorForWallet(entry.wallet, operators);

  return (
    <div className={`hive-activity-row ${last ? "is-last" : ""}`}>
      <NftBadge size={22} variant={operator.badge} />
      <span className="hive-feed-operator">
        <strong>{operator.codename}</strong>
        <small>{entry.wallet}</small>
      </span>
      <span className={`hive-action is-${entry.action}`}>{actionLabel(entry.action)}</span>
      <span className="hive-feed-copy">{entry.task}</span>
      {entry.pft && <span className="hive-pft">+{entry.pft} PFT</span>}
      <time>{entry.time}</time>
    </div>
  );
}

function HiveContextPanel({ context, expanded, onToggle, status, secretary }) {
  const [rawOpen, setRawOpen] = useState(false);
  const groups = context?.groups || [];
  const entryCount = Number(context?.entryCount || 0);
  const userCount = Number(context?.userCount || groups.length || 0);
  const hasEntries = entryCount > 0;
  const report = secretary?.report || null;
  const reportOutput = report?.output || {};
  const pending = secretary?.job && ["pending", "processing"].includes(secretary.job.status);
  const statusText = status === "loading"
    ? "Loading"
    : status === "error"
      ? "Could not load"
      : hasEntries
        ? `${entryCount} ${entryCount === 1 ? "entry" : "entries"} from ${userCount} ${userCount === 1 ? "user" : "users"}`
        : "No Hive Input yet";

  return (
    <div className="hive-card hive-context-panel">
      <button className="hive-context-toggle" onClick={onToggle} type="button">
        <span>
          <strong>Hive Context</strong>
          <small>{statusText}</small>
        </span>
        <ChevronDown className={expanded ? "is-open" : ""} size={16} strokeWidth={1.8} />
      </button>
      {expanded && (
        <div className="hive-context-body">
          {!hasEntries && status !== "loading" && (
            <p className="hive-context-empty">Use Hive Input from Chat to add network context.</p>
          )}
          {(report || pending || hasEntries) && (
            <section className="hive-secretary">
              <header>
                <span>
                  <strong>Hive Secretary</strong>
                  <small>
                    {report?.completedAt
                      ? `Updated ${formatContextTime(report.completedAt)}`
                      : pending
                        ? "Updating from validated wallet inputs"
                        : "Waiting for validated wallet inputs"}
                  </small>
                </span>
                {report?.model && <code>{report.model}</code>}
              </header>
              {report ? (
                <div className="hive-secretary-report">
                  <h3>{reportOutput.title || "Hive Secretary Report"}</h3>
                  {reportOutput.summary && <p>{reportOutput.summary}</p>}
                  {Array.isArray(reportOutput.projectSignals) && reportOutput.projectSignals.length > 0 && (
                    <HiveSecretaryList
                      items={reportOutput.projectSignals.map((item) => [
                        item.projectType ? `${projectTypeLabel(item.projectType)}: ` : "",
                        item.signal || item.reason || "",
                      ].join(""))}
                      title="Project signals"
                    />
                  )}
                  <HiveSecretaryList items={reportOutput.networkImplications} title="Network implications" />
                  <HiveSecretaryList items={reportOutput.openQuestions} title="Open questions" />
                  <HiveSecretaryList items={reportOutput.nextSystemFocus} title="Next system focus" />
                </div>
              ) : (
                <p className="hive-context-empty">
                  The Secretary report is generated asynchronously from linked-wallet Hive Inputs.
                </p>
              )}
            </section>
          )}
          {hasEntries && (
            <section className="hive-context-raw">
              <button className="hive-context-raw-toggle" onClick={() => setRawOpen((open) => !open)} type="button">
                <span>
                  <strong>Raw inputs</strong>
                  <small>{entryCount} {entryCount === 1 ? "entry" : "entries"} from {userCount} {userCount === 1 ? "user" : "users"}</small>
                </span>
                <ChevronDown className={rawOpen ? "is-open" : ""} size={15} strokeWidth={1.8} />
              </button>
              {rawOpen && groups.map((group) => (
                <section className="hive-context-user" key={group.accountId || group.displayName}>
                  <header>
                    <strong>{group.displayName || "Unknown user"}</strong>
                    <small>{group.entryCount} {group.entryCount === 1 ? "entry" : "entries"}</small>
                  </header>
                  <div className="hive-context-entries">
                    {(group.entries || []).map((entry) => (
                      <article className="hive-context-entry" key={entry.id}>
                        <p>{entry.body}</p>
                        <footer>
                          <time>{formatContextTime(entry.createdAt)}</time>
                          {entry.walletValidated && <span>validated wallet</span>}
                        </footer>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function HiveSecretaryList({ items = [], title }) {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalized.length) return null;
  return (
    <section className="hive-secretary-list">
      <h4>{title}</h4>
      <ul>
        {normalized.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function projectTypeLabel(value = "") {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function operatorForWallet(wallet, operators = {}) {
  return operators[wallet] || { codename: "—", archetype: "", badge: 0, allotted: false, cap: 0, load: 0, status: "quiet" };
}

function formatPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: number % 1 === 0 ? 0 : 2,
  }).format(number);
}

function formatCompactPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number) < 1000) return formatPft(number);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

function formatContextTime(value = "") {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function NftBadge({ variant = 0, size = 28 }) {
  const palettes = [
    { bg: "#1A1A1A", fg: "#E24B4A" },
    { bg: "#0C447C", fg: "#85B7EB" },
    { bg: "#0F6E56", fg: "#9FE1CB" },
    { bg: "#1A1A1A", fg: "#EF9F27" },
    { bg: "#3C3489", fg: "#CECBF6" },
    { bg: "#1A1A1A", fg: "#5DCAA5" },
    { bg: "#72243E", fg: "#F4C0D1" },
    { bg: "#1A1A1A", fg: "#D85A30" },
  ];
  const palette = palettes[variant % palettes.length];
  const shape = variant % 8;

  return (
    <svg className="hive-nft-badge" height={size} viewBox="0 0 28 28" width={size}>
      <rect fill={palette.bg} height="28" width="28" />
      {shape === 0 && (
        <g fill={palette.fg} stroke={palette.fg}>
          <rect fill="none" height="19" strokeWidth="0.6" width="19" x="4.5" y="4.5" />
          <circle cx="14" cy="14" r="3" stroke="none" />
        </g>
      )}
      {shape === 1 && (
        <g fill={palette.fg}>
          <rect height="6" width="6" x="6" y="6" />
          <rect height="6" width="6" x="16" y="6" />
          <rect height="6" width="6" x="6" y="16" />
          <rect height="6" width="6" x="16" y="16" />
        </g>
      )}
      {shape === 2 && <path d="M 4 14 L 14 4 L 24 14 L 14 24 Z" fill={palette.fg} />}
      {shape === 3 && (
        <g fill="none" stroke={palette.fg} strokeWidth="0.8">
          <path d="M 4 4 L 24 24" />
          <path d="M 24 4 L 4 24" />
          <circle cx="14" cy="14" fill={palette.fg} r="4" />
        </g>
      )}
      {shape === 4 && (
        <g>
          <circle cx="14" cy="14" fill="none" r="8" stroke={palette.fg} strokeWidth="0.8" />
          <circle cx="14" cy="14" fill={palette.fg} r="3" />
        </g>
      )}
      {shape === 5 && <DotGrid fill={palette.fg} />}
      {shape === 6 && (
        <g>
          <rect fill="none" height="20" stroke={palette.fg} strokeWidth="0.6" width="20" x="4" y="4" />
          <rect fill="none" height="10" stroke={palette.fg} strokeWidth="0.6" width="10" x="9" y="9" />
          <rect fill={palette.fg} height="4" width="4" x="12" y="12" />
        </g>
      )}
      {shape === 7 && (
        <g>
          <path d="M 4 23 L 14 5 L 24 23 Z" fill="none" stroke={palette.fg} strokeWidth="0.8" />
          <circle cx="14" cy="17" fill={palette.fg} r="2.5" />
        </g>
      )}
    </svg>
  );
}

function DotGrid({ fill }) {
  const points = [5, 10, 15, 20];
  return (
    <g fill={fill}>
      {points.flatMap((y) =>
        points.map((x) => <circle cx={x} cy={y} key={`${x}-${y}`} r="1" />)
      )}
    </g>
  );
}

function actionLabel(action) {
  return (
    {
      proposed: "proposed",
      accepted: "accepted",
      submitted: "submitted",
      verification_requested: "v. requested",
      verification_response: "v. response",
      v_requested: "v. requested",
      v_response: "v. response",
      paid: "paid",
      refused: "refused",
    }[action] || action
  );
}

function taskState(state) {
  return (
    {
      proposed: { label: "proposed", tone: "amber", ring: true, dim: false },
      accepted: { label: "accepted", tone: "green", ring: false, dim: false },
      submitted: { label: "submitted", tone: "green", ring: false, dim: false },
      verification_requested: { label: "v. requested", tone: "amber", ring: false, dim: false },
      verification_response: { label: "v. response", tone: "green", ring: false, dim: false },
      paid: { label: "paid", tone: "muted", ring: false, dim: true },
      refused: { label: "refused", tone: "muted", ring: true, dim: true },
    }[state] || { label: "proposed", tone: "amber", ring: true, dim: false }
  );
}
