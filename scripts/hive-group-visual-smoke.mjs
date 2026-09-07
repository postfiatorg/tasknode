import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { generateTaskNodeMnemonic } from "../src/wallet-core.js";
import { deriveNostrMessagingIdentity } from "../src/features/messages/nostr-messages.js";
import { createHiveGroupEvent, validateHiveGroupEvent } from "../shared/hive-group.js";
import { browserFixture } from "./browser-fixture-driver.mjs";

const origin = process.env.HIVE_FIXTURE_ORIGIN || "http://127.0.0.1:5199", output = process.env.HIVE_FIXTURE_OUTPUT || "docs/verification/hive-group-chat-2026-09-06";
await mkdir(output, { recursive: true });
const sample = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4mQAAAAASUVORK5CYII=", "base64");
const people = [];
for (const [handle, displayName] of [["cinder", "Cinder Works"], ["moss", "Moss Compiler"]]) {
  const mnemonic = generateTaskNodeMnemonic(), accountId = `fixture_${handle}`;
  const identity = await deriveNostrMessagingIdentity({ accountId, walletSecret: { mnemonic } });
  people.push({ accountId, mnemonic, identity, handle, displayName, pubkey: identity.publicKeyHex, nip05: `${handle}@tasknode.postfiat.org`, heroNft: handle === "cinder" ? { imageCid: "fictional-profile-image" } : null });
}
const botKey = randomBytes(32), bot = { pubkey: getPublicKey(botKey), handle: "hive-board", displayName: "Hive Board", accountId: "", bot: true, nip05: "hive-board@tasknode.postfiat.org" };
const members = [...people.map(({ mnemonic: _mnemonic, identity: _identity, ...member }) => member), bot];
const root = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now()/1000)-3600, tags: [], content: "Fixture room" }, botKey);
const channel = { id: "fixture-room", rootEvent: root, relays: ["wss://fixture.invalid"], botPubkey: bot.pubkey, ready: true };
const messages = [];
function append(key, author, content, actor = "member", options = {}) {
  const event = createHiveGroupEvent({ privateKey: key, rootId: root.id, content, now: Date.now()-600_000+messages.length*60_000, ...options });
  const message = { id: event.id, event, author, actor, sequence: messages.length+1, delivery: "delivered" }; messages.push(message); return message;
}
append(people[0].identity.privateKey, members[0], "The task sync patch is through review. Finally watching the board catch up without a refresh.");
append(people[1].identity.privateKey, members[1], "@cinder nice. I’m testing the reconnect path next — the interesting bugs always live there.");
const escalated = append(people[1].identity.privateKey, members[1], "@hive-board can the terminal board pick up the remaining reconnect issue? I have a reproduction and a trace.");
escalated.escalation = { id: "fixture-escalation", state: "pending", boardId: "board_pf_terminal" };
append(botKey, bot, "@moss That’s concrete enough to investigate. I’ve queued the reconnect issue for the Kimi board manager. Drop the reproduction here so the thread stays useful.", "board", { replyTo: escalated.id });
append(people[0].identity.privateKey, members[0], "The machines yearn for stable WebSockets.");
const main = await fetch(`${origin}/src/main.jsx`).then(r => r.text());
const module = await fetch(`${origin}/src/features/hive/HiveGroupChat.jsx`).then(r => r.text());
const moduleUrl = (text, name) => text.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
const react = moduleUrl(module, "/react.js"), reactDom = moduleUrl(main, "react-dom_client.js");
assert.ok(react && reactDom);
let failAfterAccept = true, sendIds = [];
function html(person) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="height:100dvh"></div><script>
window.fixtureErrors=[];window.onerror=(...args)=>fixtureErrors.push(String(args[0]));window.onunhandledrejection=e=>fixtureErrors.push(String(e.reason));
const sockets=new Set();window.WebSocket=class {constructor(){this.readyState=0;sockets.add(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},10)}send(raw){const data=JSON.parse(raw);if(data[0]==='REQ')setTimeout(()=>this.onmessage?.({data:JSON.stringify(['EOSE',data[1]])}),10)}close(){this.readyState=3;sockets.delete(this);this.onclose?.({})}};
</script><script type="module">
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import {HiveGroupChat} from '/src/features/hive/HiveGroupChat.jsx';import {MessagesView} from '/src/features/messages/MessagesView.jsx';import '/src/styles.css';
const root=ReactDOM.createRoot(document.getElementById('root'));const defaults=${JSON.stringify({ accountId: person.accountId, walletSecret: { mnemonic: person.mnemonic } })};
window.showHive=(overrides={})=>root.render(React.createElement(HiveGroupChat,{...defaults,...overrides,onOpenMessages:()=>{window.setupClicked=true},onWalletUnlock:()=>{window.unlockClicked=true},onLoginRequired:()=>{window.loginClicked=true}}));
window.showMessages=()=>root.render(React.createElement(MessagesView,{...defaults,onOpenProfile:()=>{},onWalletUnlock:()=>{},onOpenHiveChat:()=>window.showHive()}));
window.showHive();
</script></body></html>`;
}
const browser = await browserFixture({ port: 9369 });
try {
  const pageFor = person => browser.page({ url: `${origin}/__hive_fixture_${person.handle}`, intercept: async request => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__hive_fixture")) return { type: "text/html", body: html(person) };
    if (url.pathname.startsWith("/api/profile/nft/")) return { type: "image/png", base64Body: sample.toString("base64") };
    const identity = { displayName: person.displayName, nostrName: person.handle, hiveHandle: person.handle, nip05: person.nip05, discoverable: true, heroNft: person.heroNft };
    if (url.pathname === "/api/messages/bootstrap") return { body: { ok: true, identity, binding: null, defaultRelays: channel.relays, canActivate: true } };
    if (url.pathname === "/api/hive/group") return { body: { ok: true, channel, members, messages, messaging: { identity, binding: { nostrPubkeyHex: person.pubkey } }, unreadCount: 0 } };
    if (url.pathname === "/api/hive/group/read") return { body: { ok: true } };
    if (url.pathname === "/api/hive/group/messages") {
      const { event } = JSON.parse(request.postData);
      validateHiveGroupEvent(event, { rootId: root.id, authorPubkey: person.pubkey });
      sendIds.push(event.id);
      let saved = messages.find(row => row.id === event.id);
      if (!saved) { saved = { id: event.id, event, author: members.find(member => member.pubkey === event.pubkey), sequence: messages.length+1, delivery: "delivered", actor: "member" }; messages.push(saved); }
      if (failAfterAccept) { failAfterAccept = false; return { code: 503, body: { ok: false, message: "Fixture connection interrupted. Your draft stays saved for retry." } }; }
      return { body: { ok: true, message: saved } };
    }
    if (url.pathname === "/api/hive/chat") return { body: { ok: true, conversation: { id: "private-fixture" } } };
    if (url.pathname === "/api/chat/history") return { body: { ok: true, messages: [{ id: "private", role: "user", content: "PRIVATE_ARCHIVE_CANARY" }] } };
    if (url.pathname.startsWith("/api/")) return { body: { ok: true } };
    return null;
  } });
  const first = await pageFor(people[0]), second = await pageFor(people[1]);
  await first.command("Page.bringToFront");
  await first.command("Emulation.setDeviceMetricsOverride", { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await first.until("document.querySelectorAll('.hgc-message').length===5").catch(async error => { console.log(await first.evaluate("({errors:window.fixtureErrors,body:document.body.innerText})")); throw error; });
  await first.until("document.querySelector('.hgc-avatar-link img')?.naturalWidth>0");
  assert.equal(await first.evaluate("!!document.querySelector('.hgc-welcome')"), false, "filler intro must stay removed");
  assert.equal(await first.evaluate("!!document.querySelector('.hgc-composer .app-composer-send-button .lucide-arrow-up')"), true, "Hive uses the shared send button");
  await second.command("Page.bringToFront");
  await second.until("document.querySelectorAll('.hgc-message').length===5");
  await first.command("Page.bringToFront");
  assert.equal(await first.evaluate("document.querySelector('.hgc-event-time').href.includes('nevent1')"), true);
  assert.equal(await first.evaluate("document.querySelector('.hgc-message-meta>a').href.includes('/profile?account=fixture_cinder')"), true);
  assert.equal(await first.evaluate("document.body.innerText.includes('Queued for the Kimi board manager')"), true);
  const screenshot = async (page, name) => { if (process.env.HIVE_FIXTURE_SCREENSHOTS !== "true") return; const shot = await page.command("Page.captureScreenshot", { format: "png" }); await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, "base64")); };
  await screenshot(first, "hive-desktop");
  await first.evaluate("document.querySelector('textarea').focus()");
  await first.command("Input.insertText", { text: "@mo" });
  await first.until("document.querySelector('[role=option]')?.innerText.includes('@moss')");
  await screenshot(first, "hive-mention");
  await first.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  assert.equal(await first.evaluate("document.querySelector('textarea').value"), "@moss ");
  await first.command("Input.insertText", { text: "I have the reconnect trace ready." });
  await first.evaluate("document.querySelector('.hgc-composer .app-composer-send-button').click()");
  await first.until("document.querySelector('.hgc-error')?.innerText.includes('draft')");
  assert.equal(await first.evaluate("document.querySelector('textarea').value.includes('reconnect trace')"), true);
  await first.command("Page.reload");
  await first.until("document.querySelector('textarea')?.value.includes('reconnect trace')");
  await first.evaluate("document.querySelector('.hgc-composer .app-composer-send-button').click()");
  await first.until("document.querySelector('textarea')?.value===''");
  assert.equal(sendIds.length, 2); assert.equal(sendIds[0], sendIds[1], "retry after reload keeps the signed event ID");
  assert.equal(messages.filter(row => row.id === sendIds[0]).length, 1);
  assert.ok(messages.at(-1).event.tags.some(tag => tag[0] === "p" && tag[1] === people[1].pubkey));
  await second.command("Page.bringToFront");
  await second.until("document.querySelectorAll('.hgc-message').length===6");
  await first.command("Page.bringToFront");
  assert.equal(await second.evaluate("document.body.innerText.includes('I have the reconnect trace ready.')"), true);
  await first.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot(first, "hive-mobile");
  assert.equal(await first.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth"), false);
  await first.evaluate("window.showHive({walletSecret:null})");
  await first.until("document.body.innerText.includes('Unlock to chat')");
  assert.equal(await first.evaluate("document.querySelectorAll('.hgc-message').length"), 6, "wallet lock preserves public reading");
  await screenshot(first, "hive-locked-mobile");
  await first.evaluate("window.showHive({accountId:'new_member',walletSecret:null})");
  await first.until("document.body.innerText.includes('Set up Messages')");
  await screenshot(first, "hive-onboarding-mobile");
  await first.evaluate("document.querySelector('.hgc-primary').click()");
  assert.equal(await first.evaluate("window.setupClicked"), true);
  await first.evaluate("window.showMessages()");
  await first.until("document.body.textContent.includes('Your identity for Messages & Hive')").catch(async error => { console.log(await first.evaluate("({errors:window.fixtureErrors,body:document.body.innerText})")); throw error; });
  await screenshot(first, "messages-activation-mobile");
  await first.evaluate("window.showHive({accountId:'',walletSecret:null})");
  await first.until("document.body.innerText.includes('Sign in to chat')");
  assert.equal(await first.evaluate("document.querySelector('textarea')===null"), true);
  await first.evaluate("window.showHive()");
  await first.until("document.querySelector('.hgc-header>.hgc-button')!==null");
  await first.evaluate("document.querySelector('.hgc-header>.hgc-button').click()");
  await first.until("document.querySelector('.hgc-members-open')!==null");
  await screenshot(first, "hive-members-mobile");
  await first.evaluate("document.querySelector('.hgc-archive-link').click()");
  await first.until("document.body.innerText.includes('PRIVATE_ARCHIVE_CANARY')");
  assert.equal(messages.some(row => row.event.content.includes("PRIVATE_ARCHIVE_CANARY")), false);
  assert.deepEqual(await first.evaluate("window.fixtureErrors"), []);
  assert.deepEqual(await second.evaluate("window.fixtureErrors"), []);
  const result = { ok: true, mode: "Actual HiveGroupChat and MessagesView with two wallet-derived fixture identities, synthetic HTTP/relay responses and a synthetic PNG avatar; no public test messages", checks: ["shared feed across two accounts", "PFPs and profile links", "Nostr message links", "mention keyboard completion and p tags", "network failure draft retention", "same event retry across reload", "wallet locked reading", "Messages activation UX", "signed-out reading", "account switch isolation", "private archive isolation", "390px mobile without overflow"] };
  await writeFile(`${output}/browser-results.json`, JSON.stringify(result, null, 2)+"\n");
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
