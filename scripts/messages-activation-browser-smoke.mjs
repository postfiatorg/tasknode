import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { generateTaskNodeMnemonic, signWalletChallenge } from "../src/wallet-core.js";
import { deriveNostrMessagingIdentity } from "../src/features/messages/nostr-messages.js";
import { browserFixture } from "./browser-fixture-driver.mjs";
import { query, closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { enforceRoutePolicy, json } from "../server/server-http-boundary.js";
import { readValidatedJson } from "../server/request-validation.js";
import { handleCollaborationRoute } from "../server/collaboration-routes.js";
import { hiveGroupMembers } from "../server/repositories/hive-group.js";

// Real browser requests, route validation, wallet proof verification and persistence.
// Only account/session fixtures and relay transport are synthetic; no public messages.
const database = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
assert.equal(database.pathname, "/tasknode_messages_registration_20260906");
const origin = process.env.MESSAGES_FIXTURE_ORIGIN || "http://127.0.0.1:5199";
const people = [];
const requests = [];
let browser;
async function route(accountId, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json", host: "127.0.0.1:5199" };
  req.socket = { remoteAddress: "127.0.0.1" };
  let response;
  const res = { writeHead(code) { this.code = code; }, end(value) { response = { code: this.code, body: JSON.parse(value) }; } };
  const url = new URL(pathname, origin), session = accountId ? { accountId } : null;
  if (!await enforceRoutePolicy(req, url, res, session)) {
    const handled = await handleCollaborationRoute({ req, res, url, session, json, readJson: readValidatedJson });
    assert.ok(handled, pathname);
  }
  return response;
}
try {
  await migrateDatabase();
  const main = await fetch(`${origin}/src/main.jsx`).then(r => r.text());
  const component = await fetch(`${origin}/src/features/messages/MessagesView.jsx`).then(r => r.text());
  const moduleUrl = (text, name) => text.split('"').find(part => part.startsWith("/node_modules/") && part.includes(name));
  const react = moduleUrl(component, "/react.js"), reactDom = moduleUrl(main, "react-dom_client.js");
  assert.ok(react && reactDom);
  browser = await browserFixture({ port: Number(process.env.MESSAGES_FIXTURE_BROWSER_PORT || 9369) });
  for (const handle of ["activation_alice", "activation_bob"]) {
    const accountId = `fixture_${handle}`, mnemonic = generateTaskNodeMnemonic();
    const identity = await deriveNostrMessagingIdentity({ accountId, walletSecret: { mnemonic } });
    const person = { accountId, mnemonic, identity, handle }; people.push(person);
    const account = { id: accountId, status: "active", hiveHandle: handle, publicDisplayName: handle, profileVisibility: "public", profileDiscoverable: true };
    await query("INSERT INTO app_accounts(account_id,account_json,hive_handle) VALUES($1,$2::jsonb,$3)", [accountId, JSON.stringify(account), handle]);
    await query("INSERT INTO account_linked_wallets(account_id,wallet_address) VALUES($1,$2)", [accountId, identity.walletAddress]);
    const html = `<!doctype html><div id="root"></div><script>
window.fixtureErrors=[];window.onerror=(...args)=>fixtureErrors.push(String(args[0]));window.onunhandledrejection=e=>fixtureErrors.push(String(e.reason));
window.WebSocket=class {constructor(){this.readyState=0;setTimeout(()=>{this.readyState=1;this.onopen?.({});},10)}send(raw){const data=JSON.parse(raw);if(data[0]==='REQ')setTimeout(()=>this.onmessage?.({data:JSON.stringify(['EOSE',data[1]])}),10)}close(){this.readyState=3;this.onclose?.({})}};
</script><script type="module">import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import {MessagesView} from '/src/features/messages/MessagesView.jsx';import '/src/styles.css';ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(MessagesView,${JSON.stringify({ accountId, walletSecret: { mnemonic } })}));</script>`;
    const page = await browser.page({ url: `${origin}/__activation_fixture_${handle}`, intercept: async request => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/__activation_fixture_")) return { type: "text/html", body: html };
      if (url.pathname.startsWith("/api/") || url.pathname === "/.well-known/nostr.json") {
        const body = request.postData ? JSON.parse(request.postData) : undefined;
        const response = await route(accountId, request.method, url.pathname + url.search, body);
        if (request.method === "POST") requests.push({ accountId, path: url.pathname, request: body, response });
        return response;
      }
      return null;
    } });
    await page.command("Page.bringToFront");
    await page.until("document.querySelector('.messages-primary')?.textContent.trim()==='Activate Messages'");
    await page.evaluate("document.querySelector('.messages-primary').click()");
    await page.until("!!document.querySelector('.messages-page')").catch(async error => {
      console.log(await page.evaluate("({body:document.body.innerText,errors:window.fixtureErrors})")); throw error;
    });
    assert.deepEqual(await page.evaluate("window.fixtureErrors"), []);
    const activation = requests.find(item => item.accountId === accountId && item.path === "/api/messages/identity");
    assert.equal(activation.response.code, 200);
    assert.equal(activation.request.nip05, `${handle}@tasknode.postfiat.org`);
    assert.equal((await query("SELECT count(*)::int AS n FROM account_nostr_identities WHERE account_id=$1 AND status='active'", [accountId])).rows[0].n, 1);
    assert.ok((await hiveGroupMembers()).some(member => member.accountId === accountId), "activation must make the contributor eligible for Hive");
    assert.equal((await route(accountId, "POST", "/api/messages/identity", activation.request)).body.error, "collaboration_challenge_invalid", "used wallet proofs cannot be replayed");
    await page.command("Page.reload");
    await page.until("!!document.querySelector('.messages-page')");
  }
  const { accountId, mnemonic, identity } = people[0];
  const valid = requests.find(item => item.accountId === accountId && item.path === "/api/messages/identity").request;
  assert.equal((await route("", "POST", "/api/messages/identity", valid)).code, 401);
  assert.equal((await route(accountId, "POST", "/api/messages/identity", { ...valid, unexpectedField: true })).body.error, "request_body_field_unknown");
  assert.equal((await route(accountId, "POST", "/api/messages/identity", { ...valid, nip05: 42 })).body.error, "request_body_field_type_invalid");
  assert.equal((await route(accountId, "POST", "/api/messages/identity", { ...valid, nip05: "a".repeat(321) })).body.error, "request_body_field_too_long");
  const { proof: _proof, ...payload } = valid;
  async function signedBody(value) {
    const challenge = await route(accountId, "POST", "/api/collaboration/challenge", { action: "nostr_bind", resourceId: identity.publicKeyHex, payload: value });
    assert.equal(challenge.code, 200);
    const signed = signWalletChallenge(mnemonic, challenge.body.challenge.message);
    return { ...value, proof: { challengeId: challenge.body.challenge.id, publicKey: signed.publicKey, signature: signed.signature } };
  }
  const forgedAddress = await signedBody({ ...payload, nip05: "someone_else@tasknode.postfiat.org" });
  assert.equal((await route(accountId, "POST", "/api/messages/identity", forgedAddress)).body.error, "collaboration_challenge_invalid", "the server must independently derive the canonical address");
  const brokenSignature = await signedBody(payload);
  brokenSignature.proof.signature = "0".repeat(brokenSignature.proof.signature.length);
  assert.equal((await route(accountId, "POST", "/api/messages/identity", brokenSignature)).body.error, "collaboration_wallet_signature_invalid");
  const retry = await signedBody(payload);
  assert.equal((await route(accountId, "POST", "/api/messages/identity", retry)).code, 200, "a fresh proof must recover a failed activation");
  const evidence = { ok: true, mode: "Actual MessagesView → real request validator → real signature verifier → disposable Postgres", accountsActivated: people.length, reloadsRestored: people.length, hiveMembershipVerified: true, protections: ["unauthenticated", "unknown field", "wrong type", "oversized address", "spoofed address", "invalid signature", "replayed proof"], freshProofRetry: true, publicMessagesSent: 0 };
  if (process.env.MESSAGES_FIXTURE_OUTPUT) await writeFile(process.env.MESSAGES_FIXTURE_OUTPUT, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  for (const table of ["account_nostr_identities", "collaboration_wallet_challenges", "collaboration_audit_events", "account_linked_wallets", "app_accounts"]) {
    await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`, [people.map(person => person.accountId)]);
  }
  await closePool();
}
