// Review, Confirm and the send on both withdrawal screens, run with the real components, the real
// window hook and readiness helpers, and the real TxBuilder and RpcClient over a stand-in socket
// (React, timers, storage, fetch and the socket are stand-ins). Points R5-01 to R5-04, N1 and N2
// of the complete pass (27 November 2026), and a whole Confirm without a window against b24a7c1.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";
import { fakeTime, REACT, RUNTIME } from "./react-harness.mjs";
import { RpcClient } from "../lib/rpc-client.js";
import { TxBuilder } from "../lib/tx-builder.js";
import { CHAIN_ID, GENESIS_HASH, PROTOCOL_VERSION } from "../lib/utils.js";

const BASELINE = "b24a7c1dde0e5f6f7d0b8783621f99373b466870";
const here = new URL(".", import.meta.url);
const real = (path) => new URL(path, here).href;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const ADDRESS = "pf" + "1".repeat(40), TX = "e".repeat(96), OTHER = "b".repeat(96), WALLET = "11111111111111111111111111111111";
const READY = {
  ok: true, ready: true, build_id: "dev", asset_id: "a".repeat(96), series_asset_id: "c".repeat(96), bucket_id: "d".repeat(96),
  issuer: "pf" + "d".repeat(40), epoch: 73, reserve_packet_hash: "f".repeat(96),
  destination_prefix: "solana-spl:45296998a6f8e2a784db5d9f95e18fc23f70441a1039446801089879b08c7ef0:",
  bucket_outstanding_atoms: "2000000", per_deposit_cap_atoms: "2000000", total_cap_atoms: "5000000",
};
const ROW = { asset_id: READY.series_asset_id, asset_family_id: READY.asset_id, source_series_id: "7".repeat(96), source_bucket_id: READY.bucket_id, issuer: READY.issuer, balance: "2000000" };
const hours = (h, m, s = 0) => ({ opens_utc: "17:00", closes_utc: "19:00", open_minute: 1020, close_minute: 1140, now_unix_ms: Date.UTC(2026, 10, 27, h, m, s) });
const OPEN = { ...READY, proving_window: hours(17, 30) }, CLOSED = { ok: true, ready: false, proving_window: hours(17, 30), message: "newer closed answer" };
const UI = `const pass = ({ children, title }) => [title, children];
export const Amount = () => "", Badge = pass, Card = pass, CardHead = pass, KV = () => "", Mono = () => "", Notice = pass, Spinner = () => "";`;

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
function shape(node) {
  if (node === null || node === undefined || typeof node === "boolean" || node === "") return null;
  if (Array.isArray(node)) { const kept = node.map(shape).filter((child) => child !== null); return kept.length === 1 ? kept[0] : kept; }
  if (typeof node !== "object") return typeof node === "bigint" ? node.toString() : node;
  const props = Object.fromEntries(Object.entries(node.props || {}).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "function" ? "function" : shape(value)]));
  return { type: typeof node.type === "function" ? node.type.name : node.type, props };
}
function later() { let finish; const promise = new Promise((resolve) => { finish = resolve; }); return { promise, finish }; }
const button = (tree, label) => find(tree, (node) => node.type === "button" && node.props.children === label);
const baseline = (name) => execFileSync("git", ["show", `${BASELINE}:src/features/wallet/l1/bridge/${name}.jsx`], { cwd: new URL("../../../../..", here), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

async function load(dir, name, source) {
  let code = (await transformWithOxc(source, `${name}.jsx`, { jsx: { runtime: "automatic" } })).code;
  const map = { "react": "./react.mjs", "react/jsx-runtime": "./runtime.mjs", "lucide-react": "./icons.mjs", "../ui.jsx": "./ui.mjs", "./SolanaPayout.jsx": "./payout.mjs", "./use-proving-window.js": "./hook.mjs" };
  code = code.replace(/from "([^"]+)"/g, (whole, spec) => `from "${map[spec] || (spec.startsWith(".") ? real(spec) : spec)}"`);
  const hook = (await readFile(new URL("use-proving-window.js", here), "utf8"))
    .replace('from "react"', 'from "./react.mjs"').replace('from "./proving-window.js"', `from "${real("proving-window.js")}"`);
  await Promise.all([["react.mjs", REACT], ["runtime.mjs", RUNTIME], ["icons.mjs", "export const ExternalLink = () => null;"], ["ui.mjs", UI],
    ["payout.mjs", "export default function SolanaPayout({ burn }) { return `tracking ${burn}`; }"], ["hook.mjs", hook], ["screen.mjs", code]]
    .map(([file, body]) => writeFile(join(dir, file), body)));
  const base = pathToFileURL(join(dir, "/")).href;
  return { Screen: (await import(base + "screen.mjs")).default, react: await import(base + "react.mjs") };
}

// One browser tab with the screen mounted. ctl.hold names the next await to hold (readiness,
// balance, sign or receipt); ctl.connect holds the socket connection of the next request.
async function tab(name, { source, answer = OPEN, saved = null } = {}, script) {
  const dir = await mkdtemp(join(tmpdir(), "withdraw-dispatch-")), time = fakeTime(0);
  const kept = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  const ctl = { answer, hold: null, release: null, connect: null, reject: false, signs: 0 };
  const slot = new Map(saved ? [["fixture", saved]] : []), writes = [], fetched = [], sends = [], listeners = [];
  const held = (value) => { const gate = later(); ctl.hold = null; ctl.release = () => gate.finish(value); return gate.promise; };
  const respond = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  try {
    time.install();
    globalThis.localStorage = {
      getItem: (key) => (slot.has(key) ? slot.get(key) : null),
      setItem: (key, value) => { writes.push(["set", key, String(value)]); slot.set(key, String(value)); },
      removeItem: (key) => { writes.push(["remove", key]); slot.delete(key); },
    };
    globalThis.window = { addEventListener: (type, fn) => { if (type === "storage") listeners.push(fn); }, removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (key, a, b) => (typeof a === "function" ? a : b)({ name: key }) } } });
    globalThis.fetch = async (url, options = {}) => {
      const path = String(url); fetched.push(`${options.method || "GET"} ${path}`);
      if (path.includes("/recipient/")) return respond({ ok: true, recipient: WALLET, allowed: true, kind: "wallet" });
      if (path.endsWith("/readiness")) { const answer = respond(ctl.answer); return ctl.hold === "readiness" ? held(answer) : answer; }
      return respond({ ok: true, burn_tx_id: TX, stage: "queued" });
    };
    const rpc = new RpcClient("ws://fixture.invalid");
    rpc.connect = () => (ctl.connect ? ctl.connect.promise : Promise.resolve());
    rpc.socket = {
      send(raw) {
        const message = JSON.parse(raw), task = rpc.pending.get(message.id);
        sends.push(message.method);
        const reply = (result) => { clearTimeout(task.timer); rpc.pending.delete(message.id); task.resolve({ id: message.id, ok: true, result }); };
        const answer = message.method === "asset_fee_quote"
          ? { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: PROTOCOL_VERSION, source: ADDRESS, sequence: 1, minimum_fee: 1, sender_meets_reserve_after_fee: true, operation: JSON.parse(message.params.operation_json) }
          : message.method === "account_assets" ? { assets: [ROW] }
            : message.method.startsWith("mempool_") ? { tx_id: TX, finality: { receipt: { tx_id: TX, accepted: !ctl.reject, reject_reason: "FIXTURE execution rejected" } } } : [];
        const hold = (message.method === "account_assets" && ctl.hold === "balance") || (message.method.startsWith("mempool_") && ctl.hold === "receipt");
        if (hold) void held(answer).then(reply); else queueMicrotask(() => reply(answer));
      },
    };
    const builder = new TxBuilder(rpc);
    const wasm = { wallet_sign_asset_transaction_fields: (backup, fields) => ({ unsigned: JSON.parse(fields), signature: "synthetic" }) };
    const client = {
      accountId: "fixture", address: ADDRESS,
      call: (method, params) => rpc.call(method, params),
      getBalances: async () => ({ assets: { lines: [{ asset_id: READY.series_asset_id, balance: "2000000" }] } }),
      quote: (intent) => builder.quote(intent, ADDRESS),
      sign: async (intent, quote) => { ctl.signs++; const handle = builder.sign(intent, quote, ADDRESS, "fixture", wasm); return ctl.hold === "sign" ? held(handle) : handle; },
      submit: (handle, options) => builder.submit(handle, options),
    };
    const loaded = await load(dir, name, source ?? await readFile(new URL(`${name}.jsx`, here), "utf8"));
    const page = () => loaded.react.render(loaded.Screen, { client, storageKey: "fixture" });
    const eth = name === "EthereumWithdraw";
    const api = {
      ctl, slot, time, page, sends, fetched, writes,
      mempool: () => sends.filter((method) => method.startsWith("mempool_")).length,
      async mount() { page(); await settle(); page(); },
      fill() {
        const shown = page(), field = (match) => find(shown, (node) => node.type === "input" && match(node.props));
        field((props) => props.inputMode === "decimal").props.onChange({ target: { value: "1" } });
        field((props) => props.autoComplete === "off").props.onChange({ target: { value: eth ? "0x" + "1".repeat(40) : WALLET } });
        page();
      },
      review: () => find(page(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} }),
      confirm: () => button(page(), "Confirm and burn").props.onClick(),
      offered: () => Boolean(button(page(), "Confirm and burn")),
      // A newer automatic readiness answer, applied by the window hook's foreground refresh.
      async newer(next) { ctl.answer = next; page(); time.visible(); await settle(); page(); },
      // Another tab writes the shared slot and this tab hears its storage event.
      otherTab(value, heard = true) {
        if (value === null) slot.delete("fixture"); else slot.set("fixture", value);
        if (heard) for (const fn of [...listeners]) fn({ storageArea: globalThis.localStorage, key: "fixture", newValue: value });
        page();
      },
      text: () => text(page()),
      shape: () => shape(page()),
    };
    const result = await script(api);
    loaded.react.unmount();
    return result;
  } finally {
    time.restore();
    Object.assign(globalThis, { fetch: kept.fetch, window: kept.window, localStorage: kept.localStorage });
    if (kept.navigator) Object.defineProperty(globalThis, "navigator", kept.navigator); else delete globalThis.navigator;
    await rm(dir, { recursive: true, force: true });
  }
}
async function reviewed(t) { await t.mount(); t.fill(); await t.review(); await settle(); assert.ok(t.offered(), "the review is offered"); }

