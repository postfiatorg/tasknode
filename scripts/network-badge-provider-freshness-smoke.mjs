import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserFixture } from "./browser-fixture-driver.mjs";

const origin = process.env.TASKNODE_APP_ORIGIN || "http://127.0.0.1:5198";
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9358) });
const accountId = "badge_freshness_fixture";
const x = { provider: "x", username: "fixture_operator", verified: true, metrics: { followersCount: 8000 } };
let state = { accountId, identityProfile: { aliases: [x] }, badges: [{ badgeId: "kol", status: "verified", expiresAt: null }], approvals: [] };
const main = await fetch(origin + "/src/main.jsx").then((r) => r.text());
const panel = await fetch(origin + "/src/features/profile/ProfileIdentityPanels.jsx").then((r) => r.text());
const moduleUrl = (text, name) => text.split('"').find((part) => part.startsWith("/node_modules/") && part.includes(name));
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from ${JSON.stringify(moduleUrl(panel, "/react.js"))};
import ReactDOM from ${JSON.stringify(moduleUrl(main, "react-dom_client.js"))};
import {NetworkBadgesPanel} from '/src/features/profile/ProfileIdentityPanels.jsx';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.show=(session)=>root.render(React.createElement(NetworkBadgesPanel,{session}));
window.show({accountId:${JSON.stringify(accountId)},identityProfile:{aliases:[]},linkedProviders:[]});
</script></body></html>`;
try {
  const page = await browser.page({ url: origin + "/__badge_freshness", intercept: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/__badge_freshness") return { type: "text/html", body: html };
    if (path === "/api/profile/network-badges") return { body: { ok: true, state } };
    return null;
  } });
  const card = "[...document.querySelectorAll('div')].find(el=>el.children.length===0&&el.textContent==='KOL').parentElement.parentElement.parentElement.parentElement.innerText";
  await page.until("document.body.innerText.includes('8,000 X followers')");
  const connected = await page.evaluate(card);
  assert.ok(connected.includes("Ready"));
  assert.equal(connected.includes("Needs X"), false);
  state = { accountId, identityProfile: { aliases: [] }, badges: [{ badgeId: "kol", status: "revoked", revokedAt: new Date().toISOString() }], approvals: [] };
  await page.evaluate(`window.show({accountId:${JSON.stringify(accountId)},identityProfile:{aliases:[${JSON.stringify(x)}]},linkedProviders:[{id:'x',kind:'oauth'}]});window.dispatchEvent(new Event('focus'));`);
  await page.until("document.body.innerText.includes('Needs X')");
  const disconnected = await page.evaluate(card);
  assert.equal(disconnected.includes("Ready"), false);
  state = { accountId: "different_account", identityProfile: { aliases: [x] }, badges: [{ badgeId: "kol", status: "verified" }], approvals: [] };
  await page.evaluate(`window.show({accountId:'new_account',identityProfile:{aliases:[]},linkedProviders:[]});`);
  await page.until("document.body.innerText.includes('Needs X')");
  assert.equal((await page.evaluate(card)).includes("Ready"), false);
  const result = { passed: true, checks: ["Fresh X proof overrides stale missing session identity", "Verified KOL displays Ready", "Focus refresh removes disconnected provider despite stale session", "Other account badge state cannot leak across account switch"] };
  await mkdir("docs/verification/task-request-and-offer-repair-2026-09-06", { recursive: true });
  await writeFile("docs/verification/task-request-and-offer-repair-2026-09-06/badge-browser.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
