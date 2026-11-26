import { useEffect, useState } from "react";
import { monotonicNow, msUntilBoundary, STALE_MS } from "./proving-window.js";

// Keeps the window text current: re-renders once a minute and just after the window's next
// boundary, and asks for fresh readiness (onRefresh) at that boundary, when the tab comes back to
// the foreground, and when an "open" answer is about to go stale. Returns the monotonic time to
// render at. Without a window it does nothing.
export function useProvingWindowClock(window, receivedAt, onRefresh, open = false) {
  const [tick, setTick] = useState(monotonicNow);
  useEffect(() => {
    const now = monotonicNow();
    const age = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : 0;
    const boundary = msUntilBoundary(window, window && window.now_unix_ms + age);
    if (boundary === null) return undefined;
    const wake = () => setTick(monotonicNow());
    const minute = setInterval(wake, 60_000);
    const atBoundary = setTimeout(() => { wake(); onRefresh?.(); }, boundary + 1_000);
    const beforeStale = open ? setTimeout(() => { wake(); onRefresh?.(); }, Math.max(0, STALE_MS - age)) : null;
    const visible = () => { if (document.visibilityState === "visible") { wake(); onRefresh?.(); } };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(minute); clearTimeout(atBoundary); if (beforeStale) clearTimeout(beforeStale);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [window, receivedAt, onRefresh, open]);
  return tick;
}
