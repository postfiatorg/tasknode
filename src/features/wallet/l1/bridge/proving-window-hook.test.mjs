// The real use-proving-window.js hook, with stand-in React, timers and clock.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeTime, REACT } from "./react-harness.mjs";

const here = new URL(".", import.meta.url);
const window = (hour, minute) => ({ opens_utc: "17:00", closes_utc: "19:00", open_minute: 1020, close_minute: 1140, now_unix_ms: Date.UTC(2026, 10, 26, hour, minute) });

async function load(dir) {
  const code = (await readFile(new URL("use-proving-window.js", here), "utf8"))
    .replace('from "react"', 'from "./react.mjs"').replace('from "./proving-window.js"', `from "${new URL("proving-window.js", here).href}"`);
  await writeFile(join(dir, "react.mjs"), REACT);
  await writeFile(join(dir, "hook.mjs"), code);
  const base = pathToFileURL(join(dir, "/")).href;
  return { react: await import(base + "react.mjs"), hook: (await import(base + "hook.mjs")).useProvingWindowClock };
}
async function withHook(run) {
  const dir = await mkdtemp(join(tmpdir(), "window-hook-")), time = fakeTime(0);
  try {
    time.install();
    const { react, hook } = await load(dir);
    const show = (props) => react.render(() => hook(props.window, props.receivedAt, props.onRefresh, props.open, props.answer), props);
    await run({ time, react, show });
  } finally { time.restore(); await rm(dir, { recursive: true, force: true }); }
}

test("a refusal at the opening is asked again after 15, 30 and 60 seconds until the route is ready", async () => {
  await withHook(async ({ time, react, show }) => {
    let asked = 0;
    const onRefresh = async () => { asked++; };
    show({ window: window(17, 0), receivedAt: 0, onRefresh, open: false, answer: {} });
    await time.advance(15_000);
    assert.equal(asked, 1);
    show({ window: window(17, 0), receivedAt: 0, onRefresh, open: false, answer: {} });
    await time.advance(29_000);
    assert.equal(asked, 1);
    await time.advance(1_000);
    assert.equal(asked, 2);
    show({ window: window(17, 0), receivedAt: 0, onRefresh, open: false, answer: {} });
    await time.advance(60_000);
    assert.equal(asked, 3);
    // Ready now: no more asking until the answer is ten minutes old.
    show({ window: window(17, 2), receivedAt: time.now, onRefresh, open: true, answer: {} });
    await time.advance(9 * 60_000);
    assert.equal(asked, 3);
    react.unmount();
    assert.equal(time.active, 0);
  });
});

test("a failed refresh without window data keeps the last window and keeps asking", async () => {
  await withHook(async ({ time, show }) => {
    let asked = 0;
    const onRefresh = async () => { asked++; };
    const kept = window(17, 30);
    show({ window: kept, receivedAt: 0, onRefresh, open: true, answer: {} });
    await time.advance(10 * 60_000);
    assert.equal(asked, 1);
    // The refresh failed: the screen keeps the window and its clock, and only drops "open".
    show({ window: kept, receivedAt: 0, onRefresh, open: false, answer: {} });
    await time.advance(15_000);
    assert.equal(asked, 2);
    time.visible();
    await time.advance(0);
    assert.equal(asked, 2, "the return to the foreground waits for the minimum gap");
  });
});

test("coincident stale, boundary and foreground triggers share one request, then wait the minimum gap", async () => {
  await withHook(async ({ time, react, show }) => {
    let asked = 0, finish;
    const onRefresh = () => { asked++; return new Promise((resolve) => { finish = resolve; }); };
    show({ window: window(18, 50), receivedAt: 0, onRefresh, open: true, answer: {} });
    await time.advance(10 * 60_000 + 1_000);
    time.visible(); time.visible();
    await time.advance(0);
    assert.equal(asked, 1, "stale, boundary and two foreground events share the one request in flight");
    finish(); await time.advance(0);
    assert.equal(asked, 1, "the coalesced request waits until 15 seconds after the last one");
    await time.advance(15_000);
    assert.equal(asked, 2);
    react.unmount();
    assert.equal(time.active, 0);
    assert.equal(time.listeners.size, 0);
  });
});

test("without a window the hook sets no timer, adds no listener and asks nothing", async () => {
  await withHook(async ({ time, react, show }) => {
    let asked = 0;
    show({ window: undefined, receivedAt: 0, onRefresh: async () => { asked++; }, open: true, answer: {} });
    await time.advance(24 * 3_600_000);
    assert.deepEqual([asked, time.counts.timeouts, time.counts.intervals, time.counts.listeners], [0, 0, 0, 0]);
    react.unmount();
  });
});
