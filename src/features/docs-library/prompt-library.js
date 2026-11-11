import { requestJson } from '../../api';
import { decryptPrompt, encryptPrompt, newLibraryKey } from '../../../packages/tasknode-cli/lib/prompt-crypto.mjs';
export async function promptRequest(path, payload) {
  const result = await requestJson(`/api/docs/prompts/${path}`, payload === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!result.ok) throw new Error(result.body?.error || 'Prompt library request failed');
  return result.body;
}
export async function unlockPromptLibrary(rootKey) {
  let { envelope } = await promptRequest('key');
  if (!envelope) {
    const key = newLibraryKey();
    const candidate = await encryptPrompt({ key }, rootKey);
    try { await promptRequest('key', { envelope: candidate }); }
    catch { /* Another unlocked tab may have initialized first; always read back. */ }
    ({ envelope } = await promptRequest('key'));
    if (!envelope) throw new Error('Prompt library setup failed');
  }
  return (await decryptPrompt(envelope, rootKey)).key;
}
export async function readPromptHistory(key) {
  const events = []; let after = '';
  do {
    const result = await promptRequest(`history${after ? `?after=${after}` : ''}`);
    for (const row of result.events) {
      const payload = await decryptPrompt(row.ciphertext, key);
      if (payload.eventId !== row.eventId || payload.documentId !== row.documentId) throw new Error('Prompt history identity mismatch');
      events.push({ ...payload, createdAt: row.createdAt });
    }
    after = result.next;
  } while (after);
  return events;
}
export async function savePromptEvent(key, documentId, payload) {
  const eventId = crypto.randomUUID();
  const event = { ...payload, eventId, documentId, at: new Date().toISOString() };
  const ciphertext = await encryptPrompt(event, key);
  await promptRequest('history', { eventId, documentId, ciphertext });
  return event;
}
