import { useMemo, useState } from "react";
import { BookOpen, CheckCheck, Newspaper, Search, Sparkles, Star } from "lucide-react";
import {
  isNewSinceBaseline,
  matchesTodayFilters,
  sortWithWatchlistFirst,
} from "./goodbrief-sandbox.js";

const ASSET_FILTERS = [
  { id: "all", label: "All" },
  { id: "equities", label: "Equities" },
  { id: "crypto", label: "Crypto" },
  { id: "macro", label: "Macro" },
];

function WatchStar({ starred, ticker, onToggle }) {
  return (
    <button
      aria-label={starred ? `Remove ${ticker} from watchlist` : `Add ${ticker} to watchlist`}
      className={`fh-star-btn${starred ? " is-starred" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(ticker);
      }}
      type="button"
    >
      <Star size={14} strokeWidth={1.8} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

function NewBadge({ show }) {
  if (!show) return null;
  return <span className="fh-new-badge">New</span>;
}

export function FinanceHubToday({
  data,
  loading,
  watchlist,
  visitBaselineAt,
  onToggleWatchlist,
  onMarkCaughtUp,
  onOpenModel,
  onOpenGoodbrief,
  onOpenLibrary,
  onAskAgent,
}) {
  const [query, setQuery] = useState("");
  const [assetClass, setAssetClass] = useState("all");
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const watchlistSet = useMemo(() => new Set((watchlist || []).map((t) => String(t).toUpperCase())), [watchlist]);
  const filterOpts = useMemo(
    () => ({ query, assetClass, watchlistSet, watchlistOnly }),
    [query, assetClass, watchlistSet, watchlistOnly]
  );

  const justReported = useMemo(
    () => sortWithWatchlistFirst((data?.justReported || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.justReported, filterOpts, watchlistSet]
  );
  const modelUpdates = useMemo(
    () => sortWithWatchlistFirst((data?.modelUpdates || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.modelUpdates, filterOpts, watchlistSet]
  );
  const reportingThisWeek = useMemo(
    () => sortWithWatchlistFirst((data?.reportingThisWeek || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.reportingThisWeek, filterOpts, watchlistSet]
  );
  const liveMovers = useMemo(
    () => sortWithWatchlistFirst((data?.liveMovers || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.liveMovers, filterOpts, watchlistSet]
  );
  const coverageChanges = useMemo(
    () => sortWithWatchlistFirst((data?.coverageChanges || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.coverageChanges, filterOpts, watchlistSet]
  );
  const models = useMemo(
    () => sortWithWatchlistFirst((data?.models || []).filter((item) => matchesTodayFilters(item, filterOpts)), watchlistSet),
    [data?.models, filterOpts, watchlistSet]
  );
  const libraryItems = useMemo(
    () => (data?.library || []).filter((item) => matchesTodayFilters(item, { query, assetClass: "all" })),
    [data?.library, query]
  );

  const goodbrief = data?.goodbrief || null;
  const goodbriefIsNew = isNewSinceBaseline(goodbrief?.published_at || goodbrief?.updated_at, visitBaselineAt);

  return (
    <div className="fh-today-scroll">
      <div className="fh-today-wrap">
        <div className="fh-toolbar">
          <label className="fh-search-box">
            <Search size={15} strokeWidth={1.8} />
            <input
              aria-label="Search tickers, companies, or macro topics"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search ~60 models, tickers, or Goodbrief..."
              type="search"
              value={query}
            />
          </label>
          <div className="fh-filter-pills" role="group" aria-label="Asset class filter">
            {ASSET_FILTERS.map((filter) => (
              <button
                className={`fh-pill${assetClass === filter.id ? " is-active" : ""}`}
                key={filter.id}
                onClick={() => setAssetClass(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
            <button
              className={`fh-pill${watchlistOnly ? " is-active" : ""}`}
              onClick={() => setWatchlistOnly((value) => !value)}
              type="button"
            >
              <Star size={12} strokeWidth={2} /> Watchlist ({watchlistSet.size})
            </button>
          </div>
          <button className="fh-pill fh-caught-up-btn" onClick={onMarkCaughtUp} type="button">
            <CheckCheck size={14} strokeWidth={1.8} /> Mark caught up
          </button>
        </div>

        {loading && <p className="fh-muted">Loading today&apos;s research desk...</p>}

        {/* 1. Goodbrief Summary */}
        <section className="fh-section">
          <div className="fh-section-head">
            <h2><Newspaper size={16} strokeWidth={1.8} /> Goodbrief Macro Roundup <NewBadge show={goodbriefIsNew} /></h2>
            <button className="fh-link-btn" onClick={onOpenGoodbrief} type="button">Open isolated brief</button>
          </div>
          {goodbrief ? (
            <div className="fh-goodbrief-card">
              <div className="fh-card-title-row">
                <strong>{goodbrief.title || "Morning Macro Brief"}</strong>
                {goodbrief.published_at && <span className="fh-meta">{String(goodbrief.published_at).slice(0, 16).replace("T", " ")} UTC</span>}
              </div>
              <p className="fh-body-text">{goodbrief.summary || goodbrief.headline || "Latest daily macro roundup."}</p>
              {Array.isArray(goodbrief.highlights) && goodbrief.highlights.length > 0 && (
                <ul className="fh-highlights">
                  {goodbrief.highlights.slice(0, 4).map((line, index) => <li key={index}>{String(line)}</li>)}
                </ul>
              )}
            </div>
          ) : (
            <p className="fh-muted">
              {data?.goodbriefAllowed === false
                ? "Goodbrief is not enabled for your current access basis."
                : "Today's Goodbrief summary will appear here as soon as it is published."}
            </p>
          )}
        </section>

        {/* 2. Just Reported */}
        <section className="fh-section">
          <div className="fh-section-head">
            <h2>Just Reported</h2>
            <span className="fh-meta">{justReported.length} items</span>
          </div>
          {justReported.length > 0 ? (
            <div className="fh-card-grid">
              {justReported.map((item) => {
                const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                return (
                  <article className="fh-card" key={`${ticker}-${item.reported_at || item.period || ""}`} onClick={() => onOpenModel(ticker)}>
                    <div className="fh-card-title-row">
                      <span className="fh-ticker">{ticker}</span>
                      <NewBadge show={isNewSinceBaseline(item.updated_at || item.reported_at, visitBaselineAt)} />
                      <WatchStar onToggle={onToggleWatchlist} starred={watchlistSet.has(ticker)} ticker={ticker} />
                    </div>
                    <div className="fh-card-sub">{item.name || ticker} {item.vs_consensus ? `· ${item.vs_consensus}` : ""}</div>
                    {item.takeaway && <p className="fh-body-text">{item.takeaway}</p>}
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="fh-muted">No recent earnings releases match your filters.</p>
          )}
        </section>

        {/* 3. Model Updates */}
        <section className="fh-section">
          <div className="fh-section-head">
            <h2>Model Updates</h2>
            <span className="fh-meta">{modelUpdates.length} updates</span>
          </div>
          {modelUpdates.length > 0 ? (
            <div className="fh-list">
              {modelUpdates.map((item) => {
                const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                return (
                  <div className="fh-list-row" key={`${ticker}-${item.updated_at || ""}`}>
                    <div className="fh-row-main" onClick={() => onOpenModel(ticker)}>
                      <div className="fh-card-title-row">
                        <span className="fh-ticker">{ticker}</span>
                        <span className="fh-meta">{item.target_before && item.target_after ? `${item.target_before} → ${item.target_after}` : ""}</span>
                        {item.upside_after && <span className="fh-meta">({item.upside_after})</span>}
                        <NewBadge show={isNewSinceBaseline(item.updated_at, visitBaselineAt)} />
                      </div>
                      {item.why && <p className="fh-body-text">{item.why}</p>}
                    </div>
                    <div className="fh-row-actions">
                      <button className="fh-pill" onClick={() => onAskAgent(ticker)} type="button">
                        <Sparkles size={12} strokeWidth={1.8} /> Ask agent
                      </button>
                      <WatchStar onToggle={onToggleWatchlist} starred={watchlistSet.has(ticker)} ticker={ticker} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="fh-muted">No model target or upside changes match your filters.</p>
          )}
        </section>

        {/* 4. Reporting This Week & 5. Live Movers */}
        <div className="fh-two-col">
          <section className="fh-section">
            <div className="fh-section-head">
              <h2>Reporting This Week</h2>
              <span className="fh-meta">{reportingThisWeek.length}</span>
            </div>
            {reportingThisWeek.length > 0 ? (
              <div className="fh-compact-list">
                {reportingThisWeek.map((item) => {
                  const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                  return (
                    <div className="fh-compact-row" key={ticker} onClick={() => onOpenModel(ticker)}>
                      <span className="fh-ticker">{ticker}</span>
                      <span className="fh-meta">{item.report_date || ""}</span>
                      <span className="fh-meta">{item.implied_move ? `±${item.implied_move}` : ""}</span>
                      <WatchStar onToggle={onToggleWatchlist} starred={watchlistSet.has(ticker)} ticker={ticker} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="fh-muted">No covered companies reporting this week.</p>
            )}
          </section>

          <section className="fh-section">
            <div className="fh-section-head">
              <h2>Live Movers</h2>
              <span className="fh-meta">{data?.liveMoversSessionLabel || "Latest session"}</span>
            </div>
            {liveMovers.length > 0 ? (
              <div className="fh-compact-list">
                {liveMovers.map((item) => {
                  const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                  const pct = Number(item.change_pct ?? 0);
                  return (
                    <div className="fh-compact-row" key={ticker} onClick={() => onOpenModel(ticker)}>
                      <span className="fh-ticker">{ticker}</span>
                      <span className={`fh-move ${pct >= 0 ? "is-up" : "is-down"}`}>
                        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </span>
                      <WatchStar onToggle={onToggleWatchlist} starred={watchlistSet.has(ticker)} ticker={ticker} />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="fh-muted">No live mover data loaded yet.</p>
            )}
          </section>
        </div>

        {/* 6. Coverage Changes */}
        {coverageChanges.length > 0 && (
          <section className="fh-section">
            <div className="fh-section-head">
              <h2>Coverage Changes</h2>
              <span className="fh-meta">{coverageChanges.length}</span>
            </div>
            <div className="fh-compact-list">
              {coverageChanges.map((item) => {
                const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                return (
                  <div className="fh-compact-row" key={`${ticker}-${item.action || ""}`} onClick={() => onOpenModel(ticker)}>
                    <span className="fh-ticker">{ticker}</span>
                    <span className="fh-meta">{item.action || "updated"} · {item.name || ""}</span>
                    <NewBadge show={isNewSinceBaseline(item.updated_at, visitBaselineAt)} />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Coverage Universe (~60 models) */}
        <section className="fh-section">
          <div className="fh-section-head">
            <h2>Coverage Universe</h2>
            <span className="fh-meta">{models.length} models</span>
          </div>
          {models.length > 0 ? (
            <div className="fh-model-grid">
              {models.map((item) => {
                const ticker = String(item.ticker || item.model_id || "").toUpperCase();
                return (
                  <div className="fh-model-chip" key={ticker} onClick={() => onOpenModel(ticker)}>
                    <div>
                      <span className="fh-ticker">{ticker}</span>
                      <div className="fh-meta">{item.name || ticker}</div>
                    </div>
                    <WatchStar onToggle={onToggleWatchlist} starred={watchlistSet.has(ticker)} ticker={ticker} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="fh-muted">Open the Models tab to browse the full ~60-company coverage universe.</p>
          )}
        </section>

        {/* GoodAlexander Library preview */}
        <section className="fh-section">
          <div className="fh-section-head">
            <h2><BookOpen size={16} strokeWidth={1.8} /> GoodAlexander Library</h2>
            <button className="fh-link-btn" onClick={onOpenLibrary} type="button">View all</button>
          </div>
          {libraryItems.length > 0 ? (
            <div className="fh-compact-list">
              {libraryItems.slice(0, 6).map((item) => (
                <a className="fh-compact-row fh-library-link" href={item.url || "#finance-hub/library"} key={item.id || item.title} rel="noreferrer">
                  <span>{item.title}</span>
                  <span className="fh-meta">{item.published_at ? String(item.published_at).slice(0, 10) : item.kind || "Report"}</span>
                </a>
              ))}
            </div>
          ) : (
            <p className="fh-muted">Library posts and research reports appear here as published.</p>
          )}
        </section>
      </div>
    </div>
  );
}
