// Test-only stand-ins: React hooks with dependency tracking and cleanup, a manual clock and timers,
// and a document with visibility events. Used to run the real screen and hook code without a browser.
export const REACT = `
let slots = [], index = 0, queue = [];
const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
export function useState(init) {
  const key = index++;
  if (!(key in slots)) slots[key] = { value: typeof init === "function" ? init() : init };
  const slot = slots[key];
  return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
}
export function useRef(value) { const key = index++; if (!(key in slots)) slots[key] = { current: value }; return slots[key]; }
export function useCallback(fn, deps) {
  const key = index++, slot = slots[key];
  if (!slot || changed(slot.deps, deps)) slots[key] = { fn, deps };
  return slots[key].fn;
}
export function useEffect(fn, deps) {
  const key = index++, slot = slots[key];
  if (!slot || !deps || changed(slot.deps, deps)) queue.push(() => { slot?.cleanup?.(); slots[key] = { deps, cleanup: fn() }; });
}
export function render(Component, props) { index = 0; const out = Component(props); const run = queue; queue = []; run.forEach((effect) => effect()); return out; }
export function unmount() { for (const slot of slots) if (slot && typeof slot.cleanup === "function") slot.cleanup(); slots = []; }
`;
export const RUNTIME = `export const Fragment = "fragment"; export function jsx(type, props) { return { type, props }; } export const jsxs = jsx;`;

export function fakeTime(start = 0) {
  let now = start, nextId = 1;
  const timers = new Map(), listeners = new Map(), counts = { timeouts: 0, intervals: 0, listeners: 0 };
  const saved = { setTimeout, clearTimeout, setInterval, clearInterval, performance: globalThis.performance, document: globalThis.document };
  const add = (fn, ms, every) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, ms || 0), fn, every }); return id; };
  const api = {
    counts, listeners,
    get now() { return now; },
    get active() { return timers.size; },
    install() {
      globalThis.setTimeout = (fn, ms) => { counts.timeouts++; return add(fn, ms, 0); };
      globalThis.setInterval = (fn, ms) => { counts.intervals++; return add(fn, ms, ms); };
      globalThis.clearTimeout = globalThis.clearInterval = (id) => { timers.delete(id); };
      Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true, writable: true });
      globalThis.document = {
        visibilityState: "visible",
        addEventListener(name, fn) { counts.listeners++; listeners.set(fn, name); },
        removeEventListener(name, fn) { listeners.delete(fn); },
      };
    },
    restore() {
      Object.assign(globalThis, { setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout, setInterval: saved.setInterval, clearInterval: saved.clearInterval });
      Object.defineProperty(globalThis, "performance", { value: saved.performance, configurable: true, writable: true });
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    },
    // Runs every timer due up to now + ms, in time order.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) timer.at += timer.every; else timers.delete(id);
        timer.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
    visible() { for (const [fn, name] of [...listeners]) if (name === "visibilitychange") fn(); },
  };
  return api;
}
