import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {browserFixture} from "./browser-fixture-driver.mjs";
const origin="http://127.0.0.1:5197";
const output=process.env.THEME_SCREENSHOTS||"/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-dark-mode";
await mkdir(output,{recursive:true});
const state=await fetch("https://tasknode.postfiat.org/api/app-state").then(r=>r.json());
const config=await fetch("https://tasknode.postfiat.org/runtime-config.json").then(r=>r.json());
state.session={...state.session,status:"signed_in",accountId:"theme_fixture",displayName:"Theme review",hiveHandle:"theme-review",identity:{hiveHandle:"theme-review"},linkedProviders:[]};
state.chat.modes=state.chat.modes.map(m=>({...m,enabled:true}));state.chat.defaultMode="Instant";
state.chat.seedMessages = [
 {role:"user",text:"Review this proposed task."},
 {role:"assistant",text:"## Review\nReadable **text**, [a link](https://example.org), and `inline code`.\n\n| State | Result |\n| --- | --- |\n| Accepted | Ready |\n\n```js\nconst theme = \"dark\";\n```\n\n> Evidence remains available."}
];
state.tasks.sync.status = "ready";
state.tasks.outstanding = ["proposed", "accepted", "submitted"].map((status, i) => ({taskId:"theme-"+i,id:"theme-"+i,title:"Theme review: "+status,status,statusKey:status,kind:i?"Personal":"Network",isNetworkTask:!i,pft:8,fullDue:"Tomorrow",ago:"1 hour ago"}));
const browser=await browserFixture({port:9377});
try{
 const page=await browser.page({url:origin,intercept:async request=>{
  const url=new URL(request.url);
  if(url.pathname==="/api/app-state")return {body:state};
  if(url.pathname==="/runtime-config.json")return {body:config};
  if(url.pathname.startsWith("/api/")){
   if(url.pathname==="/api/hive/projects")return {body:{ok:true,document:{projects:{},projectIds:[]},contributors:[]}};
   if(url.pathname==="/api/profile/identity")return {body:{ok:true,profile:{hiveHandle:"theme-review",displayName:"Theme review"}}};
   return {body:{ok:true,exists:true,profile:{hiveHandle:"theme-review"},items:[],entries:[],messages:[],conversations:[],documents:[],folders:[],projects:[],members:[],invites:[],badges:[],verifiedBadges:[],memories:[],results:[],rows:[],availableCreditUsd:10}};
  }
  if(url.origin!==origin)return {fail:true};
  const response=await fetch(request.url,{headers:request.headers});
  return {code:response.status,type:response.headers.get("content-type")||"text/plain",base64Body:Buffer.from(await response.arrayBuffer()).toString("base64")};
 }});
 await page.until("Boolean(document.querySelector('.model-button'))");
 await page.command("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await page.evaluate("window.tasknodeAppearance.setPreference('dark')");
 await page.evaluate("document.querySelector('.profile-button').click()");
 await page.until("Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Settings')");
 await page.evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Settings').click()");
 await page.until("Boolean(document.querySelector('input[name=appearance]'))");
 await page.evaluate("document.querySelector('input[name=appearance][value=dark]').focus()");
 await page.command("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37});
 await page.command("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowLeft",code:"ArrowLeft",windowsVirtualKeyCode:37});
 await page.until("document.documentElement.dataset.themePreference==='light'");
 assert.equal(await page.evaluate("document.activeElement.value"),"light");
 await page.evaluate("window.tasknodeAppearance.setPreference('system')");
 for(const os of ["dark","light"]){
  await page.command("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:os}]});
  await page.until(`document.documentElement.dataset.theme===${JSON.stringify(os)}`);
 }
 for(const width of [1440,768,390,320]){
  await page.command("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:width<500});
  for(const preference of ["light","dark","system"]){
   await page.evaluate(`document.querySelector('input[name=appearance][value=${preference}]').click()`);
   await page.until(`document.documentElement.dataset.themePreference===${JSON.stringify(preference)}`);
   assert.equal(await page.evaluate("localStorage.getItem('tasknode.appearance.v1')"),preference);
  }
  await page.evaluate("document.querySelector('input[name=appearance][value=dark]').click()");
  assert.ok(await page.evaluate(`(()=>{const r=document.querySelector('.appearance-options').getBoundingClientRect();return r.left>=0&&r.right<=${width};})()`));
  const shot=await page.command("Page.captureScreenshot",{format:"png"});await writeFile(output+"/settings-"+width+".png",Buffer.from(shot.data,"base64"));
 }
 await page.evaluate("document.querySelector('.settings-close').click()");
 await page.command("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 const findings=[];
 for(const view of ["chat","tasks","wallet","context","hive","directory","profile","help","docs","memory","team","messages"]){
  await page.evaluate(`window.location.hash=${JSON.stringify("/"+view)}`);
  await new Promise(resolve=>setTimeout(resolve,600));
  const result=await page.evaluate(`(()=>{
    const bright=Array.from(document.querySelectorAll('body *')).filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),c=s.backgroundColor.match(/[\\d.]+/g)?.map(Number)||[];return r.width*r.height>12000&&r.width>100&&r.height>50&&r.top<1000&&s.visibility!=='hidden'&&c.length>=3&&(c.length<4||c[3]>.8)&&Math.min(...c.slice(0,3))>170;}).map(el=>({tag:el.tagName,cls:String(el.className).slice(0,120),color:getComputedStyle(el).backgroundColor}));
    return {text:document.body.innerText.slice(-450),bright};
  })()`);
  findings.push({view,...result});
  assert.deepEqual(result.bright, [], view+" has no unintended light panels");
  for(const theme of ["light","dark"]){
   await page.evaluate(`window.tasknodeAppearance.setPreference(${JSON.stringify(theme)})`);
   await new Promise(resolve=>setTimeout(resolve,100));
   const shot=await page.command("Page.captureScreenshot",{format:"png"});await writeFile(output+"/"+view+"-"+theme+".png",Buffer.from(shot.data,"base64"));
  }
 }
 await writeFile(output+"/findings.json",JSON.stringify(findings,null,2)+"\n");
 console.log(JSON.stringify(findings));
 await page.command("Page.reload");
 await page.until("Boolean(document.querySelector('.app-shell'))");
 assert.equal(await page.evaluate("document.documentElement.dataset.theme"),"dark");
 const tab = await browser.page({url:origin});
 await tab.until("Boolean(window.tasknodeAppearance)");
 await tab.evaluate("window.tasknodeAppearance.setPreference('light')");
 await page.until("document.documentElement.dataset.theme==='light'");
 await tab.evaluate("window.tasknodeAppearance.setPreference('dark')");
 await page.until("document.documentElement.dataset.theme==='dark'");
 // Observe the initial root change while app loading is still blocked by the module request.
 await page.command("Page.addScriptToEvaluateOnNewDocument",{source:"window.themeEarly=[]; new MutationObserver(()=>{if(document.documentElement?.dataset.theme) window.themeEarly.push({theme:document.documentElement.dataset.theme,app:!!document.querySelector('.app-shell')});}).observe(document,{subtree:true,attributes:true,attributeFilter:['data-theme']});"});
 await page.command("Network.enable");
 await page.command("Network.setCacheDisabled",{cacheDisabled:true});
 for(const [preference,os] of [["dark","light"],["light","dark"]]){
  await page.evaluate(`window.tasknodeAppearance.setPreference(${JSON.stringify(preference)})`);
  await page.command("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:os}]});
  await page.command("Page.reload",{ignoreCache:true});
  await page.until("Boolean(document.querySelector('.app-shell'))");
  assert.equal(await page.evaluate("window.themeEarly[0]?.theme"),preference);
  assert.equal(await page.evaluate("window.themeEarly[0]?.app"),false);
 }
 console.log("Passed: keyboard focus, OS changes, four widths, twelve routes in both themes, reload, cross-tab sync, and opposite-OS cold bootstrap before app mount");
}finally{await browser.close();}
