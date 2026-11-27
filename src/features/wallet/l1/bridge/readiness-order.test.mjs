// Ordering of readiness answers on the three screens, run with the real components, the real window
// hook and the real readiness helpers (React, timers and the network are stand-ins). An older
// answer that completes after a newer one has been applied writes nothing; a screen that never
// receives a window behaves as origin/main's component.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";
import { fakeTime, REACT, RUNTIME } from "./react-harness.mjs";
import { readinessOrder } from "./proving-window.js";

const here = new URL(".", import.meta.url);
const real = (path) => new URL(path, here).href;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const READY = {
  ok: true, ready: true, build_id: "dev", asset_id: "a".repeat(96), series_asset_id: "b".repeat(96), bucket_id: "c".repeat(96),
  issuer: "pf" + "d".repeat(40), epoch: 73, reserve_packet_hash: "f".repeat(96),
  destination_prefix: "solana-spl:45296998a6f8e2a784db5d9f95e18fc23f70441a1039446801089879b08c7ef0:",
  bucket_outstanding_atoms: "2000000", per_deposit_cap_atoms: "2000000", total_cap_atoms: "5000000",
};
const ROW = { asset_id: READY.series_asset_id, asset_family_id: READY.asset_id, source_series_id: "7".repeat(96), source_bucket_id: READY.bucket_id, issuer: READY.issuer, balance: "2000000" };
const WINDOW = { opens_utc: "17:00", closes_utc: "19:00", open_minute: 1020, close_minute: 1140, now_unix_ms: Date.UTC(2026, 10, 26, 17, 30) };
const UI = `const pass = ({ children, title }) => [title, children];
export const Amount = () => "", Badge = pass, Card = pass, CardHead = pass, Details = () => "", IdChip = () => "", KV = () => "", Mono = () => "", Notice = pass, Spinner = () => "";`;
const DEPOSIT_VIEW = `export const ACTIVE = new Set(), AmountField = () => null, Credited = () => null, DepositProgress = () => null, NotSent = () => null;
export const elapsedText = () => "", holdsForm = () => false, phaseState = () => "";
export const DepositForm = (props) => ({ type: "deposit-form", props: { ready: props.ready, checking: props.checking, readyText: props.readyText, children: props.notices } });`;
const RELAY = `export const answers = [], asked = []; export async function bridgeJson(path) { asked.push(path); const next = answers.shift(); if (next instanceof Error) throw next; return next; }`;

function text(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node.type === "function") return text(node.type(node.props));
  return text(node.props?.children);
}
function find(node, match) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, match); if (hit) return hit; } return null; }
  if (match(node)) return node;
  return find(node.props?.children, match);
}
const form = (page) => find(page, (node) => node.type === "form");
// What a screen shows: element types, text and the props that are not functions.
function shape(node) {
  if (node === null || node === undefined || typeof node === "boolean" || node === "") return null;
  if (Array.isArray(node)) { const kept = node.map(shape).filter((child) => child !== null); return kept.length === 1 ? kept[0] : kept; }
  if (typeof node !== "object") return typeof node === "bigint" ? node.toString() : node;
  const props = Object.fromEntries(Object.entries(node.props || {}).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "function" ? "function" : shape(value)]));
  return { type: typeof node.type === "function" ? node.type.name : node.type, props };
}

