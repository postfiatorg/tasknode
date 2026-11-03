import { useEffect, useRef, useState } from "react";
import { ChartLine } from "lucide-react";
import { useAppearance } from "../../theme/use-appearance.js";
import {
  FINANCE_HUB_MESSAGES,
  FINANCE_HUB_VIEW,
  financeHubAppHash,
  financeHubFrameSrc,
  financeHubRouteFromAppHash,
  financeHubRouteFromViewerHash,
  financeHubViewerHash,
} from "./finance-hub-route.js";
import "./finance-hub.css";

// The Finance Hub research bundle, rendered inside the Task Node shell. The viewer reports every route it shows and
// Task Node mirrors it into the address bar (replaceState: the iframe's own entries already carry back/forward);
// when the address bar changes from outside (sidebar, back/forward, a pasted link) Task Node tells the viewer to follow.
export function FinanceHubView({ hasAccess, locationHash, onLocationChange }) {
  const { resolved: theme } = useAppearance();
  const frameRef = useRef(null);
  const reportedRef = useRef(null);
  const themeRef = useRef(theme);
  const targetRef = useRef("");
  const target = financeHubViewerHash(financeHubRouteFromAppHash(locationHash));
  const [src] = useState(() => financeHubFrameSrc(financeHubRouteFromAppHash(locationHash), theme));

  useEffect(() => {
    function post(message) {
      frameRef.current?.contentWindow?.postMessage(message, window.location.origin);
    }
    function onMessage(event) {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type !== FINANCE_HUB_MESSAGES.route || typeof event.data.hash !== "string") return;
      const route = financeHubRouteFromViewerHash(event.data.hash);
      const firstReport = reportedRef.current === null;
      reportedRef.current = financeHubViewerHash(route);
      if (event.data.theme !== themeRef.current) post({ type: FINANCE_HUB_MESSAGES.theme, theme: themeRef.current });
      // The address bar moved while the viewer was still loading: the viewer follows it, not the other way round.
      if (firstReport && reportedRef.current !== targetRef.current) return post({ type: FINANCE_HUB_MESSAGES.navigate, hash: targetRef.current });
      const nextHash = `#${financeHubAppHash(route)}`;
      if (window.location.hash === nextHash || !window.location.hash.replace(/^#\/?/, "").toLowerCase().startsWith(FINANCE_HUB_VIEW)) return;
      window.history.replaceState({ tasknodeView: FINANCE_HUB_VIEW }, "", `${window.location.pathname}${window.location.search}${nextHash}`);
      onLocationChange?.(window.location.hash);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onLocationChange]);

  useEffect(() => {
    targetRef.current = target;
    if (reportedRef.current === null || reportedRef.current === target) return;
    frameRef.current?.contentWindow?.postMessage({ type: FINANCE_HUB_MESSAGES.navigate, hash: target }, window.location.origin);
  }, [target]);

  useEffect(() => {
    themeRef.current = theme;
    if (reportedRef.current === null) return;
    frameRef.current?.contentWindow?.postMessage({ type: FINANCE_HUB_MESSAGES.theme, theme }, window.location.origin);
  }, [theme]);

  if (!hasAccess) {
    return (
      <div className="route-scroll">
        <div className="finance-hub-locked">
          <span className="finance-hub-locked-icon"><ChartLine size={18} strokeWidth={1.75} /></span>
          <h1>Finance Hub</h1>
          <p>Company models, earnings and the validator brief are available to connected validators.</p>
          <a className="light-pill" href="#settings/validator">Connect a validator</a>
        </div>
      </div>
    );
  }
  return (
    <div className="finance-hub-view">
      <iframe className="finance-hub-frame" ref={frameRef} src={src} title="Finance Hub" />
    </div>
  );
}