// R5-01: the connection of the send is re-established while a newer closed answer arrives.
for (const name of ["SolanaWithdraw", "EthereumWithdraw"]) {
  test(`${name}: a newer closed answer while the send waits for its connection sends nothing and says nothing`, async () => {
    await tab(name, {}, async (t) => {
      await reviewed(t);
      t.ctl.hold = "sign"; const work = t.confirm(); await settle();
      t.ctl.connect = later(); t.ctl.release(); await settle();
      assert.equal(t.mempool(), 0, "the send waits for its connection");
      await t.newer(CLOSED);
      const connect = t.ctl.connect; t.ctl.connect = null; connect.finish(); await work; await settle();
      assert.equal(t.mempool(), 0);
      assert.equal(t.slot.has("fixture") || t.slot.has(`l1-withdrawal:fixture:${ADDRESS}`), false, "no marker or burn id is left");
      assert.doesNotMatch(t.text(), /burned|rejected|Check your burn|Starting withdrawal|tracking/);
    });
  });
}

// Once the bytes have left, a newer closed answer changes nothing about tracking the outcome.
test("SolanaWithdraw: a burn sent before a newer closed answer is still tracked", async () => {
  await tab("SolanaWithdraw", {}, async (t) => {
    await reviewed(t);
    t.ctl.hold = "receipt"; const work = t.confirm(); await settle();
    assert.equal(t.mempool(), 1);
    await t.newer(CLOSED);
    t.ctl.release(); await work; await settle();
    assert.equal(t.slot.get("fixture"), TX);
    assert.match(t.text(), new RegExp(`tracking ${TX}`));
  });
});

