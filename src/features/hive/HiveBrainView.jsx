import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import "./hive.css";

// Hive Brain v2: the network's control room. One autonomous board-manager
// agent per board; this view shows what each one is actually doing — a
// structured action feed from the audit log beside a live, secret-scrubbed
// mirror of the agent's terminal screen.

const BOARDS = [
  { id: "board_community_promotion", label: "Community & Promotion", code: "CMP" },
  { id: "board_pf_terminal", label: "PF Terminal", code: "PFT" },
  { id: "board_postfiat_l1v2", label: "PostfiatL1V2", code: "L1V2" },
  { id: "board_ai_l1_governance", label: "AI L1 Governance", code: "GOV" },
  { id: "board_tasknode_fixes", label: "Task Node Fixes", code: "TNF" },
  { id: "board_capital_markets", label: "Capital Markets", code: "CAP" },
];

const POLL_MS = 20000;

const COMMAND_META = {
  review: { label: "Reward decision", tone: "green" },
  verify_request: { label: "Verification challenge", tone: "amber" },
  task_create: { label: "Task routed", tone: "ink" },
  board_update: { label: "Board updated", tone: "muted" },
  journal_append: { label: "Journal entry", tone: "muted" },
  handoff: { label: "Daily handoff", tone: "muted" },
};

function pft(value) {
  return `${Number(value || 0).toLocaleString("en-US")} PFT`;
}

function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function ActionCard({ action }) {
  const meta = COMMAND_META[action.command] || { label: action.command, tone: "muted" };
  return (
    <article className={`bm-action bm-tone-${meta.tone}`}>
      <header className="bm-action-head">
        <span className="bm-action-kind">{meta.label}</span>
        <time className="bm-action-time" dateTime={action.created_at}>
          {timeAgo(action.created_at)}
        </time>
      </header>
      {action.command === "review" ? (
        <p className="bm-action-body">
          <strong className={action.decision === "reject" ? "bm-reject" : "bm-reward"}>
            {action.decision || "decision"}
          </strong>
          {action.task_id ? <> on <code>{action.task_id}</code></> : null}
          {action.requested_pft ? (
            <>
              {" — asked "}
              {pft(action.requested_pft)}
              {action.clamped_pft !== null && action.clamped_pft !== action.requested_pft ? (
                <>
                  , <strong className="bm-clamped">clamped to {pft(action.clamped_pft)}</strong>
                </>
              ) : null}
            </>
          ) : null}
          {action.refused ? <strong className="bm-reject"> — refused by caps</strong> : null}
        </p>
      ) : action.command === "task_create" ? (
        <p className="bm-action-body">
          {action.need || "New network task"}
          {action.reward_max ? <> · up to {pft(action.reward_max)}</> : null}
          {action.dry_run && !action.executed ? <em className="bm-dim"> (dry run)</em> : null}
        </p>
      ) : (
        <p className="bm-action-body">{action.reason || action.need || "—"}</p>
      )}
      {action.caps_applied?.length ? (
        <p className="bm-action-caps">caps: {action.caps_applied.join(", ")}</p>
      ) : null}
    </article>
  );
}

function BudgetMeter({ budget }) {
  if (!budget) return null;
  const spent = budget.spent_today_pft || 0;
  const total = budget.daily_budget_pft || 1;
  const percent = Math.min(100, Math.round((spent / total) * 100));
  return (
    <section className="bm-budget" aria-label="Daily reward budget">
      <div className="bm-budget-row">
        <span>Today&apos;s budget</span>
        <span className="bm-budget-nums">
          {pft(spent)} / {pft(total)}
        </span>
      </div>
      <div className="bm-budget-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="bm-budget-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="bm-budget-caps">
        per-task cap {pft(budget.per_task_cap_pft)} · per-user 7d {pft(budget.per_user_7d_cap_pft)}
      </div>
    </section>
  );
}

export function HiveBrainView() {
  const [boardId, setBoardId] = useState(BOARDS[1].id);
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id) => {
    setLoading(true);
    try {
      const result = await requestJson(`/api/hive/bm-feed?board=${encodeURIComponent(id)}`);
      if (result.ok && result.body?.ok) {
        setFeed(result.body);
        setError("");
      } else {
        setError(result.body?.error || `feed unavailable (${result.status})`);
      }
    } catch {
      setError("feed unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setFeed(null);
    load(boardId);
    const timer = setInterval(() => load(boardId), POLL_MS);
    return () => clearInterval(timer);
  }, [boardId, load]);

  const online = feed?.agent?.online === true;
  const transcriptLines = useMemo(() => {
    const content = feed?.transcript?.content || "";
    return content.split("\n").filter((line) => line.trim() !== "").slice(-40).join("\n");
  }, [feed]);

  return (
    <div className="route-scroll hive-route">
      <div className="hive-shell hive-brain-shell">
        <header className="bm-head">
          <div>
            <h1 className="bm-title">Hive Brain</h1>
            <p className="bm-sub">
              Autonomous board managers run this network&apos;s task boards.
              This is their public control room: every decision on the left,
              the agent&apos;s live terminal on the right.
            </p>
          </div>
          <button
            type="button"
            className="bm-refresh"
            onClick={() => load(boardId)}
            disabled={loading}
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? "bm-spin" : undefined} />
            Refresh
          </button>
        </header>

        <nav className="bm-boards" aria-label="Boards">
          {BOARDS.map((board) => (
            <button
              key={board.id}
              type="button"
              className={board.id === boardId ? "bm-board-tab is-active" : "bm-board-tab"}
              onClick={() => setBoardId(board.id)}
            >
              <span className="bm-board-code">{board.code}</span>
              <span className="bm-board-name">{board.label}</span>
            </button>
          ))}
        </nav>

        {error ? <div className="bm-error">{error}</div> : null}

        {feed ? (
          <div className="bm-grid">
            <section className="bm-feed" aria-label="Agent activity">
              <h2 className="bm-col-title">
                <Activity size={14} aria-hidden="true" /> Activity
              </h2>
              {feed.actions?.length ? (
                feed.actions.map((action) => <ActionCard key={action.id} action={action} />)
              ) : (
                <div className="bm-empty">
                  No manager actions recorded on this board yet. When the
                  agent reviews a submission, routes a task, or writes its
                  journal, it appears here.
                </div>
              )}
            </section>

            <aside className="bm-side">
              <section className="bm-screen-card" aria-label="Agent terminal">
                <header className="bm-screen-head">
                  <span className={online ? "bm-led is-on" : "bm-led"} aria-hidden="true" />
                  <span className="bm-screen-title">
                    {feed.transcript?.session_name || "agent screen"}
                  </span>
                  <span className="bm-screen-status">
                    {online
                      ? "LIVE"
                      : feed.agent?.last_seen
                        ? `idle · ${timeAgo(feed.agent.last_seen)}`
                        : "offline"}
                  </span>
                </header>
                {transcriptLines ? (
                  <pre className="bm-screen" tabIndex={0}>{transcriptLines}</pre>
                ) : (
                  <div className="bm-screen bm-screen-empty">
                    No terminal capture yet. The agent&apos;s screen is
                    mirrored here every few minutes while it runs.
                  </div>
                )}
              </section>
              <BudgetMeter budget={feed.budget} />
            </aside>
          </div>
        ) : !error ? (
          <div className="bm-empty">Loading board feed…</div>
        ) : null}
      </div>
    </div>
  );
}
