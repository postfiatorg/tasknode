import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture-driver.mjs";
process.env.VERCEL_AI_GATEWAY_API_KEY = "fixture";
const { chatModes } = await import("../server/product-chat-contracts.js");
const modes = chatModes();
const origin = process.env.MODEL_PICKER_ORIGIN || "http://127.0.0.1:5197";
const sources = await Promise.all(["/src/main.jsx", "/src/features/chat/AppChatDialogs.jsx"].map(path => fetch(origin + path).then(response => response.text())));
const moduleUrl = (source, name) => source.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(sources[1], "/react.js");
const reactDom = moduleUrl(sources[0], "react-dom_client.js");
assert.ok(react && reactDom);
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9377) });
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"></div><script>window.fixtureErrors=[];window.onerror=message=>fixtureErrors.push(String(message));window.onunhandledrejection=event=>fixtureErrors.push(String(event.reason));</script><script type="module">
window.fixtureStage='vite';await import('/@vite/client');window.fixtureStage='react';
const React=(await import(${JSON.stringify(react)})).default;
const ReactDOM=(await import(${JSON.stringify(reactDom)})).default;
window.fixtureStage='component';const {ModelOption}=await import('/src/features/chat/AppChatDialogs.jsx');
window.fixtureStage='styles';await import('/src/styles.css');window.fixtureStage='render';
const modes=${JSON.stringify(modes)};
function Picker(){const [selected,setSelected]=React.useState('Instant');return React.createElement('div',{className:'model-menu',style:{position:'relative',inset:'auto',margin:'12px'}},modes.map(mode=>React.createElement(ModelOption,{key:mode.label,mode,selected:mode.label===selected,onClick:()=>setSelected(mode.label)})));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Picker));
</script></body></html>`;
try {
  const page = await browser.page({ url: origin + "/__model_fixture", intercept: async request => {
    if (new URL(request.url).pathname === "/__model_fixture") return { type: "text/html", body: html };
    if (new URL(request.url).origin !== origin) return { fail: true };
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(10000) });
    return { code: response.status, type: response.headers.get("content-type") || "text/plain", base64Body: Buffer.from(await response.arrayBuffer()).toString("base64") };
  } });
  try { await page.until("document.querySelectorAll('.model-option').length === 5 || window.fixtureErrors?.length"); }
  catch (error) { throw new Error(JSON.stringify(await page.evaluate("({stage:window.fixtureStage,errors:window.fixtureErrors,html:document.body.innerText})")), { cause: error }); }
  assert.deepEqual(await page.evaluate("window.fixtureErrors"), []);
  for (const width of [1280, 390]) {
    await page.command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 500 });
    const rows = await page.evaluate("Array.from(document.querySelectorAll('.model-option')).map(el=>({text:el.innerText,right:el.getBoundingClientRect().right,left:el.getBoundingClientRect().left}))");
    assert.equal(rows.length, 5);
    assert.ok(rows.every(row=>row.left >= 0 && row.right <= width), "options must fit viewport");
    for (const label of ["GPT-6 Astra", "Kimi K3"]) {
      assert.ok(rows.find(row=>row.text.includes(label)).text.includes("API rates"));
      await page.evaluate(`Array.from(document.querySelectorAll('.model-option')).find(el=>el.querySelector('strong').textContent===${JSON.stringify(label)}).click()`);
      await page.until(`document.querySelector('.model-option.selected strong')?.textContent === ${JSON.stringify(label)}`);
    }
  }
  console.log("model selector browser smoke passed: desktop/mobile rates, five options, both selections");
} finally { await browser.close(); }
