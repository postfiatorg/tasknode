import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { browserFixture } from "./browser-fixture-driver.mjs";
const origin="https://tasknode.postfiat.org";
const evidence={assets:[]};
for(const file of ["theme-init.js","theme-page.js"]){
 const response=await fetch(origin+"/"+file),body=await response.text();
 assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
 assert.equal(body,await readFile("public/"+file,"utf8"));
 assert.ok(response.headers.get("content-security-policy").includes("script-src 'self'"));
 evidence.assets.push({file,sha256:createHash("sha256").update(body).digest("hex"),cacheControl:response.headers.get("cache-control")});
}
const browser=await browserFixture({port:9377});
try {
 const signedOut=await browser.page({url:origin});
 await signedOut.until("Boolean(document.querySelector('.model-button'))");
 await signedOut.evaluate("window.tasknodeAppearance.setPreference('dark')");
 await signedOut.command("Page.reload",{ignoreCache:true});
 await signedOut.until("Boolean(document.querySelector('.model-button'))");
 assert.equal(await signedOut.evaluate("document.documentElement.dataset.theme"),"dark");
 assert.equal(await signedOut.evaluate("getComputedStyle(document.body).backgroundColor"),"rgb(23, 24, 22)");
 const state=await fetch(origin+"/api/app-state").then(r=>r.json());
 state.session={...state.session,status:"signed_in",accountId:"theme_fixture",displayName:"Theme review",hiveHandle:"theme-review",linkedProviders:[]};
 const page=await browser.page({url:origin,intercept:async request=>{
  const url=new URL(request.url);
  if(url.pathname==="/api/app-state")return {body:state};
  if(url.pathname.startsWith("/api/"))return {body:{ok:true,exists:true,profile:{hiveHandle:"theme-review"},items:[],entries:[],messages:[],conversations:[],rows:[]}};
  return null;
 }});
 await page.until("Boolean(document.querySelector('.model-button'))");
 await page.evaluate("document.querySelector('.profile-button').click()");
 await page.until("Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Settings')");
 await page.evaluate("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Settings').click()");
 await page.until("Boolean(document.querySelector('input[name=appearance]'))");
 for(const theme of ["dark","light","system","dark"]){
  await page.evaluate(`document.querySelector('input[name=appearance][value=${theme}]').click()`);
  await page.until(`document.documentElement.dataset.themePreference===${JSON.stringify(theme)}`);
  assert.equal(await page.evaluate("localStorage.getItem('tasknode.appearance.v1')"),theme);
 }
 assert.equal(await page.evaluate("getComputedStyle(document.body).backgroundColor"),"rgb(23, 24, 22)");
 const shot=await page.command("Page.captureScreenshot",{format:"png"});
 await writeFile("/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-dark-mode/production-settings.png",Buffer.from(shot.data,"base64"));
 await page.command("Page.reload",{ignoreCache:true});
 await page.until("Boolean(document.querySelector('.model-button'))");
 assert.equal(await page.evaluate("document.documentElement.dataset.theme"),"dark");
 evidence.browser="Unmocked signed-out production theme/reload passed. Real deployed Settings assets with synthetic signed-in API session: all choices, computed canvas, saved preference and reload passed.";
 assert.equal(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--tn-control-border').trim()"),"#808376");
 console.log(JSON.stringify(evidence,null,2));
} finally {await browser.close();}
