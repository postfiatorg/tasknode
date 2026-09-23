import assert from "node:assert/strict";
import { browserFixture } from "./browser-fixture-driver.mjs";
const origin = process.env.TASKNODE_APP_ORIGIN || "http://127.0.0.1:5198";
const base = await fetch("https://tasknode.postfiat.org/api/app-state").then(r => r.json());
const config = await fetch("https://tasknode.postfiat.org/runtime-config.json").then(r => r.json());
let selected = "", members = [], failure = "", lists = 0;
const identities = { alpha: "Alpha fixture", beta: "Beta fixture" };
const session = () => ({ ...base.session, status: selected ? "signed_in" : "signed_out", accountId: selected, displayName: identities[selected] || "", hiveHandle: selected, linkedProviders: [], identityProfile: { hiveHandle: selected, displayName: identities[selected] || "", handleRequired: false }, accountLinks: [{ id: "email", enabled: true, startPath: "/api/auth/email/start", verifyPath: "/api/auth/email/verify" }] });
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9347) });
try {
  const page = await browser.page({ url: origin, intercept: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/app-state") return { body: { ...base, session: session() } };
    if (path === "/runtime-config.json") return { body: config };
    if (path === "/api/auth/password") {
      if (failure === "login_network") return { fail: true };
      const payload = JSON.parse(request.postData);
      selected = payload.identifier || payload.email;
      assert.ok(identities[selected]);
      if (!members.includes(selected)) members.push(selected);
      return { body: { ok: true, session: session() } };
    }
    if (path === "/api/auth/accounts") {
      lists++;
      if (failure === "list") return { code: 503, body: { ok: false, message: "Profiles temporarily unavailable" } };
      return { body: { ok: true, selectedAccountId: selected, accounts: members.map(accountId => ({ accountId, displayName: identities[accountId], hiveHandle: accountId })) } };
    }
    if (path === "/api/auth/accounts/switch") {
      if (failure === "switch") return { fail: true };
      selected = JSON.parse(request.postData).targetAccountId;
      return { body: { ok: true, selectedAccountId: selected, session: session() } };
    }
    if (path === "/api/auth/logout" || path === "/api/auth/logout-all") {
      if (failure === "logout_http") return { code: 503, body: { ok: false, message: "Log out temporarily unavailable" } };
      if (failure === "logout_network") return { fail: true };
      members = path.endsWith("logout-all") ? [] : members.filter(id => id !== selected);
      selected = members[0] || "";
      return { body: { ok: true, selectedAccountId: selected, signedOut: !selected, session: session() } };
    }
    if (path.startsWith("/api/")) return { body: { ok: true, items: [], entries: [], messages: [], conversations: [], documents: [], folders: [], projects: [], members: [], invites: [], badges: [], memories: [], results: [], rows: [], availableCreditUsd: 0 } };
  } });
  await page.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const click = async label => {
    const expression = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
    await page.until(`Boolean(${expression})`);
    await page.evaluate(`${expression}.click()`);
  };
  const menu = async () => {
    await page.until("Boolean(document.querySelector('.profile-button:not(:disabled)'))");
    if (!await page.evaluate("Boolean(document.querySelector('.profile-menu'))")) await page.evaluate("document.querySelector('.profile-button').click()");
  };
  const login = async id => {
    await click("Password");
    for (const [label,value] of [["Verified email or Hive handle",id],["Account password","fixture-password-long"]]) {
      await page.evaluate(`(()=>{const i=document.querySelector('input[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    }
    if (!members.length && !selected && id === "alpha") {
      failure = "login_network";
      await click("Continue");
      await page.until("document.querySelector('.login-dialog')?.textContent.includes('fetch')");
      failure = "";
    }
    await click("Continue");
    await page.until(`document.querySelector('.profile-button')?.textContent.includes(${JSON.stringify(identities[id])}) && !document.querySelector('.login-dialog')`);
  };
  await menu(); await click("Log in or sign up"); await login("alpha");
  await menu(); await click("Add account"); await login("beta");
  await menu(); await page.until("document.querySelectorAll('.profile-account-row').length===2");
  assert.ok(await page.evaluate("document.querySelector('.profile-menu').textContent.includes('Switch profile')"));
  failure = "list";
  await page.evaluate("document.querySelector('.profile-button').click()"); await menu();
  await page.until("document.body.innerText.includes('Profiles temporarily unavailable')");
  assert.equal(await page.evaluate("document.querySelectorAll('.profile-account-row').length"),2);
  failure = "switch";
  await page.evaluate("document.querySelector('.profile-account-row:not(.selected) button').click()");
  await page.until("!document.querySelector('.account-transition-overlay') && document.querySelector('.profile-menu-message')?.textContent.includes('fetch')");
  failure = "";
  await page.evaluate("document.querySelector('.profile-account-row:not(.selected) button').click()");
  await page.until("document.querySelector('.profile-button')?.textContent.includes('Alpha fixture') && !document.querySelector('.account-transition-overlay')");
  await menu(); await click("Log out this account");
  failure = "logout_http"; await click("Log out this account");
  await page.until("document.body.innerText.includes('Log out temporarily unavailable') && !document.querySelector('.account-transition-overlay')");
  assert.equal(selected,"alpha");
  failure = "logout_network"; await click("Log out this account");
  await page.until("document.querySelector('.profile-menu-message')?.textContent.includes('fetch') && !document.querySelector('.account-transition-overlay')");
  failure = ""; await click("Log out this account");
  await page.until("document.querySelector('.profile-button')?.textContent.includes('Beta fixture') && !document.querySelector('.account-transition-overlay')");
  await menu(); await click("Log out all accounts");
  await page.until("document.querySelector('.profile-button:not(:disabled)')?.getAttribute('aria-label')==='Log in or sign up'");
  await menu(); await click("Log in or sign up"); await login("alpha");
  const evidence = { ok: true, mode: "Real App, LoginDialog and profile menu in Chrome with fixture HTTP responses", lists, checks: ["password network failure allows retry", "password login", "add second account", "Switch profile remains visible", "list failure preserves profiles", "switch network failure unlocks UI", "switch changes account", "logout HTTP and network failures allow retry", "logout current selects remaining profile", "logout all signs out", "login after logout"] };
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
