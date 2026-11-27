import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChartLine, LayoutDashboard, Newspaper } from "lucide-react";
import { useAppearance } from "../../theme/use-appearance.js";
import {
  FINANCE_HUB_MESSAGES,
  FINANCE_HUB_VIEW,
  financeHubAppHash,
  financeHubFrameSrc,
  financeHubRouteFromAppHash,
  financeHubRouteFromViewerHash,
  financeHubSectionFromAppHash,
  financeHubViewerHash,
} from "./finance-hub-route.js";
import { formatAccessBasisBadge } from "./goodbrief-sandbox.js";
import { FinanceHubToday } from "./FinanceHubToday.jsx";
import { GoodbriefFrame } from "./GoodbriefFrame.jsx";
import "./finance-hub.css";

function viewerOriginFromConfig() {
  if (typeof window === "undefined") return "";
  return String(window.__TASKNODE_CONFIG__?.financeHub?.viewerOrigin || "").trim();
}

export function FinanceHubView({ access = null, hasAccess, locationHash, onLocationChange }) {
  const { resolved: theme } = useAppearance();
  const frameRef = useRef(null);
  const reportedRef = useRef(null);
  const themeRef = useRef(theme);
  const targetRef = useRef("");

  const viewerOrigin = useMemo(() => viewerOriginFromConfig(), []);
  const expectedOrigin = useMemo(() => {
    if (viewerOrigin) {
      try { return new URL(viewerOrigin).origin; } catch { /* fallback below */ }
    }
    return typeof window !== "undefined" ? window.location.origin : "";
  }, [viewerOrigin]);

  const section = financeHubSectionFromAppHash(locationHash);
  const route = financeHubRouteFromAppHash(locationHash);
  const target = financeHubViewerHash(route);
  const [frameSrc] = useState(() => financeHubFrameSrc(route, theme, viewerOrigin));

  const [todayData, setTodayData] = useState(null);
  const [todayLoading, setTodayLoading] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [visitBaselineAt, setVisitBaselineAt] = useState(null);
  const [goodbriefData, setGoodbriefData] = useState(null);
  const [goodbriefLoading, setGoodbriefLoading] = useState(false);

  const effectiveAccess = todayData?.access || access;
  const badge = formatAccessBasisBadge(effectiveAccess);

  const navigateHash = useCallback((nextPath) => {
    const nextHash = `#${nextPath}`;
    if (typeof window !== "undefined") {
      window.history.pushState({ tasknodeView: FINANCE_HUB_VIEW }, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    }
    onLocationChange?.(nextHash);
  }, [onLocationChange]);

  useEffect(() => {
    if (!hasAccess) return;
    let active = true;
    setTodayLoading(true);
    fetch("/api/finance-hub/today", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!active || !body?.ok) return;
        setTodayData(body);
        setWatchlist(Array.isArray(body.userState?.watchlist) ? body.userState.watchlist : []);
        setVisitBaselineAt(body.userState?.visitBaselineAt || null);
      })
      .catch(() => {})
      .finally(() => { if (active) setTodayLoading(false); });
    return () => { active = false; };
  }, [hasAccess]);

  useEffect(() => {
    if (!hasAccess || section !== "goodbrief" || goodbriefData) return;
    let active = true;
    setGoodbriefLoading(true);
    fetch("/api/finance-hub/goodbrief", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (active && body?.ok) setGoodbriefData(body); })
      .catch(() => {})
      .finally(() => { if (active) setGoodbriefLoading(false); });
    return () => { active = false; };
  }, [hasAccess, section, goodbriefData]);

  useEffect(() => {
    if (!hasAccess || section !== "models") return undefined;
    function post(message) {
      if (!expectedOrigin) return;
      frameRef.current?.contentWindow?.postMessage(message, expectedOrigin);
    }
    function onMessage(event) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow || event.origin !== expectedOrigin) return;
      if (event.data?.type !== FINANCE_HUB_MESSAGES.route || typeof event.data.hash !== "string") return;
      const nextRoute = financeHubRouteFromViewerHash(event.data.hash);
      const firstReport = reportedRef.current === null;
      reportedRef.current = financeHubViewerHash(nextRoute);
      if (event.data.theme !== themeRef.current) post({ type: FINANCE_HUB_MESSAGES.theme, theme: themeRef.current });
      if (firstReport && reportedRef.current !== targetRef.current) return post({ type: FINANCE_HUB_MESSAGES.navigate, hash: targetRef.current });
      const nextHash = `#${financeHubAppHash(nextRoute)}`;
      if (window.location.hash === nextHash || !window.location.hash.replace(/^#\/?/, "").toLowerCase().startsWith(FINANCE_HUB_VIEW)) return;
      window.history.replaceState({ tasknodeView: FINANCE_HUB_VIEW }, "", `${window.location.pathname}${window.location.search}${nextHash}`);
      onLocationChange?.(window.location.hash);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [expectedOrigin, hasAccess, onLocationChange, section]);

  useEffect(() => {
    targetRef.current = target;
    if (reportedRef.current === null || reportedRef.current === target || !expectedOrigin) return;
    frameRef.current?.contentWindow?.postMessage({ type: FINANCE_HUB_MESSAGES.navigate, hash: target }, expectedOrigin);
  }, [expectedOrigin, target]);

  useEffect(() => {
    themeRef.current = theme;
    if (reportedRef.current === null || !expectedOrigin) return;
    frameRef.current?.contentWindow?.postMessage({ type: FINANCE_HUB_MESSAGES.theme, theme }, expectedOrigin);
  }, [expectedOrigin, theme]);

  const handleToggleWatchlist = useCallback((ticker) => {
    const normalized = String(ticker || "").trim().toUpperCase();
    if (!normalized) return;
    setWatchlist((current) => {
      const next = current.includes(normalized)
        ? current.filter((item) => item !== normalized)
        : [normalized, ...current];
      fetch("/api/finance-hub/state", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watchlist: next }),
      }).catch(() => {});
      return next;
    });
  }, []);

  const handleMarkCaughtUp = useCallback(() => {
    fetch("/api/finance-hub/mark-caught-up", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.state?.visitBaselineAt) setVisitBaselineAt(body.state.visitBaselineAt);
      })
      .catch(() => {});
  }, []);

  if (!hasAccess) {
    return (
      <div className="route-scroll">
        <div className="finance-hub-locked">
          <span className="finance-hub-locked-icon"><ChartLine size={18} strokeWidth={1.75} /></span>
          <h1>Finance Hub</h1>
          <p>
            Finance Hub (~60 company &amp; crypto models, daily Goodbrief macro roundup, and GoodAlexander Library)
            is unlocked for <strong>Active Validators</strong> (95%/30-day uptime with 14-day grace) and the
            <strong> daily Top 30 non-validator Task Node contributors</strong> (keep-until rank 35 + 7-day grace).
          </p>
          {effectiveAccess?.graceEndsAt && (
            <p className="fh-meta">Your prior grace window ended on {String(effectiveAccess.graceEndsAt).slice(0, 10)}.</p>
          )}
          <div className="fh-locked-actions">
            <a className="light-pill" href="#settings/validator">Connect a validator</a>
            <a className="light-pill" href="#directory">View leaderboard</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="finance-hub-shell">
      <header className="fh-subnav">
        <div className="fh-tabs" role="tablist" aria-label="Finance Hub views">
          <button
            aria-selected={section === "today"}
            className={`fh-tab${section === "today" ? " is-active" : ""}`}
            onClick={() => navigateHash(FINANCE_HUB_VIEW)}
            role="tab"
            type="button"
          >
            <LayoutDashboard size={14} strokeWidth={1.8} /> Today
          </button>
          <button
            aria-selected={section === "models"}
            className={`fh-tab${section === "models" ? " is-active" : ""}`}
            onClick={() => navigateHash(`${FINANCE_HUB_VIEW}/models`)}
            role="tab"
            type="button"
          >
            <ChartLine size={14} strokeWidth={1.8} /> Models
          </button>
          <button
            aria-selected={section === "goodbrief"}
            className={`fh-tab${section === "goodbrief" ? " is-active" : ""}`}
            onClick={() => navigateHash(`${FINANCE_HUB_VIEW}/goodbrief`)}
            role="tab"
            type="button"
          >
            <Newspaper size={14} strokeWidth={1.8} /> Goodbrief
          </button>
          <button
            aria-selected={section === "library"}
            className={`fh-tab${section === "library" ? " is-active" : ""}`}
            onClick={() => navigateHash(`${FINANCE_HUB_VIEW}/library`)}
            role="tab"
            type="button"
          >
            <BookOpen size={14} strokeWidth={1.8} /> Library
          </button>
        </div>
        {badge && <span className={`fh-access-badge is-${badge.tone}`}>{badge.label}</span>}
      </header>

      {section === "today" && (
        <FinanceHubToday
          data={todayData}
          loading={todayLoading}
          onAskAgent={(ticker) => navigateHash(`chat?topic=${encodeURIComponent(ticker)}`)}
          onMarkCaughtUp={handleMarkCaughtUp}
          onOpenGoodbrief={() => navigateHash(`${FINANCE_HUB_VIEW}/goodbrief`)}
          onOpenLibrary={() => navigateHash(`${FINANCE_HUB_VIEW}/library`)}
          onOpenModel={(ticker) => navigateHash(financeHubAppHash({ model: ticker, tab: "summary" }))}
          onToggleWatchlist={handleToggleWatchlist}
          visitBaselineAt={visitBaselineAt}
          watchlist={watchlist}
        />
      )}

      {section === "models" && (
        <div className="finance-hub-view">
          <iframe className="finance-hub-frame" ref={frameRef} src={frameSrc} title="Finance Hub Models" />
        </div>
      )}

      {section === "goodbrief" && (
        <div className="finance-hub-view">
          {goodbriefLoading ? (
            <div className="finance-hub-empty"><p>Loading isolated Goodbrief edition...</p></div>
          ) : (
            <GoodbriefFrame
              srcDoc={goodbriefData?.srcDoc || ""}
              title={goodbriefData?.title || "Goodbrief Macro Roundup"}
              watermarkId={goodbriefData?.watermarkId || ""}
            />
          )}
        </div>
      )}

      {section === "library" && (
        <div className="fh-today-scroll">
          <div className="fh-today-wrap">
            <section className="fh-section">
              <div className="fh-section-head">
                <h2><BookOpen size={16} strokeWidth={1.8} /> GoodAlexander Library</h2>
                <span className="fh-meta">{(todayData?.library || []).length} publications</span>
              </div>
              {(todayData?.library || []).length > 0 ? (
                <div className="fh-compact-list">
                  {todayData.library.map((item) => (
                    <a className="fh-compact-row fh-library-link" href={item.url || "#finance-hub/library"} key={item.id || item.title} rel="noreferrer">
                      <div>
                        <strong>{item.title}</strong>
                        {item.summary && <div className="fh-meta">{item.summary}</div>}
                      </div>
                      <span className="fh-meta">{item.published_at ? String(item.published_at).slice(0, 10) : item.kind || "Report"}</span>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="fh-muted">No GoodAlexander Library reports are published yet.</p>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
