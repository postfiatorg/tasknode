import assert from "node:assert/strict";
const { chromium } = await import(process.env.CORBANU_PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.DECISIONS_BROWSER_ORIGIN || "http://127.0.0.1:5199";
const sources = await Promise.all(["/src/main.jsx", "/src/features/chat/ChatSurface.jsx"].map(path => fetch(origin + path).then(r => r.text())));
const moduleUrl = (source, name) => source.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(sources[1], "/react.js"), reactDom = moduleUrl(sources[0], "react-dom_client.js");
assert.ok(react && reactDom);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let posts = 0, reads = 0, complete = false, started = false, request;
const report = "# User Proposed Decision\n\nWhich launch approach should we choose?\n\n## Summary of User Context\n\nA small team with a working prototype.\n\n## Machine Generated Options\n\nA: Public launch. B: Private pilot. C: Partner launch. D: Wait. E: Open beta.\n\n## The Decision Recommended and Its Votes\n\nChoose B, with two of three Flash votes.\n\n## A Summary in Plain English of the Reasoning\n\nA private pilot lets the team learn from customers while keeping support manageable.\n\n## The Vote Tally for Each Option\n\nA: 1; B: 2; C: 0; D: 0; E: 0.";
function result() {
  const status = complete ? "completed" : "running", stage = complete ? "completed" : "researching";
  return { ok: true, job: { id: "fixture-decision", conversationId: "fixture-chat", gatewayJobId: "gateway", status, stage },
    user: { id: "fixture-user", role: "user", body: request?.input || "Launch question" },
    assistant: { id: "fixture-assistant", role: "assistant", body: complete ? report : "Researching the options. You can leave and return to this chat.",
      metadata: { kind: "decision", decision: { jobId: "fixture-decision", status, stage, mode: "budget", contextIncluded: true,
        contextSnapshot: { version: 1, document: { revision: 7 }, deepMemoryCount: 3, recentMemoryCount: 36 },
        researchProgress: [{status: complete ? "COMPLETED" : "RUNNING", stage: "waiting_for_capacity"}],
        completedCalls: complete ? 10 : 2, markdown: complete ? report : "", selected: complete ? "B" : "", voteCounts: complete ? { A: 1, B: 2, C: 0, D: 0, E: 0 } : {} } } } };
}
const html = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
await import('/@vite/client');
const React=(await import(${JSON.stringify(react)})).default;
const ReactDOM=(await import(${JSON.stringify(reactDom)})).default;
const {ChatSurface}=await import('/src/features/chat/ChatSurface.jsx');
await import('/src/styles.css');
const chat={modes:[{label:'Instant',enabled:true}],defaultMode:'Instant',seedMessages:[],deepResearchAvailable:true,decisionsAvailable:true};
function Fixture(){const [active,setActive]=React.useState(${started ? "{id:'fixture-chat',conversationId:'fixture-chat',source:'server',title:'Decision fixture'}" : "null"});return React.createElement('main',{className:'main-panel',style:{height:'100vh',maxWidth:'100%',margin:0}},React.createElement(ChatSurface,{accountId:'acct-fixture',activeChat:active,chat,chatResetKey:0,chatSelectionKey:0,onActiveChatChange:setActive,onChatSettled:async()=>{}}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script></body></html>`;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 950 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route(`${origin}/__decision_fixture`, route => route.fulfill({ contentType: "text/html", body: html() }));
  await page.route(`${origin}/api/**`, async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/decisions/jobs" && req.method() === "POST") {
      posts++; request = req.postDataJSON(); started = true;
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(result()) });
    }
    if (path === "/api/decisions/jobs/fixture-decision") { reads++; return route.fulfill({ contentType: "application/json", body: JSON.stringify(result()) }); }
    if (path === "/api/chat/history") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [result().user, result().assistant] }) });
    if (path.endsWith("/pdf")) return route.fulfill({ contentType: "application/pdf", body: "%PDF-fixture" });
    if (path.endsWith("/packet")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ mode: "budget" }) });
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.goto(`${origin}/__decision_fixture`);
  await page.locator('.composer-plus > button').click();
  await page.getByRole('button', {name:'Decisions',exact:true}).click();
  assert.equal(await page.getByRole('checkbox', {name:'Use my context and chat memory'}).isChecked(), true);
  assert.equal(await page.locator('.model-button').isDisabled(), true);
  await page.locator('.composer-input').fill("Which launch approach should we choose? We have a working prototype and ten interested customers.");
  await page.locator('.composer-input').press('Enter');
  await page.waitForFunction(() => globalThis.document.querySelector('.decision-card')?.textContent.includes('2 of 10'));
  assert.equal(posts, 1); assert.equal(request.includeContext, true); assert.equal(request.mode, undefined);
  assert.ok(!JSON.stringify(request).includes('standard'));
  await page.reload();
  await page.waitForFunction(() => globalThis.document.querySelector('.decision-card')?.textContent.includes('Research the options'));
  assert.equal(posts, 1);
  assert.ok((await page.locator('.decision-card [role="status"]').innerText()).includes('Waiting for model capacity'));
  assert.ok((await page.locator('.decision-card').innerText()).includes('saved context document and 39 conversation memories'));
  complete = true;
  await page.reload();
  await page.getByRole('button', {name:'Copy Markdown',exact:true}).waitFor();
  assert.ok((await page.locator('.assistant-body').innerText()).includes('private pilot lets the team learn'));
  await page.getByRole('button', {name:'Copy Markdown',exact:true}).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), report);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download .md',exact:true}).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'decision-fixture-decision.md');
  assert.ok((await page.getByRole('link',{name:'Download PDF'}).getAttribute('href')).endsWith('/pdf'));
  assert.ok((await page.getByRole('link',{name:'Full packet'}).getAttribute('href')).endsWith('/packet'));
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:950});
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'no viewport overflow');
  }
  assert.deepEqual(errors,[]);
  assert.equal(posts,1);
  console.log(JSON.stringify({passed:true,posts,statusReads:reads,checks:['budget composer','context control','progress','reload without duplicate','inline report','copy','Markdown download','PDF and packet links','desktop/mobile']}));
} finally { await browser.close(); }
