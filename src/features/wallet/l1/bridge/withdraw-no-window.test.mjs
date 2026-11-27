// Without a proving window in any answer, the Ethereum withdrawal screen makes the same requests,
// sets the same timers and listeners and shows the same text as on origin/main.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";
import { fakeTime, REACT, RUNTIME } from "./react-harness.mjs";

const here = new URL(".", import.meta.url);
const real = (path) => new URL(path, here).href;
const UI = `const pass = ({ children, title }) => [title, children];
export const Amount = () => "", Badge = pass, Card = pass, CardHead = pass, KV = () => "", Mono = () => "", Notice = pass, Spinner = () => "";`;
const RELAY = `export const answers = [], asked = []; export async function bridgeJson(path) { asked.push(path); const next = answers.shift(); if (next instanceof Error) throw next; return next; }`;

function text(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node.type === "function") return text(node.type(node.props));
  return text(node.props?.children);
}
function find(node, test) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const hit = find(child, test); if (hit) return hit; } return null; }
  if (test(node)) return node;
  if (typeof node.type === "function") return find(node.type(node.props), test);
  return find(node.props?.children, test);
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

async function screen(dir, source) {
  let code = (await transformWithOxc(source, "EthereumWithdraw.jsx", { jsx: { runtime: "automatic" } })).code;
  const map = {
    "react": "./react.mjs", "react/jsx-runtime": "./runtime.mjs", "lucide-react": "./icons.mjs", "../ui.jsx": "./ui.mjs",
    "./bridge-relay.js": "./relay.mjs", "./use-proving-window.js": "./hook.mjs",
    "./controller.js": real("controller.js"), "../market/model.js": real("../market/model.js"), "../format.js": real("../format.js"),
    "./proving-window.js": real("proving-window.js"),
  };
  code = code.replace(/from "([^"]+)"/g, (whole, name) => (name in map ? `from "${map[name]}"` : whole));
  const hook = (await readFile(new URL("use-proving-window.js", here), "utf8"))
    .replace('from "react"', 'from "./react.mjs"').replace('from "./proving-window.js"', `from "${real("proving-window.js")}"`);
  await Promise.all([["react.mjs", REACT], ["runtime.mjs", RUNTIME], ["icons.mjs", "export const ExternalLink = () => null;"],
    ["ui.mjs", UI], ["relay.mjs", RELAY], ["hook.mjs", hook], ["screen.mjs", code]].map(([name, body]) => writeFile(join(dir, name), body)));
  const base = pathToFileURL(join(dir, "/")).href;
  return { Screen: (await import(base + "screen.mjs")).default, react: await import(base + "react.mjs"), relay: await import(base + "relay.mjs") };
}

// Mount with a ready answer, then Review gets `review` (an answer or a thrown error); no window anywhere.
async function run(source, review) {
  const dir = await mkdtemp(join(tmpdir(), "eth-no-window-")), time = fakeTime(0);
  try {
    time.install();
    const { Screen, react, relay } = await screen(dir, source);
    const client = { accountId: "acct", address: "pf" + "1".repeat(40), getBalances: async () => ({ assets: { lines: [] } }), quote: async () => ({ minimum_fee: 1 }) };
    relay.answers.push({ ok: true, ready: true, series_asset_id: "x" });
    react.render(Screen, { client });
    await settle();
    let page = react.render(Screen, { client });
    const mounted = text(page);
    relay.answers.push(review);
    await find(page, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    await settle();
    page = react.render(Screen, { client });
    await time.advance(24 * 3_600_000);
    const result = { mounted, reviewed: text(react.render(Screen, { client })), asked: [...relay.asked], ...time.counts };
    react.unmount();
    return result;
  } finally { time.restore(); await rm(dir, { recursive: true, force: true }); }
}

function mainSource() {
  try { return execFileSync("git", ["show", "origin/main:src/features/wallet/l1/bridge/EthereumWithdraw.jsx"], { cwd: new URL("../../../../..", here), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}

const REVIEWS = [
  ["a returned refusal", { ok: true, ready: false, message: "payout service is closed" }],
  ["a thrown error", new Error("payout service is unreachable")],
];

for (const [name, review] of REVIEWS) {
  test(`without a window, Review with ${name} behaves as on origin/main`, async () => {
    const now = await run(await readFile(new URL("EthereumWithdraw.jsx", here), "utf8"), review);
    // The counts recorded from origin/main's component with this harness.
    assert.deepEqual([now.asked, now.timeouts, now.intervals, now.listeners], [["/withdrawals/readiness", "/withdrawals/readiness"], 0, 0, 0]);
    assert.match(now.reviewed, /Withdrawals ready/);
    assert.doesNotMatch(now.reviewed, /Withdrawals are paused|Withdrawals unavailable/);
    const main = mainSource();
    if (main) assert.deepEqual(now, await run(main, review));
  });
}
