import assert from "node:assert/strict";
import { telegramAuthorizePage, telegramAuthorizeErrorHtml } from "../server/auth-telegram-pages.js";
import { browserFixture } from "./browser-fixture-driver.mjs";
const origin = "http://127.0.0.1:5197";
const browser = await browserFixture({port:9377});
try {
 for (const html of [telegramAuthorizePage(), telegramAuthorizeErrorHtml({title:"Sign in needs attention",message:"Please try again.",actionRequired:"Return to Task Node."})]) {
  const page = await browser.page({url:origin+"/theme-auth-fixture",intercept: async request => {
   if (request.url===origin+"/theme-auth-fixture") return {body:html,type:"text/html"};
   if (!request.url.startsWith(origin+"/")) return {fail:true};
   return null;
  }});
  await page.until("Boolean(document.querySelector('main')) && Boolean(window.tasknodeAppearance)");
  for (const theme of ["dark","light"]) {
   await page.evaluate(`window.tasknodeAppearance.setPreference(${JSON.stringify(theme)})`);
   assert.equal(await page.evaluate("getComputedStyle(document.body).backgroundColor"),theme==="dark"?"rgb(23, 24, 22)":"rgb(247, 246, 242)");
  }
  await page.evaluate("window.tasknodeAppearance.setPreference('system')");
  await page.command("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
  await page.until("document.documentElement.dataset.theme==='dark'");
 }
 console.log("Standalone auth pages passed light/dark and live System changes; external widget blocked in fixture");
} finally { await browser.close(); }