// R5-02: the chain rejects a burn that was sent before a newer closed answer.
test("SolanaWithdraw: a rejection of a sent burn is shown after a newer closed answer", async () => {
  await tab("SolanaWithdraw", {}, async (t) => {
    await reviewed(t);
    t.ctl.reject = true; t.ctl.hold = "receipt"; const work = t.confirm(); await settle();
    await t.newer(CLOSED);
    t.ctl.release(); await work; await settle();
    assert.match(t.text(), /FIXTURE execution rejected.*No PFUSDC was burned/);
    assert.equal(t.slot.has("fixture"), false, "its own record is removed");
  });
});

// R5-03: while this tab signs, a newer closed answer stops it and another tab replaces the record.
for (const [what, replacement] of [["another pending claim", "submitting:other-tab"], ["an accepted burn id", OTHER]]) {
  test(`SolanaWithdraw: a stopped Confirm keeps ${what} that another tab saved`, async () => {
    await tab("SolanaWithdraw", {}, async (t) => {
      await reviewed(t);
      t.ctl.hold = "sign"; const work = t.confirm(); await settle();
      assert.match(t.slot.get("fixture"), /^submitting/);
      await t.newer(CLOSED);
      t.otherTab(null); t.otherTab(replacement);
      t.ctl.release(); await work; await settle();
      assert.equal(t.mempool(), 0);
      assert.equal(t.slot.get("fixture"), replacement);
    });
  });
}
test("SolanaWithdraw: \"I verified that no burn was accepted\" keeps a burn id another tab saved since", async () => {
  await tab("SolanaWithdraw", { saved: "submitting" }, async (t) => {
    await t.mount();
    t.otherTab(OTHER, false);
    button(t.page(), "I verified that no burn was accepted").props.onClick(); await settle();
    assert.equal(t.slot.get("fixture"), OTHER);
    assert.match(t.text(), new RegExp(`tracking ${OTHER}`));
  });
});