// The comparison baseline: the last commit before the proving-window feature (origin/main now contains it).
const BASELINE = "b24a7c1dde0e5f6f7d0b8783621f99373b466870";
function mainSource(name) {
  try { return execFileSync("git", ["show", `${BASELINE}:src/features/wallet/l1/bridge/${name}.jsx`], { cwd: new URL("../../../../..", here), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}
const current = (name) => readFile(new URL(`${name}.jsx`, here), "utf8");

// The screen's real source, with React, the UI kit and the relay replaced; everything else is the real module.
async function load(dir, name, source) {
  let code = (await transformWithOxc(source, `${name}.jsx`, { jsx: { runtime: "automatic" } })).code;
  const map = {
    "react": "./react.mjs", "react/jsx-runtime": "./runtime.mjs", "lucide-react": "./icons.mjs", "../ui.jsx": "./ui.mjs",
    "./DepositView.jsx": "./deposit-view.mjs", "./SolanaPayout.jsx": "./payout.mjs", "./use-proving-window.js": "./hook.mjs",
    ...(name === "EthereumWithdraw" ? { "./bridge-relay.js": "./relay.mjs" } : {}),
  };
  code = code.replace(/from "([^"]+)"/g, (whole, spec) => `from "${map[spec] || (spec.startsWith(".") ? real(spec) : spec)}"`);
  const hook = (await readFile(new URL("use-proving-window.js", here), "utf8"))
    .replace('from "react"', 'from "./react.mjs"').replace('from "./proving-window.js"', `from "${real("proving-window.js")}"`);
  const icons = "export const ArrowUpRight = () => null, ExternalLink = () => null, FileCheck = () => null, Landmark = () => null, Wallet = () => null;";
  await Promise.all([["react.mjs", REACT], ["runtime.mjs", RUNTIME], ["icons.mjs", icons], ["ui.mjs", UI], ["deposit-view.mjs", DEPOSIT_VIEW],
    ["payout.mjs", "export default function SolanaPayout() { return null; }"], ["relay.mjs", RELAY], ["hook.mjs", hook], ["screen.mjs", code]]
    .map(([file, body]) => writeFile(join(dir, file), body)));
  const base = pathToFileURL(join(dir, "/")).href;
  return { Screen: (await import(base + "screen.mjs")).default, react: await import(base + "react.mjs"), relay: await import(base + "relay.mjs") };
}

const response = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
// A browser for one run: a manual clock, a counting window and fetch, and answers given in order;
// an answer can be a function that returns a promise the test resolves later.
async function browser(name, source, answers, run, ctl) {
  const dir = await mkdtemp(join(tmpdir(), "readiness-order-")), time = fakeTime(0), calls = [], saved = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage };
  let windowListeners = 0;
  try {
    time.install();
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.window = { addEventListener() { windowListeners++; }, removeEventListener() {} };
    globalThis.fetch = async (url) => {
      calls.push([time.now, String(url)]);
      if (typeof answers === "function") return answers(String(url));
      const next = answers.shift();
      if (typeof next === "function") return next();
      if (next instanceof Error) throw next;
      return response(next);
    };
    const client = {
      accountId: "fixture", address: "pf" + "1".repeat(40),
      call: async (method) => { calls.push([time.now, method]); return { ok: true, result: { assets: [ROW] } }; },
      getBalances: async () => { calls.push([time.now, "getBalances"]); return { assets: { lines: [] } }; },
      quote: async () => (ctl?.hold === "quote" ? ctl.held({ minimum_fee: 1 }) : { minimum_fee: 1 }),
      sign: async () => { if (ctl) ctl.signs++; return ctl?.hold === "sign" ? ctl.held({ signed: true }) : { signed: true }; },
      submit: async () => { if (ctl) ctl.submits++; throw Error("TEST: no transaction is sent"); },
    };
    const loaded = await load(dir, name, source);
    const props = { client, storageKey: "fixture" };
    const page = () => loaded.react.render(loaded.Screen, props);
    const result = await run({ ...loaded, page, time, calls });
    loaded.react.unmount();
    return { result, calls, counts: { ...time.counts, windowListeners }, remaining: time.active };
  } finally {
    time.restore(); Object.assign(globalThis, saved);
    await rm(dir, { recursive: true, force: true });
  }
}
function later() { let finish; const promise = new Promise((resolve) => { finish = resolve; }); return { promise, finish }; }

// R3-01: a foreground refresh starts, Review's newer answer refuses, then the older refresh says ready.
test("Solana withdrawal: an older ready refresh after a newer refusal does not bring the form back", async () => {
  const older = later();
  const { result } = await browser("SolanaWithdraw", await current("SolanaWithdraw"), [
    { ...READY, proving_window: WINDOW }, () => older.promise, { ok: true, ready: false, proving_window: WINDOW }], async ({ page, time }) => {
    page(); await settle(); let shown = page();
    time.visible(); await settle();
    await form(shown).props.onSubmit({ preventDefault() {} });
    shown = page(); const refused = Boolean(form(shown));
    older.finish(response({ ...READY, proving_window: WINDOW })); await settle();
    shown = page();
    return { refused, form: Boolean(form(shown)), text: text(shown) };
  });
  assert.equal(result.refused, false);
  assert.equal(result.form, false);
  assert.doesNotMatch(result.text, /right now/);
});

// The mirror: an older refusal that completes after a newer ready answer does not take the form away.
test("Solana withdrawal: an older refusal after a newer ready answer does not take the form away", async () => {
  const older = later();
  const { result } = await browser("SolanaWithdraw", await current("SolanaWithdraw"), [
    { ...READY, proving_window: WINDOW }, () => older.promise, { ...READY, proving_window: WINDOW }], async ({ page, time }) => {
    page(); await settle(); let shown = page();
    time.visible(); await settle();
    await form(shown).props.onSubmit({ preventDefault() {} });
    older.finish(response({ ok: true, ready: false, proving_window: WINDOW })); await settle();
    shown = page();
    return { form: Boolean(form(shown)), text: text(shown) };
  });
  assert.equal(result.form, true);
  assert.doesNotMatch(result.text, /should be open now and is not/);
});

// R3-02: the newer answer has no window (the setting was removed); the older one still carries it.
test("Solana withdrawal: an older answer with a window after a newer answer without one brings back neither", async () => {
  const older = later();
  const { result } = await browser("SolanaWithdraw", await current("SolanaWithdraw"), [
    { ...READY, proving_window: WINDOW }, () => older.promise, { ok: true, ready: false }], async ({ page, time }) => {
    page(); await settle(); let shown = page();
    time.visible(); await settle();
    await form(shown).props.onSubmit({ preventDefault() {} });
    page(); const timers = time.active;
    older.finish(response({ ...READY, proving_window: WINDOW })); await settle();
    shown = page();
    return { form: Boolean(form(shown)), text: text(shown), timers, after: time.active };
  });
  assert.equal(result.form, false);
  assert.doesNotMatch(result.text, /Open now/);
  assert.equal(result.after, result.timers);
});

// Review's own answer is older than a refresh already applied: no review is built from it.
test("Solana withdrawal: a Review whose answer is older than an applied one stops quietly", async () => {
  const older = later();
  const { result } = await browser("SolanaWithdraw", await current("SolanaWithdraw"), [
    { ...READY, proving_window: WINDOW }, () => older.promise, { ok: true, ready: false, proving_window: WINDOW }], async ({ page, time }) => {
    page(); await settle(); const shown = page();
    const reviewing = form(shown).props.onSubmit({ preventDefault() {} });
    time.visible(); await settle();
    older.finish(response({ ...READY, proving_window: WINDOW })); await reviewing; await settle();
    const after = page();
    return { form: Boolean(form(after)), text: text(after) };
  });
  assert.equal(result.form, false);
  assert.doesNotMatch(result.text, /Confirm and burn/);
});

test("Ethereum withdrawal: an older answer with a window after a newer answer without one brings back neither", async () => {
  const older = later();
  const { result } = await browser("EthereumWithdraw", await current("EthereumWithdraw"), [], async ({ page, time, relay }) => {
    relay.answers.push({ ok: true, ready: true, series_asset_id: "x", proving_window: WINDOW });
    page(); await settle(); let shown = page();
    relay.answers.push(older.promise);
    time.visible(); await settle();
    relay.answers.push({ ok: true, ready: false, message: "payout service is closed" });
    await form(shown).props.onSubmit({ preventDefault() {} }); await settle();
    page(); const timers = time.active;
    older.finish({ ok: true, ready: true, series_asset_id: "x", proving_window: WINDOW }); await settle();
    shown = page();
    return { asked: relay.asked.length, text: text(shown), timers, after: time.active };
  });
  assert.equal(result.asked, 3);
  assert.doesNotMatch(result.text, /Withdrawals ready|Open now/);
  assert.equal(result.after, result.timers);
});

test("the order consults nothing until a window is involved: every completion applies, in any order", () => {
  const order = readinessOrder(), made = [order.next(), order.next(), order.next(), order.next()];
  for (const n of [made[3], made[0], made[2], made[1], made[0]]) assert.equal(order.apply(n), true);
  assert.equal(order.seen, false);
  // An older answer that carries a window is refused; once a window has been applied, every older
  // completion is refused, also one without a window.
  assert.equal(order.apply(made[1], true), false);
  const windowed = order.next();
  assert.equal(order.apply(windowed, true), true);
  assert.equal(order.apply(made[3], false), false);
  const removed = order.next();
  assert.equal(order.apply(removed, false), true);
  assert.equal(order.apply(windowed, true), false);
});

// Without a window in any answer, each screen makes the same requests in the same order, sets the
// same timers and listeners and shows the same thing as origin/main's component.
async function same(name, answers, run) {
  const main = mainSource(name);
  const now = await browser(name, await current(name), structuredClone(answers), run);
  if (main) assert.deepEqual(now, await browser(name, main, structuredClone(answers), run));
  return now;
}
const MODES = [["ready", READY], ["refused", { ok: true, ready: false, build_id: "dev", message: "closed" }], ["failed", new Error("offline")]];
for (const [mode, answer] of MODES) {
  const repeat = Array.from({ length: 8 }, () => answer);
  test(`without a window, the Solana deposit screen (${mode}) behaves as on origin/main`, async () => {
    const now = await same("SolanaDeposit", repeat, async ({ page, time }) => {
      page(); await settle(); const mounted = shape(page());
      await time.advance(60_000); await settle(); time.visible(); await settle();
      return { mounted, last: shape(page()) };
    });
    assert.ok(now.calls.length >= 1);
  });
  test(`without a window, the Solana withdrawal screen (${mode}) behaves as on origin/main`, async () => {
    await same("SolanaWithdraw", repeat, async ({ page, time }) => {
      page(); await settle(); const mounted = shape(page());
      await time.advance(60_000); await settle(); time.visible(); await settle();
      return { mounted, last: shape(page()) };
    });
  });
}
for (const [mode, review] of MODES.slice(1)) {
  test(`without a window, Solana withdrawal Review with a ${mode} answer behaves as on origin/main`, async () => {
    await same("SolanaWithdraw", [READY, review, review], async ({ page, time }) => {
      page(); await settle(); const shown = page();
      await form(shown).props.onSubmit({ preventDefault() {} }); await settle();
      const reviewed = shape(page()); time.visible(); await time.advance(86_400_000);
      return { reviewed, last: shape(page()) };
    });
  });
  test(`without a window, Ethereum withdrawal Review with a ${mode} answer behaves as on origin/main`, async () => {
    await same("EthereumWithdraw", [], async ({ page, time, relay }) => {
      relay.answers.push({ ok: true, ready: true, series_asset_id: "x" });
      page(); await settle(); const shown = page();
      relay.answers.push(review instanceof Error ? review : { ...review });
      await form(shown).props.onSubmit({ preventDefault() {} }); await settle();
      const reviewed = shape(page()); time.visible(); await time.advance(86_400_000);
      return { reviewed, last: shape(page()), asked: [...relay.asked] };
    });
  });
}

// Review and Confirm go on after each of their awaits only while they are current. At each await a
// newer answer arrives (closed, or open after closed); the operation then neither offers the
// confirmation nor signs, and a newer open answer alone does not stop it.
const WALLET = "11111111111111111111111111111111";
const OPEN = { ...READY, proving_window: WINDOW }, CLOSED = { ok: true, ready: false, proving_window: WINDOW, message: "newer closed answer" };
async function operation(name, op, stage, newer) {
  const ctl = { hold: null, release: null, next: OPEN, signs: 0, submits: 0 };
  const held = (value) => { const gate = later(); ctl.release = () => gate.finish(value); ctl.hold = null; return gate.promise; };
  ctl.held = held;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (key, fn) => { const value = fn(); return ctl.hold === "lock" ? held(value) : value; } } } });
  const route = (url) => {
    if (url.includes("/recipient/")) {
      const answer = response({ ok: true, recipient: WALLET, allowed: true, kind: "wallet" });
      return ctl.hold === "recipient" ? held(answer) : answer;
    }
    return ctl.hold === "readiness" ? held(response(ctl.next)) : response(ctl.next);
  };
  try {
    const { result } = await browser(name, await current(name), route, async ({ page, time, relay }) => {
      const ask = () => { const answer = { ...ctl.next }; return ctl.hold === "readiness" ? held(answer) : answer; };
      const eth = name === "EthereumWithdraw";
      if (eth) relay.answers.push(ask());
      page(); await settle(); let shown = page();
      const field = (match) => find(shown, (node) => node.type === "input" && match(node.props));
      field((props) => props.inputMode === "decimal" || props["aria-label"] === "PFUSDC amount").props.onChange({ target: { value: "1" } });
      field((props) => props.autoComplete === "off" || props["aria-label"] === "Ethereum recipient").props.onChange({ target: { value: eth ? "0x" + "1".repeat(40) : WALLET } });
      shown = page();
      const confirmButton = (tree) => find(tree, (node) => node.type === "button" && node.props.children === "Confirm and burn");
      const newerAnswers = async () => {
        ctl.next = CLOSED; if (eth) relay.answers.push({ ...CLOSED });
        time.visible(); await settle();
        if (newer === "closed then open") { ctl.next = OPEN; if (eth) relay.answers.push({ ...OPEN }); await time.advance(16_000); time.visible(); await settle(); }
      };
      if (op === "confirm") {
        if (eth) relay.answers.push(ask());
        await form(shown).props.onSubmit({ preventDefault() {} }); await settle(); shown = page();
        assert.ok(confirmButton(shown), "the review is offered before the newer answer");
      }
      ctl.hold = stage === "start" ? null : stage;
      if (eth && op === "review") relay.answers.push(ask());
      const work = op === "review" ? form(shown).props.onSubmit({ preventDefault() {} }) : stage === "start" ? null : confirmButton(shown).props.onClick();
      await settle();
      if (stage !== "start") assert.equal(typeof ctl.release, "function", `the operation waits at ${stage}`);
      if (newer === "open") { ctl.next = OPEN; if (eth) relay.answers.push({ ...OPEN }); time.visible(); await settle(); }
      else await newerAnswers();
      page();
      if (stage === "start") { shown = page(); const button = confirmButton(shown); if (button) await button.props.onClick(); }
      else { ctl.release(); await work; }
      await settle(); shown = page();
      return { offered: Boolean(confirmButton(shown)), signs: ctl.signs, submits: ctl.submits, text: text(shown) };
    }, ctl);
    return result;
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator); else delete globalThis.navigator;
  }
}
const eth = (name) => name === "EthereumWithdraw";
const CASES = [
  ["SolanaWithdraw", "review", ["readiness", "recipient", "quote"]],
  ["SolanaWithdraw", "confirm", ["readiness", "recipient", "lock", "sign"]],
  ["EthereumWithdraw", "review", ["readiness", "quote"]],
  ["EthereumWithdraw", "confirm", ["start", "sign"]],
];
for (const [name, op, stages] of CASES) {
  for (const stage of stages) {
    test(`${name} ${op}: a newer closed answer while it waits at ${stage} stops it before the confirmation or a send`, async () => {
      const result = await operation(name, op, stage, "closed");
      assert.equal(result.offered, false);
      assert.equal(result.submits, 0);
      if (stage !== "sign") assert.equal(result.signs, 0);
      assert.doesNotMatch(result.text, /No funds moved|No PFUSDC was burned/);
    });
  }
}
for (const [name, stage] of [["SolanaWithdraw", "quote"], ["EthereumWithdraw", "quote"]]) {
  test(`${name} review: a newer open answer after a newer closed one does not bring back the review it stopped`, async () => {
    const result = await operation(name, "review", stage, "closed then open");
    assert.match(result.text, eth(name) ? /Withdrawals ready/ : /You can withdraw/);
    assert.equal(result.offered, false);
    assert.equal(result.signs, 0);
  });
  test(`${name} review: a newer open answer alone does not stop it`, async () => {
    const result = await operation(name, "review", stage, "open");
    assert.equal(result.offered, true);
  });
}
