import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { requestJson } from "../../api";
import { transactionExplorerHref } from "../../pftl-explorer.js";
import { ComposerSendButton } from "../chat/ComposerSendButton.jsx";
import { profileNftImageCandidates } from "../profile/profile-nft-images.js";
import {
  NftBadge,
  actionLabel,
  compactWallet,
  formatContextTime,
  formatPft,
  nextTaskEyebrow,
  operatorForWallet,
  taskNextAction,
  taskState,
} from "./hive-view-utils.jsx";

export function ProjectBoardComments({ onCommentSaved, project = {} }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [localComments, setLocalComments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ tone: "", message: "" });
  const comments = useMemo(
    () => mergeProjectComments(localComments, project?.comments || []),
    [localComments, project?.comments]
  );
  const trimmedDraft = draft.trim();
  const commentCount = comments.length;

  useEffect(() => {
    setExpanded(false);
    setDraft("");
    setLocalComments([]);
    setSaving(false);
    setStatus({ tone: "", message: "" });
  }, [project?.id]);

  async function submitComment(event) {
    event.preventDefault();
    if (!trimmedDraft || saving) return;
    setSaving(true);
    setStatus({ tone: "", message: "" });
    try {
      const result = await requestJson("/api/hive/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: trimmedDraft,
          conversationTitle: `Hive board: ${project.name || project.id || "Project"}`,
          projectComment: {
            projectId: project.id,
            projectName: project.name,
          },
        }),
      });
      if (!result.ok || !result.body?.entry) {
        throw new Error(result.body?.message || `Hive Context returned HTTP ${result.status}.`);
      }
      const savedComment = projectCommentFromEntry(result.body.entry, project);
      setLocalComments((current) => mergeProjectComments([savedComment], current));
      setDraft("");
      setStatus({ tone: "success", message: "Saved to board comments." });
      await onCommentSaved?.();
    } catch (error) {
      setStatus({ tone: "error", message: error?.message || "Could not save this comment." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`hive-project-comments ${expanded ? "is-expanded" : ""}`}>
      <button
        aria-expanded={expanded}
        className="hive-project-comments-toggle"
        onClick={() => setExpanded((open) => !open)}
        type="button"
      >
        <span>
          <MessageSquare size={15} strokeWidth={1.8} />
          <strong>Board comments</strong>
          <small>{commentCount ? `${commentCount} ${commentCount === 1 ? "comment" : "comments"}` : "No comments yet"}</small>
        </span>
        <ChevronDown className={expanded ? "is-open" : ""} size={16} strokeWidth={1.8} />
      </button>
      {expanded && (
        <div className="hive-project-comments-body">
          <form className="hive-project-comment-form" onSubmit={submitComment}>
            <textarea
              aria-label="Project board comment"
              maxLength={2000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Comment on ${project.name || "this project"}`}
              value={draft}
            />
            <ComposerSendButton
              ariaLabel={saving ? "Saving comment" : "Send comment"}
              className="hive-project-comment-send"
              disabled={saving || !trimmedDraft}
              title={saving ? "Saving" : "Send comment"}
            />
          </form>
          {status.message && (
            <p className={`hive-project-comment-status ${status.tone ? `is-${status.tone}` : ""}`}>
              {status.message}
            </p>
          )}
          {comments.length ? (
            <ol className="hive-project-comment-list">
              {comments.map((comment) => (
                <li key={comment.id || `${comment.accountId}-${comment.createdAt}`}>
                  <header>
                    <strong>{comment.handle || comment.displayName || "Contributor"}</strong>
                    {comment.createdAt && <time>{formatContextTime(comment.createdAt)}</time>}
                  </header>
                  <p>{comment.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hive-project-comment-empty">Project comments will appear here after contributors add them.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function projectCommentFromEntry(entry = {}, project = {}) {
  const metadata = entry.metadata?.projectComment || {};
  return {
    id: entry.id,
    projectId: metadata.projectId || project.id || "",
    projectName: metadata.projectName || project.name || "",
    accountId: entry.accountId || "",
    displayName: entry.displayName || "",
    handle: entry.displayName || "Contributor",
    body: entry.body || "",
    walletValidated: Boolean(entry.walletValidated),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function mergeProjectComments(...commentLists) {
  const byId = new Map();
  for (const comment of commentLists.flat()) {
    if (!comment?.body) continue;
    const key = comment.id || `${comment.accountId || comment.handle}-${comment.createdAt || comment.body}`;
    if (!byId.has(key)) byId.set(key, comment);
  }
  return Array.from(byId.values()).sort((left, right) =>
    String(right.createdAt || "").localeCompare(String(left.createdAt || "")) ||
    String(right.id || "").localeCompare(String(left.id || ""))
  );
}

export function ProjectDocList({ items = [], title }) {
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

export function Stat({ label, value, accent = false }) {
  return (
    <div className="hive-stat">
      <span>{label}</span>
      <strong className={accent ? "is-accent" : ""}>{value}</strong>
    </div>
  );
}

export function Section({ title, subtitle, children, layerNumber = "" }) {
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

export function ProjectCard({ onOpenTask, operators, project, onClick }) {
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

export function ProjectNextTaskPreview({ nextTask, onOpenTask, operators = {}, pendingGenerationCount = 0, project = {} }) {
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
        <small>{nextTaskEyebrow(nextTask)}</small>
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

export function profileHref(accountId = "") {
  const normalized = String(accountId || "").trim();
  return normalized ? `#/profile?account=${encodeURIComponent(normalized)}` : "";
}

export function operatorHandle(operator = {}) {
  return String(operator.hiveHandle || operator.handle || "").replace(/^@+/, "").trim();
}

export function operatorDisplayName(operator = {}, wallet = "") {
  const handle = operatorHandle(operator);
  return operator.codename || operator.displayName || operator.publicDisplayName || (handle ? `@${handle}` : "") || compactWallet(wallet);
}

export function MachineOperatorBadge({ className = "", disclosure = null }) {
  if (!disclosure?.isMachineOperator) return null;
  return (
    <span className={`hive-machine-badge ${className}`}>
      {disclosure.label || "Orc operator"}
    </span>
  );
}

export function HiveProfileIdentity({
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

export function assigneeForTask(task = {}, operators = {}) {
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

export function hiveTaskSeed(source = {}, { operators = {}, project = {} } = {}) {
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

export function hiveTaskClickProps(seed = {}, onOpenTask = null) {
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

export function rewardProofTarget({ onOpenTask, pftlExplorerUrl = "", seed = {} } = {}) {
  const state = String(seed.state || seed.action || "").trim().toLowerCase();
  if (!["rewarded", "paid"].includes(state)) return null;
  const txHash = String(seed.proofTxHash || "").trim();
  const cid = String(seed.proofCid || "").trim();
  if (!txHash && !cid) return null;
  const href = transactionExplorerHref(txHash, pftlExplorerUrl);
  if (href) {
    return {
      cid,
      href,
      title: txHash,
      txHash,
    };
  }
  if (!seed.taskId || typeof onOpenTask !== "function") return null;
  return {
    cid,
    onOpen: () => onOpenTask(seed),
    title: txHash || cid,
    txHash,
  };
}

export function HiveProofAction({ label = "Reward proof", onOpenTask, pftlExplorerUrl = "", seed = {} }) {
  const target = rewardProofTarget({ onOpenTask, pftlExplorerUrl, seed });
  if (!target) return null;
  if (target.href) {
    return (
      <a
        aria-label={`Open reward transaction ${target.txHash}`}
        className="hive-proof-action"
        href={target.href}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        title={target.title}
      >
        <span>{label}</span>
        <ArrowUpRight size={12} strokeWidth={1.8} />
      </a>
    );
  }
  return (
    <button
      aria-label={target.txHash ? `View reward proof ${target.txHash}` : `View reward proof ${target.cid}`}
      className="hive-proof-action"
      onClick={(event) => {
        event.stopPropagation();
        target.onOpen?.();
      }}
      title={target.title}
      type="button"
    >
      <span>{label}</span>
      <ArrowUpRight size={12} strokeWidth={1.8} />
    </button>
  );
}

export function HiveRewardProofAmount({ amount, onOpenTask, pftlExplorerUrl = "", seed = {} }) {
  const target = rewardProofTarget({ onOpenTask, pftlExplorerUrl, seed });
  const label = `+${formatPft(amount)} PFT`;
  if (!target) return <span className="hive-pft">{label}</span>;
  if (target.href) {
    return (
      <a
        aria-label={`Open reward proof for ${label}`}
        className="hive-pft hive-reward-proof-amount"
        href={target.href}
        onClick={(event) => event.stopPropagation()}
        rel="noreferrer"
        target="_blank"
        title={target.title}
      >
        <span>{label}</span>
        <ArrowUpRight size={12} strokeWidth={1.8} />
      </a>
    );
  }
  return (
    <button
      aria-label={`View reward proof for ${label}`}
      className="hive-pft hive-reward-proof-amount"
      onClick={(event) => {
        event.stopPropagation();
        target.onOpen?.();
      }}
      title={target.title}
      type="button"
    >
      <span>{label}</span>
      <ArrowUpRight size={12} strokeWidth={1.8} />
    </button>
  );
}

export function FeedRow({ entry, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
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
      {entry.pft !== null && entry.pft !== undefined && (
        <HiveRewardProofAmount
          amount={entry.pft}
          onOpenTask={onOpenTask}
          pftlExplorerUrl={pftlExplorerUrl}
          seed={seed}
        />
      )}
      {showTime && <time>{timeLabel}</time>}
    </div>
  );
}

export function ContributorSpotlightRow({ contributor, rank = 0, last = false }) {
  const name = contributor.displayName || (contributor.handle ? `@${contributor.handle}` : contributor.accountId);
  const href = contributor.hasPublicProfile ? profileHref(contributor.accountId) : "";
  return (
    <div className={`hive-veteran-row ${last ? "is-last" : ""}`}>
      <span className="hive-veteran-rank">{rank}</span>
      <HiveProfileBadge nft={contributor.heroNft} size={26} variant={rank} />
      {href ? (
        <a className="hive-veteran-name" href={href}>{name}</a>
      ) : (
        <span className="hive-veteran-name">{name}</span>
      )}
      <span className="hive-veteran-stats">
        <span>{contributor.tasksRewarded} rewarded</span>
        <strong>{Number(contributor.rewards || 0).toLocaleString("en-US")} PFT</strong>
      </span>
    </div>
  );
}

export function AllottedOperatorRow({ wallet, operator, last = false }) {
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

export function ContributorCard({ contributor }) {
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

export function ProjectTaskRow({ task, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
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

export function HiveProfileBadge({ nft = null, size = 20, variant = 0 }) {
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

export function ActivityRow({ entry, last = false, onOpenTask, operators = {}, pftlExplorerUrl = "", project = {} }) {
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

export const HIVE_TASK_LIFECYCLE = [
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

export function hiveTaskLifecycleIndex(state = "") {
  const key = String(state || "").toLowerCase();
  if (["rewarded", "paid", "reward_decided"].includes(key)) return 4;
  if (["verification_requested", "verification_response_submitted", "verification_response"].includes(key)) return 3;
  if (key === "submitted") return 2;
  if (key === "accepted") return 1;
  return 0;
}

export function hiveTaskTone(state = "") {
  return HIVE_TASK_TONES[String(state || "").toLowerCase()] || "muted";
}

export function hiveTaskLabel(state = "") {
  return String(state || "unknown").replace(/_/g, " ");
}

export function shortPublicReference(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= 18 ? text : `${text.slice(0, 9)}…${text.slice(-7)}`;
}

export function nftHasImage(nft = null) {
  return Boolean(nft?.imageCid || nft?.imageGatewayUrl || nft?.imageDataUrl);
}

export function assigneeFromDetail(detailTask = {}, fallbackAssignee = null) {
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

export function mergeHiveTaskDetail(initialTask = {}, detailBody = null) {
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

export function hasReviewContent(review = null) {
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
