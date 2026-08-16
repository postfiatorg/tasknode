import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
} from "lucide-react";
import { requestJson } from "../../api";
import { parseMarkdownBlocks } from "./hive-report-markdown.js";
import {
  ActivityRow,
  AllottedOperatorRow,
  ContributorCard,
  ContributorSpotlightRow,
  FeedRow,
  ProjectBoardComments,
  ProjectCard,
  ProjectDocList,
  ProjectTaskRow,
  Section,
  Stat,
} from "./HiveProjectPanels.jsx";
import { HiveTaskPopout } from "./HiveTaskPopout.jsx";
import { HiveContextPanel } from "./HiveContextPanels.jsx";
import {
  contributorsSubtitle,
  formatCompactPft,
  formatContextTime,
  formatPft,
  paginateRows,
  tasksSubtitle,
} from "./hive-view-utils.jsx";
export { compactWallet, formatCompactPft, formatPft } from "./hive-view-utils.jsx";
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
  const [contributorsSpotlight, setContributorsSpotlight] = useState([]);
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
      setContributorsSpotlight(Array.isArray(result.body?.contributors) ? result.body.contributors : []);
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
          onProjectCommentSaved={() => loadProjectDocument({ shouldApply: () => true })}
          operators={projectDocument?.operators || {}}
          pftlExplorerUrl={pftlExplorerUrl}
          project={projectDocument?.projects?.[selectedProject] || null}
          status={projectStatus}
        />
      ) : (
        <HiveIndex
          contributorsSpotlight={contributorsSpotlight}
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

function HiveIndex({ contributorsSpotlight = [], onOpenTask, onSelectProject, pftlExplorerUrl = "", projectDocument, projectStatus }) {
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

      <Section
        title="Contributors"
        subtitle="All-time recognized work across the network. This record is derived from rewarded task history and survives board changes."
      >
        <div className="hive-card">
          {contributorsSpotlight.map((contributor, index) => (
            <ContributorSpotlightRow
              key={contributor.accountId || contributor.handle || index}
              contributor={contributor}
              last={index === contributorsSpotlight.length - 1}
              rank={index + 1}
            />
          ))}
          {projectStatus === "ready" && !contributorsSpotlight.length && (
            <div className="hive-empty-project">No rewarded contributions recorded yet.</div>
          )}
          {projectStatus === "loading" && <div className="hive-empty-project">Loading contributors.</div>}
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
  const [archivedOpen, setArchivedOpen] = useState(false);
  const projects = document?.projects || {};
  const projectIds = document?.projectIds || [];
  const archivedProjects = document?.archivedProjects || {};
  const archivedProjectIds = document?.archivedProjectIds || [];
  if (status === "loading") {
    return <div className="hive-card hive-empty-project">Loading active projects.</div>;
  }
  if (status === "error") {
    return <div className="hive-card hive-empty-project">Active projects are unavailable.</div>;
  }
  if (!projectIds.length) {
    return (
      <>
        <div className="hive-card hive-empty-project">No active projects are registered.</div>
        <ArchivedBoardsToggle
          archivedOpen={archivedOpen}
          archivedProjectIds={archivedProjectIds}
          archivedProjects={archivedProjects}
          onToggle={() => setArchivedOpen((open) => !open)}
        />
      </>
    );
  }
  return (
    <>
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
      <ArchivedBoardsToggle
        archivedOpen={archivedOpen}
        archivedProjectIds={archivedProjectIds}
        archivedProjects={archivedProjects}
        onToggle={() => setArchivedOpen((open) => !open)}
      />
    </>
  );
}

function ArchivedBoardsToggle({ archivedOpen = false, archivedProjectIds = [], archivedProjects = {}, onToggle }) {
  if (!archivedProjectIds.length) return null;
  const count = archivedProjectIds.length;
  return (
    <div className={`hive-archived-boards ${archivedOpen ? "is-open" : ""}`}>
      <button
        aria-expanded={archivedOpen}
        className="hive-archived-boards-toggle"
        onClick={onToggle}
        type="button"
      >
        <span>
          <strong>See Archived Boards</strong>
          <small>{count} {count === 1 ? "board" : "boards"}</small>
        </span>
        <ChevronDown className={archivedOpen ? "is-open" : ""} size={15} strokeWidth={1.8} />
      </button>
      {archivedOpen && (
        <div className="hive-archived-board-list">
          {archivedProjectIds.map((id) => (
            <ArchivedBoardRow key={id} project={archivedProjects[id] || { id }} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedBoardRow({ project = {} }) {
  const archivedAt = formatContextTime(project.archivedAt || project.lastActivityAt);
  const taskCount = Number(project.taskCount || 0);
  const contributorCount = Number(project.contributorCount || 0);
  return (
    <article className="hive-archived-board-row">
      <span>
        <strong>{project.name || project.id || "Archived board"}</strong>
        <small>
          {project.type || "Hive board"}
          {archivedAt ? ` · archived ${archivedAt}` : ""}
          {project.operatorArchiveLock ? " · operator locked" : ""}
        </small>
      </span>
      {project.summary && <p>{project.summary}</p>}
      <span className="hive-archived-board-metrics">
        <small>{taskCount} {taskCount === 1 ? "task" : "tasks"}</small>
        <small>{contributorCount} {contributorCount === 1 ? "operator" : "operators"}</small>
        <small>{formatPft(project.pft)} PFT</small>
      </span>
      {project.archivedReason && <em>{project.archivedReason}</em>}
    </article>
  );
}

function ProjectDetail({ onBack, onOpenTask, onProjectCommentSaved, operators, pftlExplorerUrl = "", project, status }) {
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
          <ProjectStatusDocument document={project.productDocument} memo={project.secretaryMemo} />
          <ProjectBoardComments onCommentSaved={onProjectCommentSaved} project={project} />
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

function isMemoMetadataLine(value = "") {
  return /^(generated|model|source packet|source digest|prompt version|usage)\s*:/i.test(String(value || "").trim());
}

function visibleMemoBlocks(markdown = "") {
  return parseMarkdownBlocks(markdown)
    .map((block) => {
      if (block.type === "paragraph" && isMemoMetadataLine(block.text)) return null;
      if (block.type === "unordered" || block.type === "ordered") {
        const items = (block.items || []).filter((item) => !isMemoMetadataLine(item));
        return items.length ? { ...block, items } : null;
      }
      return block;
    })
    .filter(Boolean);
}

function MarkdownMemoBody({ markdown = "" }) {
  const blocks = useMemo(() => visibleMemoBlocks(markdown), [markdown]);
  if (!blocks.length) return <p>Project status memo is empty.</p>;
  return (
    <div className="hive-project-doc-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = `h${Math.min(Math.max(block.level + 1, 3), 5)}`;
          return <Heading key={`${block.type}-${index}`}>{block.text}</Heading>;
        }
        if (block.type === "rule") return <hr key={`${block.type}-${index}`} />;
        if (block.type === "code") return <pre key={`${block.type}-${index}`}>{block.text}</pre>;
        if (block.type === "ordered") {
          return (
            <ol key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ol>
          );
        }
        if (block.type === "unordered") {
          return (
            <ul key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ul>
          );
        }
        if (block.type === "table") {
          const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
          const cellsFor = (row) => Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] || "");
          return (
            <div className="hive-report-table-wrap" key={`${block.type}-${index}`}>
              <table>
                <thead>
                  <tr>
                    {cellsFor(block.header).map((cell, cellIndex) => <th key={`${index}-head-${cellIndex}`}>{cell}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${index}-row-${rowIndex}`}>
                      {cellsFor(row).map((cell, cellIndex) => <td key={`${index}-${rowIndex}-${cellIndex}`}>{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

function markdownPreview(markdown = "", max = 260) {
  const blocks = visibleMemoBlocks(markdown);
  let text = "";
  for (const block of blocks) {
    if (block.type === "paragraph") {
      text = block.text;
      break;
    }
    if (block.type === "unordered" || block.type === "ordered") {
      const items = block.items || [];
      if (items.length) {
        text = items.slice(0, 2).join(" ");
        break;
      }
    }
  }
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}...`;
}

function ProjectStatusDocument({ document, memo }) {
  const statusKey = memo?.id || memo?.generatedAt || document?.id || document?.createdAt || "";
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    setExpanded(true);
  }, [statusKey]);
  if (memo?.memoMarkdown) {
    return (
      <div className={`hive-project-doc is-secretary-memo ${expanded ? "is-expanded" : ""}`}>
        <button
          aria-expanded={expanded}
          className="hive-project-doc-toggle"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          <span>
            <strong>Project Status</strong>
            {memo.generatedAt && <time>{formatContextTime(memo.generatedAt)}</time>}
          </span>
          <ChevronDown className={expanded ? "is-open" : ""} size={16} strokeWidth={1.8} />
        </button>
        {!expanded && (
          <div className="hive-project-doc-preview">
            <p>{markdownPreview(memo.memoMarkdown) || "Open for the latest GLM board secretary memo."}</p>
          </div>
        )}
        {expanded && (
          <MarkdownMemoBody markdown={memo.memoMarkdown} />
        )}
      </div>
    );
  }
  if (!document) {
    return (
      <div className="hive-project-doc is-empty">
        <span>Project Status</span>
        <p>Project status has not been generated yet.</p>
      </div>
    );
  }
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
        </>
      )}
    </div>
  );
}
