import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Flag, X } from "lucide-react";
import { requestJson } from "../../api";
import { transactionExplorerHref } from "../../pftl-explorer.js";
import { profileNftImageCandidates } from "../profile/profile-nft-images.js";
import "./hive.css";

const PROJECT_DETAIL_PAGE_SIZE = 8;

function validProjectDocument(document) {
  return Boolean(
    document &&
      typeof document === "object" &&
      !Array.isArray(document) &&
      document.projects &&
      typeof document.projects === "object" &&
      !Array.isArray(document.projects) &&
      Array.isArray(document.projectIds)
  );
}

export function HiveView({ pftlExplorerUrl = "" }) {
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedHiveTask, setSelectedHiveTask] = useState(null);
  const [projectDocument, setProjectDocument] = useState(null);
  const [projectStatus, setProjectStatus] = useState("loading");
  const lastGoodProjectDocument = useRef(null);
  const projectRequestSeq = useRef(0);
  const openHiveTask = useCallback((task) => {
    if (task?.taskId) setSelectedHiveTask(task);
  }, []);

  const loadProjectDocument = useCallback(async ({ showLoading = false, shouldApply = () => true } = {}) => {
    const requestSeq = projectRequestSeq.current + 1;
    projectRequestSeq.current = requestSeq;
    const canApply = () => shouldApply() && projectRequestSeq.current === requestSeq;
    if (showLoading && canApply() && !lastGoodProjectDocument.current) setProjectStatus("loading");
    try {
      const result = await requestJson("/api/hive/projects");
      if (!canApply()) return;
      if (!result.ok) throw new Error(result.body?.message || `Hive projects returned HTTP ${result.status}.`);
      const nextDocument = result.body?.document || null;
      if (!validProjectDocument(nextDocument)) throw new Error("Hive projects returned an invalid document.");
      lastGoodProjectDocument.current = nextDocument;
      setProjectDocument(nextDocument);
      setProjectStatus("ready");
    } catch {
      if (!canApply()) return;
      if (lastGoodProjectDocument.current) {
        setProjectDocument(lastGoodProjectDocument.current);
        setProjectStatus("ready");
        return;
      }
      setProjectDocument(null);
      setProjectStatus("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadProjectDocument({ showLoading: true, shouldApply: () => !cancelled });
    const intervalId = window.setInterval(() => {
      loadProjectDocument({ shouldApply: () => !cancelled });
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [loadProjectDocument]);

  return (
    <div className="route-scroll hive-route">
      {selectedProject ? (
        <ProjectDetail
          onBack={() => setSelectedProject(null)}
          onOpenTask={openHiveTask}
          operators={projectDocument?.operators || {}}
          pftlExplorerUrl={pftlExplorerUrl}
          project={projectDocument?.projects?.[selectedProject] || null}
          status={projectStatus}
        />
      ) : (
        <HiveIndex
          onSelectProject={setSelectedProject}
          onOpenTask={openHiveTask}
          pftlExplorerUrl={pftlExplorerUrl}
          projectDocument={projectDocument}
          projectStatus={projectStatus}
        />
      )}
      {selectedHiveTask && (
        <HiveTaskPopout
          initialTask={selectedHiveTask}
          onClose={() => setSelectedHiveTask(null)}
          pftlExplorerUrl={pftlExplorerUrl}
        />
      )}
    </div>
  );
}

function HiveIndex({ onOpenTask, onSelectProject, pftlExplorerUrl = "", projectDocument, projectStatus }) {
  const [hiveContext, setHiveContext] = useState(null);
  const [hiveSecretary, setHiveSecretary] = useState(null);
  const [boardManager, setBoardManager] = useState(null);
  const [hiveContextOpen, setHiveContextOpen] = useState(false);
  const [hiveContextStatus, setHiveContextStatus] = useState("loading");
  const stats = projectDocument?.stats || {};

  const loadHiveContext = useCallback(async ({ showLoading = false, shouldApply = () => true } = {}) => {
    if (showLoading && shouldApply()) {
      setHiveContextStatus("loading");
    }
    try {
      const result = await requestJson("/api/hive/context?limit=120&agentLogs=full");
      if (!shouldApply()) return;
      if (!result.ok) throw new Error(result.body?.message || `Hive Context returned HTTP ${result.status}.`);
      setHiveContext(result.body?.context || null);
      setHiveSecretary(result.body?.secretary || null);
      setBoardManager(result.body?.boardManager || null);
      setHiveContextStatus("ready");
    } catch {
      if (!shouldApply()) return;
      setHiveContext(null);
      setBoardManager(null);
      setHiveContextStatus("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadHiveContext({ showLoading: true, shouldApply: () => !cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadHiveContext]);

  useEffect(() => {
    if (!hiveContextOpen) return undefined;
    loadHiveContext();
    const intervalId = window.setInterval(() => {
      loadHiveContext();
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [hiveContextOpen, loadHiveContext]);

  const toggleHiveContext = useCallback(() => {
    setHiveContextOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) loadHiveContext();
      return nextOpen;
    });
  }, [loadHiveContext]);

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
          <Stat label="Active projects" value={projectStatus === "ready" ? stats.activeProjects || 0 : "—"} />
          <Stat label="Open tasks" value={projectStatus === "ready" ? stats.tasksInFlight || 0 : "—"} />
          <Stat label="PFT routed" value={projectStatus === "ready" ? formatCompactPft(stats.pftRouted) : "—"} accent />
        </div>
      </header>

      <Section title="Active projects" subtitle="What the hive is routing operators to">
        <ProjectGrid
          document={projectDocument}
          onOpenTask={onOpenTask}
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
              onOpenTask={onOpenTask}
              operators={projectDocument?.operators || {}}
              pftlExplorerUrl={pftlExplorerUrl}
              project={projectDocument?.projects?.[entry.projectId] || { name: entry.project }}
            />
          ))}
          {projectStatus === "loading" && <div className="hive-empty-project">Loading project feed.</div>}
          {projectStatus === "error" && <div className="hive-empty-project">Project feed is unavailable.</div>}
          {projectStatus === "ready" && !(projectDocument?.routingFeed || []).length && (
            <div className="hive-empty-project">No project-linked routing events yet.</div>
          )}
        </div>
      </Section>

      <Section title="Allotted operators" subtitle="Operators currently routed by live project tasks">
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
          {projectStatus === "ready" && !Object.values(projectDocument?.operators || {}).some((operator) => operator.allotted) && (
            <div className="hive-empty-project">No operators are allocated to active network projects yet.</div>
          )}
        </div>
      </Section>

      <Section title="Hive Context" subtitle="User-submitted network context, grouped by contributor">
        <HiveContextPanel
          context={hiveContext}
          expanded={hiveContextOpen}
          onToggle={toggleHiveContext}
          status={hiveContextStatus}
          secretary={hiveSecretary}
          boardManager={boardManager}
        />
      </Section>
    </div>
  );
}

function ProjectGrid({ document, onOpenTask, onSelectProject, status }) {
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
          onOpenTask={onOpenTask}
          operators={document?.operators || {}}
          project={projects[id] || {}}
          onClick={() => onSelectProject(id)}
        />
      ))}
    </div>
  );
}

