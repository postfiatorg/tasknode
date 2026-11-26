import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { hiveTaskSeed } from "./HiveProjectPanels.jsx";
import { formatPft } from "./hive-view-utils.jsx";
import "./hive-wanted.css";

const STATES = [
  { id: "open", label: "Open", empty: "Nothing open right now. New needs are added as they come up." },
  { id: "in_progress", label: "Taken", empty: "Nobody is working on an item on this board yet." },
  { id: "done", label: "Done", empty: "Nothing finished yet." },
];

// A short, readable name for where a need came from.
export function wantedSourceLabel(url = "") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "Source";
  }
  const host = parsed.hostname.startsWith("www.") ? parsed.hostname.slice(4) : parsed.hostname;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 4) {
    const repo = parts[1];
    if (parts[2] === "issues") return `${repo} issue #${parts[3]}`;
    if (parts[2] === "pull") return `${repo} PR #${parts[3]}`;
    if (parts.includes("governance")) return "Governance Entry 001";
    return repo;
  }
  if (host === "goodalexander.com" && parts[0] === "trade-ideas" && parts[1]) return `${parts[1].toUpperCase()} trade idea`;
  if ((host === "x.com" || host === "twitter.com") && parts[0]) return `X post by @${parts[0]}`;
  if (host === "postfiat.org") {
    if (parts[0] === "blog" || parts[0] === "research") return "postfiat.org post";
    return `postfiat.org/${parts[0] || ""}`.replace(/\/$/, "");
  }
  return host;
}

function ownerName(owner) {
  if (!owner) return "";
  if (owner.handle) return `@${owner.handle}`;
  return owner.displayName || "";
}

function WantedSource({ url }) {
  if (!url) return null;
  return (
    <a className="hive-wanted-source" href={url} rel="noreferrer" target="_blank">
      {wantedSourceLabel(url)}
      <ExternalLink aria-hidden="true" size={11} strokeWidth={2} />
    </a>
  );
}

function WantedCard({ item, showBoard, owner, onOpenTask }) {
  const openTask = item.taskId && onOpenTask
    ? () => onOpenTask(hiveTaskSeed({ taskId: item.taskId, title: item.title, state: item.taskStatus, projectId: item.boardId, project: item.boardName || "" }))
    : null;
  return (
    <article className={`hive-wanted-card is-${item.state}`}>
      <div className="hive-wanted-card-top">
        {showBoard && item.boardName ? <span className="hive-wanted-board">{item.boardName}</span> : <span />}
        {item.rewardPft > 0 ? <span className="hive-wanted-reward">Up to {formatPft(item.rewardPft)} PFT</span> : null}
      </div>
      <h3 className="hive-wanted-title">{item.title}</h3>
      <p className="hive-wanted-why">{item.why}</p>
      <div className="hive-wanted-card-foot">
        <WantedSource url={item.sourceUrl} />
        {item.state === "in_progress" || item.state === "done" ? (
          <span className="hive-wanted-owner">
            {ownerName(owner) ? (item.state === "done" ? `Done by ${ownerName(owner)}` : `Taken by ${ownerName(owner)}`) : item.state === "done" ? "Done" : "Taken"}
          </span>
        ) : null}
        {openTask ? (
          <button className="hive-wanted-task" onClick={openTask} type="button">View task</button>
        ) : null}
      </div>
    </article>
  );
}

// The Wanted list: specific things Post Fiat needs, each with a link to where
// the need came from. Open items first; taken and done items one click away.
export function WantedPanel({ items = [], boards = [], owners = {}, onOpenTask, showBoard = false, status = "ready" }) {
  const [board, setBoard] = useState("all");
  const [state, setState] = useState("open");
  const live = useMemo(() => items.filter((item) => item.state !== "dropped" && item.state !== "rewrite"), [items]);
  const inBoard = useMemo(() => (board === "all" ? live : live.filter((item) => item.boardId === board)), [live, board]);
  const counts = useMemo(() => Object.fromEntries(STATES.map(({ id }) => [id, inBoard.filter((item) => item.state === id).length])), [inBoard]);
  const shown = inBoard.filter((item) => item.state === state);
  const current = STATES.find((entry) => entry.id === state) || STATES[0];

  if (status === "loading") return <div className="hive-card hive-empty-project">Loading the Wanted list.</div>;
  if (!live.length) return <div className="hive-card hive-empty-project">Nothing on the Wanted list yet.</div>;

  return (
    <div className="hive-wanted">
      <div className="hive-wanted-controls">
        {showBoard && boards.length > 1 ? (
          <div aria-label="Board" className="hive-wanted-boards" role="tablist">
            {[{ id: "all", name: "All boards" }, ...boards].map((entry) => {
              const open = (entry.id === "all" ? live : live.filter((item) => item.boardId === entry.id)).filter((item) => item.state === "open").length;
              return (
                <button
                  aria-selected={board === entry.id}
                  className={`hive-wanted-chip ${board === entry.id ? "is-active" : ""}`}
                  key={entry.id}
                  onClick={() => setBoard(entry.id)}
                  role="tab"
                  type="button"
                >
                  {entry.name}
                  <span className="hive-wanted-chip-count">{open}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <div aria-label="Status" className="hive-wanted-states" role="tablist">
          {STATES.map((entry) => (
            <button
              aria-selected={state === entry.id}
              className={`hive-wanted-state-tab ${state === entry.id ? "is-active" : ""}`}
              key={entry.id}
              onClick={() => setState(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label} <span>{counts[entry.id]}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <div className="hive-wanted-grid">
          {shown.map((item) => (
            <WantedCard item={item} key={item.id} onOpenTask={onOpenTask} owner={owners[item.taskId]} showBoard={showBoard && board === "all"} />
          ))}
        </div>
      ) : (
        <div className="hive-card hive-empty-project">{current.empty}</div>
      )}
    </div>
  );
}

// taskId -> public owner identity, from the Hive document's task rows.
export function wantedOwnersFromProjects(projects = {}) {
  const owners = {};
  for (const project of Object.values(projects || {})) {
    for (const task of project.tasks || []) {
      if (!task.taskId) continue;
      owners[task.taskId] = task.assigneeHasPublicProfile
        ? { handle: task.assigneeHandle || "", displayName: task.assigneeDisplayName || "" }
        : { handle: "", displayName: "" };
    }
  }
  return owners;
}
