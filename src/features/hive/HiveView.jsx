import React, { useState } from "react";
import { Activity, ArrowLeft, ChevronRight } from "lucide-react";
import {
  operatorForWallet,
  operators,
  projectPreviewContributors,
  projects,
  projectTaskCount,
  routingFeed,
} from "./hive-data";
import "./hive.css";

export function HiveView() {
  const [selectedProject, setSelectedProject] = useState(null);

  return (
    <div className="route-scroll hive-route">
      {selectedProject ? (
        <ProjectDetail projectId={selectedProject} onBack={() => setSelectedProject(null)} />
      ) : (
        <HiveIndex onSelectProject={setSelectedProject} />
      )}
    </div>
  );
}

function HiveIndex({ onSelectProject }) {
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
          <Stat label="Operators online" value="47" />
          <Stat label="Tasks in flight" value="124" />
          <Stat label="PFT routed · 24h" value="1.8k" accent />
        </div>
      </header>

      <Section title="Active projects" subtitle="What the hive is routing operators to">
        <div className="hive-project-grid">
          {Object.entries(projects).map(([id, project]) => (
            <ProjectCard key={id} id={id} project={project} onClick={() => onSelectProject(id)} />
          ))}
        </div>
      </Section>

      <Section title="Routing feed" subtitle="Recent state transitions across the network">
        <div className="hive-card hive-feed">
          {routingFeed.map((entry, index) => (
            <FeedRow entry={entry} key={`${entry.wallet}-${entry.task}`} last={index === routingFeed.length - 1} />
          ))}
        </div>
      </Section>

      <Section title="Allotted operators" subtitle="Full-time nodes the hive routes to first">
        <div className="hive-card">
          {Object.entries(operators)
            .filter(([, operator]) => operator.allotted)
            .map(([wallet], index, list) => (
              <AllottedOperatorRow key={wallet} wallet={wallet} last={index === list.length - 1} />
            ))}
        </div>
      </Section>
    </div>
  );
}

function ProjectDetail({ projectId, onBack }) {
  const project = projects[projectId];
  if (!project) return null;
  const fullProject = project.contributors?.length > 0;

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
          <Stat label="Tasks" value={projectTaskCount[projectId] || project.tasks.length} />
          <Stat label="Contributors" value={project.contributors?.length || 0} />
          <Stat label="PFT routed" value={project.pft} accent />
        </div>
      </header>

      {fullProject ? (
        <>
          <Section title="About" subtitle="What this project is" layerNumber="01">
            <div className="hive-card hive-about">
              <p>{project.about}</p>
              <div className="hive-about-meta">
                <span>
                  <small>Proposed by hive</small>
                  <strong>{project.proposed}</strong>
                </span>
                <span>
                  <small>Phase</small>
                  <strong>{project.phase}</strong>
                </span>
              </div>
            </div>
          </Section>

          <Section title="Contributors" subtitle={`${project.contributors.length} operators have earned PFT on this project`} layerNumber="02">
            <div className="hive-contributor-grid">
              {project.contributors.map((contributor) => (
                <ContributorCard contributor={contributor} key={contributor.wallet} />
              ))}
            </div>
          </Section>

          <Section title="Tasks" subtitle={`${project.tasks.length} tasks across all states`} layerNumber="03">
            <div className="hive-card">
              {project.tasks.map((task, index) => (
                <ProjectTaskRow key={`${task.title}-${task.state}`} last={index === project.tasks.length - 1} task={task} />
              ))}
            </div>
          </Section>

          <Section title="Activity" subtitle="Recent events scoped to this project" layerNumber="04">
            <div className="hive-card">
              {project.activity.map((entry, index) => (
                <ActivityRow entry={entry} key={`${entry.wallet}-${entry.task}`} last={index === project.activity.length - 1} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <div className="hive-empty-project">Full project view available for PFT distribution v3 in this mock. Other projects show summary only.</div>
      )}
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

function ProjectCard({ id, project, onClick }) {
  const previewWallets = (projectPreviewContributors[id] || []).slice(0, 4);
  const contributorCount = (projectPreviewContributors[id] || []).length;
  const taskCount = projectTaskCount[id] || 0;

  return (
    <button className="hive-project-card" onClick={onClick} type="button">
      <span className="hive-project-card-title">{project.name}</span>
      <span className="hive-project-type">{project.type}</span>
      <p>{project.summary}</p>
      <span className="hive-card-contributors">
        <span className="hive-badge-stack">
          {previewWallets.map((wallet, index) => (
            <span className="hive-badge-wrap" key={wallet} style={{ marginLeft: index === 0 ? 0 : -8 }}>
              <NftBadge size={22} variant={operatorForWallet(wallet).badge} />
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
        <span className="hive-pft">{project.pft} PFT</span>
        <ChevronRight size={14} strokeWidth={1.8} />
      </span>
    </button>
  );
}

function FeedRow({ entry, last = false }) {
  const operator = operatorForWallet(entry.wallet);
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
      {entry.pft && <span className="hive-pft">+{entry.pft} PFT</span>}
      <time>{entry.time}</time>
    </div>
  );
}

function AllottedOperatorRow({ wallet, last = false }) {
  const operator = operatorForWallet(wallet);
  const loadPercent = Math.round((operator.load / operator.cap) * 100);
  const active = operator.status === "active";

  return (
    <div className={`hive-operator-row ${last ? "is-last" : ""}`}>
      <NftBadge size={26} variant={operator.badge} />
      <span className="hive-operator-id">
        <strong>{operator.codename}</strong>
        <small>{wallet}</small>
      </span>
      <span className={`hive-presence ${active ? "is-active" : "is-quiet"}`} />
      <span className="hive-operator-role">{operator.archetype}</span>
      <span className="hive-load">
        <span>
          <i style={{ width: `${loadPercent}%` }} />
        </span>
        <small>
          {operator.load}/{operator.cap}
        </small>
      </span>
    </div>
  );
}

function ContributorCard({ contributor }) {
  const operator = operatorForWallet(contributor.wallet);

  return (
    <div className="hive-contributor-card">
      <NftBadge size={36} variant={operator.badge} />
      <div className="hive-contributor-main">
        <span>
          <strong>{operator.codename}</strong>
          {contributor.role === "lead" && <small>lead</small>}
        </span>
        <code>{contributor.wallet}</code>
        <p>{operator.archetype}</p>
      </div>
      <div className="hive-contributor-metrics">
        <span>
          <strong>{contributor.tasks}</strong> tasks
        </span>
        <span className="hive-pft">{contributor.pft} PFT</span>
        <small>active {contributor.lastActive}</small>
      </div>
    </div>
  );
}

function ProjectTaskRow({ task, last = false }) {
  const state = taskState(task.state);
  const operator = task.assignee ? operatorForWallet(task.assignee) : null;

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

function ActivityRow({ entry, last = false }) {
  const operator = operatorForWallet(entry.wallet);

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
