import { useEffect, useRef, useState } from "react";
import { monotonicNow, msUntilBoundary, STALE_MS, windowPosition } from "./proving-window.js";

// No automatic readiness request comes sooner than this after the previous one.
export const MIN_GAP_MS = 15_000;
// Inside the hours, a closed or failed answer is asked again after 15, 30 and 60 seconds, then every minute.
export const RETRY_MS = [15_000, 30_000, 60_000];

// Keeps the window text current: re-renders once a minute and just after the window's next
// boundary, and asks for fresh readiness (onRefresh) at that boundary, when the tab comes back to
// the foreground, when an "open" answer is about to go stale, and, inside the hours, again after a
// closed or failed answer. All of these share one request at a time and a minimum gap. `answer` is
// the stored answer itself, so every new answer re-arms the timers. Without a window it does nothing.
export function useProvingWindowClock(window, receivedAt, onRefresh, open = false, answer = window) {
  const [tick, setTick] = useState(monotonicNow);
  const asking = useRef({ inflight: false, pending: false, last: -Infinity, delay: null, retries: 0, ask: null });
  useEffect(() => () => { const state = asking.current; clearTimeout(state.delay); state.delay = null; state.ask = null; }, []);
  useEffect(() => {
    const state = asking.current;
    const now = monotonicNow();
    const age = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : 0;
    const serverNow = window && window.now_unix_ms + age;
    const boundary = msUntilBoundary(window, serverNow);
    if (boundary === null) { clearTimeout(state.delay); state.delay = null; state.ask = null; return undefined; }
    const ask = () => {
      if (!onRefresh || state.ask !== ask) return;
      if (state.inflight) { state.pending = true; return; }
      const wait = state.last + MIN_GAP_MS - monotonicNow();
      if (wait > 0) { if (!state.delay) state.delay = setTimeout(() => { state.delay = null; state.ask?.(); }, wait); return; }
      state.last = monotonicNow(); state.inflight = true;
      Promise.resolve().then(onRefresh).catch(() => {}).finally(() => {
        state.inflight = false;
        if (state.pending) { state.pending = false; state.ask?.(); }
      });
    };
    state.ask = ask;
    const wake = () => setTick(monotonicNow());
    const { inside } = windowPosition(window, serverNow);
    if (!inside || open) state.retries = 0;
    const minute = setInterval(wake, 60_000);
    const atBoundary = setTimeout(() => { wake(); ask(); }, boundary + 1_000);
    const retry = inside && !open ? setTimeout(() => { state.retries += 1; wake(); ask(); }, RETRY_MS[Math.min(state.retries, RETRY_MS.length - 1)]) : null;
    const beforeStale = open ? setTimeout(() => { wake(); ask(); }, Math.max(0, STALE_MS - age)) : null;
    const visible = () => { if (document.visibilityState === "visible") { wake(); ask(); } };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(minute); clearTimeout(atBoundary); clearTimeout(retry); clearTimeout(beforeStale);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [window, receivedAt, onRefresh, open, answer]);
  return tick;
}
