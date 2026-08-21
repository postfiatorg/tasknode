import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, RefreshCw, Search } from "lucide-react";
import { requestJson } from "../../api";
import {
  DOC_GROUPS,
  DOC_PAGES,
  SYSTEM_STATUS_DOC_LINKS,
  loadDocMarkdown,
  loadDocSearchIndex,
} from "./docs-content";
import { DocsDiagram } from "./DocsDiagram";
import "./docs.css";

const DEFAULT_DOC = "system-status-home";

export function DocsView() {
  const [selectedSlug, setSelectedSlug] = useState(() => docSlugFromLocation());
  const [pendingAnchor, setPendingAnchor] = useState("");
  const [query, setQuery] = useState("");
  const [markdownState, setMarkdownState] = useState({ slug: "", markdown: "", loading: true, error: "" });
  const [searchIndex, setSearchIndex] = useState(null);
  const [contentReload, setContentReload] = useState(0);
  const activeNavButtonRef = useRef(null);
  const contentRef = useRef(null);
  const selectedPage = DOC_PAGES.find((page) => page.slug === selectedSlug) || DOC_PAGES[0];
  const filteredGroups = useMemo(() => filterGroups(DOC_GROUPS, query, searchIndex), [query, searchIndex]);

  function openDocsPage(slug, anchor = "") {
    const nextSlug = DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
    setSelectedSlug(nextSlug);
    setPendingAnchor(anchor);
    setQuery("");
    writeDocsLocation(nextSlug);
  }

  useEffect(() => {
    if (
      !pendingAnchor ||
      markdownState.loading ||
      markdownState.slug !== selectedPage.slug ||
      typeof window === "undefined"
    ) return;
    const anchor = pendingAnchor;
    window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setPendingAnchor("");
  }, [markdownState.loading, markdownState.slug, pendingAnchor, selectedPage.slug]);

  useEffect(() => {
    let cancelled = false;
    setMarkdownState({ slug: selectedPage.slug, markdown: "", loading: true, error: "" });
    loadDocMarkdown(selectedPage)
      .then((markdown) => {
        if (!cancelled) setMarkdownState({ slug: selectedPage.slug, markdown, loading: false, error: "" });
      })
      .catch((error) => {
        if (!cancelled) {
          setMarkdownState({
            slug: selectedPage.slug,
            markdown: "",
            loading: false,
            error: error?.message || "This Help page could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contentReload, selectedPage]);

  useEffect(() => {
    if (!query.trim() || searchIndex) return undefined;
    let cancelled = false;
    loadDocSearchIndex()
      .then((index) => {
        if (!cancelled) setSearchIndex(index);
      })
      .catch(() => {
        // Metadata search remains available if one of the deferred documents fails.
      });
    return () => {
      cancelled = true;
    };
  }, [query, searchIndex]);

  useEffect(() => {
    if (pendingAnchor) return;
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    activeNavButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [pendingAnchor, selectedSlug]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    function syncDocsSlug() {
      setSelectedSlug(docSlugFromLocation());
    }

    window.addEventListener("popstate", syncDocsSlug);
    window.addEventListener("hashchange", syncDocsSlug);
    return () => {
      window.removeEventListener("popstate", syncDocsSlug);
      window.removeEventListener("hashchange", syncDocsSlug);
    };
  }, []);

  return (
    <div className="docs-view">
      <aside className="docs-sidebar" aria-label="Docs navigation">
        <div className="docs-brand">
          <span>
            <BookOpen size={18} strokeWidth={1.75} />
          </span>
          <div>
            <strong>Task Node Docs</strong>
            <small>Product and architecture wiki</small>
          </div>
        </div>
        <label className="docs-search">
          <Search size={15} strokeWidth={1.75} />
          <input
            aria-label="Search docs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs"
            type="search"
            value={query}
          />
        </label>
        <nav className="docs-nav">
          {filteredGroups.map((group) => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.pages.map((page) => (
                <button
                  className={page.slug === selectedPage.slug ? "active" : ""}
                  key={page.slug}
                  onClick={() => openDocsPage(page.slug)}
                  ref={page.slug === selectedPage.slug ? activeNavButtonRef : null}
                  type="button"
                >
                  <span>
                    <strong>{page.title}</strong>
                    <small>{page.summary}</small>
                  </span>
                  <ChevronRight size={14} strokeWidth={1.75} />
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <article className="docs-content" aria-labelledby="docs-page-title" ref={contentRef}>
        <header className="docs-header">
          <span>{selectedPage.group}</span>
          <h1 id="docs-page-title">{selectedPage.title}</h1>
          <p>{selectedPage.summary}</p>
        </header>
        {markdownState.loading && <div className="docs-content-state" role="status">Loading page…</div>}
        {!markdownState.loading && markdownState.error && (
          <div className="docs-content-state is-error" role="alert">
            <p>{markdownState.error}</p>
            <button onClick={() => setContentReload((value) => value + 1)} type="button">Retry</button>
          </div>
        )}
        {!markdownState.loading && !markdownState.error && <MarkdownArticle markdown={markdownState.markdown} />}
        {selectedPage.component === "system-status" && <SystemStatusPage onOpenDocPage={openDocsPage} />}
      </article>
    </div>
  );
}

function filterGroups(groups, query, searchIndex = null) {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  return groups
    .map((group) => ({
      ...group,
      pages: group.pages.filter((page) =>
        `${page.title} ${page.summary} ${page.markdown || ""} ${searchIndex?.[page.slug] || ""}`
          .toLowerCase()
          .includes(needle)
      ),
    }))
    .filter((group) => group.pages.length > 0);
}

function docSlugFromLocation() {
  if (typeof window === "undefined") return DEFAULT_DOC;
  const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
  const parts = hashPath.split("?")[0].split("/").filter(Boolean);
  const slug = ["help", "docs"].includes(parts[0]) ? parts[1] || DEFAULT_DOC : DEFAULT_DOC;
  return DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
}

function writeDocsLocation(slug) {
  if (typeof window === "undefined") return;
  const normalizedSlug = DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
  const url = new URL(window.location.href);
  url.hash = normalizedSlug === DEFAULT_DOC ? "help" : `help/${normalizedSlug}`;

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;
  window.history.pushState({ tasknodeView: "help", docsSlug: normalizedSlug }, "", nextPath);
}

function MarkdownArticle({ markdown }) {
  return (
    <div className="docs-markdown">
      {parseMarkdown(markdown).map((block, index) => (
        <MarkdownBlock block={block} key={index} />
      ))}
    </div>
  );
}

function SystemStatusPage({ onOpenDocPage }) {
  const [state, setState] = useState({ loading: true, status: null, error: "" });
  const [showAgentActivity, setShowAgentActivity] = useState(true);
  const [showNetworkSpend, setShowNetworkSpend] = useState(false);
  const [showBoardManagerCost, setShowBoardManagerCost] = useState(false);

  async function loadStatus() {
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await requestJson("/api/system/status");
    if (!result.ok || !result.body?.ok) {
      setState({
        loading: false,
        status: null,
        error: result.body?.error || `system_status_http_${result.status}`,
      });
      return;
    }
    setState({ loading: false, status: result.body, error: "" });
  }

  useEffect(() => {
    loadStatus();
  }, []);

  const status = state.status;
  const summary = status?.summary || {};
  return (
    <section className="system-status-panel" aria-label="Live system status">
      <div className="system-status-toolbar">
        <div>
          <h2>Live Status</h2>
          <p>{status?.generatedAt ? `Generated ${formatDateTime(status.generatedAt)}` : "Reading scheduler state"}</p>
        </div>
        <button className="system-status-refresh" disabled={state.loading} onClick={loadStatus} type="button">
          <RefreshCw size={15} strokeWidth={1.8} />
          <span>{state.loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </div>
      {state.error && <p className="system-status-error">{state.error}</p>}
      {status && (
        <>
          <div className="system-status-summary" aria-label="Status summary">
            {["critical", "warning", "ok", "unknown", "disabled"].map((key) => (
              <div className={`system-status-summary-cell is-${key}`} key={key}>
                <strong>{Number(summary[key] || 0)}</strong>
                <span>{statusLabel(key)}</span>
              </div>
            ))}
          </div>
          <p className="system-status-db">
            Database: {status.database?.enabled ? "enabled" : "not enabled"} · durable: {status.database?.durable ? "yes" : "no"}
          </p>
          {status.chatPricing && <SystemPricingPanel pricing={status.chatPricing} />}
          {status.agentActivity && (
            <SystemAgentActivityPanel
              activity={status.agentActivity}
              expanded={showAgentActivity}
              onToggle={() => setShowAgentActivity((value) => !value)}
            />
          )}
          {status.boardManagerDailyCost && (
            <SystemBoardManagerCostPanel
              cost={status.boardManagerDailyCost}
              expanded={showBoardManagerCost}
              onToggle={() => setShowBoardManagerCost((value) => !value)}
            />
          )}
          {status.networkTaskSpendByDay && (
            <SystemNetworkSpendPanel
              spend={status.networkTaskSpendByDay}
              expanded={showNetworkSpend}
              onToggle={() => setShowNetworkSpend((value) => !value)}
            />
          )}
          <div className="system-status-categories">
            {status.categories?.map((category) => (
              <section className="system-status-category" key={category.id}>
                <h2>{category.title}</h2>
                <p>{category.summary}</p>
                <div className="system-status-jobs">
                  {category.items?.map((entry) => (
                    <SystemStatusRow entry={entry} key={entry.id} onOpenDocPage={onOpenDocPage} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SystemAgentActivityPanel({ activity, expanded, onToggle }) {
  const summary = activity?.summary || {};
  const agents = Array.isArray(activity?.agents) ? activity.agents : [];
  return (
    <section className="system-agent-activity-panel" aria-label="Orc agent activity">
      <button
        className="system-network-spend-toggle system-agent-activity-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={expanded ? "is-expanded" : ""} size={15} strokeWidth={1.9} />
        <span>Orc agent activity</span>
        <strong>{Number(summary.activeAgentCount || 0).toLocaleString()} active</strong>
        <em>
          {Number(summary.currentTaskCount || 0).toLocaleString()} current tasks ·{" "}
          {formatPft(summary.rewardActualPft)} PFT
        </em>
      </button>
      {expanded && (
        <div className="system-agent-activity-list">
          {activity.enabled === false && <p>Orc agent activity tables are not available.</p>}
          {activity.enabled !== false && agents.length === 0 && <p>No registered Orc agents found.</p>}
          {agents.map((agent) => (
            <article className="system-agent-activity-card" key={agent.id || agent.handle}>
              <div className="system-agent-activity-card-title">
                <div>
                  <h3>{agent.handle || agent.agentId || "Unnamed agent"}</h3>
                  <p>{agent.role || "operator"} · {agent.status || "unknown"}</p>
                </div>
                <span>{agent.active ? "active" : "inactive"}</span>
              </div>
              <div className="system-agent-activity-grid">
                <div>
                  <strong>Current task</strong>
                  {agent.currentTask ? (
                    <p>
                      {agent.currentTask.title || agent.currentTask.taskId} · {agent.currentTask.status}
                    </p>
                  ) : (
                    <p>No active task</p>
                  )}
                </div>
                <div>
                  <strong>Rewards</strong>
                  <p>
                    {Number(agent.rewards?.taskCount || 0).toLocaleString()} tasks ·{" "}
                    {formatPft(agent.rewards?.totalPft)} PFT
                  </p>
                </div>
              </div>
              {agent.currentTasks?.length > 1 && (
                <ul className="system-agent-activity-list-compact">
                  {agent.currentTasks.slice(1, 4).map((task) => (
                    <li key={task.taskId}>
                      <span>{task.title || task.taskId}</span>
                      <em>{task.status}</em>
                    </li>
                  ))}
                </ul>
              )}
              {agent.recentActions?.length > 0 && (
                <div className="system-agent-recent-actions">
                  <strong>Recent actions</strong>
                  <ul>
                    {agent.recentActions.slice(0, 4).map((action, index) => (
                      <li key={`${agent.id}-action-${index}`}>
                        <span>{action.action || "agent_action"}</span>
                        <em>
                          {action.outcomeStatus || action.status || "recorded"}
                          {action.taskId ? ` · ${shortId(action.taskId)}` : ""}
                        </em>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SystemBoardManagerCostPanel({ cost, expanded, onToggle }) {
  const rows = Array.isArray(cost?.rows) ? cost.rows : [];
  const totals = cost?.totals || {};
  const maxTotal = rows.reduce((max, row) => Math.max(max, Number(row.costUsd || 0)), 0);
  return (
    <section
      className="system-network-spend-panel system-board-manager-cost-panel"
      aria-label="Board Manager daily token cost"
    >
      <button
        className="system-network-spend-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={expanded ? "is-expanded" : ""} size={15} strokeWidth={1.9} />
        <span>Board Manager daily token cost</span>
        <strong>{formatUsd(totals.costUsd)}</strong>
        <em>
          {Number(totals.runs || 0).toLocaleString()} model calls · {cost.windowDays || 30}d
        </em>
      </button>
      {expanded && (
        <div className="system-network-spend-list">
          <p>Operational LLM provider cost in USD. This is separate from Network Task PFT rewards.</p>
          {rows.length === 0 && (
            <p>{cost.enabled === false ? "Database token cost data is not available." : "No Board Manager token usage in this window."}</p>
          )}
          {rows.map((row) => {
            const total = Number(row.costUsd || 0);
            const width = maxTotal > 0 ? Math.max(4, Math.round((total / maxTotal) * 100)) : 0;
            return (
              <div className="system-network-spend-row system-board-manager-cost-row" key={row.date}>
                <span>{formatDateOnly(row.date)}</span>
                <div aria-hidden="true">
                  <i style={{ width: `${width}%` }} />
                </div>
                <strong>{formatUsd(total)}</strong>
                <em>
                  {Number(row.totalTokens || 0).toLocaleString()} tokens · {Number(row.runs || 0).toLocaleString()} calls
                </em>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SystemNetworkSpendPanel({ spend, expanded, onToggle }) {
  const rows = Array.isArray(spend?.rows) ? spend.rows : [];
  const totals = spend?.totals || {};
  const maxTotal = rows.reduce((max, row) => Math.max(max, Number(row.totalPft || 0)), 0);
  return (
    <section className="system-network-spend-panel" aria-label="Network task spend by day">
      <button
        className="system-network-spend-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={expanded ? "is-expanded" : ""} size={15} strokeWidth={1.9} />
        <span>Network task spend by day</span>
        <strong>{formatPft(totals.totalPft)} PFT</strong>
        <em>{Number(totals.taskCount || 0).toLocaleString()} tasks · {spend.windowDays || 30}d</em>
      </button>
      {expanded && (
        <div className="system-network-spend-list">
          {rows.length === 0 && (
            <p>{spend.enabled === false ? "Database spend data is not available." : "No paid Network Tasks in this window."}</p>
          )}
          {rows.map((row) => {
            const total = Number(row.totalPft || 0);
            const width = maxTotal > 0 ? Math.max(4, Math.round((total / maxTotal) * 100)) : 0;
            return (
              <div className="system-network-spend-row" key={row.date}>
                <span>{formatDateOnly(row.date)}</span>
                <div aria-hidden="true">
                  <i style={{ width: `${width}%` }} />
                </div>
                <strong>{formatPft(total)} PFT</strong>
                <em>{Number(row.taskCount || 0).toLocaleString()} tasks</em>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SystemPricingPanel({ pricing }) {
  const modes = Array.isArray(pricing?.modes) ? pricing.modes : [];
  const references = Array.isArray(pricing?.references) ? pricing.references : [];
  const live = pricing?.live || {};
  const cacheEfficiency = pricing?.cacheEfficiency || {};
  const cacheModes = Array.isArray(cacheEfficiency.modes) ? cacheEfficiency.modes : [];
  return (
    <section className="system-pricing-panel" aria-label="Chat model pricing">
      <div className="system-pricing-heading">
        <div>
          <h2>Chat Model Pricing</h2>
          <p>
            Configured estimates and live Ambient metadata for the current chat modes.{" "}
            {cacheEfficiency.status === "ok"
              ? `${cacheEfficiency.cacheHitPercent ?? 0}% cache hit across ${cacheEfficiency.reportedRuns}/${cacheEfficiency.runs} reported runs, saving ${formatUsd(cacheEfficiency.cacheSavingsUsd)} over ${cacheEfficiency.windowDays} days.`
              : cacheEfficiency.status === "awaiting_reported_usage"
                ? `Cache telemetry is waiting for a provider response with cache details (${cacheEfficiency.runs || 0} runs in the current window).`
                : "Cache telemetry is not currently available."}
          </p>
        </div>
        <span className={`system-pricing-source is-${live.status || "unknown"}`}>
          {live.status === "ok"
            ? `Live ${formatDateTime(live.fetchedAt)}`
            : live.status === "disabled"
              ? "Live pricing off"
              : live.status === "error"
                ? "Live pricing error"
                : "Live pricing pending"}
        </span>
      </div>
      {live.error && <p className="system-status-error">{live.error}</p>}
      <div className="system-pricing-grid">
        {modes.map((mode) => (
          <SystemPricingCard
            cacheMetrics={cacheModes.find((entry) => entry.mode === mode.mode && entry.model === mode.model)}
            key={mode.mode}
            mode={mode}
          />
        ))}
      </div>
      {references.length > 0 && (
        <div className="system-pricing-references">
          {references.map((reference) => (
            <div key={reference.id}>
              <strong>{reference.title}</strong>
              <span>{reference.provider} · {reference.model}</span>
              <span>
                {formatUsdPerMillion(reference.inputUsdPerMillion)} in ·{" "}
                {formatUsdPerMillion(reference.outputUsdPerMillion)} out
              </span>
              <p>{reference.privacyPolicy}</p>
            </div>
          ))}
        </div>
      )}
      {pricing.notes?.length > 0 && (
        <ul className="system-pricing-notes">
          {pricing.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SystemPricingCard({ cacheMetrics = null, mode }) {
  const liveModel = mode.liveModel || {};
  const endpoints = pricingEndpointsForDisplay(mode);
  const maxOutputLabel = liveModel.maxCompletionTokens || mode.maxOutputTokens
    ? formatCompactNumber(liveModel.maxCompletionTokens || mode.maxOutputTokens)
    : "provider default";
  return (
    <article className="system-pricing-card">
      <div className="system-pricing-card-title">
        <h3>{mode.mode}</h3>
        <span>{mode.providerLabel || mode.provider}</span>
      </div>
      <p>{mode.description}</p>
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{mode.model}</dd>
        </div>
        <div>
          <dt>Configured estimate</dt>
          <dd>
            {formatUsdPerMillion(mode.configuredPricing?.inputUsdPerMillion)} in ·{" "}
            {formatUsdPerMillion(mode.configuredPricing?.outputUsdPerMillion)} out
            {mode.configuredPricing?.inputCacheHitUsdPerMillion
              ? ` · ${formatUsdPerMillion(mode.configuredPricing.inputCacheHitUsdPerMillion)} cache hit`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Live headline</dt>
          <dd>
            {liveModel.inputUsdPerMillion === undefined
              ? "n/a"
              : `${formatUsdPerMillion(liveModel.inputUsdPerMillion)} in · ${formatUsdPerMillion(liveModel.outputUsdPerMillion)} out${
                  liveModel.cacheReadUsdPerMillion
                    ? ` · ${formatUsdPerMillion(liveModel.cacheReadUsdPerMillion)} cache hit`
                    : ""
                }`}
          </dd>
        </div>
        <div>
          <dt>Context / max output</dt>
          <dd>
            {formatCompactNumber(liveModel.contextLength)} /{" "}
            {maxOutputLabel}
          </dd>
        </div>
        <div>
          <dt>Reasoning</dt>
          <dd>{mode.reasoning || "none"}</dd>
        </div>
        <div>
          <dt>Cache efficiency</dt>
          <dd>
            {cacheMetrics?.reportedRuns > 0
              ? `${cacheMetrics.cacheHitPercent ?? 0}% hit · ${Number(cacheMetrics.promptCacheHitTokens || 0).toLocaleString()} tokens · ${formatUsd(cacheMetrics.cacheSavingsUsd)} saved · ${cacheMetrics.reportedRuns}/${cacheMetrics.runs} runs reported`
              : cacheMetrics?.runs > 0
                ? `Awaiting provider cache details · 0/${cacheMetrics.runs} runs reported`
                : "No runs in telemetry window"}
          </dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>{mode.privacyPolicy}</dd>
        </div>
      </dl>
      {liveModel.description && <p className="system-pricing-description">{liveModel.description}</p>}
      {endpoints.length > 0 && (
        <div className="system-pricing-endpoints">
          {endpoints.map((endpoint) => (
            <span className={endpoint.allowed ? "is-allowed" : "is-reference"} key={`${mode.mode}-${endpoint.providerSlug}`}>
              {endpoint.provider} · {formatUsdPerMillion(endpoint.outputUsdPerMillion)} out{" "}
              {endpoint.allowed ? "allowed" : "reference"}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function pricingEndpointsForDisplay(mode = {}) {
  const endpoints = Array.isArray(mode.liveEndpoints) ? mode.liveEndpoints : [];
  const allowed = endpoints.filter((endpoint) => endpoint.allowed).slice(0, 4);
  const deepseek = endpoints.find((endpoint) => endpoint.providerSlug === "deepseek" && !endpoint.allowed);
  return [deepseek, ...allowed].filter(Boolean).slice(0, 5);
}

function SystemStatusRow({ entry, onOpenDocPage }) {
  const docLink = SYSTEM_STATUS_DOC_LINKS[entry.id];
  return (
    <article className={`system-status-row is-${entry.status || "unknown"}`}>
      <div className="system-status-row-main">
        <span className="system-status-dot" aria-hidden="true" />
        <div>
          <h3>{entry.title}</h3>
          <p>{entry.description}</p>
        </div>
      </div>
      <div className="system-status-row-meta">
        <span>{entry.statusLabel || statusLabel(entry.status)}</span>
        <span>{entry.owner}</span>
        <span>{entry.cadence}</span>
      </div>
      <dl>
        <div>
          <dt>Last run</dt>
          <dd>{formatDateTime(entry.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{formatDateTime(entry.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>{formatDateTime(entry.nextRunAt)}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{entry.trigger || "n/a"}</dd>
        </div>
      </dl>
      {entry.counts && Object.keys(entry.counts).length > 0 && (
        <div className="system-status-counts">
          {Object.entries(entry.counts).map(([key, value]) => (
            <span key={key}>
              {compactLabel(key)} <strong>{String(value)}</strong>
            </span>
          ))}
        </div>
      )}
      {entry.lastError && <p className="system-status-last-error">{entry.lastError}</p>}
      {entry.details?.length > 0 && (
        <ul className="system-status-details">
          {entry.details.map((detail, index) => (
            <li key={`${entry.id}-${index}`}>{detail}</li>
          ))}
        </ul>
      )}
      {docLink && (
        <a
          className="system-status-doc-link"
          href={`#docs/${docLink.slug}`}
          onClick={(event) => {
            event.preventDefault();
            onOpenDocPage?.(docLink.slug);
          }}
        >
          <BookOpen size={14} strokeWidth={1.8} />
          <span>{docLink.label}</span>
        </a>
      )}
    </article>
  );
}

function statusLabel(status = "unknown") {
  return {
    critical: "Red",
    warning: "Amber",
    ok: "Green",
    unknown: "Unknown",
    disabled: "Disabled",
  }[status] || "Unknown";
}

function compactLabel(value = "") {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatUsdPerMillion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return `$${numeric.toLocaleString(undefined, {
    minimumFractionDigits: numeric < 1 ? 3 : 2,
    maximumFractionDigits: numeric < 1 ? 6 : 3,
  })}/M`;
}

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "$0.00";
  return `$${numeric.toLocaleString(undefined, {
    minimumFractionDigits: numeric > 0 && numeric < 0.01 ? 4 : 2,
    maximumFractionDigits: numeric > 0 && numeric < 0.01 ? 6 : 2,
  })}`;
}

function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "n/a";
  return numeric.toLocaleString();
}

function formatPft(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString(undefined, {
    maximumFractionDigits: numeric >= 1000 ? 0 : 2,
  });
}

function formatDateOnly(value) {
  if (!value) return "n/a";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "n/a";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shortId(value = "") {
  const text = String(value || "");
  if (text.length <= 14) return text;
  return `${text.slice(0, 7)}...${text.slice(-4)}`;
}

function MarkdownBlock({ block }) {
  if (block.type === "h1") return null;
  if (block.type === "h2") return <h2 id={slugifyHeading(block.text)}>{block.text}</h2>;
  if (block.type === "h3") return <h3 id={slugifyHeading(block.text)}>{block.text}</h3>;
  if (block.type === "p") return <p>{renderInline(block.text)}</p>;
  if (block.type === "ul") {
    return (
      <ul>
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "ol") {
    return (
      <ol>
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "code") {
    if (block.lang === "mermaid") return <DocsDiagram source={block.text} />;
    return (
      <pre>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === "table") {
    return (
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={index}>{renderInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

function slugifyHeading(value = "") {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const raw = line.trimEnd();
    const trimmed = raw.trim();
    const fence = trimmed.match(/^```(\w+)?/);

    if (fence) {
      if (code) {
        blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { lang: fence[1] || "", lines: [] };
      }
      continue;
    }

    if (code) {
      code.lines.push(raw);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const nextLine = lines[lineIndex + 1]?.trim() || "";
    if (isMarkdownTableRow(trimmed) && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const headers = splitMarkdownTableRow(trimmed);
      const rows = [];
      let cursor = lineIndex + 2;
      while (cursor < lines.length && isMarkdownTableRow(lines[cursor]?.trim() || "")) {
        rows.push(normalizeTableRow(splitMarkdownTableRow(lines[cursor]), headers.length));
        cursor += 1;
      }
      blocks.push({ type: "table", headers, rows });
      lineIndex = cursor - 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2] });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  if (code) blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
  return blocks;
}

function isMarkdownTableRow(line) {
  const text = String(line || "").trim();
  return text.startsWith("|") && text.endsWith("|") && text.split("|").length > 3;
}

function isMarkdownTableSeparator(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeTableRow(row, count) {
  return Array.from({ length: count }, (_, index) => row[index] || "");
}

function renderInline(text) {
  const tokens = [];
  const pattern = /(\[[^\]]+\]\((?:https?:\/\/|#)[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|#)[^)\s]+)\)$/);
      tokens.push(
        link && link[2].startsWith("#") ? (
          <a href={link[2]} key={tokens.length}>
            {link[1]}
          </a>
        ) : link ? (
          <a href={link[2]} key={tokens.length} rel="noreferrer" target="_blank">
            {link[1]}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("`")) {
      tokens.push(<code key={tokens.length}>{token.slice(1, -1)}</code>);
    } else {
      tokens.push(<strong key={tokens.length}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens;
}
