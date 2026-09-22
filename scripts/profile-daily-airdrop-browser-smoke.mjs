import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { browserFixture } from "./browser-fixture-driver.mjs";

const origin = process.env.TASKNODE_APP_ORIGIN || "http://127.0.0.1:5198";
const main = await fetch(`${origin}/src/main.jsx`).then(response => response.text());
const briefing = await fetch(`${origin}/src/features/profile/ProfileBriefing.jsx`).then(response => response.text());
const moduleUrl = (source, name) => source.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(briefing, "/react.js");
const reactDom = moduleUrl(main, "react-dom_client.js");
assert.ok(react && reactDom);
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(reactDom)};
import {TodaysBriefing} from '/src/features/profile/ProfileBriefing.jsx';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.showBriefing=props=>root.render(React.createElement(TodaysBriefing,props));
window.showBriefing({loading:true});
</script></body></html>`;
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9347) });
try {
  const page = await browser.page({ url: `${origin}/__airdrop_fixture`, intercept: request => new URL(request.url).pathname === "/__airdrop_fixture" ? { type: "text/html", body: html } : null });
  await page.until("typeof window.showBriefing==='function'");
  const airdrop = { dailyAirdropPft: 45, retentionValueScore: 80, alignmentScore7d: 0.00435714,
    completedAt: new Date().toISOString(), rewardTotals: { rewarded_task_count: 8 },
    whatRaisedToday: "The review accepted the local restore test.", whatKeptItLower: "No specific shortfall was recorded.",
    toImproveTomorrow: "No corrective action is needed.", reasoningText: "The accepted task supports the reward.",
    issuance: { status: "submitted", amountPft: 45, submittedAt: new Date().toISOString(), txHash: "FIXTURE_TRANSACTION" } };
  await page.evaluate(`window.showBriefing(${JSON.stringify({ airdrop })})`);
  await page.until("document.body.innerText.includes('Daily airdrop paid')");
  const text = await page.evaluate("document.body.innerText");
  for (const label of ["What contributed", "Reward details", "Next step", "8 rewarded tasks", "45", "No corrective action is needed."]) assert.ok(text.toLowerCase().includes(label.toLowerCase()), label);
  for (const label of ["What kept it lower", "To improve tomorrow"]) assert.equal(text.toLowerCase().includes(label.toLowerCase()), false, label);
  const alignment = "document.querySelector('[data-testid=daily-airdrop-alignment]')";
  assert.equal(await page.evaluate(`${alignment}.querySelector('strong').textContent`), "80", "A model score of 80 must not become the 0/100 payout ratio");
  assert.ok(await page.evaluate(`${alignment}.textContent.includes('/ 100')`));
  assert.ok(await page.evaluate(`${alignment}.title.includes('recent rewarded work')`));
  await page.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Full reasoning')).click()");
  await page.until("document.body.innerText.includes('The accepted task supports the reward.')");
  await page.evaluate(`window.showBriefing(${JSON.stringify({ airdrop: { ...airdrop, alignmentScore7d: 0.99, issuance: { status: "failed_before_submit" } } })})`);
  await page.until("document.body.innerText.includes('Retry pending')");
  assert.ok(await page.evaluate("document.body.innerText.includes('Daily airdrop scored, not paid yet')"));
  assert.equal(await page.evaluate(`${alignment}.querySelector('strong').textContent`), "80", "Payout status and legacy ratio cannot change the alignment score");
  for (const [retentionValueScore, expected] of [[0, "0"], [93, "93"], [undefined, "—"]]) {
    await page.evaluate(`window.showBriefing(${JSON.stringify({ airdrop: { ...airdrop, retentionValueScore, alignmentScore7d: 0.99 } })})`);
    await page.until(`${alignment}?.querySelector('strong').textContent===${JSON.stringify(expected)}`);
  }
  await page.evaluate("window.showBriefing({airdrop:null})");
  await page.until("document.body.innerText.includes('No score generated yet')");
  const evidence = { ok: true, origin, mode: "Actual TodaysBriefing component rendered in Chrome with synthetic paid and pending data", checks: ["Alignment / 100 restored using actual model score", "80 stays 80 with low and high payout ratios", "real zero preserved; missing score displayed as unavailable", "neutral feedback headings", "paid amount and reviewed task count preserved", "full reasoning expands", "pending payout remains visibly unpaid", "empty state preserved"] };
  await mkdir("docs/verification/alignment-restored-2026-09-10", { recursive: true });
  await writeFile("docs/verification/alignment-restored-2026-09-10/browser-local.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