// N1: while the receipt is awaited, another tab saves its own burn id; this burn is not saved over it.
test("SolanaWithdraw: a sent burn does not overwrite a burn id another tab saved meanwhile, and stays visible", async () => {
  await tab("SolanaWithdraw", {}, async (t) => {
    await reviewed(t);
    t.ctl.hold = "receipt"; const work = t.confirm(); await settle();
    t.otherTab(OTHER);
    t.ctl.release(); await work; await settle();
    assert.equal(t.slot.get("fixture"), OTHER);
    assert.match(t.text(), new RegExp(TX));
  });
});

// R5-04: a newer open answer during the operation's own read does not drop it.
for (const [name, op, stage] of [["SolanaWithdraw", "review", "readiness"], ["SolanaWithdraw", "review", "balance"], ["EthereumWithdraw", "review", "readiness"], ["SolanaWithdraw", "confirm", "readiness"]]) {
  test(`${name} ${op}: a newer open answer while it waits at ${stage} does not drop it`, async () => {
    await tab(name, {}, async (t) => {
      await t.mount(); t.fill();
      if (op === "confirm") { await t.review(); await settle(); }
      t.ctl.hold = stage; const work = op === "review" ? t.review() : t.confirm(); await settle();
      assert.equal(typeof t.ctl.release, "function", `it waits at ${stage}`);
      await t.newer({ ...OPEN });
      t.ctl.release(); await work; await settle();
      if (op === "review") assert.ok(t.offered(), "the review is offered");
      else { assert.equal(t.ctl.signs, 1); assert.equal(t.mempool(), 1); assert.equal(t.slot.get("fixture"), TX); }
    });
  });
}

// N2: an Ethereum Review offered at 18:59:30; the closing refresh is slow, and Confirm is pressed after 19:00.
test("EthereumWithdraw: Confirm after the closing reads readiness again instead of trusting the Review's answer", async () => {
  await tab("EthereumWithdraw", { answer: { ...READY, proving_window: hours(18, 59, 30) } }, async (t) => {
    await reviewed(t);
    t.ctl.answer = { ...CLOSED, proving_window: hours(19, 0, 1) }; t.ctl.hold = "readiness";
    await t.time.advance(40_000); await settle();
    assert.ok(t.offered(), "no newer answer has arrived");
    await t.confirm(); await settle();
    assert.equal(t.ctl.signs, 0);
    assert.equal(t.mempool(), 0);
    assert.match(t.text(), /newer closed answer/);
  });
});

// Without a window in any answer, a whole Review and Confirm makes the same requests, sends the
// same bytes, writes the same storage and shows the same thing as b24a7c1.
for (const name of ["SolanaWithdraw", "EthereumWithdraw"]) {
  test(`${name}: without a window, Review and Confirm behave as on b24a7c1`, async () => {
    const run = (source) => tab(name, { source, answer: READY }, async (t) => {
      await reviewed(t);
      const before = t.shape();
      await t.confirm(); await settle();
      return { before, after: t.shape(), sends: [...t.sends], fetched: [...t.fetched], writes: [...t.writes], signs: t.ctl.signs, timers: { ...t.time.counts } };
    });
    const now = await run();
    assert.equal(now.sends.filter((method) => method.startsWith("mempool_")).length, 1);
    assert.deepEqual(now, await run(baseline(name)));
  });
}
