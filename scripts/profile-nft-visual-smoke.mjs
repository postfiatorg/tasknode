import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { browserFixture } from "./browser-fixture-driver.mjs";

const origin = process.env.TASKNODE_APP_ORIGIN || "http://127.0.0.1:5198";
const scratch = process.env.NFT_PROOF_DIR || "/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-nft-refactor-20260906";
const output = "docs/verification/profile-nft-techno-mordor-2026-09-06";
await mkdir(output, { recursive: true });
const sample = `data:image/png;base64,${(await readFile(`${scratch}/sample.png`)).toString("base64")}`;
const { artSpec } = JSON.parse(await readFile(`${scratch}/prepared.json`));
const nft = { id: "synthetic_art", status: "generated", title: "Techno Mordor", imageCid: "QmRFm24foudJKp7rjXLWg1CRVzZLQxrcm84CyrG7Sw6Q3X", metadataJson: { art: artSpec } };
const operators = [
  { accountId: "fictional_builder", handle: "ink_builder", displayName: "Ink Builder", heroNft: nft, networkTasks: 2, personalTasks: 1, rewards: 5000, alignment: 80, score: 87, hasPublicProfile: true },
  { accountId: "fictional_newcomer", handle: "new_arrival", displayName: "New Arrival", heroNft: null, networkTasks: 0, personalTasks: 0, rewards: 0, alignment: 0, score: 0, hasPublicProfile: true },
  { accountId: "fictional_recovery", handle: "image_recovery", displayName: "Image Recovery", heroNft: { imageGatewayUrl: `${origin}/broken-image` }, networkTasks: 0, personalTasks: 3, rewards: 3000, alignment: 60, score: 63, hasPublicProfile: true },
];
// Import the exact React URLs emitted by this Vite instance to share its runtime.
const main = await fetch(`${origin}/src/main.jsx`).then((response) => response.text());
const directory = await fetch(`${origin}/src/features/directory/DirectoryView.jsx`).then((response) => response.text());
const moduleUrl = (text, name) => text.split('"').find((part) => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(directory,"/react.js");
const reactDom = moduleUrl(main,"react-dom_client.js");
assert.ok(react && reactDom);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>window.fixtureErrors=[];window.onerror=(...args)=>window.fixtureErrors.push(String(args[0]));window.onunhandledrejection=e=>window.fixtureErrors.push(String(e.reason));</script><div id="root"></div><script type="module">
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
const {createRoot}=ReactDOM;
import {DirectoryView} from '/src/features/directory/DirectoryView.jsx';
import {MemberProfileView} from '/src/features/profile/ProfileView.jsx';
import '/src/styles.css';
const root=createRoot(document.getElementById('root'));
window.showDirectory=()=>root.render(React.createElement(DirectoryView));
window.showProfile=(accountId)=>root.render(React.createElement(MemberProfileView,{accountId,onBack:window.showDirectory}));
window.showDirectory();
</script></body></html>`;
const thumbnailRequests = new Map();
let fullImageRequests = 0;
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9358) });
try {
  const page = await browser.page({ url: `${origin}/__nft_fixture`, intercept: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/__nft_fixture") return { type: "text/html", body: html };
    if (url.pathname.startsWith("/api/profile/nft/pfp/")) {
      const attempt = (thumbnailRequests.get(url.pathname+url.search) || 0)+1;
      thumbnailRequests.set(url.pathname+url.search,attempt);
      if (attempt===1) return { code: 202, body: { ok: true, status: "warming" } };
      if (attempt===2) return { type: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="red"/></svg>' };
      return { type: "image/png", base64Body: sample.split(",")[1] };
    }
    if (url.pathname.startsWith("/api/profile/nft/image/")) { fullImageRequests++; return { type: "image/png", base64Body: sample.split(",")[1] }; }
    if (url.pathname === "/broken-image") return { fail: true };
    if (url.pathname === "/api/directory/leaderboard") return { body: { ok: true, document: { operators, totals: { operators: 3, tasksRewarded: 6, pftDistributed: 8000 } } } };
    if (url.pathname === "/api/profile/member") {
      const operator = operators.find((row) => row.accountId === url.searchParams.get("accountId")) || operators[0];
      return { body: { ok: true, profile: { accountId: operator.accountId, identity: { displayName: operator.displayName, handle: operator.handle }, heroNft: operator.heroNft, metrics: {}, nfts: operator.heroNft === nft ? [nft] : [], role: { roleTitle: "Infrastructure contributor", roleSummary: "Builds reliable shared systems." } } } };
    }
    if (url.pathname.startsWith("/api/")) return { body: { ok: true, entries: [], tasks: [], rows: [] } };
    return null;
  } });
  const screenshot = async (name) => { const shot = await page.command("Page.captureScreenshot", { format: "png" }); await writeFile(`${output}/${name}.png`, Buffer.from(shot.data,"base64")); };
  await page.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.until("document.querySelectorAll('.directory-avatar').length===3").catch(async error=>{ console.log(await page.evaluate("({errors:window.fixtureErrors,body:document.body.innerText})")); throw error; });
  await page.until("[...document.querySelectorAll('.directory-avatar img')].some(image=>image.complete&&image.naturalWidth>0)");
  await page.until("document.querySelectorAll('.directory-avatar svg').length===2");
  assert.equal(await page.evaluate("document.querySelector('.directory-avatar').getBoundingClientRect().width"),64);
  assert.equal(await page.evaluate(`document.body.innerText.includes(${JSON.stringify("Hyperstition "+artSpec.hyperstition)})`),true);
  assert.equal(fullImageRequests, 0, "Cold thumbnails should poll within the bounded warm queue, not fan out full-image fetches");
  assert.ok([...thumbnailRequests.values()].some((value)=>value===3));
  await screenshot("directory-desktop");
  await page.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"),false);
  await screenshot("directory-mobile");
  await page.evaluate("window.showProfile('fictional_newcomer')");
  await page.until("document.body.innerText.includes('New Arrival')");
  await page.until("document.querySelector('[aria-label=\"Profile picture\"] svg')!==null");
  assert.equal(await page.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"),false);
  await screenshot("profile-starter-mobile");
  await page.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.evaluate("window.showProfile('fictional_builder')");
  await page.until("document.body.innerText.includes('Ink Builder')");
  await page.until("document.querySelector('[aria-label=\"Profile picture\"] img')?.naturalWidth>0");
  await screenshot("profile-art-desktop");
  await writeFile(`${output}/browser-results.json`, JSON.stringify({ ok: true, origin, mode: "Actual Directory and MemberProfileView components with synthetic API fixtures and real anonymous generated artwork", checks: ["64px directory art", "202 cold-thumbnail polling", "legacy SVG ignored", "no cold full-image fanout", "starter portraits", "failed image fallback", "public profile art and traits", "mobile overflow"], viewports: [1440,390] },null,2)+"\n");
  console.log("Profile NFT browser checks passed; desktop and mobile screenshots saved.");
} finally { await browser.close(); }
