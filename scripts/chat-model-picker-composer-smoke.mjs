import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { browserFixture } from "./browser-fixture-driver.mjs";
process.env.VERCEL_AI_GATEWAY_API_KEY = "fixture";
const { chatModes } = await import("../server/product-chat-contracts.js");
const modes = chatModes();
const { CHAT_MODALITIES } = await import("../shared/chat-personas.js");
const sent = [];
const origin = process.env.MODEL_PICKER_ORIGIN || "http://127.0.0.1:5197";
const sources = await Promise.all(["/src/main.jsx", "/src/features/chat/ChatSurface.jsx"].map(path => fetch(origin + path).then(response => response.text())));
const moduleUrl = (source, name) => source.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(sources[1], "/react.js"), reactDom = moduleUrl(sources[0], "react-dom_client.js");
const browser = await browserFixture({ port: 9377 });
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script>window.fixtureErrors=[];window.onerror=message=>fixtureErrors.push(String(message));window.onunhandledrejection=event=>fixtureErrors.push(String(event.reason));</script><script type="module">
const React=(await import(${JSON.stringify(react)})).default;
const ReactDOM=(await import(${JSON.stringify(reactDom)})).default;
const {ChatSurface}=await import('/src/features/chat/ChatSurface.jsx');await import('/src/styles.css');
const root=ReactDOM.createRoot(document.getElementById('root'));
window.showChat=(props={})=>root.render(React.createElement(ChatSurface,{key:props.fixtureKey||'new',accountId:'model-picker-fixture',chat:{modes:${JSON.stringify(modes)},defaultMode:'Instant',seedMessages:[]},usage:{availableCreditUsd:10},...props}));
window.showChat();
</script></body></html>`;
try {
  const page = await browser.page({url:origin+"/__composer_fixture",intercept:async request=>{
    const url=new URL(request.url);
    if(url.pathname==="/__composer_fixture")return {type:"text/html",body:html};
    if(url.pathname === "/api/i-ching/profile")return {body:{ok:true,exists:true,profile:{}}};
    if(url.pathname === "/api/chat/send")sent.push(JSON.parse(request.postData));
    if(url.pathname.startsWith("/api/"))return {body:{ok:true,messages:[],profile:null}};
    if(url.origin!==origin)return {fail:true};
    const response=await fetch(request.url,{headers:request.headers,signal:AbortSignal.timeout(10000)});
    return {code:response.status,type:response.headers.get("content-type")||"text/plain",base64Body:Buffer.from(await response.arrayBuffer()).toString("base64")};
  }});
  await page.until("Boolean(document.querySelector('.model-button')) || window.fixtureErrors.length > 0");
  assert.deepEqual(await page.evaluate("window.fixtureErrors"),[]);
  for(const width of [1280,768,760,390,320]){
    await page.command("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:1,mobile:width<500});
    const trigger=await page.evaluate("(()=>{const el=document.querySelector('.model-button'),r=el.getBoundingClientRect();return {label:el.innerText,width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,display:getComputedStyle(el.parentElement).display};})()");
    assert.ok(await page.evaluate("document.querySelector('.composer-input').getBoundingClientRect().width > 120"), "model control must not squeeze the prompt field");
    assert.notEqual(trigger.display,"none");
    assert.ok(trigger.label.startsWith("Model: "));
    assert.ok(await page.evaluate("document.querySelector('.model-button').getAttribute('aria-label').startsWith('Choose model')"));
    assert.ok(trigger.width>0&&trigger.left>=0&&trigger.right<=width&&trigger.top>=0&&trigger.bottom<=844,JSON.stringify({width,trigger}));
    await page.command("Page.bringToFront");
    await page.evaluate("document.querySelector('.model-button').focus()");
    assert.ok(await page.evaluate("document.activeElement === document.querySelector('.model-button')"));
    await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.until("document.querySelectorAll('.model-option').length===5");
    for(const label of ["GPT-6 Astra","Kimi K3"]){
      if(!(await page.evaluate("Boolean(document.querySelector('.model-menu'))")))await page.evaluate("document.querySelector('.model-button').click()");
      await page.evaluate(`Array.from(document.querySelectorAll('.model-option')).find(el=>el.querySelector('strong').textContent===${JSON.stringify(label)}).click()`);
      await page.until(`document.querySelector('.model-button').textContent.includes(${JSON.stringify(label)})`);
      assert.equal(await page.evaluate("localStorage.getItem('tasknode.chat.mode.model-picker-fixture')"),label);
    }
    console.log(JSON.stringify({width,trigger:trigger.label,selection:"Kimi K3",visible:true}));
  }
  await page.evaluate("window.showChat({fixtureKey:'remount'})");
  await page.until("document.querySelector('.model-button').textContent.includes('Kimi K3')");
  for (const modality of CHAT_MODALITIES) {
    await page.evaluate(`localStorage.setItem('tasknode.chat.persona.model-picker-fixture', ${JSON.stringify(modality.id)}); window.showChat({fixtureKey:${JSON.stringify(modality.id)}})`);
    await page.until(`document.querySelector('.composer-input').placeholder===${JSON.stringify(modality.inputPlaceholder)}`);
    assert.equal(await page.evaluate("document.querySelector('.model-button').disabled"),false,modality.id);
    for (const label of ["GPT-6 Astra","Kimi K3"]) {
      await page.evaluate("document.querySelector('.model-button').click()");
      await page.until("document.querySelectorAll('.model-option').length===5");
      await page.evaluate(`Array.from(document.querySelectorAll('.model-option')).find(el=>el.querySelector('strong').textContent===${JSON.stringify(label)}).click()`);
      await page.evaluate("(()=>{const el=document.querySelector('.composer-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'What should I consider next?');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await page.until("document.querySelector('.composer-input').value.length>0");
      const previous = sent.length;
      await page.evaluate("document.querySelector('form.composer').requestSubmit()");
      for(let attempt=0;attempt<100&&sent.length===previous;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(sent.length,previous+1,modality.id+" must send");
      assert.equal(sent.at(-1).mode,label);
      assert.equal(sent.at(-1).persona,modality.id);
      await page.until("document.querySelector('.composer-input').value===''");
    }
    console.log(JSON.stringify({savedModality:modality.id,models:["GPT-6 Astra","Kimi K3"],payloadsVerified:true}));
  }
  if(process.env.MODEL_PICKER_SCREENSHOT){const {data}=await page.command("Page.captureScreenshot",{format:"png"});await writeFile(process.env.MODEL_PICKER_SCREENSHOT,Buffer.from(data,"base64"));}
  console.log("full ChatSurface selector: five widths, open/select, account persistence and remount passed");
} finally {await browser.close();}
