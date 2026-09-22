import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatDeletionState, removeRecentChat, restoreRecentChat } from '../src/features/chat/chat-deletion-state.js';

const first = { id: 'first', title: 'First chat' };
const second = { conversationId: 'second', title: 'Second chat' };
const state = (accountId = 'alpha', recents = [first, second]) => ({ session: { accountId }, chat: { recents }, tasks: { outstanding: [] } });
const ids = (value) => value.chat.recents.map((chat) => chat.conversationId || chat.id);

test('pending deletion and late snapshots cannot reinsert a deleted conversation', () => {
  const ledger = createChatDeletionState();
  const beforeDelete = ledger.capture();
  assert.equal(ledger.begin('alpha', 'first'), true);
  assert.equal(ledger.begin('alpha', 'first'), false);
  const whileDeleting = ledger.capture();
  assert.deepEqual(ids(ledger.reconcile(state(), beforeDelete)), ['second']);
  assert.deepEqual(ids(ledger.reconcile(state(), whileDeleting)), ['second']);
  ledger.complete('alpha', 'first');
  assert.deepEqual(ids(ledger.reconcile(state(), beforeDelete)), ['second']);
  assert.deepEqual(ids(ledger.reconcile(state(), whileDeleting)), ['second']);
  assert.deepEqual(ids(ledger.reconcile(state('alpha', [second]), ledger.capture())), ['second']);
});

test('failed deletion restores only that conversation, preserving concurrent changes and order', () => {
  const ledger = createChatDeletionState();
  ledger.begin('alpha', 'first');
  ledger.begin('alpha', 'second');
  const newChat = { id: 'new', title: 'Created while saving' };
  let current = removeRecentChat(removeRecentChat(state(), 'alpha', 'first'), 'alpha', 'second');
  current = { ...current, chat: { recents: [newChat] } };
  ledger.fail('alpha', 'first');
  current = restoreRecentChat(current, 'alpha', first, 0);
  assert.deepEqual(ids(current), ['first', 'new']);
  assert.deepEqual(ids(ledger.reconcile(state(), ledger.capture())), ['first']);
  assert.equal(restoreRecentChat(current, 'alpha', first, 0), current);
  assert.equal(ledger.begin('alpha', 'first'), true, 'failure allows retry');
});

test('deletion and rollback stay within their account', () => {
  const ledger = createChatDeletionState();
  ledger.begin('alpha', 'first');
  const beta = state('beta');
  assert.equal(removeRecentChat(beta, 'alpha', 'first'), beta);
  assert.equal(restoreRecentChat(beta, 'alpha', first, 0), beta);
  assert.deepEqual(ids(ledger.reconcile(beta, ledger.capture())), ['first', 'second']);
  ledger.complete('alpha', 'first');
  assert.deepEqual(ids(ledger.reconcile(beta, 0)), ['first', 'second']);
});

test('fresh server state can intentionally re-enable a disabled Hive conversation', () => {
  const ledger = createChatDeletionState();
  const hive = { id: 'hive', kind: 'hive', title: 'Hive Chat' };
  ledger.begin('alpha', 'hive');
  const pending = ledger.capture();
  ledger.complete('alpha', 'hive');
  assert.deepEqual(ids(ledger.reconcile(state('alpha', [hive]), pending)), []);
  assert.deepEqual(ids(ledger.reconcile(state('alpha', [hive]), ledger.capture())), ['hive']);
});
