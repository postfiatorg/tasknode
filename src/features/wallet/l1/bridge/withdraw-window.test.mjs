// The Ethereum withdrawal screen, rendered with stand-in hooks: a fresh refusal from Review
// replaces the stored readiness, so "Open now" does not stay beside the new error.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";

const here = new URL(".", import.meta.url);
const real = (path) => new URL(path, here).href;

const REACT = `
let states = [], index = 0;
export const effects = [];
export function useState(init) {
  const key = index++;
  if (!(key in states)) states[key] = typeof init === "function" ? init() : init;
  return [states[key], (value) => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
}
export function useRef(value) { const key = index++; if (!(key in states)) states[key] = { current: value }; return states[key]; }
export function useCallback(fn) { index++; return fn; }
export function useEffect(fn) { index++; effects.push(fn); }
export function render(Component, props) { index = 0; effects.length = 0; return Component(props); }
`;
const RUNTIME = `export const Fragment = "fragment"; export function jsx(type, props) { return { type, props }; } export const jsxs = jsx;`;
const UI = `const pass = ({ children, title }) => [title, children];
export const Amount = () => "", Badge = pass, Card = pass, CardHead = pass, KV = () => "", Mono = () => "", Notice = pass, Spinner = () => "";`;
const RELAY = `export const answers = []; export async function bridgeJson() { const next = answers.shift(); if (next instanceof Error) throw next; return next; }`;
const CLOCK = `export function useProvingWindowClock(window, receivedAt) { return receivedAt; }`;

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

async function screen(dir) {
  let code = (await transformWithOxc(await readFile(new URL("EthereumWithdraw.jsx", here), "utf8"), "EthereumWithdraw.jsx", { jsx: { runtime: "automatic" } })).code;
  const map = {
    "react": "./react.mjs", "react/jsx-runtime": "./runtime.mjs", "lucide-react": "./icons.mjs", "../ui.jsx": "./ui.mjs",
    "./bridge-relay.js": "./relay.mjs", "./use-proving-window.js": "./clock.mjs",
    "./controller.js": real("controller.js"), "../market/model.js": real("../market/model.js"), "../format.js": real("../format.js"),
    "./proving-window.js": real("proving-window.js"),
  };
  code = code.replace(/from "([^"]+)"/g, (whole, name) => (name in map ? `from "${map[name]}"` : whole));
  await Promise.all([["react.mjs", REACT], ["runtime.mjs", RUNTIME], ["icons.mjs", "export const ExternalLink = () => null;"],
    ["ui.mjs", UI], ["relay.mjs", RELAY], ["clock.mjs", CLOCK], ["screen.mjs", code]].map(([name, body]) => writeFile(join(dir, name), body)));
  const base = pathToFileURL(join(dir, "/")).href;
  return { Screen: (await import(base + "screen.mjs")).default, react: await import(base + "react.mjs"), relay: await import(base + "relay.mjs") };
}

test("a fresh refusal from Review replaces Open now on the Ethereum withdrawal screen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eth-window-"));
  try {
    const { Screen, react, relay } = await screen(dir);
    const window = (minute) => ({ opens_utc: "17:00", closes_utc: "19:00", open_minute: 1020, close_minute: 1140, now_unix_ms: Date.UTC(2026, 10, 26, 17, minute) });
    const client = { accountId: "acct", address: "pf" + "1".repeat(40), getBalances: async () => ({ assets: { lines: [] } }), quote: async () => ({ minimum_fee: 1 }) };
    relay.answers.push({ ok: true, ready: true, series_asset_id: "x", proving_window: window(30) });
    react.render(Screen, { client });
    await Promise.all(react.effects.map((effect) => effect()));
    let page = react.render(Screen, { client });
    assert.match(text(page), /Open now until 19:00 UTC/);
    // Review asks again and the route is now closed.
    relay.answers.push({ ok: true, ready: false, message: "payout service is closed", proving_window: window(31) });
    await find(page, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    page = react.render(Screen, { client });
    const shown = text(page);
    assert.match(shown, /payout service is closed/);
    assert.doesNotMatch(shown, /Open now/);
    assert.match(shown, /This should be open now and is not\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