function ProjectDetail({ onBack, onOpenTask, operators, pftlExplorerUrl = "", project, status }) {
  const [taskPage, setTaskPage] = useState(1);
  const [activityPage, setActivityPage] = useState(1);
  const projectTasks = project?.tasks || [];
  const projectActivity = project?.activity || [];
  const taskPageState = paginateRows(projectTasks, taskPage, PROJECT_DETAIL_PAGE_SIZE);
  const activityPageState = paginateRows(projectActivity, activityPage, PROJECT_DETAIL_PAGE_SIZE);

  useEffect(() => {
    setTaskPage(1);
    setActivityPage(1);
  }, [project?.id]);

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
          <Stat label="Task rows" value={projectTasks.length} />
          <Stat label="Operators" value={project.contributors?.length || 0} />
          <Stat label="PFT routed" value={formatPft(project.pft)} accent />
        </div>
      </header>

      <Section title="About" subtitle="What this project is" layerNumber="01">
        <div className="hive-card hive-about">
          <p>{project.about || project.objective || project.summary}</p>
          <ProjectStatusDocument document={project.productDocument} />
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

      <Section title="Activity" subtitle="Recent events scoped to this project" layerNumber="02">
        <div className="hive-card">
          {projectActivity.length ? (
            <>
              {activityPageState.rows.map((entry, index) => (
                <ActivityRow
                  entry={entry}
                  key={entry.id || `${entry.wallet}-${entry.task}`}
                  last={index === activityPageState.rows.length - 1}
                  onOpenTask={onOpenTask}
                  operators={operators}
                  pftlExplorerUrl={pftlExplorerUrl}
                  project={project}
                />
              ))}
              <PaginationControls
                label="Activity"
                onPageChange={setActivityPage}
                page={activityPageState.page}
                pageCount={activityPageState.pageCount}
                pageSize={PROJECT_DETAIL_PAGE_SIZE}
                total={projectActivity.length}
              />
            </>
          ) : (
            <div className="hive-empty-project">Project activity will populate as project-linked tasks move.</div>
          )}
        </div>
      </Section>

      <Section title="Contributors" subtitle={contributorsSubtitle(project)} layerNumber="03">
        {project.contributors.length ? (
          <div className="hive-contributor-grid">
            {project.contributors.map((contributor) => (
              <ContributorCard contributor={contributor} key={contributor.wallet} />
            ))}
          </div>
        ) : (
          <div className="hive-card hive-empty-project">Contributors will populate after live network tasks are allocated and rewarded.</div>
        )}
      </Section>

      <Section title="Tasks" subtitle={tasksSubtitle(project)} layerNumber="04">
        <div className="hive-card">
          {projectTasks.length ? (
            <>
              {taskPageState.rows.map((task, index) => (
                <ProjectTaskRow
                  key={task.id || `${task.title}-${task.state}`}
                  last={index === taskPageState.rows.length - 1}
                  onOpenTask={onOpenTask}
                  operators={operators}
                  pftlExplorerUrl={pftlExplorerUrl}
                  project={project}
                  task={task}
                />
              ))}
              <PaginationControls
                label="Tasks"
                onPageChange={setTaskPage}
                page={taskPageState.page}
                pageCount={taskPageState.pageCount}
                pageSize={PROJECT_DETAIL_PAGE_SIZE}
                total={projectTasks.length}
              />
            </>
          ) : (
            <div className="hive-empty-project">Network tasks will appear after the allocation worker creates PFTL task offers for this project.</div>
          )}
        </div>
      </Section>
    </div>
  );
}

