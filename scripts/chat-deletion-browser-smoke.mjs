import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { browserFixture } from './browser-fixture-driver.mjs';

const origin = process.env.TASKNODE_APP_ORIGIN || 'http://127.0.0.1:5199';
const base = await fetch('https://tasknode.postfiat.org/api/app-state').then((response) => response.json());
const config = await fetch('https://tasknode.postfiat.org/runtime-config.json').then((response) => response.json());
let recents = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((title) => ({ id: 'chat_' + title.toLowerCase(), conversationId: 'chat_' + title.toLowerCase(), title, messageCount: 2 }));
const pending = new Map();
let appStateCalls = 0;
const browser = await browserFixture({ port: Number(process.env.CDP_PORT || 9348) });
const measurements = [];
try {
  const page = await browser.page({ url: origin, intercept: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/runtime-config.json') return { body: config };
    if (path === '/api/app-state') {
      appStateCalls++;
      return { body: { ...base, session: { ...base.session, status: 'signed_in', accountId: 'chat_delete_fixture', displayName: 'Deletion fixture', linkedProviders: [], identityProfile: { hiveHandle: 'deletion_fixture', handleRequired: false } }, chat: { ...base.chat, recents: [...recents], seedMessages: [] } } };
    }
    if (path === '/api/chat/conversation' && request.method === 'DELETE') {
      const { conversationId } = JSON.parse(request.postData);
      const response = await new Promise((resolve) => pending.set(conversationId, resolve));
      pending.delete(conversationId);
      if (response.body?.ok || response.code === 404) recents = recents.filter((chat) => chat.id !== conversationId);
      return response;
    }
    if (path === '/api/chat/history') return { body: { messages: [], conversationId: new URL(request.url).searchParams.get('conversationId') } };
    if (path.startsWith('/api/')) return { body: { ok: true, accounts: [], items: [], entries: [], messages: [], conversations: [], documents: [], folders: [], projects: [], members: [], invites: [], badges: [], results: [], availableCreditUsd: 0 } };
  } });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const row = (title) => `Array.from(document.querySelectorAll('.recent-chat-row')).find(row=>row.querySelector('.recent-chat-open')?.title===${JSON.stringify(title)})`;
  const click = async (expression) => { await page.until(`Boolean(${expression})`); await page.evaluate(`${expression}.click()`); };
  const waitPending = async (id) => {
    for (let i = 0; i < 100 && !pending.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(pending.has(id), 'delete request reached fixture');
  };
  async function beginDelete(title) {
    await click(`${row(title)}.querySelector('.recent-chat-more')`);
    await click("document.querySelector('.chat-action-menu-item.danger')");
    await page.until("Boolean(document.querySelector('#delete-chat-title'))");
    await page.evaluate(`(()=>{window.chatDeleteStart=performance.now();window.chatDeleteLatency=null;const observer=new MutationObserver(()=>{if(!(${row(title)})&&!document.querySelector('#delete-chat-title')){window.chatDeleteLatency=performance.now()-window.chatDeleteStart;observer.disconnect();}});observer.observe(document.body,{childList:true,subtree:true});document.querySelector('.chat-edit-modal .danger-button').click();})()`);
    await waitPending('chat_' + title.toLowerCase());
    await page.until(`!(${row(title)}) && !document.querySelector('#delete-chat-title')`);
    const latency = await page.evaluate('window.chatDeleteLatency');
    assert.ok(latency !== null && latency < 500, 'sidebar should update without waiting for the network');
    measurements.push({ title, confirmationToRemovalMs: Math.round(latency * 10) / 10, responseStillPending: true });
  }
  await page.until(`Boolean(${row('Alpha')})`);
  const callsBefore = appStateCalls;
  await click(`${row('Alpha')}.querySelector('.recent-chat-open')`);
  await beginDelete('Alpha');
  await click(`${row('Beta')}.querySelector('.recent-chat-open')`);
  pending.get('chat_alpha')({ body: { ok: true, conversationId: 'chat_alpha' } });
  await page.until(`${row('Beta')}?.classList.contains('active')`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.evaluate(`Boolean(${row('Alpha')})`), false);
  assert.equal(await page.evaluate(`${row('Beta')}?.classList.contains('active')`), true);

  await beginDelete('Gamma');
  pending.get('chat_gamma')({ code: 503, body: { ok: false, message: 'Unavailable' } });
  await page.until(`Boolean(${row('Gamma')}) && document.querySelector('[role=alert]')?.textContent.includes('Could not confirm deletion')`);
  await click("document.querySelector('[aria-label=\"Dismiss chat deletion error\"]')");
  await page.until("!document.querySelector('[role=alert]')");
  await beginDelete('Gamma');
  pending.get('chat_gamma')({ code: 404, body: { ok: false, error: 'chat_conversation_not_found' } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await page.evaluate(`Boolean(${row('Gamma')})`), false);
  assert.equal(await page.evaluate("Boolean(document.querySelector('[role=alert]'))"), false);

  await beginDelete('Delta');
  pending.get('chat_delta')({ fail: true });
  await page.until(`Boolean(${row('Delta')}) && Boolean(document.querySelector('[role=alert]'))`);
  assert.equal(await page.evaluate(`${row('Beta')}?.classList.contains('active')`), true);
  await beginDelete('Beta');
  pending.get('chat_beta')({ body: { ok: true, conversationId: 'chat_beta' } });
  await page.until("!document.querySelector('.recent-chat-row.active') && !document.querySelector('.thread-actions')");
  assert.equal(appStateCalls, callsBefore, 'deletion does not trigger a full app-state refresh');
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no mobile overflow');
  const evidence = { ok: true, origin, measurements, appStateCallsDuringDeletes: appStateCalls - callsBefore, checks: ['immediate row removal and dialog closure with DELETE response held open', 'newer active chat survives late deletion success', 'HTTP failure restores only deleted chat and displays dismissible error', 'retry of already deleted chat succeeds', 'network failure restores row', 'active chat clears after confirmed success', 'mobile layout has no horizontal overflow'] };
  if (process.env.CHAT_DELETE_EVIDENCE_PATH) await writeFile(process.env.CHAT_DELETE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const resolve of pending.values()) resolve({ fail: true });
  await browser.close();
}