function PaginationControls({ label, onPageChange, page, pageCount, pageSize, total }) {
  if (total <= pageSize) return null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="hive-pagination">
      <span>{label}: {start}-{end} of {total}</span>
      <div>
        <button
          disabled={page <= 1}
          onClick={() => onPageChange((current) => Math.max(1, current - 1))}
          type="button"
        >
          Previous
        </button>
        <button
          disabled={page >= pageCount}
          onClick={() => onPageChange((current) => Math.min(pageCount, current + 1))}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function ProjectStatusDocument({ document }) {
  const [expanded, setExpanded] = useState(false);
  if (!document) {
    return (
      <div className="hive-project-doc is-empty">
        <span>Project Status</span>
        <p>Project status has not been generated yet.</p>
      </div>
    );
  }
  const metadata = [
    document.boardManagerRunId ? "Board Manager" : "",
    document.model || "",
    document.promptVersion || "",
  ].filter(Boolean);
  return (
    <div className={`hive-project-doc ${expanded ? "is-expanded" : ""}`}>
      <button
        aria-expanded={expanded}
        className="hive-project-doc-toggle"
        onClick={() => setExpanded((open) => !open)}
        type="button"
      >
        <span>
          <strong>Project Status</strong>
          {document.createdAt && <time>{formatContextTime(document.createdAt)}</time>}
        </span>
        <ChevronDown className={expanded ? "is-open" : ""} size={16} strokeWidth={1.8} />
      </button>
      <div className="hive-project-doc-preview">
        {document.summary && <p>{document.summary}</p>}
        {expanded && document.projectStatus && <p>{document.projectStatus}</p>}
      </div>
      {expanded && (
        <>
          <ProjectDocList items={document.keyPoints} title="Key execution points" />
          <ProjectDocList items={document.blockedOrUnclear} title="Blocked or unclear" />
          <ProjectDocList items={document.nextActions} title="Next actions" />
          <footer>
            {metadata.map((item) => <span key={item}>{item}</span>)}
          </footer>
        </>
      )}
    </div>
  );
}

function ProjectDocList({ items = [], title }) {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalized.length) return null;
  return (
    <section className="hive-project-doc-list">
      <h3>{title}</h3>
      <ul>
        {normalized.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </section>
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

function ProjectCard({ onOpenTask, operators, project, onClick }) {
  const previewWallets = (project.contributors || []).map((contributor) => contributor.wallet).slice(0, 4);
  const contributorCount = project.contributors?.length || 0;
  const taskCount = project.tasks?.length || 0;
  const pendingGenerationCount = Number(project.pendingGenerationCount || 0);
  const hasAllocatedContributors = previewWallets.length > 0;
  const nextTask = project.nextTask || null;

  return (
    <article className="hive-project-card">
      <button className="hive-project-card-main" onClick={onClick} type="button">
        <span className="hive-project-card-title">{project.name}</span>
        <span className="hive-project-type">{project.type}</span>
        <p>{project.summary}</p>
      </button>
      <ProjectNextTaskPreview
        nextTask={nextTask}
        onOpenTask={onOpenTask}
        operators={operators}
        pendingGenerationCount={pendingGenerationCount}
        project={project}
      />
      <span className="hive-card-contributors">
        {hasAllocatedContributors && (
          <span className="hive-badge-stack">
            {previewWallets.map((wallet, index) => (
              <span className="hive-badge-wrap" key={wallet} style={{ marginLeft: index === 0 ? 0 : -8 }}>
                <HiveProfileBadge
                  nft={operatorForWallet(wallet, operators).nft}
                  size={22}
                  variant={operatorForWallet(wallet, operators).badge}
                />
              </span>
            ))}
          </span>
        )}
        <span>
          {`${contributorCount} ${contributorCount === 1 ? "operator" : "operators"}`}
          {pendingGenerationCount > 0 && (
            <small>{pendingGenerationCount} pending generation{pendingGenerationCount === 1 ? "" : "s"}</small>
          )}
        </span>
      </span>
      <button className="hive-project-card-foot" onClick={onClick} type="button">
        <span>
          <strong>{taskCount}</strong> task {taskCount === 1 ? "row" : "rows"}
        </span>
        <span className="hive-pft">{formatPft(project.pft)} PFT routed</span>
        <ChevronRight size={14} strokeWidth={1.8} />
      </button>
    </article>
  );
}

function ProjectNextTaskPreview({ nextTask, onOpenTask, operators = {}, pendingGenerationCount = 0, project = {} }) {
  if (nextTask) {
    const canOpen = Boolean(nextTask.taskId && onOpenTask);
    const TaskTag = canOpen ? "button" : "span";
    const taskProps = canOpen
      ? {
          onClick: () => onOpenTask(hiveTaskSeed(nextTask, { operators, project })),
          type: "button",
        }
      : {};
    return (
      <TaskTag className={`hive-project-next-task${canOpen ? " is-clickable" : ""}`} {...taskProps}>
        <small>{nextTask.viewerScoped ? "Your active task" : "Next reward task"}</small>
        <strong>{nextTask.title}</strong>
        <em>{actionLabel(nextTask.state)} · {formatPft(nextTask.pft)} PFT</em>
        {nextTask.nextAction && <span>{nextTask.nextAction}</span>}
      </TaskTag>
    );
  }
  const blocker = pendingGenerationCount > 0
    ? `${pendingGenerationCount} generation ${pendingGenerationCount === 1 ? "job is" : "jobs are"} queued.`
    : "No reward-bearing task is available on this project right now.";
  return (
    <span className="hive-project-next-task is-empty">
      <small>Next reward task</small>
      <strong>{blocker}</strong>
    </span>
  );
}

function profileHref(accountId = "") {
  const normalized = String(accountId || "").trim();
  return normalized ? `#/profile?account=${encodeURIComponent(normalized)}` : "";
}

function operatorHandle(operator = {}) {
  return String(operator.hiveHandle || operator.handle || "").replace(/^@+/, "").trim();
}

function operatorDisplayName(operator = {}, wallet = "") {
  const handle = operatorHandle(operator);
  return operator.codename || operator.displayName || operator.publicDisplayName || (handle ? `@${handle}` : "") || compactWallet(wallet);
}

function MachineOperatorBadge({ className = "", disclosure = null }) {
  if (!disclosure?.isMachineOperator) return null;
  return (
    <span className={`hive-machine-badge ${className}`}>
      {disclosure.label || "Orc operator"}
    </span>
  );
}

function HiveProfileIdentity({
  children = null,
  className = "",
  copyClassName = "",
  operator = {},
  showBadge = true,
  size = 20,
  wallet = "",
}) {
  const accountId = String(operator.accountId || "").trim();
  const canLink = Boolean(accountId && operator.hasPublicProfile);
  const href = canLink ? profileHref(accountId) : "";
  const label = operatorDisplayName(operator, wallet);
  const walletLabel = compactWallet(wallet);
  const handle = operatorHandle(operator);
  const secondary = handle ? `@${handle}${wallet ? ` · ${walletLabel}` : ""}` : walletLabel;
  const Tag = canLink ? "a" : "span";
  const tagProps = canLink
    ? {
        href,
        onClick: (event) => event.stopPropagation(),
        "aria-label": `Open ${label} public profile`,
      }
    : {};

  return (
    <Tag className={`hive-profile-identity ${className} ${canLink ? "is-link" : ""}`} {...tagProps}>
      {showBadge && <HiveProfileBadge nft={operator.nft} size={size} variant={operator.badge || 0} />}
      <span className={`hive-profile-copy ${copyClassName}`}>
        <strong>{label}</strong>
        {secondary && label !== secondary && <small>{secondary}</small>}
        <MachineOperatorBadge disclosure={operator.operatorDisclosure} />
        {children}
      </span>
      {canLink && <ArrowUpRight className="hive-profile-go" size={13} strokeWidth={1.8} />}
    </Tag>
  );
}

function assigneeForTask(task = {}, operators = {}) {
  const wallet = task.assignee || task.wallet || "";
  const operator = wallet ? operatorForWallet(wallet, operators) : {};
  return wallet
    ? {
        wallet,
        accountId: task.assigneeAccountId || operator.accountId || task.accountId || "",
        codename: task.assigneeDisplayName || operator.codename || compactWallet(wallet),
        handle: task.assigneeHandle || operator.hiveHandle || task.hiveHandle || "",
        hasPublicProfile: Boolean(task.assigneeHasPublicProfile || operator.hasPublicProfile || task.hasPublicProfile),
        badge: operator.badge || task.badge || 0,
        nft: task.assigneeNft || operator.nft || null,
        operatorDisclosure: task.assigneeOperatorDisclosure || operator.operatorDisclosure || task.operatorDisclosure || null,
      }
    : null;
}

function hiveTaskSeed(source = {}, { operators = {}, project = {} } = {}) {
  const taskId = source.taskId || source.task_id || "";
  const assignee = assigneeForTask(source, operators);
  const proofTxHash = source.proofTxHash || source.rewardTxHash || source.lastEventTxHash || source.txHash || source.paymentTxHash || "";
  const proofCid = source.proofCid || source.rewardCid || source.lastEventCid || source.cid || source.paymentCid || "";
  return {
    id: taskId || source.id || "",
    taskId,
    title: source.title || source.task || "Hive task",
    kind: "Network task",
    state: source.state || source.action || "proposed",
    pft: Number(source.pft || source.rewardPft || 0),
    age: source.age || source.time || source.updatedAt || "",
    summary: source.summary || source.description || "",
    nextAction: source.nextAction || taskNextAction(source.state || source.action),
    proofTxHash,
    proofCid,
    project: {
      id: source.projectId || project.id || "",
      name: source.project || project.name || "",
      type: source.projectType || project.type || "",
    },
    assignee,
    review: null,
    timeline: [],
  };
}

function hiveTaskClickProps(seed = {}, onOpenTask = null) {
  if (!seed.taskId || typeof onOpenTask !== "function") return { className: "", props: {} };
  return {
    className: "is-clickable",
    props: {
      onClick: (event) => {
        if (event.target?.closest?.("a,button")) return;
        onOpenTask(seed);
      },
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenTask(seed);
      },
      role: "button",
      tabIndex: 0,
    },
  };
}

function HiveProofAction({ onOpenTask, pftlExplorerUrl = "", seed = {} }) {
  const state = String(seed.state || seed.action || "").trim().toLowerCase();
  if (!["rewarded", "paid"].includes(state)) return null;
  const txHash = String(seed.proofTxHash || "").trim();
  const cid = String(seed.proofCid || "").trim();
  const href = transactionExplorerHref(txHash, pftlExplorerUrl);
  const label = txHash ? `Proof tx ${shortPublicReference(txHash)}` : cid ? `Proof cid ${shortPublicReference(cid)}` : "Proof";
  if (!txHash && !cid) return null;
  if (href) {
    return (
      <a
        aria-label={`Open reward transaction ${txHash}`}
        className="hive-proof-action"
        href={href}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        title={txHash}
      >
        <span>{label}</span>
        <ArrowUpRight size={12} strokeWidth={1.8} />
      </a>
    );
  }
  if (!seed.taskId || typeof onOpenTask !== "function") return null;
  return (
    <button
      aria-label={txHash ? `View reward proof ${txHash}` : `View reward proof ${cid}`}
      className="hive-proof-action"
      onClick={(event) => {
        event.stopPropagation();
        onOpenTask(seed);
      }}
      title={txHash || cid}
      type="button"
    >
      <span>{label}</span>
      <ArrowUpRight size={12} strokeWidth={1.8} />
    </button>
  );
}

function FeedRow({ entry, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
  const operator = operatorForWallet(entry.wallet, operators);
  const timeLabel = String(entry.time || "").trim();
  const showTime = timeLabel && timeLabel.toLowerCase() !== "indexed";
  const seed = hiveTaskSeed(entry, { operators, project });
  const clickProps = hiveTaskClickProps(seed, onOpenTask);
  return (
    <div className={`hive-feed-row ${last ? "is-last" : ""} ${clickProps.className}`} {...clickProps.props}>
      <HiveProfileIdentity
        className="hive-feed-profile"
        operator={operator}
        size={24}
        wallet={entry.wallet}
      />
      <span className={`hive-action is-${entry.action}`}>{actionLabel(entry.action)}</span>
      <span className="hive-feed-copy">
        {entry.task}
        <small>· {entry.project}</small>
      </span>
      {entry.pft !== null && entry.pft !== undefined && <span className="hive-pft">+{formatPft(entry.pft)} PFT</span>}
      <HiveProofAction onOpenTask={onOpenTask} pftlExplorerUrl={pftlExplorerUrl} seed={seed} />
      {showTime && <time>{timeLabel}</time>}
    </div>
  );
}

function AllottedOperatorRow({ wallet, operator, last = false }) {
  const resolvedOperator = operator || operatorForWallet(wallet);
  const loadPercent = resolvedOperator.cap ? Math.round((resolvedOperator.load / resolvedOperator.cap) * 100) : 0;
  const active = resolvedOperator.status === "active";
  const focusTask = (resolvedOperator.currentTasks || [])[0] || null;

  return (
    <div className={`hive-operator-row ${last ? "is-last" : ""}`}>
      <HiveProfileIdentity
        className="hive-operator-profile"
        copyClassName="hive-operator-id"
        operator={resolvedOperator}
        size={26}
        wallet={wallet}
      />
      <span className={`hive-presence ${active ? "is-active" : "is-quiet"}`} />
      <span className="hive-operator-role">
        <span>{resolvedOperator.archetype}</span>
        {focusTask && (
          <small>Working on {focusTask.title}{focusTask.projectName ? ` · ${focusTask.projectName}` : ""}</small>
        )}
      </span>
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
  const focusTask = (contributor.currentTasks || [])[0] || null;
  return (
    <div className="hive-contributor-card">
      <HiveProfileBadge nft={contributor.nft} size={36} variant={contributor.badge} />
      <div className="hive-contributor-main">
        <HiveProfileIdentity
          className="hive-contributor-profile"
          copyClassName="hive-contributor-title"
          operator={contributor}
          showBadge={false}
          wallet={contributor.wallet}
        >
          {contributor.role === "lead" && <small>lead</small>}
        </HiveProfileIdentity>
        <code>{contributor.wallet}</code>
        <p>{focusTask ? `Working on ${focusTask.title}` : contributor.archetype}</p>
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

function ProjectTaskRow({ task, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
  const state = taskState(task.state);
  const age = String(task.age || "").trim();
  const nextAction = task.nextAction || taskNextAction(task.state);
  const assignee = assigneeForTask(task, operators);
  const seed = hiveTaskSeed(task, { operators, project });
  const clickProps = hiveTaskClickProps(seed, onOpenTask);

  return (
    <div className={`hive-task-row ${last ? "is-last" : ""} ${state.dim ? "is-dim" : ""} ${clickProps.className}`} {...clickProps.props}>
      <span className={`hive-task-dot ${state.ring ? "is-ring" : ""} is-${state.tone}`} />
      <span className="hive-task-main">
        <strong>{task.title}</strong>
        <small className="hive-task-state-line">
          <span className={`hive-action is-${state.key}`}>{state.label}</span>
          {age ? <> · {age}</> : null}
        </small>
        {nextAction && <small className="hive-task-next">Next: {nextAction}</small>}
        {(seed.proofTxHash || seed.proofCid) && (
          <small className="hive-task-proof-line">
            <HiveProofAction onOpenTask={onOpenTask} pftlExplorerUrl={pftlExplorerUrl} seed={seed} />
          </small>
        )}
      </span>
      <span className="hive-task-assignee">
        {assignee ? (
          <HiveProfileIdentity
            className="hive-task-assignee-profile"
            copyClassName="hive-task-assignee-label"
            operator={assignee}
            size={20}
            wallet={assignee.wallet}
          />
        ) : (
          <em>unassigned</em>
        )}
      </span>
      <span className="hive-task-pft">
        <strong>{formatPft(task.pft)}</strong>
        <small>PFT</small>
      </span>
    </div>
  );
}

function HiveProfileBadge({ nft = null, size = 20, variant = 0 }) {
  const imageCandidates = useMemo(() => profileNftImageCandidates(nft || {}, { avatarCssSize: size }), [nft, size]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  if (!imageSrc) return <NftBadge size={size} variant={variant} />;

  return (
    <img
      alt={nft?.title || "Profile NFT"}
      className="hive-profile-badge"
      decoding="async"
      height={size}
      loading="lazy"
      onError={() => setImageIndex((index) => index + 1)}
      src={imageSrc}
      width={size}
    />
  );
}

function ActivityRow({ entry, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
  const state = taskState(entry.action);
  const operator = operatorForWallet(entry.wallet, operators);
  const timeLabel = String(entry.time || "").trim() || formatContextTime(entry.updatedAt || entry.createdAt);
  const hasPft = entry.pft !== null && entry.pft !== undefined && entry.pft !== "";
  const nextAction = entry.nextAction || taskNextAction(entry.action);
  const profileOperator = {
    ...operator,
    accountId: entry.accountId || operator.accountId || "",
    codename: entry.displayName || operator.codename || compactWallet(entry.wallet),
    handle: entry.hiveHandle || operator.hiveHandle || "",
    hasPublicProfile: Boolean(entry.hasPublicProfile || operator.hasPublicProfile),
    operatorDisclosure: entry.operatorDisclosure || operator.operatorDisclosure || null,
    nft: entry.nft || operator.nft || null,
  };
  const seed = hiveTaskSeed(entry, { operators, project });
  const clickProps = hiveTaskClickProps(seed, onOpenTask);

  return (
    <div className={`hive-task-row hive-activity-task-row ${last ? "is-last" : ""} ${state.dim ? "is-dim" : ""} ${clickProps.className}`} {...clickProps.props}>
      <span className={`hive-task-dot ${state.ring ? "is-ring" : ""} is-${state.tone}`} />
      <span className="hive-task-main">
        <strong>{entry.task || "Project activity"}</strong>
        <small className="hive-task-state-line">
          <span className={`hive-action is-${state.key}`}>{state.label}</span>
          {timeLabel ? <> · {timeLabel}</> : null}
        </small>
        {nextAction && <small className="hive-task-next">Acknowledged: {nextAction}</small>}
        {(seed.proofTxHash || seed.proofCid) && (
          <small className="hive-task-proof-line">
            <HiveProofAction onOpenTask={onOpenTask} pftlExplorerUrl={pftlExplorerUrl} seed={seed} />
          </small>
        )}
      </span>
      <span className="hive-task-assignee">
        <HiveProfileIdentity
          className="hive-task-assignee-profile"
          copyClassName="hive-task-assignee-label"
          operator={profileOperator}
          size={20}
          wallet={entry.wallet}
        />
      </span>
      <span className={`hive-task-pft ${hasPft ? "" : "is-empty"}`}>
        <strong>{hasPft ? formatPft(entry.pft) : "—"}</strong>
        <small>PFT</small>
      </span>
    </div>
  );
}

const HIVE_TASK_LIFECYCLE = [
  { key: "proposed", label: "Proposed" },
  { key: "accepted", label: "Accepted" },
  { key: "submitted", label: "Submitted" },
  { key: "verification", label: "Verification" },
  { key: "rewarded", label: "Rewarded" },
];

const HIVE_TASK_TONES = {
  proposed: "amber",
  accepted: "green",
  submitted: "green",
  verification_requested: "amber",
  verification_response_submitted: "green",
  verification_response: "green",
  reward_decided: "muted",
  rewarded: "muted",
  paid: "muted",
};

function hiveTaskLifecycleIndex(state = "") {
  const key = String(state || "").toLowerCase();
  if (["rewarded", "paid", "reward_decided"].includes(key)) return 4;
  if (["verification_requested", "verification_response_submitted", "verification_response"].includes(key)) return 3;
  if (key === "submitted") return 2;
  if (key === "accepted") return 1;
  return 0;
}

function hiveTaskTone(state = "") {
  return HIVE_TASK_TONES[String(state || "").toLowerCase()] || "muted";
}

function hiveTaskLabel(state = "") {
  return String(state || "unknown").replace(/_/g, " ");
}

function shortPublicReference(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= 18 ? text : `${text.slice(0, 9)}…${text.slice(-7)}`;
}

function nftHasImage(nft = null) {
  return Boolean(nft?.imageCid || nft?.imageGatewayUrl || nft?.imageDataUrl);
}

function assigneeFromDetail(detailTask = {}, fallbackAssignee = null) {
  const wallet = detailTask.assignee || fallbackAssignee?.wallet || "";
  if (!wallet && !fallbackAssignee) return null;
  const detailNft = nftHasImage(detailTask.assigneeNft) ? detailTask.assigneeNft : null;
  return {
    wallet,
    accountId: detailTask.assigneeAccountId || fallbackAssignee?.accountId || "",
    codename: detailTask.assigneeDisplayName || fallbackAssignee?.codename || compactWallet(wallet),
    handle: detailTask.assigneeHandle || fallbackAssignee?.handle || "",
    hasPublicProfile: Boolean(detailTask.assigneeHasPublicProfile || fallbackAssignee?.hasPublicProfile),
    operatorDisclosure: detailTask.assigneeOperatorDisclosure || fallbackAssignee?.operatorDisclosure || null,
    badge: fallbackAssignee?.badge || 0,
    nft: detailNft || fallbackAssignee?.nft || null,
  };
}

function mergeHiveTaskDetail(initialTask = {}, detailBody = null) {
  const detailTask = detailBody?.task || {};
  const taskId = detailTask.taskId || detailTask.id || initialTask.taskId || initialTask.id || "";
  const outcome = detailBody?.review?.outcome || initialTask.review?.outcome || {};
  const timeline = Array.isArray(detailBody?.timeline) ? detailBody.timeline : Array.isArray(initialTask.timeline) ? initialTask.timeline : [];
  const rewardEvent = [...timeline].reverse().find((event) =>
    String(event?.action || "").toLowerCase().includes("reward") ||
    String(event?.label || "").toLowerCase().includes("reward")
  ) || {};
  return {
    ...initialTask,
    ...detailTask,
    id: detailTask.id || detailTask.taskId || initialTask.id || taskId,
    taskId,
    title: detailTask.title || initialTask.title || "Hive task",
    kind: detailTask.kind || initialTask.kind || "Network task",
    state: detailTask.state || initialTask.state || "proposed",
    pft: Number(detailTask.pft ?? initialTask.pft ?? 0),
    age: detailTask.age || initialTask.age || "",
    summary: detailTask.summary || initialTask.summary || "",
    description: detailTask.description || initialTask.description || "",
    nextAction: detailTask.nextAction || initialTask.nextAction || taskNextAction(detailTask.state || initialTask.state),
    proofTxHash: detailTask.proofTxHash || outcome.paymentTxHash || initialTask.proofTxHash || rewardEvent.txHash || "",
    proofCid: detailTask.proofCid || outcome.paymentCid || initialTask.proofCid || rewardEvent.cid || "",
    project: {
      id: detailTask.project?.id || initialTask.project?.id || "",
      name: detailTask.project?.name || initialTask.project?.name || "Hive project",
      type: detailTask.project?.type || initialTask.project?.type || "network",
    },
    assignee: assigneeFromDetail(detailTask, initialTask.assignee || null),
    review: detailBody?.review || initialTask.review || null,
    evaluationPackets: detailBody?.evaluationPackets || initialTask.evaluationPackets || [],
    timeline: detailBody?.timeline || initialTask.timeline || [],
  };
}

function hasReviewContent(review = null) {
  if (!review) return false;
  const submissions = Array.isArray(review.submissions) ? review.submissions : [];
  const evidence = Array.isArray(review.evidence) ? review.evidence : [];
  const verification = review.verification || {};
  const outcome = review.outcome || {};
  return Boolean(
    submissions.length ||
    evidence.length ||
    verification.request ||
    verification.response ||
    outcome.decision ||
    outcome.reason ||
    Number(outcome.rewardPft || 0)
  );
}

function HiveTaskPopout({ initialTask, onClose, pftlExplorerUrl = "" }) {
  const [mounted, setMounted] = useState(false);
  const [copiedValue, setCopiedValue] = useState("");
  const [loadStatus, setLoadStatus] = useState("loading");
  const [task, setTask] = useState(() => mergeHiveTaskDetail(initialTask));

  useEffect(() => {
    setTask(mergeHiveTaskDetail(initialTask));
    setLoadStatus(initialTask?.taskId ? "loading" : "error");
  }, [initialTask]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function loadDetail() {
      if (!initialTask?.taskId) return;
      try {
        const result = await requestJson(`/api/hive/task-detail?taskId=${encodeURIComponent(initialTask.taskId)}`);
        if (cancelled) return;
        if (!result.ok) {
          setLoadStatus("error");
          return;
        }
        setTask(mergeHiveTaskDetail(initialTask, result.body));
        setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    }
    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [initialTask]);

  const reached = hiveTaskLifecycleIndex(task.state);
  const tone = hiveTaskTone(task.state);
  const assignee = task.assignee || null;
  const canLinkAssignee = Boolean(assignee?.accountId && assignee?.hasPublicProfile);
  const OperatorTag = canLinkAssignee ? "a" : "div";
  const operatorProps = canLinkAssignee
    ? {
        href: profileHref(assignee.accountId),
        "aria-label": `Open ${assignee.codename || compactWallet(assignee.wallet)} public profile`,
      }
    : {};
  const review = task.review || null;
  const submissions = Array.isArray(review?.submissions) ? review.submissions : [];
  const evidence = Array.isArray(review?.evidence) ? review.evidence : [];
  const evaluationPackets = Array.isArray(task.evaluationPackets) ? task.evaluationPackets : [];
  const verification = review?.verification || {};
  const outcome = review?.outcome || {};
  const timeline = Array.isArray(task.timeline) && task.timeline.length
    ? task.timeline
    : [{
        action: task.state,
        label: task.nextAction || taskNextAction(task.state),
        time: task.age || "",
        txHash: "",
        cid: "",
      }];
  const rewardEvent = [...timeline].reverse().find((event) =>
    String(event?.action || "").toLowerCase().includes("reward") ||
    String(event?.label || "").toLowerCase().includes("reward")
  ) || {};
  const rewardTxHash = outcome.paymentTxHash || task.proofTxHash || rewardEvent.txHash || "";
  const rewardCid = outcome.paymentCid || task.proofCid || rewardEvent.cid || "";
  const rewardHref = transactionExplorerHref(rewardTxHash, pftlExplorerUrl);

  function copyValue(name, value) {
    const text = String(value || "").trim();
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedValue(name);
    window.setTimeout(() => setCopiedValue((current) => (current === name ? "" : current)), 1400);
  }

  function copyId() {
    copyValue("task-id", task.taskId || task.id);
  }

  return (
    <div className="htp-layer">
      <div className={`htp-wash${mounted ? " is-mounted" : ""}`} onClick={onClose} role="presentation" />
      <section
        aria-labelledby="htp-title"
        aria-modal="true"
        className={`htp-modal${mounted ? " is-mounted" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="htp-header">
          <span className="htp-kicker">
            <Flag size={11} strokeWidth={1.9} />
            {task.kind}
            <i>·</i>
            <span className="htp-kicker-project">{task.project?.name || "Hive project"}</span>
          </span>
          <button className="htp-close" onClick={onClose} type="button">
            <X size={14} strokeWidth={1.8} />
            Close
          </button>
        </header>

        <div className="htp-body">
          <h2 id="htp-title">{task.title}</h2>
          <button className="htp-id" onClick={copyId} type="button">
            {task.taskId || task.id}
            {copiedValue === "task-id" ? <Check size={11} strokeWidth={1.9} /> : <Copy size={11} strokeWidth={1.7} />}
          </button>

          <ol aria-label="Task lifecycle" className="htp-stepper">
            {HIVE_TASK_LIFECYCLE.map((step, index) => {
              const status = index < reached ? "done" : index === reached ? "current" : "todo";
              return (
                <li className={`htp-step is-${status}`} key={step.key}>
                  <span className="htp-step-dot" />
                  <span className="htp-step-label">{step.label}</span>
                  {index < HIVE_TASK_LIFECYCLE.length - 1 && <span className="htp-step-bar" />}
                </li>
              );
            })}
          </ol>

          <div className="htp-stats">
            <div>
              <small>Reward</small>
              <span className="htp-reward">{formatPft(task.pft)}<em>PFT</em></span>
            </div>
            <div>
              <small>Status</small>
              <span className={`htp-state is-${tone}`}>
                <i /> {hiveTaskLabel(task.state)}
              </span>
            </div>
            <div>
              <small>Project</small>
              <span>{task.project?.type || "network"}</span>
            </div>
            <div>
              <small>Last event</small>
              <span>{task.age || (loadStatus === "loading" ? "Loading" : "Indexed")}</span>
            </div>
          </div>

          <section className="htp-section">
            <h3>Routed to</h3>
            {assignee ? (
              <OperatorTag className={`htp-operator${canLinkAssignee ? " is-link" : ""}`} {...operatorProps}>
                <HiveProfileBadge nft={assignee.nft} size={34} variant={assignee.badge} />
                <span className="htp-operator-copy">
                  <strong>{assignee.codename || compactWallet(assignee.wallet)}</strong>
                  <small>{assignee.handle ? `@${assignee.handle} · ` : ""}{compactWallet(assignee.wallet)}</small>
                  <MachineOperatorBadge disclosure={assignee.operatorDisclosure} />
                </span>
                {canLinkAssignee && <ArrowUpRight className="htp-operator-go" size={15} strokeWidth={1.8} />}
              </OperatorTag>
            ) : (
              <div className="htp-operator is-empty">
                <em>Unassigned — open for routing</em>
              </div>
            )}
          </section>

          <section className="htp-section">
            <h3>About this task</h3>
            <p className="htp-summary">{task.summary || task.description || "No public summary has been indexed for this Hive task yet."}</p>
            {task.nextAction && (
              <p className="htp-next"><span>Next</span>{task.nextAction}</p>
            )}
            {loadStatus === "error" && (
              <p className="htp-load-note">The public task-detail projection could not be loaded. Showing the Hive snapshot.</p>
            )}
          </section>

          {hasReviewContent(review) && (
            <section className="htp-section">
              <h3>Work &amp; review</h3>
              <div className="htp-review">
                {submissions.map((submission, index) => (
                  <div className="htp-review-row" key={`${submission.type || "submission"}-${index}`}>
                    <span className="htp-review-tag">{submission.type || "Submission"}</span>
                    <p>{submission.summary}</p>
                  </div>
                ))}
                {evidence.map((item, index) => (
                  <div className="htp-review-row" key={`${item.schema || item.type || "evidence"}-${item.cid || item.txHash || index}`}>
                    <span className="htp-review-tag">{item.type || "Evidence"}</span>
                    {item.excerpt && <p>{item.excerpt}</p>}
                    {item.privateContentHidden && <p className="htp-review-note">Private or encrypted content hidden.</p>}
                    {Array.isArray(item.artifactRefs) && item.artifactRefs.length > 0 && (
                      <div className="htp-review-artifacts">
                        {item.artifactRefs.slice(0, 5).map((artifact, artifactIndex) => (
                          <code key={`${artifact.type || "artifact"}-${artifact.cid || artifact.txHash || artifact.url || artifactIndex}`}>
                            {artifact.type || "artifact"}
                            {artifact.label ? ` · ${artifact.label}` : ""}
                            {artifact.url ? ` · ${shortPublicReference(artifact.url)}` : ""}
                            {artifact.cid ? ` · cid ${shortPublicReference(artifact.cid)}` : ""}
                            {artifact.txHash ? ` · tx ${shortPublicReference(artifact.txHash)}` : ""}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {(verification.request || verification.response) && (
                  <div className="htp-review-row is-verify">
                    <span className="htp-review-tag">Verification</span>
                    {verification.request && <p><strong>Asked.</strong> {verification.request}</p>}
                    {verification.response && <p><strong>Answered.</strong> {verification.response}</p>}
                  </div>
                )}
                {(outcome.decision || outcome.reason || Number(outcome.rewardPft || 0)) && (
                  <div className="htp-review-outcome">
                    <span>{outcome.decision || "Reward outcome"} · {formatPft(outcome.rewardPft)} PFT</span>
                    {outcome.reason && <p>{outcome.reason}</p>}
                    {(rewardTxHash || rewardCid) && (
                      <div className="htp-proof-card">
                        <strong>Reward proof</strong>
                        {rewardTxHash && <code title={rewardTxHash}>tx {rewardTxHash}</code>}
                        {rewardCid && <code title={rewardCid}>cid {rewardCid}</code>}
                        <div>
                          {rewardTxHash && (
                            <button onClick={() => copyValue("reward-tx", rewardTxHash)} type="button">
                              {copiedValue === "reward-tx" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                              Copy tx
                            </button>
                          )}
                          {rewardHref && (
                            <a href={rewardHref} rel="noreferrer" target="_blank">
                              <ArrowUpRight size={12} strokeWidth={1.8} />
                              Open tx
                            </a>
                          )}
                          {rewardCid && (
                            <button onClick={() => copyValue("reward-cid", rewardCid)} type="button">
                              {copiedValue === "reward-cid" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                              Copy CID
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {evaluationPackets.length > 0 && (
            <section className="htp-section">
              <h3>Evidence evaluation</h3>
              <div className="htp-review">
                {evaluationPackets.slice(0, 3).map((packet) => (
                  <div className="htp-review-row" key={packet.id || `${packet.taskId}-${packet.updatedAt}`}>
                    <span className="htp-review-tag">{packet.packetStatus || "Packet"}</span>
                    <p>{packet.summary}</p>
                    {packet.recommendation && <p><strong>Next.</strong> {packet.recommendation}</p>}
                    {Array.isArray(packet.artifactVerdicts) && packet.artifactVerdicts.length > 0 && (
                      <div className="htp-review-artifacts">
                        {packet.artifactVerdicts.slice(0, 4).map((verdict, index) => (
                          <code key={`${verdict.status || "verdict"}-${verdict.label || index}`}>
                            {verdict.status || "unknown"} · {verdict.label || verdict.artifactType || "artifact"}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="htp-section">
            <h3>Timeline</h3>
            <ul className="htp-timeline">
              {timeline.map((event, index) => (
                <li className={`htp-tl-row is-${hiveTaskTone(event.action)}`} key={`${event.action || "event"}-${event.time || index}`}>
                  <span className="htp-tl-dot" />
                  <span className="htp-tl-copy">
                    <span className="htp-tl-label">{event.label || actionLabel(event.action)}</span>
                    {(event.txHash || event.cid) && (
                      <span className="htp-tl-meta">
                        {event.txHash && <code>tx {shortPublicReference(event.txHash)}</code>}
                        {event.cid && <code>cid {shortPublicReference(event.cid)}</code>}
                      </span>
                    )}
                  </span>
                  <time>{event.time}</time>
                </li>
              ))}
            </ul>
          </section>

          <footer className="htp-foot">
            <p>Public network-task record. Operators are routed by the Board Manager; this view is read-only.</p>
          </footer>
        </div>
      </section>
    </div>
  );
}

function HiveContextPanel({ boardManager, context, expanded, onToggle, status, secretary }) {
  const [activeTab, setActiveTab] = useState("context");
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
        : "No Hive chat entries yet";

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
          <div className="hive-context-tabs" role="tablist" aria-label="Hive context views">
            <button
              aria-selected={activeTab === "context"}
              className={activeTab === "context" ? "is-active" : ""}
              onClick={() => setActiveTab("context")}
              role="tab"
              type="button"
            >
              Hive Context
            </button>
            <button
              aria-selected={activeTab === "agent"}
              className={activeTab === "agent" ? "is-active" : ""}
              onClick={() => setActiveTab("agent")}
              role="tab"
              type="button"
            >
              Hive Mind Agent
            </button>
          </div>
          {activeTab === "context" ? (
            <HiveContextInputs
              groups={groups}
              hasEntries={hasEntries}
              pending={pending}
              rawOpen={rawOpen}
              report={report}
              reportOutput={reportOutput}
              setRawOpen={setRawOpen}
              status={status}
              userCount={userCount}
              entryCount={entryCount}
            />
          ) : (
            <HiveMindAgentPanel boardManager={boardManager} />
          )}
        </div>
      )}
    </div>
  );
}

function HiveContextInputs({
  entryCount,
  groups,
  hasEntries,
  pending,
  rawOpen,
  report,
  reportOutput,
  setRawOpen,
  status,
  userCount,
}) {
  return (
    <>
      {!hasEntries && status !== "loading" && (
        <p className="hive-context-empty">Use the default Hive chat to add network context.</p>
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
              The Secretary report is generated asynchronously from linked-wallet Hive chat entries.
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
    </>
  );
}

function HiveMindAgentPanel({ boardManager }) {
  const feed = boardManager?.feed || [];
  const logMode = boardManager?.logMode || "summary";
  return (
    <section className="hive-agent-panel">
      <header className="hive-agent-heading">
        <span>
          <strong>Hive Mind Agent</strong>
          <small>
            {feed.length ? `${feed.length} recent ${feed.length === 1 ? "run" : "runs"}` : "No agent runs recorded"}
            {logMode === "full" ? " · full logs available" : ""}
          </small>
        </span>
      </header>
      <div className="hive-agent-feed">
        {feed.length ? feed.map((entry) => (
          <HiveAgentRun entry={entry} key={entry.id || entry.runId} />
        )) : (
          <p className="hive-context-empty">Board Manager runs will appear here after the agent evaluates Hive state.</p>
        )}
      </div>
    </section>
  );
}

function HiveAgentRun({ entry }) {
  const [logsOpen, setLogsOpen] = useState(false);
  const target = [entry.targetType, entry.targetId].filter(Boolean).join(" · ");
  const resultCount = entry.actionResults?.length || 0;
  const decisionReason = entry.reason && entry.reason !== entry.summary ? entry.reason : "";
  const resultSummary = entry.actionResults?.find((result) => result.summary || result.error)?.summary || "";
  const details = entry.details || null;
  const hasDetails = Boolean(details);
  const decisionBasis = buildDecisionBasis({ entry, details });
  const auditSummary = buildAgentAuditSummary({ entry, details });
  return (
    <article className={`hive-agent-run is-${entry.state || "recorded"}`}>
      <div className="hive-agent-run-top">
        <span className={`hive-agent-state is-${entry.state || "recorded"}`}>{entry.label || "No decision"}</span>
        <time>{formatContextTime(entry.completedAt || entry.startedAt)}</time>
      </div>
      <p>{entry.summary || entry.reason || "No summary recorded."}</p>
      {decisionReason && (
        <div className="hive-agent-audit-block">
          <span>Decision reason</span>
          <p>{decisionReason}</p>
        </div>
      )}
      {resultSummary && (
        <div className="hive-agent-audit-block">
          <span>Action result</span>
          <p>{resultSummary}</p>
        </div>
      )}
      {decisionBasis.nextCheck && (
        <div className="hive-agent-audit-block">
          <span>Next check</span>
          <p>{decisionBasis.nextCheck}</p>
        </div>
      )}
      <div className="hive-agent-audit-row">
        {Number.isFinite(entry.confidence) && entry.confidence > 0 && <span>Confidence {Math.round(entry.confidence * 100)}%</span>}
        {entry.runId && <span>Run {shortId(entry.runId)}</span>}
        {entry.sourcePacketDigest && <span>Source {shortHash(entry.sourcePacketDigest)}</span>}
        {entry.sessionMode && <span>{entry.sessionMode}</span>}
      </div>
      <footer>
        {target && <span>{target}</span>}
        {entry.dryRun && <span>dry run</span>}
        {resultCount > 0 && <span>{resultCount} {resultCount === 1 ? "result" : "results"}</span>}
        {entry.trigger && <span>{entry.trigger}</span>}
      </footer>
      <button
        aria-expanded={logsOpen}
        className="hive-agent-log-toggle"
        onClick={() => setLogsOpen((open) => !open)}
        type="button"
      >
        <span>Full logs</span>
        <ChevronDown className={logsOpen ? "is-open" : ""} size={15} strokeWidth={1.8} />
      </button>
      {logsOpen && (
        <div className="hive-agent-full-logs">
          {hasDetails ? (
            <>
              <DecisionBasisPanel basis={decisionBasis} />
              <AgentAuditSummary summary={auditSummary} />
              <AgentLogSection title="Raw Scheduler Job JSON" value={details.job} />
              <AgentLogSection title="Raw Decision JSON" value={details.decision} />
              <AgentLogSection title="Raw Action Payload JSON" value={details.actionPayload} />
              <AgentLogSection title="Raw Action Result JSON" value={details.actionResults} />
              <AgentLogSection title="Provider Output" value={details.outputText} empty="No provider output text was stored for this run." />
              <AgentLogSection title="Micro Summary" value={details.microSummaryText || details.microSummary} />
              <AgentLogSection title="Raw Source Snapshot JSON" value={details.sourcePacket} />
            </>
          ) : (
            <p className="hive-agent-log-empty">Full logs were not attached to this feed response.</p>
          )}
        </div>
      )}
    </article>
  );
}

function AgentAuditSummary({ summary }) {
  const rows = Array.isArray(summary?.rows) ? summary.rows.filter((row) => row?.value) : [];
  if (!rows.length) return null;
  return (
    <section className="hive-agent-audit-summary">
      <h4>Audit Summary</h4>
      <dl>
        {rows.map((row) => (
          <React.Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
}

function DecisionBasisPanel({ basis }) {
  return (
    <section className="hive-agent-basis-panel">
      <h4>Decision Basis</h4>
      <DecisionBasisList items={basis.sourceFacts} title="Source facts" />
      <DecisionBasisList items={basis.tradeoffs} title="Tradeoffs" />
      <DecisionBasisRejected items={basis.rejectedActions} />
      <DecisionBasisList items={basis.riskNotes} title="Risk notes" />
      {basis.nextCheck && (
        <div className="hive-agent-basis-next">
          <strong>Next check</strong>
          <p>{basis.nextCheck}</p>
        </div>
      )}
    </section>
  );
}

function DecisionBasisList({ items = [], title }) {
  const normalized = items.filter(Boolean);
  if (!normalized.length) return null;
  return (
    <div className="hive-agent-basis-list">
      <strong>{title}</strong>
      <ul>
        {normalized.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function DecisionBasisRejected({ items = [] }) {
  const normalized = items.filter((item) => item?.action || item?.reason);
  if (!normalized.length) return null;
  return (
    <div className="hive-agent-basis-list">
      <strong>Rejected actions</strong>
      <ul>
        {normalized.map((item, index) => (
          <li key={`${item.action || "action"}-${index}`}>
            {item.action ? <span>{item.action}: </span> : null}
            {item.reason || "No reason recorded."}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentLogSection({ empty = "No value recorded.", title, value }) {
  const rendered = formatLogValue(value);
  const isRaw = /^Raw\b/.test(title);
  if (isRaw) {
    return (
      <details className="hive-agent-log-section is-raw">
        <summary>{title}</summary>
        {rendered ? <pre>{rendered}</pre> : <p>{empty}</p>}
      </details>
    );
  }
  return (
    <section className="hive-agent-log-section">
      <h4>{title}</h4>
      {rendered ? <pre>{rendered}</pre> : <p>{empty}</p>}
    </section>
  );
}

function formatLogValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && !Object.keys(value).length) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "").trim();
  }
}

function buildAgentAuditSummary({ entry = {}, details = null } = {}) {
  const job = details?.job || {};
  const decision = details?.decision || {};
  const actionPayload = details?.actionPayload || {};
  const sourcePacket = details?.sourcePacket || {};
  const pressureSummary = sourcePacket.boardActionPressure?.summary || {};
  const routingAccounts = Array.isArray(sourcePacket.routingConstraints?.accounts)
    ? sourcePacket.routingConstraints.accounts
    : [];
  const actionResults = Array.isArray(details?.actionResults) ? details.actionResults : [];
  const firstResult = actionResults[0]?.result || {};
  const action = entry.action || decision.action || actionPayload.action || "";
  const target = [entry.targetType || decision.target_type, entry.targetId || decision.target_id].filter(Boolean).join(" / ");
  const routingConstraintText = routingAccounts.length
    ? routingAccounts.slice(0, 4).map((account) => {
        const minPft = account.reservationRate?.minPft;
        return `${account.accountId || "account"} min ${formatPft(minPft)} PFT`;
      }).join("; ")
    : "No explicit reservation-rate constraints in this source packet.";
  const boardState = [
    pressureSummary.motionState ? `motion=${pressureSummary.motionState}` : "",
    pressureSummary.eligibleCandidateCount !== undefined ? `eligible=${pressureSummary.eligibleCandidateCount}` : "",
    pressureSummary.projectsWithoutLiveTasks !== undefined ? `projects_without_live_tasks=${pressureSummary.projectsWithoutLiveTasks}` : "",
    pressureSummary.openFollowupCount !== undefined ? `open_followups=${pressureSummary.openFollowupCount}` : "",
  ].filter(Boolean).join("; ");
  const actionOutcome = [
    firstResult.reason || firstResult.error || actionResults[0]?.summary || "",
    firstResult.executed === false || firstResult.skipped ? "skipped" : "",
    firstResult.followupId ? `followup=${shortId(firstResult.followupId)}` : "",
    firstResult.taskId ? `task=${shortId(firstResult.taskId)}` : "",
    firstResult.allocationId ? `allocation=${shortId(firstResult.allocationId)}` : "",
  ].filter(Boolean).join("; ");
  return {
    rows: [
      { label: "Trigger", value: job.trigger || entry.trigger || "manual/unknown" },
      { label: "Job state", value: job.id ? `${shortId(job.id)} is ${job.status || entry.status || "pending"}` : (entry.status || entry.state || "") },
      { label: "Timing", value: [
        job.runAfter ? `run_after=${formatContextTime(job.runAfter)}` : "",
        job.claimedAt ? `claimed=${formatContextTime(job.claimedAt)}` : "",
        entry.completedAt || entry.startedAt ? `run=${formatContextTime(entry.completedAt || entry.startedAt)}` : "",
      ].filter(Boolean).join("; ") },
      { label: "Decision", value: action ? `${action}${target ? ` -> ${target}` : ""}` : "" },
      { label: "Board state", value: boardState },
      { label: "Routing constraints", value: routingConstraintText },
      { label: "Action outcome", value: actionOutcome || entry.summary || entry.reason || "" },
      { label: "Source digest", value: sourcePacket.sourcePacketDigest || entry.sourcePacketDigest || "" },
    ],
  };
}

function buildDecisionBasis({ entry = {}, details = null } = {}) {
  const decision = details?.decision || {};
  const structured = normalizeDecisionBasis(decision.decision_basis || decision.decisionBasis || entry.decisionBasis || {});
  if (structured.hasAny) return structured;
  if (details?.job) return buildSchedulerJobBasis({ entry, job: details.job });
  const sourcePacket = details?.sourcePacket || {};
  const actionResults = details?.actionResults || [];
  if (entry.action === "daily_airdrop") {
    return buildDailyAirdropBasis({ entry, sourcePacket, actionResults });
  }
  return buildSourceSnapshotBasis({ entry, sourcePacket, actionResults });
}

function normalizeDecisionBasis(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceFacts = stringList(input.source_facts || input.sourceFacts, 8);
  const tradeoffs = stringList(input.tradeoffs, 6);
  const rejectedActions = Array.isArray(input.rejected_actions || input.rejectedActions)
    ? (input.rejected_actions || input.rejectedActions).slice(0, 8).map((item) => ({
        action: String(item?.action || "").trim(),
        reason: String(item?.reason || "").trim(),
      })).filter((item) => item.action || item.reason)
    : [];
  const riskNotes = stringList(input.risk_notes || input.riskNotes, 6);
  const nextCheck = String(input.next_check || input.nextCheck || "").trim();
  return {
    sourceFacts,
    tradeoffs,
    rejectedActions,
    riskNotes,
    nextCheck,
    hasAny: Boolean(sourceFacts.length || tradeoffs.length || rejectedActions.length || riskNotes.length || nextCheck),
  };
}

function buildSchedulerJobBasis({ entry = {}, job = {} } = {}) {
  const attempts = Number(job.attemptCount || 0);
  const maxAttempts = Number(job.maxAttempts || 0);
  return {
    sourceFacts: [
      `Scheduler job ${job.id || entry.id || "unknown"} is ${job.status || entry.status || "pending"}.`,
      job.trigger ? `Trigger is ${job.trigger}.` : "",
      job.reason ? `Reason: ${job.reason}` : "",
      Number.isFinite(attempts) && maxAttempts ? `Attempt ${attempts.toLocaleString("en-US")} of ${maxAttempts.toLocaleString("en-US")}.` : "",
      job.claimedBy ? `Claimed by ${job.claimedBy}.` : "The job has not recorded a worker claim yet.",
    ].filter(Boolean),
    tradeoffs: ["This is a scheduler job waiting for, or currently inside, a Board Manager run. Decision JSON is not available until the run is started and persisted."],
    rejectedActions: [],
    riskNotes: job.lastError ? [job.lastError] : [],
    nextCheck: "Wait for the matching Board Manager run to complete, or inspect this scheduler job for stale claimed_at/run_after timestamps if it stays pending.",
    hasAny: true,
  };
}

function buildDailyAirdropBasis({ entry = {}, sourcePacket = {}, actionResults = [] } = {}) {
  const result = actionResults?.[0]?.result || {};
  const candidateCount = Number(sourcePacket.candidateCount ?? result.candidateCount ?? 0);
  const scoredCount = Number(sourcePacket.scoredCount ?? result.scoredCount ?? 0);
  const issuedCount = Number(sourcePacket.issuedCount ?? result.userCount ?? 0);
  const failedCount = Number(sourcePacket.failedCount ?? result.failedCount ?? 0);
  const totalPft = Number(sourcePacket.totalPft ?? result.totalPft ?? 0);
  const sourceFacts = [
    `${candidateCount.toLocaleString("en-US")} candidate ${candidateCount === 1 ? "account was" : "accounts were"} loaded for this daily airdrop tick.`,
    `${scoredCount.toLocaleString("en-US")} candidate ${scoredCount === 1 ? "account was" : "accounts were"} scored.`,
    `${issuedCount.toLocaleString("en-US")} payout ${issuedCount === 1 ? "was" : "were"} submitted, totaling ${formatPft(totalPft)} PFT.`,
  ];
  if (failedCount) sourceFacts.push(`${failedCount.toLocaleString("en-US")} candidate ${failedCount === 1 ? "failed" : "accounts failed"} during scoring or issuance.`);
  return {
    sourceFacts,
    tradeoffs: ["This is a deterministic worker audit card, not a model-selected Hive board decision."],
    rejectedActions: [],
    riskNotes: failedCount ? ["Failed accounts should be inspected before retrying issuance."] : [],
    nextCheck: totalPft > 0
      ? "Inspect action-result JSON for issuance ids, recipient wallets, and transaction hashes."
      : "Inspect scored account rows to confirm why eligible accounts received 0 PFT.",
    hasAny: true,
  };
}

function buildSourceSnapshotBasis({ entry = {}, sourcePacket = {}, actionResults = [] } = {}) {
  const pressure = sourcePacket.boardActionPressure || {};
  const summary = pressure.summary || {};
  const signals = Array.isArray(pressure.signals) ? pressure.signals : [];
  const sourceFacts = [];
  if (summary.motionState) sourceFacts.push(`Board motion state was ${summary.motionState}.`);
  if (summary.activeProjectCount !== undefined) sourceFacts.push(`${Number(summary.activeProjectCount || 0).toLocaleString("en-US")} active project ${Number(summary.activeProjectCount || 0) === 1 ? "was" : "were"} in the source packet.`);
  if (summary.projectsWithoutLiveTasks !== undefined) sourceFacts.push(`${Number(summary.projectsWithoutLiveTasks || 0).toLocaleString("en-US")} active project ${Number(summary.projectsWithoutLiveTasks || 0) === 1 ? "had" : "had"} no live task movement.`);
  if (summary.eligibleCandidateCount !== undefined) sourceFacts.push(`${Number(summary.eligibleCandidateCount || 0).toLocaleString("en-US")} eligible Network Task candidate ${Number(summary.eligibleCandidateCount || 0) === 1 ? "was" : "were"} available after capacity blockers.`);
  signals.slice(0, 4).forEach((signal) => {
    const reasons = Array.isArray(signal.reasons) ? signal.reasons.join("; ") : "";
    sourceFacts.push(`${signal.projectId || "project"}: ${reasons || signal.pressure || "pressure signal recorded"}.`);
  });
  const result = actionResults?.[0]?.result || {};
  if (result.error) sourceFacts.push(`Action hook reported error: ${result.error}.`);
  return {
    sourceFacts: sourceFacts.length ? sourceFacts : [entry.reason || entry.summary || "No structured source facts were stored for this run."],
    tradeoffs: entry.reason ? [entry.reason] : [],
    rejectedActions: [],
    riskNotes: result.error ? [result.error] : [],
    nextCheck: "Open Source Snapshot JSON to inspect boardActionPressure, candidates, open follow-ups, and project task state for this run.",
    hasAny: true,
  };
}

function stringList(value, max = 6) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, max)
    : [];
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
  return operators[wallet] || { codename: compactWallet(wallet), archetype: "", badge: 0, allotted: false, cap: 0, load: 0, status: "quiet", nft: null, operatorDisclosure: null };
}

export function compactWallet(wallet = "") {
  const normalized = String(wallet || "").trim();
  if (normalized.length <= 12) return normalized || "unassigned";
  return `${normalized.slice(0, 6)}...${normalized.slice(-5)}`;
}

function shortId(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length <= 18) return normalized || "-";
  return `${normalized.slice(0, 10)}...${normalized.slice(-6)}`;
}

function shortHash(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length <= 16) return normalized || "-";
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

export function formatPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: number % 1 === 0 ? 0 : 2,
  }).format(number);
}

export function formatCompactPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number) < 1000) return formatPft(number);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

function contributorsSubtitle(project = {}) {
  const allocated = project.contributors?.length || 0;
  if (allocated) return `${allocated} allocated ${allocated === 1 ? "operator" : "operators"} on this project`;
  return "No operators allocated yet";
}

function paginateRows(rows = [], requestedPage = 1, pageSize = PROJECT_DETAIL_PAGE_SIZE) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const pageCount = Math.max(1, Math.ceil(normalizedRows.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const startIndex = (page - 1) * pageSize;
  return {
    page,
    pageCount,
    rows: normalizedRows.slice(startIndex, startIndex + pageSize),
  };
}

function tasksSubtitle(project = {}) {
  const allocated = project.tasks?.length || 0;
  const pending = Number(project.pendingGenerationCount || 0);
  if (project.nextTask?.title) return `${allocated} task ${allocated === 1 ? "row" : "rows"}; next: ${project.nextTask.title}`;
  if (allocated) return `${allocated} allocated task ${allocated === 1 ? "row" : "rows"} on this project`;
  if (pending) return `${pending} Network Task generation ${pending === 1 ? "job is" : "jobs are"} queued for this project`;
  return "No project task rows yet";
}

function taskNextAction(state = "") {
  const normalized = String(state || "").trim().toLowerCase();
  if (normalized === "accepted") return "Complete the task and submit evidence for review.";
  if (normalized === "verification_requested") return "Answer the reviewer follow-up.";
  if (normalized === "verification_response_submitted") return "Wait for review.";
  if (normalized === "submitted") return "Wait for review and respond if verification is requested.";
  if (normalized === "proposed") return "Open the task and accept or refuse it before the deadline.";
  if (normalized === "reward_decided") return "Wait for the terminal reward outcome to settle.";
  if (["rewarded", "paid"].includes(normalized)) return "Reward paid. View proof, copy the tx, or request another task.";
  if (["refused", "cancelled", "rejected", "expired"].includes(normalized)) return "Task is stopped; wait for a new routed task if more work is needed.";
  return "Open the task row and inspect the latest state.";
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
  const normalized = String(action || "").trim().toLowerCase();
  return (
    {
      proposed: "proposed",
      accepted: "accepted",
      submitted: "submitted",
      verification_requested: "v. requested",
      verification_response_submitted: "awaiting review",
      verification_response: "v. response",
      v_requested: "v. requested",
      v_response: "v. response",
      reward_decided: "reward pending",
      rewarded: "rewarded",
      paid: "paid",
      cancelled: "cancelled",
      rejected: "rejected",
      expired: "expired",
      refused: "refused",
    }[normalized] || normalized || "recorded"
  );
}

function taskState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return (
    {
      proposed: { key: "proposed", label: "proposed", tone: "amber", ring: true, dim: false },
      accepted: { key: "accepted", label: "accepted", tone: "green", ring: false, dim: false },
      submitted: { key: "submitted", label: "submitted", tone: "green", ring: false, dim: false },
      verification_requested: { key: "verification_requested", label: "v. requested", tone: "amber", ring: false, dim: false },
      verification_response_submitted: { key: "verification_response_submitted", label: "awaiting review", tone: "green", ring: false, dim: false },
      verification_response: { key: "verification_response", label: "v. response", tone: "green", ring: false, dim: false },
      reward_decided: { key: "reward_decided", label: "reward pending", tone: "muted", ring: false, dim: true },
      rewarded: { key: "rewarded", label: "rewarded", tone: "muted", ring: false, dim: true },
      paid: { key: "paid", label: "paid", tone: "muted", ring: false, dim: true },
      refused: { key: "refused", label: "refused", tone: "muted", ring: true, dim: true },
      cancelled: { key: "cancelled", label: "cancelled", tone: "muted", ring: true, dim: true },
      rejected: { key: "rejected", label: "rejected", tone: "muted", ring: true, dim: true },
      expired: { key: "expired", label: "expired", tone: "muted", ring: true, dim: true },
    }[normalized] || { key: "unknown", label: normalized || "unknown", tone: "muted", ring: true, dim: true }
  );
}
